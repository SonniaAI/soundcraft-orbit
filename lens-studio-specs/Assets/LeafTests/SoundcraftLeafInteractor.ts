// SoundcraftLeafInteractor.ts — LEAF interactor for the SoundCraft Orbit Lens.
// TEST-OWNED FILE (Assets/LeafTests). Does not modify any production script.
//
// Drives the REAL SIK interaction pipeline: DefaultLeafInteractor hosts a
// DefaultSikInteractor component, and every trigger/drag runs the production
// hover -> onTriggerStart -> onTriggerEnd / onDragStart -> onDragEnd event
// path on the target Interactable — the same handlers a hand pinch drives.
// No direct hitPad()/togglePanLink() bypasses are used for the behaviors
// under test.
//
// Names here are verified against the live scene hierarchy (read-only
// serialize): BeatPanel/BassPanel/ChordPanel, Pad0..Pad3, PanToggle all sit
// as direct children of their panel root under the world root
// "SoundcraftRoot". Pad0/PanToggle exist under all three panels, so every
// lookup below disambiguates by PARENT panel name.

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import {
  findInteractables,
  findInteractableByName,
  matchInteractableName,
} from "Leaf.lspkg/Interactors/InteractableUtils"
import {matchSceneObjectParentName, sleep} from "Leaf.lspkg/Utils/common/Utils"

export class SoundcraftLeafInteractor extends DefaultLeafInteractor {
  constructor() {
    super("SoundcraftLeafInteractor")
  }

  /**
   * Interactable on a direct child (`childName`) of panel `panelName`,
   * e.g. ("BeatPanel", "Pad0") or ("BeatPanel", "PanToggle"). Disambiguates
   * the duplicated Pad / PanToggle names across the three panels by parent.
   */
  childInteractable(panelName: string, childName: string): Interactable {
    const matches = findInteractables(
      (sceneObject) => {
        const it = matchInteractableName(childName, true)(sceneObject)
        if (it === undefined) {
          return undefined
        }
        return matchSceneObjectParentName(panelName)(sceneObject) !== undefined
          ? it
          : undefined
      },
      undefined,
      true,
    )
    if (matches.length === 0) {
      throw new Error(
        `[SoundcraftLeafInteractor] No enabled Interactable on "${childName}" with parent "${panelName}". ` +
          "Confirm the panel script ran (Interactables are runtime-ensured by PadInstrument/PlaylistPanel)."
      )
    }
    return matches[0]
  }

  /**
   * Interactable on a panel ROOT (grab-and-move target). Requires a runtime
   * collider — a collider-less interactable can never be hovered/dragged.
   */
  panelInteractable(panelName: string): Interactable {
    const it = findInteractableByName(panelName, undefined, true)
    if (it === undefined) {
      throw new Error(
        `[SoundcraftLeafInteractor] No enabled Interactable on panel root "${panelName}".`
      )
    }
    if (it.colliders.length === 0) {
      throw new Error(
        `[SoundcraftLeafInteractor] "${panelName}" Interactable has no colliders; drag would never converge.`
      )
    }
    return it
  }

  /** Real SIK trigger on a pad (parent-disambiguated), then settle. */
  async triggerPad(panelName: string, padName: string): Promise<void> {
    const it = this.childInteractable(panelName, padName)
    await this.trigger(it)
    await sleep(200)
  }

  /** Real SIK trigger on a panel child such as PanToggle, then settle. */
  async triggerPanelChild(panelName: string, childName: string): Promise<void> {
    const it = this.childInteractable(panelName, childName)
    await this.trigger(it)
    await sleep(200)
  }

  /** Real SIK drag on a panel root (grab-and-move), then settle. */
  async dragPanel(
    panelName: string,
    dragVector: vec3,
    durationMs: number,
  ): Promise<void> {
    const it = this.panelInteractable(panelName)
    await this.drag(it, dragVector, durationMs)
    await sleep(200)
  }
}
