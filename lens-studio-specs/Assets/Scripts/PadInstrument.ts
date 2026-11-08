// PadInstrument.ts — one movable floating instrument panel (beat / bass / chord).
// Fresh original code for the SoundCraft Orbit SPECS Lens.
//
// The scene supplies: a root SceneObject named BeatPanel / BassPanel / ChordPanel
// whose first child is a BackPlate, plus pad children named Pad0..Pad3 (each with
// an editor-created AudioComponent wired to its GeneratedSFX one-shot), a
// PanToggle child, a UiAudio child, and optional TxtTitle / TxtSub text children.
// Layout, colliders, Interactables, and manipulation are set up here at runtime.

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import Event from "SpectaclesInteractionKit.lspkg/Utils/Event";
import {
  SoundcraftBus,
  PadInstrumentLike,
  ensureBoxCollider,
  ensureInteractable,
  ensurePanelManipulation,
  collectPads,
  findChild,
  audioOf,
  visualOf,
  textOf,
} from "./SoundcraftBus";

type PadLayout = {
  title: string;
  sub: string;
  plate: vec3; // backing plate size (cm)
  padSize: vec3; // pad box size (cm)
  positions: vec3[]; // pad local positions
  togglePos: vec3; // pan-link toggle local position
  baseColor: vec4;
  flashColor: vec4;
  padVolumes: number[];
};

// All values in cm (Lens Studio world units). Pad order here MUST match the
// editor AudioComponent wiring order (Pad0..Pad3 -> GeneratedSFX files below).
const LIB: { [key: string]: PadLayout } = {
  beat: {
    title: "BEAT PADS",
    sub: "KICK · SNARE · HAT · CLAP",
    plate: new vec3(21, 21, 1.2),
    padSize: new vec3(8, 8, 2.5),
    positions: [
      new vec3(-4.75, -4.75, 1.9),
      new vec3(4.75, -4.75, 1.9),
      new vec3(-4.75, 4.75, 1.9),
      new vec3(4.75, 4.75, 1.9),
    ],
    togglePos: new vec3(12.6, -6.5, 1.6),
    baseColor: new vec4(0.93, 0.28, 0.72, 1),
    flashColor: new vec4(1.0, 0.66, 0.95, 1),
    padVolumes: [1.0, 0.9, 0.75, 0.9],
  },
  bass: {
    title: "BASS",
    sub: "A1 · C2 · D2 · E2",
    plate: new vec3(11, 38, 1.2),
    padSize: new vec3(8, 8, 2.5),
    positions: [
      new vec3(0, -13.5, 1.9),
      new vec3(0, -4.5, 1.9),
      new vec3(0, 4.5, 1.9),
      new vec3(0, 13.5, 1.9),
    ],
    togglePos: new vec3(8.8, -16.2, 1.6),
    baseColor: new vec4(0.26, 0.78, 0.95, 1),
    flashColor: new vec4(0.72, 0.96, 1.0, 1),
    padVolumes: [0.95, 0.95, 0.95, 0.95],
  },
  chord: {
    title: "CHORDS",
    sub: "Cm · Bb · Ab · Eb",
    plate: new vec3(38, 11, 1.2),
    padSize: new vec3(8, 8, 2.5),
    positions: [
      new vec3(-14, 0, 2.2),
      new vec3(-4.7, 0, 0.3),
      new vec3(4.7, 0, 0.3),
      new vec3(14, 0, 2.2),
    ],
    togglePos: new vec3(21.4, -3.2, 1.6),
    baseColor: new vec4(0.64, 0.36, 0.98, 1),
    flashColor: new vec4(0.88, 0.72, 1.0, 1),
    padVolumes: [0.8, 0.8, 0.8, 0.8],
  },
};

@component
export class PadInstrument extends BaseScriptComponent {
  @input("string")
  @label("Instrument Type")
  @hint("beat | bass | chord — selects the pad layout and palette")
  instrumentType: string = "beat";

  panLinked = true;
  onPadHit: Event<{ instrument: string; pad: number }> = new Event<{ instrument: string; pad: number }>();

  private layout: PadLayout = null;
  private pads: SceneObject[] = [];
  private players: AudioComponent[] = [];
  private padMats: Material[] = [];
  private padBaseScales: vec3[] = [];
  private toggleMat: Material = null;
  private uiAudio: AudioComponent = null;

  onAwake() {
    // Explicit @input wins; otherwise derive from the panel's scene name so the
    // scene stays correct even before first TypeScript input wiring.
    let type = this.instrumentType;
    if (type === null || type === undefined || type === "" || type === "beat") {
      const n = this.sceneObject.name;
      if (n === "BassPanel") {
        type = "bass";
      } else if (n === "ChordPanel") {
        type = "chord";
      } else if (n === "BeatPanel") {
        type = "beat";
      }
    }
    // Identity fix: WRITE the derived type back — the scene authors every
    // panel's input as the default "beat", so without this assignment the bus
    // records bass/chord hits as "beat" (wrong surface ids and wrong keys).
    this.instrumentType = type;
    this.layout = LIB[type] !== undefined ? LIB[type] : LIB.beat;
    this.pads = collectPads(this.sceneObject);

    // Runtime layout from the definition table (pads are authored at origin).
    for (let i = 0; i < this.pads.length && i < this.layout.positions.length; i++) {
      this.pads[i].getTransform().setLocalPosition(this.layout.positions[i]);
      this.pads[i].getTransform().setLocalScale(this.layout.padSize);
    }

    // Panel root: backing-plate collider + Interactable + grab-and-move.
    // Grabbing the plate moves the whole panel; tapping a pad plays it.
    ensureBoxCollider(this.sceneObject, this.layout.plate);
    ensureInteractable(this.sceneObject);
    const man = ensurePanelManipulation(this.sceneObject);
    this.createEvent("OnStartEvent").bind(() => {
      man.onManipulationStart.add(() => {
        print("[Soundcraft] " + this.instrumentType + " panel grabbed");
      });
    });

    // Pan-link toggle pad (side box).
    const toggle = findChild(this.sceneObject, "PanToggle");
    if (toggle !== null) {
      toggle.getTransform().setLocalPosition(this.layout.togglePos);
      toggle.getTransform().setLocalScale(new vec3(3.5, 3.5, 2));
      // Unit-local box: the toggle's (3.5,3.5,2) scale maps (1,1,1) onto its
      // visual size (× panel root scale, e.g. 0.66 → 2.31 world on bass/chord).
      ensureBoxCollider(toggle, new vec3(1, 1, 1));
      const tInter = ensureInteractable(toggle);
      const tVis = visualOf(toggle);
      if (tVis !== null && tVis.mainMaterial !== null) {
        this.toggleMat = tVis.mainMaterial;
      }
      this.createEvent("OnStartEvent").bind(() => {
        tInter.onTriggerStart.add(() => {
          this.togglePanLink();
        });
      });
    }

    // Per-pad collider + Interactable + material clone for independent flashes.
    for (let i = 0; i < this.pads.length; i++) {
      const pad = this.pads[i];
      // Unit-local box: pads are unit SCBox meshes scaled to padSize (e.g.
      // (8,8,2.5); × 0.66 root scale → 5.28 world on bass/chord), so a (1,1,1)
      // shape tracks the visual — and the pulse (×1.3) — exactly. Never pass
      // padSize here: with a local-size shape that would double-apply.
      ensureBoxCollider(pad, new vec3(1, 1, 1));
      const inter = ensureInteractable(pad);
      const vis = visualOf(pad);
      if (vis !== null && vis.mainMaterial !== null) {
        const mat = vis.mainMaterial.clone();
        vis.mainMaterial = mat;
        this.padMats.push(mat);
      } else {
        this.padMats.push(null);
      }
      this.padBaseScales.push(pad.getTransform().getLocalScale());
      this.players.push(audioOf(pad));

      const idx = i;
      this.createEvent("OnStartEvent").bind(() => {
        // Recipe §1: SIK event subscriptions belong inside OnStartEvent.
        inter.onTriggerStart.add(() => {
          this.hitPad(idx);
        });
        inter.onHoverEnter.add(() => {
          this.setPadColor(idx, this.layout.flashColor);
        });
        inter.onHoverExit.add(() => {
          this.setPadColor(idx, this.layout.baseColor);
        });
      });
    }

    // Panel-level UI feedback audio (editor-wired ui_toggle.wav, LowLatency).
    this.uiAudio = audioOf(findChild(this.sceneObject, "UiAudio"));

    // Panel label texts (editor-created preset text objects).
    const title = textOf(findChild(this.sceneObject, "TxtTitle"));
    if (title !== null) {
      title.text = this.layout.title;
    }
    const sub = textOf(findChild(this.sceneObject, "TxtSub"));
    if (sub !== null) {
      sub.text = this.layout.sub + "  ·  side toggle = pan link";
    }

    this.createEvent("OnStartEvent").bind(() => {
      this.registerPanelAudio();
    });
    this.createEvent("UpdateEvent").bind(() => this.update());
  }

  private registerPanelAudio() {
    // Property writes belong in OnStartEvent (Specs lifecycle rule).
    for (let i = 0; i < this.players.length; i++) {
      const a = this.players[i];
      if (a === null) {
        continue;
      }
      a.playbackMode = Audio.PlaybackMode.LowLatency;
      a.volume = this.layout.padVolumes[i];
      this.applySpatial(a, this.panLinked);
    }
    if (this.uiAudio !== null) {
      this.uiAudio.playbackMode = Audio.PlaybackMode.LowLatency;
      this.uiAudio.volume = 0.6;
    }
    SoundcraftBus.instruments.push(this);
    this.applyToggleVisual();
  }

  /** Single code path for pad hits — used by pinch AND labeled editor test keys. */
  hitPad(index: number) {
    if (index < 0 || index >= this.pads.length) {
      return;
    }
    const a = this.players[index];
    if (a !== null) {
      a.stop(false);
      a.position = 0;
      a.play(1);
    }
    this.pulsePad(index);
    SoundcraftBus.recordHit(this.instrumentType, index, this.padLabel(index));
    this.onPadHit.invoke({ instrument: this.instrumentType, pad: index });
  }

  togglePanLink() {
    this.panLinked = !this.panLinked;
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i] !== null) {
        this.applySpatial(this.players[i], this.panLinked);
      }
    }
    if (this.uiAudio !== null) {
      this.uiAudio.stop(false);
      this.uiAudio.position = 0;
      this.uiAudio.play(1);
    }
    this.applyToggleVisual();
    print(
      "[Soundcraft] " +
        this.instrumentType +
        " pan link " +
        (this.panLinked ? "ON (sound follows panel position)" : "OFF (fixed stereo center)")
    );
  }

  private applySpatial(a: AudioComponent, linked: boolean) {
    // Spatial audio makes the sound source sit at the pad's world position:
    // moving the panel moves the pan/position of the sound. Disabling the link
    // plays everything from stereo center.
    a.spatialAudio.enabled = linked;
    a.spatialAudio.positionEffect.enabled = linked;
    a.spatialAudio.distanceEffect.enabled = linked;
  }

  private applyToggleVisual() {
    if (this.toggleMat !== null) {
      this.toggleMat.mainPass.baseColor = this.panLinked
        ? new vec4(0.35, 1.0, 0.85, 1)
        : new vec4(0.45, 0.4, 0.55, 1);
    }
  }

  private padLabel(index: number): string {
    const words = this.layout.sub.split("·");
    return index < words.length ? words[index].trim() : this.instrumentType + " " + index;
  }

  private pulsePad(index: number) {
    const pad = this.pads[index];
    const base = this.padBaseScales[index];
    animate({
      duration: 0.28,
      easing: "ease-out-quad",
      update: (t: number) => {
        const s = 1 + 0.3 * Math.sin(Math.PI * t);
        pad.getTransform().setLocalScale(new vec3(base.x * s, base.y * s, base.z * s));
        if (this.padMats[index] !== null) {
          this.padMats[index].mainPass.baseColor = this.lerpColor(
            this.layout.flashColor,
            this.layout.baseColor,
            t * t
          );
        }
      },
      ended: () => {
        pad.getTransform().setLocalScale(base);
        if (this.padMats[index] !== null) {
          this.padMats[index].mainPass.baseColor = this.layout.baseColor;
        }
      },
    });
  }

  private setPadColor(index: number, color: vec4) {
    if (this.padMats[index] !== null) {
      this.padMats[index].mainPass.baseColor = color;
    }
  }

  private lerpColor(a: vec4, b: vec4, t: number): vec4 {
    return new vec4(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
      a.w + (b.w - a.w) * t
    );
  }

  private update() {
    getDeltaTime(); // keep the frame delta consumed for future timing needs
  }
}
