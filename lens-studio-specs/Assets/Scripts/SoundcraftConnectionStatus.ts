// SoundcraftConnectionStatus.ts — PURE phase → UI-label mapping for
// SoundcraftConnectionUI.ts. NEW file owned by the connection-UI work stream:
// nothing here edits the controller, client, transport, or owned prototype.
//
// HONESTY CONTRACT (same rules as the client's phase machine):
//  * Labels are derived ONLY from the client's CompanionPhase — the UI never
//    guesses a phase, and every phase maps to exactly one label.
//  * "saved_confirmed" is the ONLY phase whose label says SAVED, and even that
//    label says "(RECEIPT)" — a saved badge is shown ONLY for an exact
//    `saved` receipt, never inferred from a listing or a commit alone.
//  * Unsynced counters are relayed verbatim with their UNITS intact —
//    uncapturedHits (hits while no capture session was open), overflowDropped
//    NOTES, and retired EVENTs are separate per-unit counters, never summed
//    into one total, never silenced, and nothing here clears or discards
//    unsynced notes or dresses unsaved hits up as a saved badge.
//  * The StatusDetail note-faithfulness fields are displayed as DISTINCT
//    labeled segments — "LONG NOTES NOT CAPTURED N" (retained locally,
//    UNSAVED), "TIMING UNCERTAIN N – save withheld", and "WINDOW UNKNOWN"
//    when the stuck window is not provably known — never conflated with the
//    unsynced hit/note/event counters, never summed, warn-worthy in every
//    phase.
//  * Nothing in this file ever formats a pairing code or a bearer token —
//    credentials do not exist in this module's input shapes at all.
//
// The module is plain erasable TypeScript (types + functions only, no enums,
// no namespaces, no classes) so the same file compiles inside Lens Studio AND
// runs directly under Node's type stripping for unit checks
// (tests/soundcraft-connection-status.test.mjs).

import type {
  CompanionPhase,
  SavedReceipt,
  UnsyncedState,
} from "./SoundcraftCompanionTypes";

/** Visual severity bucket the UI maps onto its color inputs. */
export type Severity = "neutral" | "info" | "ok" | "warn" | "error";

/**
 * The slice of a client snapshot the UI needs. `StatusDetail` from
 * SoundcraftCompanionClient is structurally compatible with this type (it now
 * carries the note-faithfulness fields too), so the adapter can pass a real
 * snapshot straight through.
 */
export type StatusSummary = {
  phase: CompanionPhase;
  unsynced: UnsyncedState;
  savedBadgeCount: number;
  lastSavedReceipt: SavedReceipt | null;
  /** false / missing / malformed ⇒ the stuck-note window is UNKNOWN (warn). */
  stuckKnown: boolean;
  /** Long samples rejected before sending — retained locally, UNSAVED (notes). */
  notCapturableNotes: number;
  /** Engine-substituted notes — exact-fidelity commits withheld (notes). */
  nonFaithfulNotes: number;
};

/** Exhaustive phase list — unit checks iterate this to prove no gaps. */
export const ALL_PHASES: CompanionPhase[] = [
  "config_error",
  "local_only",
  "offline",
  "awaiting_pair",
  "connecting",
  "paired",
  "capturing",
  "commit_pending",
  "saved_confirmed",
  "commit_failed",
  "commit_unknown",
  "token_expired",
  "backend_down",
];

// ---- the tables (string-keyed on purpose: they stay indexable under the
// project's non-strict tsconfig, and unknown keys fall through to honest
// defaults instead of throwing inside a UI refresh) ---------------------------

const LABELS: { [phase: string]: string } = {
  config_error: "CONFIG ERROR",
  // GENERIC on purpose: the client's `local_only` phase covers BOTH real judge
  // mode AND the unconfigured network-off placeholder — the phase alone cannot
  // prove "judge". The controller (which knows the authored
  // judgeLocalOnlyMode flag) carries the mode-specific wording in its own
  // status line; this label must never claim a mode the phase cannot prove.
  local_only: "LOCAL ONLY",
  offline: "OFFLINE",
  awaiting_pair: "WAITING FOR CODE",
  connecting: "PAIRING…",
  paired: "PAIRED",
  capturing: "CAPTURING",
  commit_pending: "COMMIT PENDING",
  saved_confirmed: "SAVED ✓ (RECEIPT)",
  commit_failed: "COMMIT FAILED",
  commit_unknown: "COMMIT UNKNOWN",
  token_expired: "TOKEN EXPIRED",
  backend_down: "COMPANION DOWN",
};

const SEVERITY: { [phase: string]: Severity } = {
  config_error: "error",
  local_only: "neutral",
  offline: "error",
  awaiting_pair: "warn",
  connecting: "info",
  paired: "ok",
  capturing: "ok",
  commit_pending: "info",
  saved_confirmed: "ok",
  commit_failed: "error",
  commit_unknown: "warn",
  token_expired: "warn",
  backend_down: "error",
};

/** Phases where the panel may collapse to the small status (token is live). */
const PAIRED_LIKE: { [phase: string]: boolean } = {
  config_error: false,
  // Collapse stays safe for `local_only` because nothing here claims a mode:
  // the generic LOCAL ONLY label renders for both real judge mode and the
  // unconfigured placeholder; the controller's own status line states which.
  local_only: true,
  offline: false,
  awaiting_pair: false,
  connecting: false,
  paired: true,
  capturing: true,
  commit_pending: true,
  saved_confirmed: true,
  commit_failed: true, // commit state is backend-refusal info; token still live
  commit_unknown: true, // readback settles it; not a re-pair situation
  token_expired: false, // a fresh one-time code is required again
  backend_down: false,
};

/** Phases where the one-time-code input row must be visible. */
const CODE_NEEDED: { [phase: string]: boolean } = {
  config_error: false, // operator must fix the endpoint, not retype a code
  local_only: false,
  offline: true, // may be a reachability blip; keep the entry visible
  awaiting_pair: true,
  connecting: false,
  paired: false,
  capturing: false,
  commit_pending: false,
  saved_confirmed: false,
  commit_failed: false,
  commit_unknown: false,
  token_expired: true,
  backend_down: false, // restart the companion first; a new code comes then
};

// ---- loss counters (hits / notes / events have DIFFERENT units) -------------

// Rendering helper: a counter is displayed only when it is a finite positive
// number; malformed values (undefined / NaN / negative) render as absent —
// never as a fabricated "0" line and never as NaN.
function renderCount(value: unknown): number {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
}

// A loss counter is "lossy" when it is provably positive OR malformed — a
// malformed counter can never be treated as a clean zero (no green claim).
function lossyCount(value: unknown): boolean {
  if (typeof value !== "number" || !isFinite(value) || value < 0) {
    return true; // malformed — cannot prove clean
  }
  return value > 0;
}

/**
 * True when ANY capture loss is present or unprovable, across the three
 * client counters — which count DIFFERENT units and are never summed:
 *  * uncapturedHits       — HITS landed while no capture session was open
 *                           (rollover / open failure),
 *  * overflowDroppedNotes — NOTES past the bounded capture window,
 *  * retiredUnsentEvents  — EVENTs retired because their session provably
 *                           ceased (note-on + note-off may be 2 events per note).
 * The UI renders these as separate per-unit counters; this helper only answers
 * "is anything lost or unprovable?" for the severity tint.
 */
export function hasLoss(u: UnsyncedState): boolean {
  if (u === null || u === undefined) {
    return false;
  }
  return lossyCount(u.uncapturedHits) || lossyCount(u.overflowDroppedNotes) || lossyCount(u.retiredUnsentEvents);
}

// ---- pure lookups ----------------------------------------------------------

/** Short uppercase label for a phase. Unknown phases pass through verbatim. */
export function labelForPhase(phase: CompanionPhase): string {
  const known = LABELS[phase];
  if (known !== undefined && known !== null && known.length > 0) {
    return known;
  }
  return phase.toUpperCase(); // honest passthrough for future phases
}

export function severityForPhase(phase: CompanionPhase): Severity {
  const known = SEVERITY[phase];
  return known !== undefined && known !== null ? known : "neutral";
}

/** True when the token is live enough that the panel may collapse. */
export function isPairedLike(phase: CompanionPhase): boolean {
  return PAIRED_LIKE[phase] === true;
}

/** True when the one-time-code input should be visible/expanded. */
export function isPairInputNeeded(phase: CompanionPhase): boolean {
  return CODE_NEEDED[phase] === true;
}

// ---- note faithfulness (client StatusDetail fields, kept DISTINCT) ----------

/**
 * The note-faithfulness segments for a snapshot, rendered as SEPARATE labeled
 * counters with no cross-field total — these StatusDetail fields may overlap
 * the UnsyncedState counters (and each other), so they are displayed verbatim
 * and never merged or added:
 *  * "LONG NOTES NOT CAPTURED N"      ← notCapturableNotes (long samples
 *    rejected before sending; retained locally, UNSAVED — never a saved badge)
 *  * "TIMING UNCERTAIN N – save withheld" ← nonFaithfulNotes (engine
 *    substituted at the stuck window; exact-fidelity commits withheld)
 *  * "WINDOW UNKNOWN"                 ← stuckKnown not exactly true (missing,
 *    false, or malformed — fail-closed: an unprovable window warns)
 * Zero-valued counters render nothing; malformed counters warn but render no
 * fabricated number. The client's own compactSummary/compactSeverity strings
 * are NOT consumed here — the mandated labels and fail-closed rules live in
 * this module so collapsed and expanded UIs stay consistent.
 */
export function faithfulnessSegments(s: StatusSummary): string[] {
  const segments: string[] = [];
  const notCapturable = renderCount(s === null || s === undefined ? undefined : s.notCapturableNotes);
  if (notCapturable > 0) {
    segments.push("LONG NOTES NOT CAPTURED " + notCapturable);
  }
  const nonFaithful = renderCount(s === null || s === undefined ? undefined : s.nonFaithfulNotes);
  if (nonFaithful > 0) {
    segments.push("TIMING UNCERTAIN " + nonFaithful + " – save withheld");
  }
  if (s === null || s === undefined || s.stuckKnown !== true) {
    segments.push("WINDOW UNKNOWN");
  }
  return segments;
}

/**
 * True when the note-faithfulness fields warrant the warn tint: any non-zero
 * (or malformed) notCapturableNotes / nonFaithfulNotes, or a window that is
 * not provably known. Applies in EVERY phase — including capturing and
 * saved_confirmed.
 */
function hasStuckUncertainty(s: StatusSummary): boolean {
  if (s === null || s === undefined) {
    return true; // no snapshot data — cannot prove clean
  }
  return (
    s.stuckKnown !== true ||
    lossyCount(s.notCapturableNotes) ||
    lossyCount(s.nonFaithfulNotes)
  );
}

// ---- summaries -------------------------------------------------------------

/**
 * One compact line for the COLLAPSED panel — structured, no free-text echo.
 * Losses render as SEPARATE per-unit counters (a hit, a note, and an event are
 * different things; they are never added into one total), only when non-zero:
 *   LABEL · MISSED HITS x · DROPPED NOTES y · RETIRED EVENTS z · unsent U ·
 *   unknown-duration K · LONG NOTES NOT CAPTURED N · TIMING UNCERTAIN M – save
 *   withheld · WINDOW UNKNOWN · SAVED n
 *  * The note-faithfulness fields (StatusDetail notCapturableNotes /
 *    nonFaithfulNotes / stuckKnown) render as their own DISTINCT segments —
 *    never conflated with the unsynced hit/note/event counters, never summed
 *    with anything, and "LONG NOTES NOT CAPTURED" is never labelled saved.
 *  * unknown-duration (commit-refused swept notes) and the unsent backlog stay
 *    visible collapsed — the collapsed panel must not degrade to "unsent 0".
 *  * "SAVED n" appears ONLY from the receipt-backed savedBadgeCount (> 0).
 * Unsaved hits are never rendered as a saved badge.
 */
export function compactSummary(s: StatusSummary): string {
  const parts: string[] = [labelForPhase(s.phase)];
  const unsynced = s.unsynced;
  if (unsynced !== null && unsynced !== undefined) {
    const missedHits = renderCount(unsynced.uncapturedHits);
    if (missedHits > 0) {
      parts.push("MISSED HITS " + missedHits);
    }
    const droppedNotes = renderCount(unsynced.overflowDroppedNotes);
    if (droppedNotes > 0) {
      parts.push("DROPPED NOTES " + droppedNotes);
    }
    const retiredEvents = renderCount(unsynced.retiredUnsentEvents);
    if (retiredEvents > 0) {
      parts.push("RETIRED EVENTS " + retiredEvents);
    }
    parts.push("unsent " + renderCount(unsynced.unsentEvents));
    const unknown = renderCount(unsynced.notesUnknownDuration);
    if (unknown > 0) {
      parts.push("unknown-duration " + unknown);
    }
    if (unsynced.uncertainInFlight === true) {
      parts.push("reply lost — reconciling");
    }
  }
  // note-faithfulness segments: distinct StatusDetail counters + window state
  for (const segment of faithfulnessSegments(s)) {
    parts.push(segment);
  }
  if (s.savedBadgeCount > 0) {
    parts.push("SAVED " + s.savedBadgeCount);
  }
  return parts.join(" · ");
}

/**
 * Full unsynced ledger line — nothing is hidden, same explicit per-unit
 * counters as the compact line (no cross-unit total): unsent, acked, held,
 * MISSED HITS / DROPPED NOTES / RETIRED EVENTS, unknown-duration, and the
 * lost-reply flag.
 */
export function unsyncedSummary(u: UnsyncedState): string {
  if (u === null || u === undefined) {
    return "";
  }
  let line =
    "unsent " + renderCount(u.unsentEvents) + " · acked " + renderCount(u.ackedEvents) + " · held " + renderCount(u.heldNotes);
  const missedHits = renderCount(u.uncapturedHits);
  if (missedHits > 0) {
    line += " · MISSED HITS " + missedHits;
  }
  const droppedNotes = renderCount(u.overflowDroppedNotes);
  if (droppedNotes > 0) {
    line += " · DROPPED NOTES " + droppedNotes;
  }
  const retiredEvents = renderCount(u.retiredUnsentEvents);
  if (retiredEvents > 0) {
    line += " · RETIRED EVENTS " + retiredEvents;
  }
  const unknown = renderCount(u.notesUnknownDuration);
  if (unknown > 0) {
    line += " · unknown-duration " + unknown;
  }
  if (u.uncertainInFlight === true) {
    line += " · reply lost — reconcile before any resend";
  }
  return line;
}

/**
 * Severity for the compact line, phase first — then ESCALATED so losses are
 * never painted green:
 *  * hasLoss (any of MISSED HITS / DROPPED NOTES / RETIRED EVENTS > 0, or a
 *    malformed counter that cannot prove clean) → "warn"
 *  * unknown-duration notes > 0 (or malformed) → "warn"
 *  * note-faithfulness: notCapturableNotes / nonFaithfulNotes > 0 (or
 *    malformed), or the stuck window not provably known → "warn" — in EVERY
 *    phase, including capturing and saved_confirmed
 * Error phases stay error (escalation never downgrades), and a clean
 * "capturing" phase keeps its ok/green tint. The client's own
 * compactSeverity is intentionally not consumed: it knows only "ok"/"warn",
 * drops phase severity, and would downgrade failing phases.
 */
export function severityForSummary(s: StatusSummary): Severity {
  let severity = severityForPhase(s.phase);
  if (severity === "error") {
    return severity; // never downgrade a failing phase
  }
  const unsynced = s.unsynced;
  if (unsynced !== null && unsynced !== undefined) {
    if (hasLoss(unsynced) || lossyCount(unsynced.notesUnknownDuration)) {
      severity = "warn";
    }
  }
  if (hasStuckUncertainty(s)) {
    severity = "warn";
  }
  return severity;
}

/**
 * Short save-acknowledgement snippet from the LAST saved receipt.
 *  * "saved"    → "SAVED ✓ <basename> (exact receipt)" — the only variant
 *                 allowed to say SAVED.
 *  * "pending"  → save did not start; the client owns the scoped retry.
 *  * "failed"   → save provably failed; the COMMIT still landed (stated).
 *  * "unknown"  → outcome unprovable; GET /v1/live/saves settles it. Never
 *                 retried blindly, never badge-worthy.
 *  * "disabled" → no project root; clip lives in backend memory only.
 * A null receipt yields "" — silence is honest here; the full status row and
 * the playlist carry the truth.
 */
export function saveAckSnippet(receipt: SavedReceipt | null): string {
  if (receipt === null || receipt === undefined) {
    return "";
  }
  if (receipt.status === "saved") {
    const name = typeof receipt.name === "string" && receipt.name.length > 0 ? receipt.name : "unnamed take";
    return "SAVED ✓ " + name + " (exact receipt)";
  }
  if (receipt.status === "pending") {
    return "SAVE PENDING — commit landed, save not started";
  }
  if (receipt.status === "failed") {
    return "SAVE FAILED (commit landed)";
  }
  if (receipt.status === "unknown") {
    return "SAVE UNKNOWN — settle by saves readback";
  }
  if (receipt.status === "disabled") {
    return "SAVING DISABLED — clip in backend memory only";
  }
  return "";
}
