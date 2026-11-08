// PlaylistPanel.ts — demo transport + session take row + LIVE backend status.
//
// HONESTY RULES BAKED IN:
//  * LOCAL and BACKEND truths are rendered by separate helper functions from
//    separate data: the take line shows ONLY the bus session clock + local
//    hit count; the two compact status rows show ONLY the controller's
//    scrubbed StatusDetail. Numbers are never merged.
//  * The backend rows come from polling captureController.getStatusSnapshot()
//    at 4 Hz (the 0.25 s text throttle) — a pure read-only getter. The
//    controller's onSnapshot / statusText hooks are deliberately NOT touched
//    (the ConnectionUI owns them; no overwrite, no chaining).
//  * SAVED wording is minted by the snapshot's savedBadgeCount / exact
//    SavedReceipt guard inside PlaylistPanelPresentation — never from a
//    listing, never for an unsettled take. A prior receipt renders as
//    "(earlier save)" while the current take holds work; unsynced/held/
//    buffered counts stay visible. No false ALL-SAVED exists here.
//  * captureController is OPTIONAL: unwired, the panel shows honest
//    local-only rows — it claims nothing about any backend.
//  * The 90 s bar is a ROLLING VIEW WINDOW (PlaylistPanelPresentation): it
//    never caps or restricts the session clock or the controller's capture
//    timing. Past 90 s the take line captions the view explicitly.
//  * The demo is the bundled generated loop, labelled as such. Audio stays the
//    LOCAL DEVICE MONITOR — the backend records notes, it never sounds them.
//  * CLEAR clears the LOCAL view only — never the backend document or saves
//    (the printed note says exactly that).
// Scene supplies: root with BackPlate, DemoPad, ClearPad, BarBG, BarFill,
// Tick0..Tick15, UiAudio (AudioComponent w/ ui_toggle.wav), and text children
// TxtTitle, TxtDemo, TxtTake, TxtSim, TxtTest.
//
// SCENE BINDING CONTRACT (for the scene owner):
//   input name  : captureController  (optional, type SoundcraftCaptureController)
//   wire target : the scene's SoundcraftCaptureController ScriptComponent
//   behavior    : polled 4 Hz via getStatusSnapshot(); no controller field is
//                 written (onSnapshot/statusText untouched); null = local-only
//                 honest rows. No other scene change is required.

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import {
  SoundcraftBus,
  HitInfo,
  ensureBoxCollider,
  ensureInteractable,
  ensurePanelManipulation,
  findChild,
  audioOf,
  visualOf,
  textOf,
} from "./SoundcraftBus";
import { SoundcraftCaptureController } from "./SoundcraftCaptureController";
import {
  PANEL_TITLE,
  BAR_VIEW_SECS,
  CLEAR_NOTE,
  backendRows,
  demoLabel,
  takeLine,
  barViewStart,
  barViewFrac,
  tickIndex,
} from "./PlaylistPanelPresentation";

const MAX_TICKS = 16;
const BAR_WIDTH = 19.4; // cm — the bar's on-panel width (view-only; see BAR_VIEW_SECS)

@component
export class PlaylistPanel extends BaseScriptComponent {
  @input
  @label("Capture Controller (optional)")
  @hint("Optional SoundcraftCaptureController. Polled 4 Hz via getStatusSnapshot(); this panel never writes onSnapshot or statusText. Unwired = honest local-only rows.")
  captureController: SoundcraftCaptureController = null;

  private demoAudio: AudioComponent = null;
  private uiAudio: AudioComponent = null;
  private demoPad: SceneObject = null;
  private clearPad: SceneObject = null;
  private barFill: SceneObject = null;
  private ticks: SceneObject[] = [];
  private txtDemo: Text = null;
  private txtTake: Text = null;
  private txtTest: Text = null;
  private txtTitle: Text = null;
  private txtSim: Text = null;
  private demoOnMat: Material = null;
  private demoOffMat: Material = null;
  private time = 0;
  private nextTextRefresh = 0;
  private barWindowStart = 0; // current 90 s VIEW window origin (display only)

  onAwake() {
    // Panel is draggable like the instruments.
    ensureBoxCollider(this.sceneObject, new vec3(34, 14, 1.2));
    ensureInteractable(this.sceneObject);
    ensurePanelManipulation(this.sceneObject);

    this.demoPad = findChild(this.sceneObject, "DemoPad");
    this.clearPad = findChild(this.sceneObject, "ClearPad");
    this.barFill = findChild(this.sceneObject, "BarFill");
    this.demoAudio = audioOf(this.demoPad);
    this.uiAudio = audioOf(findChild(this.sceneObject, "UiAudio"));

    this.txtDemo = textOf(findChild(this.sceneObject, "TxtDemo"));
    this.txtTake = textOf(findChild(this.sceneObject, "TxtTake"));
    this.txtTest = textOf(findChild(this.sceneObject, "TxtTest"));
    this.txtTitle = textOf(findChild(this.sceneObject, "TxtTitle"));
    this.txtSim = textOf(findChild(this.sceneObject, "TxtSim"));

    const demoVis = visualOf(this.demoPad);
    if (demoVis !== null && demoVis.mainMaterial !== null) {
      this.demoOffMat = demoVis.mainMaterial;
      this.demoOffMat.mainPass.baseColor = new vec4(0.85, 0.85, 0.9, 1);
      this.demoOnMat = demoVis.mainMaterial.clone();
      this.demoOnMat.mainPass.baseColor = new vec4(0.45, 1.0, 0.78, 1);
    }

    for (let i = 0; i < MAX_TICKS; i++) {
      const t = findChild(this.sceneObject, "Tick" + i);
      if (t !== null) {
        t.enabled = false;
        this.ticks.push(t);
      }
    }

    if (this.txtTitle !== null) {
      this.txtTitle.text = PANEL_TITLE;
    }
    if (this.txtSim !== null) {
      // Honest initial state BEFORE the first poll: local-only wording when no
      // controller is wired, real snapshot rows the moment one is.
      const rows = backendRows(null);
      this.txtSim.text = rows.statusRow + "\n" + rows.playlistRow;
    }

    // Test-key caption: visible only outside device runtime (editor preview).
    if (this.txtTest !== null) {
      const isDevice = global.scene.getCameraType() === "runtime";
      this.txtTest.enabled = !isDevice;
      this.txtTest.text = "TEST KEYS (editor only): 1-4 beat · QWER bass · ASDF chords · SPACE demo · P pan link";
    }

    this.wirePad(this.demoPad, () => this.toggleDemo());
    this.wirePad(this.clearPad, () => this.clearTake());

    this.createEvent("OnStartEvent").bind(() => {
      SoundcraftBus.playlist = this;
      SoundcraftBus.onHit.add((info: HitInfo) => this.onHit(info));
      SoundcraftBus.onTakeCleared.add(() => this.refreshTicks());
      SoundcraftBus.onDemoChanged.add((playing: boolean) => this.refreshDemoText(playing));
      this.refreshDemoText(SoundcraftBus.demoPlaying);
      this.refreshTicks();
      this.refreshTexts();
    });
    this.createEvent("UpdateEvent").bind(() => this.update());
  }

  private wirePad(pad: SceneObject, action: () => void) {
    if (pad === null) {
      return;
    }
    // Unit-local box: pad visuals are the shared unit SCBox scaled to their
    // final size (DemoPad 5×3×2 × 0.85 = 4.25×2.55×1.7 world), so a (1,1,1)
    // shape maps 1:1 onto the visual under the object's own transform. The
    // previous localScale-read here double-applied the size into the shape.
    ensureBoxCollider(pad, new vec3(1, 1, 1));
    const inter = ensureInteractable(pad);
    this.createEvent("OnStartEvent").bind(() => {
      inter.onTriggerStart.add(() => action());
    });
  }

  /** Demo transport. Auto-called at start ("play first"), pinchable later. */
  playDemo(on: boolean) {
    if (on) {
      if (this.demoAudio !== null) {
        // Property writes here run after OnStartEvent (autostart is deferred).
        this.demoAudio.playbackMode = Audio.PlaybackMode.LowPower;
        this.demoAudio.volume = 0.8;
        this.demoAudio.position = 0;
        this.demoAudio.play(-1);
      }
      SoundcraftBus.setDemoPlaying(true);
    } else {
      if (this.demoAudio !== null) {
        this.demoAudio.stop(true);
      }
      SoundcraftBus.setDemoPlaying(false);
    }
  }

  toggleDemo() {
    this.playDemo(!SoundcraftBus.demoPlaying);
    this.playUi();
  }

  clearTake() {
    // LOCAL view only: the bus take array + ticks. The controller, its session
    // and its saved documents are never touched from here.
    SoundcraftBus.clearTake();
    this.playUi();
    print("[Soundcraft] " + CLEAR_NOTE);
  }

  private playUi() {
    if (this.uiAudio !== null) {
      this.uiAudio.stop(false);
      this.uiAudio.position = 0;
      this.uiAudio.play(1);
    }
  }

  private onHit(info: HitInfo) {
    this.lightTick(info.time);
  }

  /** Light the tick for a hit inside the CURRENT 90 s view window (display only). */
  private lightTick(hitTimeSecs: number) {
    const idx = tickIndex(hitTimeSecs, this.barWindowStart, BAR_VIEW_SECS, this.ticks.length);
    if (idx >= 0 && this.ticks[idx] !== undefined) {
      this.ticks[idx].enabled = true;
    }
  }

  private refreshTicks() {
    for (let i = 0; i < this.ticks.length; i++) {
      this.ticks[i].enabled = false;
    }
    for (let i = 0; i < SoundcraftBus.take.length; i++) {
      this.lightTick(SoundcraftBus.take[i].time);
    }
  }

  private refreshDemoText(playing: boolean) {
    if (this.txtDemo !== null) {
      this.txtDemo.text = demoLabel(playing);
    }
    if (this.demoOnMat !== null && this.demoOffMat !== null) {
      const vis = visualOf(this.demoPad);
      if (vis !== null) {
        vis.mainMaterial = playing ? this.demoOnMat : this.demoOffMat;
      }
    }
  }

  /** Text refresh + the 4 Hz snapshot poll (pure getter; controller untouched). */
  private refreshTexts() {
    const snap = this.captureController !== null ? this.captureController.getStatusSnapshot() : null;
    const rows = backendRows(snap);
    if (this.txtSim !== null) {
      this.txtSim.text = rows.statusRow + "\n" + rows.playlistRow;
    }
    if (this.txtTake !== null) {
      this.txtTake.text = takeLine(SoundcraftBus.sessionTime, SoundcraftBus.take.length);
    }
  }

  private update() {
    this.time += getDeltaTime();

    // Rolling 90 s VIEW window on the bar. Pure display math: the session
    // clock keeps counting and the controller's capture timing is NEVER
    // capped or restricted by this bar.
    const now = SoundcraftBus.sessionTime;
    const winStart = barViewStart(now);
    if (winStart !== this.barWindowStart) {
      this.barWindowStart = winStart;
      this.refreshTicks(); // re-map hits into the new view window
    }
    if (this.barFill !== null) {
      const frac = barViewFrac(now);
      const w = Math.max(0.001, frac * BAR_WIDTH);
      this.barFill.getTransform().setLocalScale(new vec3(w, 1.5, 0.4));
      this.barFill.getTransform().setLocalPosition(new vec3(7.5 - BAR_WIDTH / 2 + w / 2, 0.9, 1.05));
    }

    // Throttled text refresh — 0.25 s = the 4 Hz getStatusSnapshot() poll.
    if (this.time >= this.nextTextRefresh) {
      this.nextTextRefresh = this.time + 0.25;
      this.refreshTexts();
    }
  }
}
