// DawManager.ts — session clock, demo autostart, and EDITOR-ONLY test keys.
// Fresh original code for the SoundCraft Orbit SPECS Lens.
//
// The test keys drive the exact same hitPad()/playDemo() code path as pinch.
// They are labelled on the playlist panel as "TEST KEYS (editor only)" and are
// disabled on device. No simulated voice or hand-tracking: those features are
// simply not built in this prototype (nothing is faked).

import { SoundcraftBus } from "./SoundcraftBus";

@component
export class DawManager extends BaseScriptComponent {
  private started = false;

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.start());
    this.createEvent("UpdateEvent").bind(() => this.update());
  }

  private start() {
    SoundcraftBus.resetSession();
    SoundcraftBus.demoBpm = 70; // matches Assets/GeneratedSFX/demo_vapor.wav

    // "Play first": the bundled demo loop starts on launch. PlaylistPanel
    // self-registers its audio; we just ask it to roll.
    // (Kept dependency-free: instruments/panels/orb register on the bus.)
    const isDevice = global.scene.getCameraType() === "runtime";
    print(
      "[Soundcraft] mini-DAW starting (" +
        (isDevice ? "device" : "editor preview") +
        ") — 3 floating instruments in arm's reach, demo loop on."
    );
    if (!isDevice) {
      print("[Soundcraft] TEST KEYS (editor only): 1-4 beat · QWER bass · ASDF chords · SPACE demo · P pan link");
      this.createEvent("KeyPressEvent").bind((ev: KeyPressEvent) => this.onKey(ev.key));
    }
  }

  private update() {
    SoundcraftBus.tick(getDeltaTime());

    // One-frame-late autostart: PlaylistPanel has finished its own OnStartEvent
    // by the second frame, so playDemo reaches a fully wired audio component.
    if (!this.started && getTime() > 0.1) {
      this.started = true;
      const playlist = SoundcraftBus.playlist;
      if (playlist !== null) {
        playlist.playDemo(true);
        print("[Soundcraft] demo 'VAPOR SUNSET' rolling (bundled generated loop)");
      }
    }
  }

  /** Editor-only keyboard mirror of the pinch interactions. */
  private onKey(key: Keys) {
    const find = (type: string) => {
      for (let i = 0; i < SoundcraftBus.instruments.length; i++) {
        if (SoundcraftBus.instruments[i].instrumentType === type) {
          return SoundcraftBus.instruments[i];
        }
      }
      return null;
    };

    const beat = find("beat");
    const bass = find("bass");
    const chord = find("chord");

    switch (key) {
      case Keys.One:
        if (beat !== null) beat.hitPad(0);
        break;
      case Keys.Two:
        if (beat !== null) beat.hitPad(1);
        break;
      case Keys.Three:
        if (beat !== null) beat.hitPad(2);
        break;
      case Keys.Four:
        if (beat !== null) beat.hitPad(3);
        break;
      case Keys.Q:
        if (bass !== null) bass.hitPad(0);
        break;
      case Keys.W:
        if (bass !== null) bass.hitPad(1);
        break;
      case Keys.E:
        if (bass !== null) bass.hitPad(2);
        break;
      case Keys.R:
        if (bass !== null) bass.hitPad(3);
        break;
      case Keys.A:
        if (chord !== null) chord.hitPad(0);
        break;
      case Keys.S:
        if (chord !== null) chord.hitPad(1);
        break;
      case Keys.D:
        if (chord !== null) chord.hitPad(2);
        break;
      case Keys.F:
        if (chord !== null) chord.hitPad(3);
        break;
      case Keys.Space:
        if (SoundcraftBus.playlist !== null) SoundcraftBus.playlist.toggleDemo();
        break;
      case Keys.P:
        for (let i = 0; i < SoundcraftBus.instruments.length; i++) {
          SoundcraftBus.instruments[i].togglePanLink();
        }
        break;
      default:
        break;
    }
  }
}
