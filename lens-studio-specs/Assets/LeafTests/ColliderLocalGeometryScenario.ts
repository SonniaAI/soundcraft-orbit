// ColliderLocalGeometryScenario.ts — pure geometry contract test for
// ensureBoxCollider (SoundcraftBus). No production objects, state, audio,
// UI, or interactions are touched: the scenario builds its own scratch
// scene objects, asserts the contract, then destroys them.
//
// TEST-OWNED FILE (Assets/LeafTests).
//
// WHY THIS FILE WAS REWRITTEN (v2 — failed run 17:31, "Expected 16 /
// Received 29.49251365661621"): v1 asserted componentwise world-scale
// products under a ROTATED NON-UNIFORM hierarchy. Two defects, both
// test-owned (the production local-shape fix was correct):
//  1. FATAL: v1 captured `box = col.shape` from the FIRST ensureBoxCollider
//     call and read it again (line "box.size.x * ws.x") AFTER a later
//     ensureBoxCollider call had assigned a NEW Shape to the component.
//     The old Shape is detached; reading `.size` through its stale wrapper
//     is undefined behavior (freed/reused native memory) and returned
//     garbage 1.8432821035385133 — × ws.x 16 = 29.49251365661621.
//     Proof this is NOT world-scale affine math: exhaustive numeric search
//     over every standard SDK decomposition (column lengths, row lengths,
//     sqrt-diag(MᵀM), sqrt-diag(MMᵀ), SVD sorted, |diag|, eigen-projection,
//     Cholesky) of BOTH candidate world matrices — Ry(90)·diag(2,3,4)·
//     Ry(90)·diag(8,8,2.5) = diag(−32,24,−5) → any decomposition gives
//     (32,24,5); with Rz(30): (18.330, 22.271, 10) / SVD (24,16,10) —
//     yields NO 29.4925. And LEAF fail-fast means the componentwise
//     world-scale asserts (16/24/10) had PASSED before the product line ran.
//  2. CONTRACT SPLIT (maintainer direction): componentwise world-scale
//     equality is only asserted in the UNROTATED chain case. The rotated
//     non-uniform case is asserted on LOCAL shape invariance + world CORNERS
//     via the verified mat4 API against an independent per-level TRS
//     composition — never via world-scale products (affine composition of
//     rotated non-uniform scales is basis-dependent; getWorldScale() is
//     documented lossy under rotated parents).
//
// Contract under test:
//  1. `size` is stored VERBATIM on the BoxShape (explicit LOCAL geometry —
//     the helper performs no arithmetic, so no division/zero-scale/NaN path
//     exists). Root-plate pattern: (11,38,1.2) stays local under a scaled +
//     rotated root (NOT divided — dividing would put an 11×38 WORLD collider
//     on a 0.66-scaled panel). Scale-as-size pattern: (1,1,1) on unit-mesh
//     visuals so the object's own transform maps 1:1 onto the visual.
//  2. fitVisual is false AFTER the call — including after an external
//     fitVisual=true (the SDK resets fitVisual to true on every shape
//     assignment; the post-assignment set must win).
//  3. The helper REUSES an existing ColliderComponent (no duplicates).
//  4. UNROTATED scale chain: getWorldScale() is exactly the componentwise
//     chain product — root (2,3,4) × pad (8,8,2.5) = (16,24,10). This is the
//     production contract that puts bass/chord pads at 5.28 = 8 × 0.66.
//  5. ROTATED non-uniform chain: the unit LOCAL shape is unchanged by
//     rotation, and the SDK's world corners
//     (getWorldTransform().multiplyPoint, verified public API) equal an
//     independent per-level composition computed by THIS test with plain
//     multiply-add plus the SDK's own quat.rotate primitive per level:
//     corner_world = T_root + R_root·(S_root ∘ (T_pad + R_pad·(S_pad ∘ c)))
//     — composition ORDER is owned by the test; no world-scale read at all.
//  6. Every asserted number is checked finite (isNaN falsy).

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {ensureBoxCollider} from "../Scripts/SoundcraftBus"

/** Componentwise product of two vec3 fields (multiply only). */
function scale3(v: vec3, s: vec3): vec3 {
  return new vec3(v.x * s.x, v.y * s.y, v.z * s.z)
}

/** Independent per-level TRS composition of a local point to world space.
 *  Uses only the SDK's quat.rotate primitive (multiplyVec3) for the two
 *  per-level rotations; scales and translations are this test's own
 *  multiply-add. Order mirrors TRS composition: R after S, parent after
 *  child. Returns [x, y, z] so every component can be asserted finite. */
function composePoint(
  rootPos: vec3, qRoot: quat, rootScale: vec3,
  padPos: vec3, qPad: quat, padScale: vec3,
  local: vec3,
): number[] {
  const s1 = scale3(local, padScale)          // S_pad ∘ c
  const r1 = qPad.multiplyVec3(s1)            // R_pad · (S_pad ∘ c)
  const t1 = padPos.add(r1)                   // T_pad + ...
  const s2 = scale3(t1, rootScale)            // S_root ∘ ...
  const r2 = qRoot.multiplyVec3(s2)           // R_root · ...
  const w = rootPos.add(r2)                   // T_root + ...
  return [w.x, w.y, w.z]
}

function assertVec3Finite(tag: string, v: vec3): void {
  expect(isNaN(v.x)).toBeFalsy() // tag: + ".x"
  expect(isNaN(v.y)).toBeFalsy()
  expect(isNaN(v.z)).toBeFalsy()
}

@component
export class ColliderLocalGeometryScenario extends Scenario {
  async run(): Promise<void> {
    // ─── Case A: UNROTATED scale chain (clear componentwise contract) ────
    const rootA = global.scene.createSceneObject("LGT_RootA")
    rootA.getTransform().setLocalPosition(new vec3(5, -1, 2))
    rootA.getTransform().setLocalScale(new vec3(2, 3, 4))
    const padA = global.scene.createSceneObject("LGT_PadA")
    padA.setParent(rootA)
    padA.getTransform().setLocalPosition(new vec3(1, -2, 0.5))
    padA.getTransform().setLocalScale(new vec3(8, 8, 2.5))

    // ─── Case B: ROTATED NON-UNIFORM chain (corner-composition contract) ─
    const rootB = global.scene.createSceneObject("LGT_RootB")
    rootB.getTransform().setLocalPosition(new vec3(5, -1, 2))
    rootB.getTransform().setLocalScale(new vec3(2, 3, 4))
    rootB.getTransform().setLocalRotation(quat.fromEulerAngles(0, 90, 0))
    const padB = global.scene.createSceneObject("LGT_PadB")
    padB.setParent(rootB)
    padB.getTransform().setLocalPosition(new vec3(1, -2, 0.5))
    padB.getTransform().setLocalScale(new vec3(8, 8, 2.5))
    padB.getTransform().setLocalRotation(quat.fromEulerAngles(0, 0, 30))

    try {
      // ══ Case A: unit box + componentwise world scale ═══════════════════
      const colA = ensureBoxCollider(padA, new vec3(1, 1, 1))
      const boxA = colA.shape as BoxShape // fresh — no later re-ensure on padA
      expect(boxA.size.x).toBeCloseTo(1, 5)
      expect(boxA.size.y).toBeCloseTo(1, 5)
      expect(boxA.size.z).toBeCloseTo(1, 5)
      assertVec3Finite("boxA.size", boxA.size)
      expect(colA.fitVisual).toBe(false)

      // Root-plate pattern stays LOCAL under a scaled root (Case A root):
      const rootColA = ensureBoxCollider(rootA, new vec3(11, 38, 1.2))
      const rootBoxA = rootColA.shape as BoxShape
      expect(rootBoxA.size.x).toBeCloseTo(11, 5)
      expect(rootBoxA.size.y).toBeCloseTo(38, 5)
      expect(rootBoxA.size.z).toBeCloseTo(1.2, 5)
      expect(rootColA.fitVisual).toBe(false)

      // The clear componentwise contract — NO rotations in this chain, so
      // getWorldScale() must equal the chain product exactly:
      // (2,3,4) × (8,8,2.5) = (16,24,10). Production analogue: BassPanel
      // 0.66 × pad 8 = 5.28 world within 5.94 cm key spacing.
      const wsA = padA.getTransform().getWorldScale()
      expect(wsA.x).toBeCloseTo(16, 3)
      expect(wsA.y).toBeCloseTo(24, 3)
      expect(wsA.z).toBeCloseTo(10, 3)
      assertVec3Finite("wsA", wsA)

      // Unit box corners under the unrotated chain: SDK mat4 vs independent
      // composition (both must agree; 8 corners of ±0.5).
      const qI = quat.fromEulerAngles(0, 0, 0)
      const worldA = padA.getTransform().getWorldTransform()
      for (let i = 0; i < 8; i++) {
        const c = new vec3(
          i % 2 === 0 ? -0.5 : 0.5,
          i % 4 < 2 ? -0.5 : 0.5,
          i < 4 ? -0.5 : 0.5,
        )
        const actual = worldA.multiplyPoint(c)
        assertVec3Finite("cornerA" + i, actual)
        const exp = composePoint(
          rootA.getTransform().getLocalPosition(),
          qI, rootA.getTransform().getLocalScale(),
          padA.getTransform().getLocalPosition(),
          qI, padA.getTransform().getLocalScale(),
          c,
        )
        expect(actual.x).toBeCloseTo(exp[0], 3)
        expect(actual.y).toBeCloseTo(exp[1], 3)
        expect(actual.z).toBeCloseTo(exp[2], 3)
      }

      // ══ Case B: rotated non-uniform — LOCAL contract only ══════════════
      const colB = ensureBoxCollider(padB, new vec3(1, 1, 1))
      expect((colB.shape as BoxShape).size.x).toBeCloseTo(1, 5)
      expect((colB.shape as BoxShape).size.y).toBeCloseTo(1, 5)
      expect((colB.shape as BoxShape).size.z).toBeCloseTo(1, 5)
      expect(colB.fitVisual).toBe(false)

      // fitVisual reset wins over BOTH the SDK shape-assignment reset and an
      // external write; the component is REUSED, and its CURRENT shape (never
      // a reference captured before a re-ensure) carries the contract.
      colB.fitVisual = true
      const colB2 = ensureBoxCollider(padB, new vec3(1, 1, 1))
      expect(colB2).toBe(colB)
      expect(colB2.fitVisual).toBe(false)
      expect((colB2.shape as BoxShape).size.x).toBeCloseTo(1, 5)
      expect((colB2.shape as BoxShape).size.y).toBeCloseTo(1, 5)
      expect((colB2.shape as BoxShape).size.z).toBeCloseTo(1, 5)

      // Root-plate pattern on the SCALED + ROTATED root stays LOCAL:
      const rootColB = ensureBoxCollider(rootB, new vec3(11, 38, 1.2))
      const rootBoxB = rootColB.shape as BoxShape
      expect(rootBoxB.size.x).toBeCloseTo(11, 5)
      expect(rootBoxB.size.y).toBeCloseTo(38, 5)
      expect(rootBoxB.size.z).toBeCloseTo(1.2, 5)
      expect(rootColB.fitVisual).toBe(false)

      // Rotation invariance of the LOCAL size: change the pad's rotation and
      // re-ensure — the shape components must not mix axes (shape space is
      // object-local; the transform maps it to world).
      padB.getTransform().setLocalRotation(quat.fromEulerAngles(0, 90, 0))
      const colBRot = ensureBoxCollider(padB, new vec3(1, 1, 1))
      const rotBox = colBRot.shape as BoxShape // fetched fresh, never stale
      expect(rotBox.size.x).toBeCloseTo(1, 5)
      expect(rotBox.size.y).toBeCloseTo(1, 5)
      expect(rotBox.size.z).toBeCloseTo(1, 5)
      assertVec3Finite("rotBox.size", rotBox.size)

      // Corner contract under rotation: SDK world corners must equal the
      // independent per-level composition of the CURRENT rotation state.
      // NO world-scale component assertions here — under rotated non-uniform
      // parents the affine basis changes and getWorldScale() is lossy.
      const expRootPos = rootB.getTransform().getLocalPosition()
      const expRootScale = rootB.getTransform().getLocalScale()
      const expRootRot = rootB.getTransform().getLocalRotation()
      const expPadPos = padB.getTransform().getLocalPosition()
      const expPadScale = padB.getTransform().getLocalScale()
      const expPadRot = padB.getTransform().getLocalRotation()
      const worldB = padB.getTransform().getWorldTransform()
      for (let i = 0; i < 8; i++) {
        const c = new vec3(
          i % 2 === 0 ? -0.5 : 0.5,
          i % 4 < 2 ? -0.5 : 0.5,
          i < 4 ? -0.5 : 0.5,
        )
        const actual = worldB.multiplyPoint(c)
        assertVec3Finite("cornerB" + i, actual)
        const exp = composePoint(
          expRootPos, expRootRot, expRootScale,
          expPadPos, expPadRot, expPadScale,
          c,
        )
        expect(actual.x).toBeCloseTo(exp[0], 3)
        expect(actual.y).toBeCloseTo(exp[1], 3)
        expect(actual.z).toBeCloseTo(exp[2], 3)
      }

      // The plate on the rotated root: same corner discipline (root-only
      // composition; plate local corners ±(5.5, 19, 0.6)).
      const rootWorldB = rootB.getTransform().getWorldTransform()
      for (let i = 0; i < 8; i++) {
        const c = new vec3(
          i % 2 === 0 ? -5.5 : 5.5,
          i % 4 < 2 ? -19 : 19,
          i < 4 ? -0.6 : 0.6,
        )
        const actual = rootWorldB.multiplyPoint(c)
        assertVec3Finite("rootCornerB" + i, actual)
        const v1 = qRootRotate(expRootRot, scale3(c, expRootScale))
        const exp = expRootPos.add(v1)
        expect(actual.x).toBeCloseTo(exp.x, 3)
        expect(actual.y).toBeCloseTo(exp.y, 3)
        expect(actual.z).toBeCloseTo(exp.z, 3)
      }
    } finally {
      // Cleanup: destroy the scratch roots (children die with them).
      // Production scene objects are never referenced by this scenario.
      rootA.destroy()
      rootB.destroy()
    }
  }
}

/** SDK-verified rotation primitive (quat.multiplyVec3), kept as a tiny
 *  helper so the composition above reads as the TRS contract it is. */
function qRootRotate(q: quat, v: vec3): vec3 {
  return q.multiplyVec3(v)
}
