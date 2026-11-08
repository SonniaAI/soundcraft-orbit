// SoundcraftPinchBeatPadScenario.ts — LEAF smoke: real SIK pinch on
// BeatPanel/Pad0 must record exactly one take hit with correct identity,
// pulse the pad AND the orb, and actually start the pad's AudioComponent.
//
// TEST-OWNED FILE (Assets/LeafTests). Imports production modules read-only;
// restores every piece of state it touches (take trimmed back to baseline,
// the tick it relit is disabled again). Never touches ClearPad/DemoPad,
// capture, connection, or any network path — preview-local and offline-safe.
//
// Honesty rule: audibility is NOT claimed. The audio claim is exactly
// `AudioComponent.isPlaying() === true` observed while polling (query
// verified in Support/StudioLib.d.ts). If the one-shot ended before the
// first poll, the scenario FAILS loudly instead of asserting "should be
// audible".

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {findSceneObjectByName, nextFrame, sleep} from "Leaf.lspkg/Utils/common/Utils"
import {SoundcraftBus, HitInfo, audioOf, findChild} from "../Scripts/SoundcraftBus"
import {SoundcraftLeafInteractor} from "./SoundcraftLeafInteractor"

// Mirrors PlaylistPanel's session-bar math so the tick we disable is exactly
// the one our hit relit (cosmetic restore, preview only).
const SESSION_CAP = 90
const MAX_TICKS = 16

@component
export class SoundcraftPinchBeatPadScenario extends Scenario {
  async run(): Promise<void> {
    // PadInstrument/PlaylistPanel/PulseOrb register on the bus in OnStartEvent;
    // Interactables/colliders are runtime-ensured. Give the lens time to wire.
    await sleep(1500)

    const interactor = new SoundcraftLeafInteractor()

    // --- Locate verified scene objects (fail loud with names, never guess) ---
    const pad0Interactable = interactor.childInteractable("BeatPanel", "Pad0")
    const pad0 = pad0Interactable.getSceneObject()

    const playlistPanel = findSceneObjectByName("PlaylistPanel")
    if (playlistPanel === undefined) {
      throw new Error('Required scene object "PlaylistPanel" not found')
    }

    const orbRoot = findSceneObjectByName("PulseOrb")
    if (orbRoot === undefined) {
      throw new Error('Required scene object "PulseOrb" not found')
    }
    const orbCore = findChild(orbRoot, "OrbCore")

    // --- Precondition: pad audio wired in editor (KICK one-shot) ---
    const audio = audioOf(pad0)
    if (audio === null) {
      throw new Error(
        'Precondition failed: BeatPanel/Pad0 has no AudioComponent (expected editor-wired GeneratedSFX one-shot)'
      )
    }
    expect(audio.duration).toBeGreaterThan(0)

    // --- Baselines BEFORE interaction (relative assertions, shared lens state) ---
    const takeBefore = SoundcraftBus.take.length
    const padBaseScale = pad0.getTransform().getLocalScale()
    const orbBaseX =
      orbCore !== null ? orbCore.getTransform().getLocalScale().x : 0

    let captured: HitInfo | null = null
    const unsubscribe = SoundcraftBus.onHit.add((info: HitInfo) => {
      captured = info
    })

    // --- ACT: real SIK hover -> triggerStart -> triggerEnd on Pad0 ---
    try {
      // Trigger WITHOUT a settle sleep first: the pad pulse lasts only
      // 0.28 s from triggerStart, so polling must begin immediately after
      // the trigger completes (~0.1 s in, ~0.2 s of pulse remaining).
      await interactor.trigger(pad0Interactable)

      // 3) Pulsing + audio: poll pad/orb local scale for the pulse window
      //    (pad pulse 0.28s peak 1.3x, orb pulse 0.4s peak 1.42x; demo
      //    breathe on the orb is only 1.07x, so thresholds separate them).
      let maxPadRatio = 1.0
      let maxOrbRatio = 1.0
      let playingObserved = false
      const deadline = getTime() + 0.6 // seconds
      for (let i = 0; i < 60 && getTime() < deadline; i++) {
        const ps = pad0.getTransform().getLocalScale()
        maxPadRatio = Math.max(
          maxPadRatio,
          ps.x / padBaseScale.x,
          ps.y / padBaseScale.y,
        )
        if (orbCore !== null && orbBaseX > 0) {
          maxOrbRatio = Math.max(
            maxOrbRatio,
            orbCore.getTransform().getLocalScale().x / orbBaseX,
          )
        }
        if (audio.isPlaying()) {
          playingObserved = true
        }
        await nextFrame()
      }

      // 1) Take incremented by exactly one hit (recorded synchronously in
      // hitPad during triggerStart, so it is stable by now).
      expect(SoundcraftBus.take.length).toBe(takeBefore + 1)

      // 2) Identity: beat instrument, pad 0, label "KICK" (beat layout order).
      const last = SoundcraftBus.take[SoundcraftBus.take.length - 1]
      expect(last.instrument).toBe("beat")
      expect(last.pad).toBe(0)
      expect(last.label).toBe("KICK")
      expect(last.time).toBeGreaterThan(-1)

      // The bus event fired with the same identity (PulseOrb/PlaylistPanel
      // consume this same event).
      expect(captured).not.toBeNull()
      if (captured !== null) {
        expect(captured.instrument).toBe("beat")
        expect(captured.pad).toBe(0)
        expect(captured.label).toBe("KICK")
      }

      expect(maxPadRatio).toBeGreaterThan(1.1)
      expect(maxOrbRatio).toBeGreaterThan(1.2)
      // Pulse settles back to the authored base scale.
      const settled = pad0.getTransform().getLocalScale()
      expect(settled.x).toBeCloseTo(padBaseScale.x, 1)

      // 4) Audio actually playing (supported query; NOT an audibility claim).
      expect(playingObserved).toBeTruthy()
    } finally {
      // --- Restore (test-owned only; no production clear/stop calls) ---
      unsubscribe()
      // Trim exactly the hit(s) this scenario added; never wipe earlier takes.
      if (SoundcraftBus.take.length > takeBefore) {
        SoundcraftBus.take.length = takeBefore
      }
      // Disable the session-bar tick our hit relit (cosmetic, guarded).
      if (captured !== null && playlistPanel !== undefined) {
        const frac = Math.min(1, captured.time / SESSION_CAP)
        const idx = Math.min(MAX_TICKS - 1, Math.floor(frac * MAX_TICKS))
        const tick = findChild(playlistPanel, "Tick" + idx)
        if (tick !== null) {
          tick.enabled = false
        }
      }
    }
  }
}
