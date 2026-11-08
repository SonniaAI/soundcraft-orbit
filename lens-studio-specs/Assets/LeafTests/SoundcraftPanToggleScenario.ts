// SoundcraftPanToggleScenario.ts — LEAF smoke: real SIK trigger on
// BeatPanel/PanToggle must reverse the panel's pan-link state and flip the
// panel's pad audio between spatial (linked) and stereo-center (unlinked),
// then a second real trigger restores the original state.
//
// TEST-OWNED FILE (Assets/LeafTests). Production state is fully restored
// (panLinked back to its pre-test value via the same real trigger path; the
// AudioComponent spatial flags follow production code). Offline, preview-local;
// the only production side effect is the panel's own UiAudio toggle blip and
// the pan-link log lines — inherent to the real toggle path.
//
// Audio claim honesty: we assert the ACTUAL SpatialAudio state
// (spatialAudio.enabled / positionEffect / distanceEffect — verified in
// Support/StudioLib.d.ts), which is what applySpatial() writes. Audibility is
// NOT claimed.

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {SoundcraftBus, PadInstrumentLike, audioOf} from "../Scripts/SoundcraftBus"
import {SoundcraftLeafInteractor} from "./SoundcraftLeafInteractor"

@component
export class SoundcraftPanToggleScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500)

    const interactor = new SoundcraftLeafInteractor()

    // The beat panel registers itself on the bus in OnStartEvent.
    const beat = findInstrument("beat")
    if (beat === null) {
      throw new Error(
        'Precondition failed: no instrument of type "beat" on SoundcraftBus.instruments ' +
          '(PadInstrument registers during OnStartEvent)'
      )
    }

    // BeatPanel/Pad0 carries the editor-wired AudioComponent whose spatial
    // state production code flips with the pan link.
    const pad0 = interactor.childInteractable("BeatPanel", "Pad0").getSceneObject()
    const padAudio = audioOf(pad0)
    if (padAudio === null) {
      throw new Error('Precondition failed: BeatPanel/Pad0 has no AudioComponent')
    }

    // Delta-based baseline: whatever state earlier scenarios left behind.
    const linkedBefore = beat.panLinked

    // --- ACT 1: real SIK trigger on BeatPanel/PanToggle -> reverse ---
    await interactor.triggerPanelChild("BeatPanel", "PanToggle")
    await sleep(150)

    expect(beat.panLinked).toBe(!linkedBefore)

    // Actual audio state follows the link: spatial enabled exactly when
    // linked (applySpatial writes all three flags to the linked value).
    expect(padAudio.spatialAudio.enabled).toBe(beat.panLinked)
    expect(padAudio.spatialAudio.positionEffect.enabled).toBe(beat.panLinked)
    expect(padAudio.spatialAudio.distanceEffect.enabled).toBe(beat.panLinked)

    // --- ACT 2: real SIK trigger again -> restore ---
    await interactor.triggerPanelChild("BeatPanel", "PanToggle")
    await sleep(150)

    expect(beat.panLinked).toBe(linkedBefore)
    expect(padAudio.spatialAudio.enabled).toBe(beat.panLinked)
    expect(padAudio.spatialAudio.positionEffect.enabled).toBe(beat.panLinked)
    expect(padAudio.spatialAudio.distanceEffect.enabled).toBe(beat.panLinked)
  }
}

function findInstrument(type: string): PadInstrumentLike | null {
  for (let i = 0; i < SoundcraftBus.instruments.length; i++) {
    if (SoundcraftBus.instruments[i].instrumentType === type) {
      return SoundcraftBus.instruments[i]
    }
  }
  return null
}
