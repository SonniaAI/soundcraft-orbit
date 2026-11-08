// SoundcraftOpenConfirm.ts — PURE two-step confirmation decision for the
// guarded `explicitOpenLastSavedProject` affordance (SoundcraftConnectionUI).
//
// WHY THIS EXISTS: one SIK gesture can deliver DUPLICATE onTriggerUp callbacks
// from the same gesture/frame (observed in preview tooling: a single poke
// armed AND fired in one gesture). Opening the last saved project REPLACES
// the live document, so the confirmation guarantee must be robust against
// that: a fire is only ever accepted from a SECOND DISTINCT trigger that
// lands at least OPEN_CONFIRM_MIN_SEPARATION_MS after the arm timestamp and
// within OPEN_CONFIRM_WINDOW_MS of it. A duplicate (too-close) trigger is
// IGNORED entirely — it does not advance, does not re-arm, does not churn
// the visible armed state. An expired trigger NEVER fires — it re-arms a
// fresh confirmation window instead, so "two distinct taps" is preserved
// across lapses.
//
// PURE by design (no imports, no Lens types, no clock reads): the caller
// supplies the monotonic timestamps (getRealTimeNanos()/1e6 in the panel).
// Dependency-free inputs/outputs let the shipped function be loaded and
// exercised directly by Node (see tests/soundcraft-open-confirm.test.mjs) —
// the tested logic IS the shipped logic, not a re-implementation.

/** How long an armed confirmation stays valid (ms). */
export const OPEN_CONFIRM_WINDOW_MS = 8000

/** Minimum time between the arm trigger and a fire trigger (ms). Duplicate
 * onTriggerUp callbacks from one gesture/frame arrive at ~0 ms and are
 * always suppressed; a deliberate second tap is far beyond this. */
export const OPEN_CONFIRM_MIN_SEPARATION_MS = 300

/** Decision for a trigger arriving at `nowMs`:
 *  - "arm"   → no valid arm exists (or it expired): enter/refresh armed state.
 *              The controller is NOT called on this branch.
 *  - "ignore"→ duplicate/synthetic trigger: do NOTHING (no state change, no
 *              call). The armed state stays exactly as it is.
 *  - "fire"  → second DISTINCT trigger inside the window: disarm and call.
 */
export type OpenConfirmDecision = "arm" | "fire" | "ignore"

export function openConfirmDecision(
  armedAtMs: number | null,
  nowMs: number,
  windowMs: number = OPEN_CONFIRM_WINDOW_MS,
  minSeparationMs: number = OPEN_CONFIRM_MIN_SEPARATION_MS,
): OpenConfirmDecision {
  // No arm (or a corrupt/non-numeric one): this trigger becomes the arm.
  if (typeof armedAtMs !== "number" || Number.isNaN(armedAtMs)) {
    return "arm"
  }
  const deltaMs = nowMs - armedAtMs
  // Duplicate synthetic trigger from the same gesture/frame: never advances,
  // never fires. This is the destructive-action protection.
  if (deltaMs < minSeparationMs) {
    return "ignore"
  }
  // Outside the window: an expired arm can never fire — this tap instead
  // re-arms a fresh confirmation (two-distinct-taps invariant is preserved).
  if (deltaMs > windowMs) {
    return "arm"
  }
  // A distinct, deliberate second tap inside the window.
  return "fire"
}
