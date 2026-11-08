// PlaylistPanelPresentation.ts — PURE view model for PlaylistPanel.ts.
// NEW file: no Lens runtime types, no decorators, no scene access — string and
// number inputs only, so the exact shipped code also runs under Node's type
// stripping for unit checks
// (tests/soundcraft-playlist-panel-presentation.test.mjs).
//
// DATA SOURCE CONTRACT: the only backend input is the controller's public
// getStatusSnapshot() — the client-scrubbed StatusDetail (phases, counters,
// basenames, receipt data). Nothing here contacts the backend, reads a
// credential, or invents state.
//
// HONESTY CONTRACT (mirrors the client + SoundcraftConnectionStatus rules):
//  * A SAVED display is minted ONLY from snapshot.savedBadgeCount (> 0) and
//    the version ONLY from an exact `saved` SavedReceipt (status === "saved",
//    numeric version). A pending/unknown/failed/disabled receipt — or a
//    malformed one — never yields a badge or a version.
//  * Backend readback listings (PlaylistEntry.savedBadge === false) grow the
//    playlist COUNT but never the SAVED count: listed entries are shown as
//    "listed n (no badge)".
//  * A prior saved receipt NEVER claims the current take: while the live take
//    holds notes / buffered hits / unsettled commit state, the version is
//    suffixed "(earlier save)" and the unsynced/held/buffered counters stay
//    visible. Nothing is cleared, nothing is re-labelled saved.
//  * Phase labels come verbatim from the shipped labelForPhase table (via
//    compactSummary) — offline / unknown / failed / expired / down states stay
//    visible. No code path in this file can produce "ALL SAVED".
//  * The null-snapshot fallback is honest local-only wording: without a wired
//    controller the panel claims NOTHING about any backend.
//  * LOCAL monitor data (bus session clock + local hit count) and BACKEND
//    pending counts (snapshot counters) are rendered by separate functions and
//    never merged into one number.
//
// 90 s BAR = VIEW WINDOW ONLY: barViewStart/barViewFrac roll a display window
// so the bar keeps meaning after 90 s. It never caps or restricts capture —
// the session clock (SoundcraftBus.tick) and the controller's monotonic
// capture timing are untouched, and the take-line caption says so.

import type { StatusDetail } from "./SoundcraftCompanionClient";
import type { SavedReceipt } from "./SoundcraftCompanionTypes";
import { compactSummary } from "./SoundcraftConnectionStatus";

// ---- fixed panel copy ---------------------------------------------------------

export const PANEL_TITLE = "SOUNDCRAFT ORBIT";

/** PLAY/STOP labels: short, and always naming the bundled demo (never live audio). */
export function demoLabel(playing: boolean): string {
  return playing ? "■ STOP demo" : "▶ PLAY demo (bundled)";
}

/** Honest clear-button receipt: the LOCAL view only — no backend document or save is touched. */
export const CLEAR_NOTE =
  "local take view cleared (LOCAL view only — backend session/document untouched)";

// ---- the 90 s rolling VIEW window ---------------------------------------------

/** The bar's view window length in seconds. VIEW ONLY — never a capture limit. */
export const BAR_VIEW_SECS = 90;

/** Start of the display window containing `sessionTimeSecs` (rolls every 90 s). */
export function barViewStart(sessionTimeSecs: number): number {
  return Math.floor(Math.max(0, sessionTimeSecs) / BAR_VIEW_SECS) * BAR_VIEW_SECS;
}

/** Fraction (0..1) through the current 90 s view window — keeps advancing forever. */
export function barViewFrac(sessionTimeSecs: number): number {
  const rel = Math.max(0, sessionTimeSecs) - barViewStart(sessionTimeSecs);
  return Math.min(1, Math.max(0, rel / BAR_VIEW_SECS));
}

/**
 * Tick slot for a hit recorded at `hitTimeSecs` inside the CURRENT view window
 * (viewStartSecs → viewStartSecs + viewSecs). Hits from older windows return
 * -1 (out of view — the rolling window only shows the live 90 s). Pure math.
 */
export function tickIndex(
  hitTimeSecs: number,
  viewStartSecs: number,
  viewSecs: number,
  tickCount: number
): number {
  if (!(tickCount > 0) || !(viewSecs > 0)) {
    return -1;
  }
  const rel = hitTimeSecs - viewStartSecs;
  if (!(rel >= 0) || rel >= viewSecs) {
    return -1;
  }
  const idx = Math.floor((rel / viewSecs) * tickCount);
  return Math.min(tickCount - 1, Math.max(0, idx));
}

// ---- LOCAL monitor line (bus data ONLY — no snapshot numbers) -------------------

/** m:ss, same accumulation-friendly rule as the bus's formatClock (no Date). */
export function formatTakeClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ":" + (r < 10 ? "0" : "") + r;
}

/**
 * The local take row: clock + local hit count. The view caption appears only
 * once the session is past the first 90 s window, and it states the truth:
 * the bar is a rolling VIEW — capture continues, nothing is capped.
 */
export function takeLine(sessionTimeSecs: number, localHitCount: number): string {
  let line = "TAKE " + formatTakeClock(sessionTimeSecs) + " · " + localHitCount + " hits";
  if (sessionTimeSecs >= BAR_VIEW_SECS) {
    line += " · bar: 90 s view (rolls · capture continues)";
  }
  return line;
}

// ---- BACKEND rows (snapshot data ONLY — no bus numbers) ------------------------

/**
 * Row 1: the shipped compactSummary (phase label + unsynced ledger + receipt
 * badge + faithfulness segments), with its trailing "SAVED n" suffix moved to
 * the playlist row so the badge is shown in exactly one place. compactSummary
 * always pushes "SAVED n" LAST (SoundcraftConnectionStatus compactSummary), so
 * a deterministic suffix strip is a pure display move — never a data change.
 * held/buffered counts are appended when > 0 because the compact summary does
 * not carry them and the current take's live work must stay visible.
 */
export function backendStatusRow(s: StatusDetail | null): string {
  if (s === null || s === undefined) {
    return "LOCAL MONITOR ONLY · this take is not saved";
  }
  let row = stripTrailingSaved(compactSummary(s));
  if (s.heldNotes > 0) {
    row += " · held " + s.heldNotes;
  }
  if (s.unsynced !== null && s.unsynced !== undefined && s.unsynced.bufferedHits > 0) {
    row += " · buffered " + s.unsynced.bufferedHits;
  }
  return row;
}

/** Strip ONLY the deterministic trailing " · SAVED <n>" that compactSummary appends. */
export function stripTrailingSaved(summary: string): string {
  const m = / · SAVED \d+$/.exec(summary);
  return m !== null ? summary.slice(0, m.index) : summary;
}

/**
 * "SAVED n" verdict — true ONLY when the snapshot's own badge count is > 0
 * (the client mints it exclusively on an exact `saved` receipt). This is the
 * only gate for any SAVED wording in the playlist row.
 */
export function hasSavedBadge(s: StatusDetail): boolean {
  return s.savedBadgeCount > 0;
}

/**
 * "v<major>" label — ONLY from the exact `saved` receipt variant with a
 * well-formed safe-integer version (mirrors the client's own isSafeInt
 * receipt proof: finite, integral, |v| ≤ 2^53-1 — zero is a valid version).
 * Pending/unknown/failed/disabled and malformed receipts return "" (no
 * version is invented).
 */
export function savedVersionLabel(receipt: SavedReceipt | null): string {
  if (
    receipt !== null &&
    receipt !== undefined &&
    receipt.status === "saved" &&
    typeof receipt.version === "number" &&
    Number.isSafeInteger(receipt.version)
  ) {
    return "v" + receipt.version;
  }
  return "";
}

/**
 * TRUE while the CURRENT take still has live/unsettled work: held voices,
 * buffered next-take hits, unsent events, a lost reply, unknown-duration
 * notes, long-note/faithfulness gaps, or a commit in flight or unproven.
 *
 * ORDERING CONTRACT: the live-work checks run BEFORE the `saved_confirmed`
 * phase exception. The client CAN sit in `saved_confirmed` while late hits
 * are preserved in the next-take buffer (bufferedHits) — that preserved
 * unsaved work must mark a prior receipt as "(earlier save)", never let the
 * version read as current. `completedNotes` alone in a clean
 * `saved_confirmed` phase ARE the just-committed notes (legitimately saved),
 * so they are exempt — but only after every actual unsaved-work check above
 * came back clean. In every other phase completedNotes > 0 stays unsettled.
 */
export function currentTakeUnsettled(s: StatusDetail): boolean {
  if (s.phase === "commit_pending" || s.phase === "commit_unknown") {
    return true;
  }
  if (s.heldNotes > 0 || s.notCapturableNotes > 0 || s.nonFaithfulNotes > 0) {
    return true;
  }
  const u = s.unsynced;
  if (u !== null && u !== undefined) {
    if (
      u.unsentEvents > 0 ||
      u.bufferedHits > 0 ||
      u.notesUnknownDuration > 0 ||
      u.uncertainInFlight === true
    ) {
      return true;
    }
  }
  if (s.phase === "saved_confirmed") {
    return false; // exact receipt AND no live work above — the take is settled
  }
  return s.completedNotes > 0;
}

/** Playlist entries that carry NO saved badge (backend readback + judge local rows). */
export function listedNoBadgeCount(s: StatusDetail): number {
  let n = 0;
  for (let i = 0; i < s.playlist.length; i++) {
    if (!s.playlist[i].savedBadge) {
      n++;
    }
  }
  return n;
}

/**
 * Row 2: the GROWING actual playlist (snapshot.playlist.length — receipts +
 * readback listings + judge local rows, exactly as the client holds them),
 * the receipt-guarded SAVED count, the latest saved version from the actual
 * parsed SavedReceipt, and the explicit no-badge marker for listed entries.
 * A prior receipt while the current take is unsettled is suffixed
 * "(earlier save)" — never allowed to read as the current take being saved.
 */
export function backendPlaylistRow(s: StatusDetail | null): string {
  if (s === null || s === undefined) {
    return "no backend linked · panel shows the local session only";
  }
  const parts: string[] = ["PLAYLIST " + s.playlist.length];
  if (hasSavedBadge(s)) {
    parts.push("SAVED " + s.savedBadgeCount);
    const ver = savedVersionLabel(s.lastSavedReceipt);
    if (ver !== "") {
      parts.push(currentTakeUnsettled(s) ? ver + " (earlier save)" : ver);
    }
  }
  const listed = listedNoBadgeCount(s);
  if (listed > 0) {
    parts.push("listed " + listed + " (no badge)");
  }
  if (parts.length === 1) {
    parts.push("nothing saved yet");
  }
  return parts.join(" · ");
}

/** Both compact backend rows in one call (what the panel renders into TxtSim). */
export function backendRows(s: StatusDetail | null): { statusRow: string; playlistRow: string } {
  return { statusRow: backendStatusRow(s), playlistRow: backendPlaylistRow(s) };
}
