// SoundcraftDragPanelScenario.ts — LEAF smoke: real SIK grab-and-drag of the
// BeatPanel root must change its WORLD transform, and the panel must be a
// child of the static world root (SoundcraftRoot), NOT of the camera/head —
// proving panels are world-fixed. The test then restores the panel using its
// own transform writes only (test-owned move), and asserts the restore.
//
// TEST-OWNED FILE (Assets/LeafTests). No production code touched; the panel
// transform is fully restored in a finally block even on failure. Offline and
// preview-local: no audio, no take changes, no capture paths.
//
// Scene facts verified by read-only serialize: "BeatPanel" parent is
// "SoundcraftRoot"; the camera lives on the separate root "Camera Object".

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {hasAncestorWithName, sleep} from "Leaf.lspkg/Utils/common/Utils"
import {SoundcraftLeafInteractor} from "./SoundcraftLeafInteractor"

@component
export class SoundcraftDragPanelScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500)

    const interactor = new SoundcraftLeafInteractor()

    // Real SIK drag needs a collider-backed panel interactable; the
    // interactor helper throws with a named error if grab was never ensured.
    const panelInteractable = interactor.panelInteractable("BeatPanel")
    const panel = panelInteractable.getSceneObject()

    const parent = panel.getParent()
    if (parent === null) {
      throw new Error('"BeatPanel" has no parent; expected world root "SoundcraftRoot"')
    }

    // --- World-fixed, not head-parented: structural proof ---
    expect(parent.name).toBe("SoundcraftRoot")
    expect(hasAncestorWithName(panel, "Camera Object", true)).toBe(false)
    expect(hasAncestorWithName(panel, "Camera", false)).toBe(false)

    const parentStartPos = parent.getTransform().getWorldPosition()
    const panelStartPos = panel.getTransform().getWorldPosition()
    const panelStartRot = panel.getTransform().getWorldRotation()

    try {
      // --- ACT: real SIK drag (hover -> onDragStart -> trigger updates -> onDragEnd).
      // SIK InteractableManipulation translates the panel along the drag.
      await interactor.dragPanel("BeatPanel", new vec3(8, 5, 0), 800)
      await sleep(200)

      const movedPos = panel.getTransform().getWorldPosition()

      // World transform actually changed (target delta 8,5,0; assert > 1 cm
      // so the check is about "moved", not about manipulation math).
      expect(panelStartPos.distance(movedPos)).toBeGreaterThan(1.0)

      // The PARENT did not move with it: panel moved relative to a static
      // world parent (i.e. it is world-anchored, not carried by a moving
      // rig). Also guards the panel silently having been re-parented.
      expect(parent.name).toBe("SoundcraftRoot")
      expect(
        parentStartPos.distance(parent.getTransform().getWorldPosition()),
      ).toBeCloseTo(0, 1)
      expect(panel.getParent()).toBe(parent)

      // --- Restore: TEST-OWNED transform writes only (no re-drag gamble) ---
    } finally {
      panel.getTransform().setWorldPosition(panelStartPos)
      panel.getTransform().setWorldRotation(panelStartRot)
      await sleep(200)

      const restoredPos = panel.getTransform().getWorldPosition()
      const restoredRot = panel.getTransform().getWorldRotation()
      expect(restoredPos.distance(panelStartPos)).toBeCloseTo(0, 1)
      expect(restoredRot.x).toBeCloseTo(panelStartRot.x, 1)
      expect(restoredRot.y).toBeCloseTo(panelStartRot.y, 1)
      expect(restoredRot.z).toBeCloseTo(panelStartRot.z, 1)
      expect(restoredRot.w).toBeCloseTo(panelStartRot.w, 1)
      // Still parented to the world root after everything.
      const restoredParent = panel.getParent()
      expect(
        restoredParent !== null && restoredParent.name === "SoundcraftRoot",
      ).toBeTruthy()
    }
  }
}
