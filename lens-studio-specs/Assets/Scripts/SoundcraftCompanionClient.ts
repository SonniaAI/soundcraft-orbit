// SoundcraftCompanionClient.ts — the pure state machine for the SoundCraft
// companion adapter. NEW file: no SceneObject, no component decorators, no
// Lens globals — every effect (HTTP, clocks, timers, logging) is injected, so
// the offline tests run this exact logic with stubs.
//
// THE CONTRACT THIS IMPLEMENTS (backend main c8e1bfb, companion API):
//
//  * Pairing: a server-minted, single-use, user-visible pairing code exchanges
//    once (POST /v1/pair) for a short-lived bearer token that lives in memory
//    only. No token, code, or any other credential is ever hardcoded, stored,
//    or logged (logs carry a length-only mask).
//  * Single-monitor honesty: the Lens's own sounds are the LOCAL monitor; the
//    backend records notes and never sounds them. Status text states this.
//  * Capture: note events keep real timing (getRealTimeNanos deltas from a
//    per-session origin — one monotonic lens clock; NO drift-correction or
//    sample-phase alignment is claimed) and stable surface ids. Events are
//    batched (never one WAN request per note) and event ids strictly increase.
//  * Bounded slices: a take commits before it can exceed the engine's
//    999-note ceiling (auto-commit margin below the server-advertised limit).
//  * Uncertainty is never guessed: a lost reply ⇒ reconcile via the journal
//    readback; resend ONLY events provably not applied (eventId > cursor).
//    A commit/save with an unknown outcome is settled by the take readback or
//    GET /v1/live/saves — never a blind retry.
//  * Offline / token expiry never drops notes silently: queues are bounded,
//    overflow is counted and surfaced, and the phase turns token_expired or
//    offline while everything waits for recovery.
//  * The saved badge exists ONLY for an exact `saved` receipt
//    (saved.status === "saved"). Backend-readback entries are listed honestly
//    without the badge.
//
// Session generations: every new take uses a NEW session id (1, 2, 3, …);
// ids are never reused in one lens run, so no state of a previous take can be
// mistaken for the current one (the companion retires receipts when ids are
// reused; we simply never do).

import {
  CapabilitiesReply,
  CommitReceipt,
  CommitReply,
  CompanionPhase,
  IngestReply,
  PairReply,
  Parsed,
  SavedReceipt,
  expectParsed,
  parseProblem,
  savedReceiptFileName,
  surfaceIdFor,
  TakeReply,
  TakeStatusWire,
  UnsyncedState,
  WireEvent,
  isSavedReceiptSaved,
} from "./SoundcraftCompanionTypes";
import {
  BearerCapableTransport,
  CompanionTransport,
  DeadlineTimer,
  errorEnvelopeOf,
  isSafeInt,
  LensSeconds,
  parseJsonBody,
  RealTimeNanos,
  TransportReply,
} from "./SoundcraftCompanionHttp";

// ---- injected environment ----------------------------------------------------

export type ClientEnv = {
  transport: CompanionTransport; // BearerCapableTransport when online mode
  nowSecs: LensSeconds; // getTime()
  realtimeNanos: RealTimeNanos; // getRealTimeNanos()
  timer: DeadlineTimer; // DelayedCallbackEvent wiring (used for retries/polls)
  log: (message: string) => void;
};

export type CompanionConfig = {
  onlineMode: boolean; // false ⇒ judge mode: local-only, never a network byte
  captureBatchMaxEvents: number; // ≤ 4096 (server limit); keep small for WAN safety
  flushIntervalSeconds: number; // batch cadence (no per-note WAN)
  idlePhraseSeconds: number; // ≥ 0: auto-commit this long after the last note activity (a phrase boundary); 0 disables
  requestedStuckTimeoutSeconds: number; // requested per-session stuck-note window (PR17); 0 disables the request (1 s engine default)
  autoCommitNotes: number; // auto-commit completed-note threshold (< 999 ALWAYS)
  commitPollIntervalSeconds: number;
  commitPollMaxTries: number;
  savesRefreshIntervalSeconds: number;
  pendingEventQueueMax: number; // bounded queue; overflow is COUNTED, not silent
  tokenExpirySafetySeconds: number; // treat token as expired this long before TTL
};

export const DEFAULT_CONFIG: CompanionConfig = {
  onlineMode: true,
  captureBatchMaxEvents: 128,
  flushIntervalSeconds: 0.5,
  // A short phrase commits ~2.5 s after its last note activity — ordinary
  // playing saves without any manual action. 0 disables idle commits.
  idlePhraseSeconds: 2.5,
  // PR17 live_open: request a 2 s stuck-note window per fresh session — the
  // actual declared one-shot durations (bass 1.25 s, chord 1.76 s) then fit
  // with headroom. The reply's stuck_timeout_samples is the EFFECTIVE bound.
  requestedStuckTimeoutSeconds: 2.0,
  // Hard ceiling: the engine caps ONE commit at 999 notes (a grouped edit =
  // the clip + one command per note, 1000-command cap). Auto-commit early.
  autoCommitNotes: 990,
  commitPollIntervalSeconds: 2.0,
  commitPollMaxTries: 30,
  savesRefreshIntervalSeconds: 30.0,
  pendingEventQueueMax: 512,
  tokenExpirySafetySeconds: 30.0,
};

// ---- local capture model -----------------------------------------------------

/**
 * A hit captured while a commit was in flight (or a landed commit awaited its
 * rollover). Stored with ABSOLUTE lens-clock times — never fabricated — and
 * transferred into the next take with fresh event ids, intra-phrase deltas
 * preserved exactly.
 */
type BufferedHit = {
  instrument: string;
  pad: number;
  key: number;
  channel: number;
  velocity: number;
  onsetAbsNanos: number;
  finishAbsNanos: number; // valid when finished
  finished: boolean;
  policyNs: number; // the pad's declared duration policy (carried across the boundary)
};

export type LocalNote = {
  instrument: string; // stable instrument type ("beat" | "bass" | "chord" | …)
  pad: number;
  key: number;
  channel: number;
  velocity: number;
  handle: number; // generation-exact identity: finishNote(handle) can only close THIS note
  onsetAbsNanos: number; // absolute monotonic lens-clock onset (policy deadlines anchor here)
  policyNs: number; // the pad's declared SAMPLE-DURATION POLICY (0 = none: stays held without a trusted finish)
  durationSource: "trusted" | "policy" | "cut" | "none";
  notCapturable: boolean; // declared duration exceeds the engine's stuck window: retained locally, never sent
  nonFaithful: boolean; // the engine substituted this note with its stuck-note policy bound (commit withheld — not exact)
  onsetNanos: number; // session-relative (originNs subtracted), monotonic
  durationNanos: number | null; // null = NOT KNOWN (never fabricated)
  finished: boolean;
  /** "local" not yet queued · "queued" ids assigned, awaiting send · "acked" in backend journal */
  state: "local" | "queued" | "acked";
  retired: boolean; // its events were PROVABLY refused/never applied — it does not exist in the backend take
  noteOnEventId: number; // valid once queued (0 before)
  noteOffEventId: number; // 0 while open
};

export type PlaylistEntry = {
  name: string; // basename only (server scrubs paths)
  bytes: number;
  modifiedMs: number;
  source: "saved_receipt" | "backend_readback" | "local_only";
  /** True ONLY for an exact `saved` receipt. Never inferred from a listing. */
  savedBadge: boolean;
};

/** One bounded next-take buffer entry, surfaced for honest status: full
 * identity + absolute onset + the MEASURED duration once its noteOff/finish
 * arrived (never fabricated). Transfers with fresh event ids after the old
 * take commits (or once a valid cap arrives). */
export type BufferedStatusNote = {
  instrument: string;
  pad: number;
  key: number;
  channel: number;
  velocity: number;
  onsetAbsNanos: number;
  finished: boolean;
  measuredNanos: number | null;
};

export type StatusDetail = {
  phase: CompanionPhase;
  detail: string; // human-readable, scrubbed (the server already scrubs its messages)
  lastErrorCode: string;
  retryNotBeforeSecs: number; // honouring 429 Retry-After / backoff
  sessionGeneration: number;
  sessionId: number;
  completedNotes: number;
  heldNotes: number;
  unknownDurationNotes: number;
  unsynced: UnsyncedState;
  playlist: PlaylistEntry[];
  savedBadgeCount: number;
  commitReceipt: CommitReceipt | null;
  lastSavedReceipt: SavedReceipt | null;
  localOnly: boolean;
  capturingStillOpen: boolean; // true when a capture session remains open (e.g. a refused stopCapture)
  simulationAuthority: boolean; // the companion advertises the labelled headless transport simulation
  transportAnchorSamples: number; // the append anchor the simulation was armed at (-1 = never)
  projectNote: string; // bootstrap outcome (recovered name / material count / nothing-to-do; no credentials)
  durationPolicyNote: string; // the truthful note-off/duration labelling for the UI
  stuckNegotiated: boolean; // the open request carried stuck_timeout_seconds and the backend accepted it
  maxDeclaredSecs: number; // the largest registered declared duration (coverage check input)
  windowCoversDeclared: boolean; // the effective window covers every declared duration
  staleFinishesIgnored: number; // generation-unsafe finish calls identified and ignored
  policyClosedNotes: number; // notes closed by the labelled SAMPLE-DURATION POLICY
  stuckKnown: boolean; // the engine's live_open exposed the real stuck-note window ints
  stuckWindowNs: number; // the REAL stuck-note window in nanoseconds (-1 unknown)
  notCapturableNotes: number; // long-declared notes rejected BEFORE sending (retained locally, visible)
  nonFaithfulNotes: number; // engine-substituted notes present: exact-fidelity commits withheld
  commitCeilingNotes: number; // the EFFECTIVE commit-note ceiling: min(configured, server max_notes_per_commit); informational only while unverified
  commitCapVerified: boolean; // the server actually advertised a well-formed max_notes_per_commit
  takeNoteFootprint: number; // notes the CURRENT take will contain at commit time (finished + held + unknown, non-retired)
  buffered: BufferedStatusNote[]; // the bounded next-take buffer, full payload (identity, onset, measured duration)
  stuckWindowSecsLabel: string; // human window label, e.g. "1.00 s" ("unknown" when unexposed)
  compactSeverity: "ok" | "warn"; // warn when long samples were not captured or timing-uncertain notes exist
  compactSummary: string; // one-line compact warning for small UIs (no credentials)
  monitorLabel: string; // the single-monitor statement, verbatim for UI
};

// ---- status text -------------------------------------------------------------

export const MONITOR_LABEL =
  "AUDIO = LOCAL DEVICE MONITOR ONLY (backend records notes, never sounds them)";

/**
 * The truthful note-off/duration labelling (rendered by the UI). The runtime
 * setOnFinish is NOT used as a note-off source: its own contract fires it on
 * manual stop with no generation identity and no timing guarantee. Durations
 * are: observed retrigger cuts, the pad's DECLARED asset duration (explicitly
 * labelled SAMPLE-DURATION POLICY), or a trusted explicit finish — and notes
 * with none of those stay held/unknown and are never saved.
 */
export const DURATION_POLICY_NOTE =
  "NOTE-OFF POLICY: retrigger cut · declared sample duration (labelled policy, never a measured natural callback) · trusted explicit finish — otherwise held/UNKNOWN and not saved";

/** What the client strictly parses out of GET /v1/capabilities (the rest is untrusted passthrough). */
type CapabilitiesCore = {
  noteCapture: boolean;
  takeToClip: boolean;
  automaticSaving: boolean;
  recovery: boolean;
  maxNotesPerCommit: number | null; // null = missing/malformed/out-of-range: UNKNOWN, never a silent 999
  transport: unknown;
};

// ---- the client --------------------------------------------------------------

export class SoundcraftCompanionClient {
  private env: ClientEnv;
  private cfg: CompanionConfig;

  // credentials: memory only
  private tokenExpiresAtSecs = 0;
  private hasToken = false;
  // Whether a token was EVER issued in this client lifetime. `token_expired`
  // is only honest when a real token reached its bounded lifetime; a client
  // that never paired is awaiting_pair/offline — never "expired".
  private tokenEverIssued = false;

  // phase + messaging
  private phase: CompanionPhase;
  private detail = "starting";
  private lastErrorCode = "";
  private retryNotBeforeSecs = 0;

  // session lifecycle
  private sessionGeneration = 0;
  private sessionId = 0;
  private trackId = -1; // resolved strictly (open reply + take readback agree); -1 = unresolved (never guessed)
  private currentTrackRef: string | number = ""; // the operator-configured reference for the FIRST open
  private originNanos = 0;

  // capture
  private notes: LocalNote[] = []; // this take's notes (bounded by auto-commit + queue caps)
  private pending: WireEvent[] = []; // ordered ascending by eventId; the send queue
  private nextEventId = 1;
  private ackedCursor = 0;
  private uncertainInFlight = false;
  private overflowDroppedNotes = 0;
  private capturing = false;
  private keyGeneration: { [voiceKey: string]: LocalNote } = {}; // open notes by channel:key

  // commit state
  private commitReceipt: CommitReceipt | null = null;
  private lastSavedReceipt: SavedReceipt | null = null;
  private commitPollTries = 0;
  private commitAwaitingReadback = false;
  private commitInFlight = false;
  private pendingSaveRetrySessionId = 0; // >0 ⇒ an exact `pending` receipt authorised this scoped retry

  // playlist + saves
  private playlist: PlaylistEntry[] = [];
  private savedBadgeCount = 0;
  private lastSavesRefreshSecs = 0;

  // cadence
  private lastFlushSecs = 0;
  private busy = false;
  private pairingInFlight = false;

  constructor(env: ClientEnv, cfg: CompanionConfig) {
    this.env = env;
    this.cfg = cfg;
    this.phase = cfg.onlineMode ? "offline" : "local_only";
    this.detail = cfg.onlineMode
      ? "not connected — enter one-time code supplied for this session"
      : "JUDGE MODE — local-only capture and monitor; no backend is contacted or claimed";
    if (this.cfg.autoCommitNotes >= 999) {
      this.cfg.autoCommitNotes = 989; // hard ceiling guard, honest and loud
      this.logLine("autoCommitNotes clamped below the 999-note commit ceiling");
    }
    if (this.cfg.captureBatchMaxEvents > 4096) {
      this.cfg.captureBatchMaxEvents = 4096;
    }
  }

  private logLine(message: string): void {
    this.env.log("[Companion] " + message);
  }

  // ---- observability ---------------------------------------------------------

  snapshot(): StatusDetail {
    return {
      phase: this.phase,
      detail: this.detail,
      lastErrorCode: this.lastErrorCode,
      retryNotBeforeSecs: this.retryNotBeforeSecs,
      sessionGeneration: this.sessionGeneration,
      sessionId: this.sessionId,
      completedNotes: this.completedNoteCount(),
      heldNotes: this.heldCount(),
      unknownDurationNotes: this.unknownDurationCount(),
      unsynced: this.unsyncedState(),
      playlist: this.playlist.slice(),
      savedBadgeCount: this.savedBadgeCount,
      commitReceipt: this.commitReceipt,
      lastSavedReceipt: this.lastSavedReceipt,
      localOnly: !this.cfg.onlineMode,
      capturingStillOpen: this.capturing,
      simulationAuthority: this.simulationAuthority,
      transportAnchorSamples: this.transportAnchorSamples,
      projectNote: this.projectNote,
      durationPolicyNote: DURATION_POLICY_NOTE,
      staleFinishesIgnored: this.staleFinishesIgnored,
      policyClosedNotes: this.policyClosedNotes,
      stuckKnown: this.stuckKnown(),
      stuckWindowNs: this.stuckWindowNs(),
      stuckNegotiated: this.stuckNegotiated,
      maxDeclaredSecs: Math.round((this.maxDeclaredPolicyNs / 1e9) * 100) / 100,
      windowCoversDeclared: this.stuckKnown() && this.stuckWindowNs() >= this.maxDeclaredPolicyNs,
      notCapturableNotes: this.notCapturableNotes,
      nonFaithfulNotes: this.nonFaithfulNotes,
      commitCeilingNotes: this.commitNoteCeiling(),
      commitCapVerified: this.serverCapAuthoritative,
      takeNoteFootprint: this.takeNoteFootprint(),
      buffered: this.nextTakeBuffer.map((b) => ({
        instrument: b.instrument,
        pad: b.pad,
        key: b.key,
        channel: b.channel,
        velocity: b.velocity,
        onsetAbsNanos: b.onsetAbsNanos,
        finished: b.finished,
        measuredNanos: b.finished && b.finishAbsNanos > b.onsetAbsNanos ? b.finishAbsNanos - b.onsetAbsNanos : null,
      })),
      stuckWindowSecsLabel: this.stuckKnown()
        ? (Math.round((this.stuckWindowNs() / 1e9) * 100) / 100).toFixed(2) + " s"
        : "unknown",
      compactSeverity:
        this.notCapturableNotes > 0 || this.nonFaithfulNotes > 0 || (this.cfg.onlineMode && !this.serverCapAuthoritative) || this.unsyncedState().notesUnknownDuration > 0
          ? "warn"
          : "ok",
      compactSummary:
        (this.notCapturableNotes > 0
          ? "NOT CAPTURED (long samples > " + (Math.round((this.stuckWindowNs() / 1e9) * 100) / 100).toFixed(2) + " s window): " + this.notCapturableNotes + " — retained locally, unsaved"
          : "") +
        (this.nonFaithfulNotes > 0
          ? (this.notCapturableNotes > 0 ? "; " : "") + "TIMING-UNCERTAIN HELD (engine substituted at window): " + this.nonFaithfulNotes
          : "") +
        (this.cfg.onlineMode && !this.serverCapAuthoritative
          ? (this.notCapturableNotes > 0 || this.nonFaithfulNotes > 0 ? "; " : "") + "SERVER CAP UNVERIFIED — AUTO-SAVE WITHHELD: notes buffered locally (visible, bounded), no backend admission or commit until the companion advertises max_notes_per_commit"
          : "")
        ,
      monitorLabel: MONITOR_LABEL,
    };
  }

  private unsyncedState(): UnsyncedState {
    let unknown = 0;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].finished && this.notes[i].durationNanos === null) {
        unknown++;
      }
    }
    return {
      unsentEvents: this.pending.length,
      ackedEvents: this.ackedCursor,
      uncertainInFlight: this.uncertainInFlight,
      notesUnknownDuration: unknown,
      heldNotes: this.heldCount(),
      overflowDroppedNotes: this.overflowDroppedNotes,
      retiredUnsentEvents: this.retiredUnsentNotes,
      retiredRefusedEvents: this.retiredRefusedEvents,
      uncapturedHits: this.uncapturedHits,
      bufferedHits: this.nextTakeBuffer.length,
      staleFinishesIgnored: this.staleFinishesIgnored,
      policyClosedNotes: this.policyClosedNotes,
      stuckKnown: this.stuckKnown(),
      stuckWindowNs: this.stuckWindowNs(),
      notCapturableNotes: this.notCapturableNotes,
      nonFaithfulNotes: this.nonFaithfulNotes,
      leftBehindTakes: this.leftBehindTakes,
      captureBlockedReason: this.captureBlockedReason,
      lastAckedEventId: this.ackedCursor,
    };
  }

  private completedNoteCount(): number {
    let n = 0;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].finished && this.notes[i].durationNanos !== null) {
        n++;
      }
    }
    return n;
  }

  /**
   * The bounded NEXT-TAKE buffer entry path, shared by every route that must
   * not admit a hit into the CURRENT take: a commit boundary (bufferingActive),
   * a take at the commit-note ceiling, or an UNVERIFIED server cap (no
   * backend admission without an authoritative max_notes_per_commit). Full
   * identity is preserved (instrument/pad/key/channel/velocity, absolute
   * monotonic onset); a later noteOff/finish on the same voice records the
   * REAL finish time (measured duration, never fabricated); a same-voice
   * retrigger cuts the previous buffered entry at the observed moment; a
   * declared duration over the stuck window is retained BEFORE buffering
   * (the fresh take would substitute it — honestly counted). Bounded: when
   * the buffer is full the hit is honestly uncapturedHits — never a fake
   * "retained"/"saved". Transfer into a fresh take happens ONLY after the
   * old take committed (or, for the unknown-cap case, once a valid cap
   * arrives and a take opens), with fresh event ids.
   */
  private bufferHitForNextTake(handle: number, instrument: string, pad: number, key: number, channel: number, velocity: number, reason: string): void {
    const bufferedVoiceKey = channel + ":" + key;
    const bufferedDeclared = this.policyDurationNs[bufferedVoiceKey] !== undefined ? this.policyDurationNs[bufferedVoiceKey] : 0;
    if (bufferedDeclared > 0 && this.stuckKnown() && bufferedDeclared > this.stuckWindowNs()) {
      // LONG declared arriving while buffering: retained BEFORE buffering
      // (the transfer would otherwise enqueue a non-faithful window-length
      // note). Counted, visible — the local monitor still played it.
      this.notCapturableNotes++;
      this.logLine("long-declared hit retained during buffering (declared " + Math.round(bufferedDeclared / 1e9 * 1000) / 1000 + " s > window) — count " + this.notCapturableNotes);
      return;
    }
    const bufferedRetrigger = this.bufferedVoice[bufferedVoiceKey];
    const nowAbsNanos = this.env.realtimeNanos();
    if (bufferedRetrigger !== undefined && bufferedRetrigger !== null && !bufferedRetrigger.finished) {
      // RETRIGGER of an unfinished buffered hit on the same channel/key —
      // exactly mirroring the non-buffered path: the previous sound is cut
      // NOW (the observed retrigger is its real audible end), the entry
      // keeps its exact first-segment duration, and the fresh hit below
      // becomes this voice's current generation. A STALE finish callback
      // from the cut sound can no longer corrupt anything: the closed
      // entry is guarded by `finished`, and the voice's slot now points at
      // the fresh generation only.
      bufferedRetrigger.finished = true;
      bufferedRetrigger.finishAbsNanos = nowAbsNanos;
      delete this.bufferedVoice[bufferedVoiceKey];
      this.logLine("buffered retrigger — previous same-voice hit closed at the observed cut (exact segment duration preserved)");
    }
    if (this.nextTakeBuffer.length >= this.cfg.pendingEventQueueMax) {
      this.uncapturedHits++;
      this.logLine("next-take buffer full — hit NOT captured (count " + this.uncapturedHits + "); the local monitor still played it");
      return;
    }
    const entry: BufferedHit = {
      instrument: instrument,
      pad: pad,
      key: key,
      channel: channel,
      velocity: velocity,
      onsetAbsNanos: nowAbsNanos,
      finishAbsNanos: 0,
      finished: false,
      policyNs: this.policyDurationNs[bufferedVoiceKey] !== undefined ? this.policyDurationNs[bufferedVoiceKey] : 0,
    };
    this.nextTakeBuffer.push(entry);
    this.bufferedVoice[bufferedVoiceKey] = entry;
    this.lastNoteActivityNanos = nowAbsNanos;
    this.logLine("hit " + handle + " buffered for the NEXT take (" + reason + ") — buffered " + this.nextTakeBuffer.length + "; the local monitor still played it");
  }

  /**
   * THE RUNTIME COMMIT-NOTE CEILING: the minimum of every bound we can prove —
   * the configured threshold and the authoritative server-advertised
   * max_notes_per_commit. NO extra subtraction: the admission gate
   * (footprint + 1 > ceiling ⇒ the hit cannot enter this take) already
   * guarantees a committed slice ≤ ceiling ≤ serverMax, and a valid cap of 1
   * must still work (ceiling 1 = one-note takes) — a negative ceiling would
   * be an invented limit, never guessed here. With the cap missing,
   * malformed, or out-of-range the client does NOT commit or admit at all
   * (fail closed, surfaced) — this number is then only informational.
   */
  private commitNoteCeiling(): number {
    const configured = this.cfg.autoCommitNotes;
    if (!this.serverCapAuthoritative || this.serverMaxNotesPerCommit === null) {
      return configured;
    }
    return Math.min(configured, this.serverMaxNotesPerCommit);
  }

  /**
   * Notes the CURRENT take will contain at commit time: every captured note
   * of this session generation (finished, open/held, or unknown-duration —
   * the engine counts them all), excluding retired notes (provably refused —
   * they do not exist server-side). Pending/in-flight noteOn events belong to
   * notes already registered here, so this is exact with no double-count.
   * Reset per take (`this.notes = []` on every fresh session).
   */
  private takeNoteFootprint(): number {
    let n = 0;
    for (let i = 0; i < this.notes.length; i++) {
      if (!this.notes[i].retired) {
        n++;
      }
    }
    return n;
  }

  private heldCount(): number {
    let n = 0;
    for (const k in this.keyGeneration) {
      if (this.keyGeneration[k] !== undefined) {
        n++;
      }
    }
    return n;
  }

  private unknownDurationCount(): number {
    let n = 0;
    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      // Retired notes were provably refused (never applied server-side): they
      // are not part of the backend take and must not block its commit.
      if (note.retired) {
        continue;
      }
      if (note.finished && note.durationNanos === null) {
        n++;
      }
    }
    return n;
  }

  private setPhase(phase: CompanionPhase, detail: string): void {
    this.phase = phase;
    this.detail = detail;
    this.logLine("phase " + phase + " — " + detail);
  }

  private setLastError(code: string, detail: string): void {
    this.lastErrorCode = code;
    this.detail = detail;
    this.logLine("error " + code + " — " + detail);
  }

  // ---- pairing ---------------------------------------------------------------

  /** True when the in-memory token is present and (by our clock) not near expiry. */
  tokenLive(): boolean {
    return this.hasToken && this.env.nowSecs() < this.tokenExpiresAtSecs - this.cfg.tokenExpirySafetySeconds;
  }

  /**
   * Exchange the user-visible, single-use pairing code for the in-memory token.
   * The code is consumed here and NOT retained; on failure the caller must ask
   * the operator for a fresh code (single-use means this one may be burned).
   */
  async pair(code: string): Promise<boolean> {
    if (!this.cfg.onlineMode) {
      this.setPhase("local_only", "judge mode — pairing is not used; nothing is claimed about a backend");
      return false;
    }
    const trimmed = (code || "").trim();
    if (trimmed.length === 0) {
      this.setPhase("awaiting_pair", "enter one-time code supplied for this session");
      return false;
    }
    if (this.pairingInFlight) {
      return false;
    }
    this.pairingInFlight = true;
    this.setPhase("connecting", "exchanging pairing code…");
    const reply = await this.rawRequest("POST", "/v1/pair", JSON.stringify({ code: trimmed }), false);
    if (reply.outcome !== "ok") {
      this.pairingInFlight = false;
      this.hasToken = false;
      this.clearBearer();
      if (reply.outcome === "network_error") {
        this.setPhase("offline", "companion unreachable — " + reply.problem + " (notes keep queuing locally)");
      } else {
        // deadline: we do not know whether the code was consumed. Say so.
        this.setPhase("offline", "pairing reply not observed in time — the single-use code may be burned; ask for a fresh code");
      }
      return false;
    }
    if (reply.status === 429) {
      this.pairingInFlight = false;
      this.retryNotBeforeSecs = this.env.nowSecs() + Math.max(1, reply.retryAfterSeconds);
      this.setPhase("awaiting_pair", "pairing rate-limited; wait " + Math.max(1, reply.retryAfterSeconds) + "s, then use a fresh code if this one was refused");
      return false;
    }
    if (reply.status !== 200) {
      this.pairingInFlight = false;
      this.hasToken = false;
      this.clearBearer();
      const env = errorEnvelopeOf(reply);
      const message = env !== null ? env.message : "pairing refused (HTTP " + reply.status + ")";
      this.setPhase("awaiting_pair", "pairing refused: " + message);
      return false;
    }
    const parsedPair = this.parseObject<PairReply>(reply.bodyText, (obj) => {
      if (typeof obj["access_token"] !== "string" || obj["access_token"].length === 0) {
        return { ok: false as const, problem: "pair reply had no access_token" };
      }
      if (!isSafeInt(obj["expires_in_s"]) || (obj["expires_in_s"] as number) <= 0) {
        return { ok: false as const, problem: "pair reply had no usable expires_in_s" };
      }
      return {
        ok: true as const,
        value: {
          access_token: obj["access_token"] as string,
          token_type: typeof obj["token_type"] === "string" ? (obj["token_type"] as string) : "bearer",
          expires_in_s: obj["expires_in_s"] as number,
          paired_to: typeof obj["paired_to"] === "string" ? (obj["paired_to"] as string) : "",
        },
      };
    });
    const pairProblem = parseProblem(parsedPair);
    if (pairProblem !== null) {
      this.hasToken = false;
      this.clearBearer();
      this.setPhase("offline", "pair reply not understood: " + pairProblem);
      return false;
    }
    const pairValue = expectParsed(parsedPair);
    this.setBearer(pairValue.access_token);
    this.tokenExpiresAtSecs = this.env.nowSecs() + pairValue.expires_in_s;
    this.hasToken = true;
    this.tokenEverIssued = true; // expiry semantics only apply once a REAL token existed
    this.retryNotBeforeSecs = 0;
    // Refresh capabilities early so unsupported backends surface before capture.
    await this.refreshCapabilities();
    // First pairing of this token: the safe project bootstrap (recover ONLY a
    // demonstrably empty document; never blind-recover into material).
    if (!this.bootstrapDone) {
      this.bootstrapDone = true;
      await this.bootstrapProject();
    }
    // Reconnecting mid-take (e.g. after token expiry): resume by id so the
    // backend lists held voices — note-ons are NEVER replayed on reconnect.
    if (this.capturing && this.sessionId > 0) {
      await this.resumeAfterReconnect();
    }
    if (this.phase === ("connecting" as CompanionPhase)) {
      this.setPhase("paired", "paired — token lives in memory only until it expires or the companion restarts");
    }
    this.pairingInFlight = false;
    return true;
  }

  /**
   * POST /v1/live/sessions/{id}/resume with last_acked = our cursor. Held
   * voices come back LISTED: the backend sweeps them with UNKNOWN duration
   * (never fabricated), and their late note-offs would be orphan refusals —
   * so pending note-offs for released voices are dropped provably-unsent,
   * the notes are marked unknown-duration, and the count is surfaced.
   */
  private async resumeAfterReconnect(): Promise<void> {
    const reply = await this.rawRequest(
      "POST",
      "/v1/live/sessions/" + this.sessionId + "/resume",
      JSON.stringify({ last_acked: this.ackedCursor }),
      true
    );
    if (!this.consumeAuthFailure(reply)) {
      return;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      const env = reply.outcome === "ok" ? errorEnvelopeOf(reply) : null;
      const message =
        env !== null && (env.code === "backend_error" || env.code === "not_found")
          ? "the capture session no longer exists server-side (a restart began a fresh SoundCraft session)"
          : "resume did not answer — " + this.detail;
      if (env !== null && (env.code === "backend_error" || env.code === "not_found")) {
        // The old session is provably gone: retire its unsent notes honestly.
        const retired = this.retireUnsentNotes("session lost on reconnect");
        this.uncertainInFlight = false;
        this.pending = [];
        this.capturing = false;
        this.lastErrorCode = "session_gone";
        this.setPhase(
          "paired",
          "the capture session no longer exists server-side (a restart began a fresh SoundCraft session) — " +
            retired +
            " unsent event(s) retired (surfaced, never silent); recapture into a fresh session"
        );
      } else {
        this.setLastError("resume_unresolved", message + "; the journal reconcile settles anything the cursor covers");
        this.uncertainInFlight = true;
      }
      return;
    }
    const parsed = this.parseObject<{ cursor: number; releasedCount: number }>(reply.bodyText, (obj) => {
      // The REAL engine's resume reply (live/mod.rs) carries BOTH
      // `cursor` (the session's applied-event cursor) and
      // `journal_last_event_id` (the journal tail). Prefer the journal tail,
      // fall back to the session cursor, then a last_event_id echo — and
      // floor-max with OUR OWN last_acked (both counters are server-stated
      // and monotonic, so the max is provably safe). The released list is
      // never parsed for matching decisions: which pending note-offs are
      // dropped is decided by OUR OWN ack watermark below.
      let adopted = -1;
      if (isSafeInt(obj["journal_last_event_id"])) {
        adopted = obj["journal_last_event_id"] as number;
      } else if (isSafeInt(obj["cursor"])) {
        adopted = obj["cursor"] as number;
      } else if (isSafeInt(obj["last_event_id"])) {
        adopted = obj["last_event_id"] as number;
      } else {
        return { ok: false as const, problem: "resume reply had no cursor/journal_last_event_id/last_event_id" };
      }
      if (adopted < this.ackedCursor) {
        adopted = this.ackedCursor; // provably safe: the server counters only move forward
      }
      const released = obj["released"];
      const releasedCount = released !== null && released !== undefined && Array.isArray(released) ? released.length : 0;
      return { ok: true as const, value: { cursor: adopted, releasedCount: releasedCount } };
    });
    const resumeProblem = parseProblem(parsed);
    if (resumeProblem !== null) {
      this.setLastError("resume_shape", "resume reply not understood: " + resumeProblem + " — reconcile will settle the cursor");
      this.uncertainInFlight = true;
      return;
    }
    const resumeValue = expectParsed(parsed);
    this.ackedCursor = Math.max(this.ackedCursor, resumeValue.cursor);
    // Drop a pending note-off ONLY when its PAIRED note-on is proven applied
    // (noteOnEventId ≤ the adopted cursor) — the backend swept that voice at
    // resume, so the late off would be an orphan. Channel-agnostic by
    // construction (we match our own note records, not wire key/channel).
    // Pending note-offs whose PAIR is still unsent survive untouched.
    let sweptUnknown = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const ev = this.pending[i];
      if (ev.payload.type !== "noteOff") {
        continue;
      }
      let pairedNote: LocalNote | null = null;
      for (let n = 0; n < this.notes.length; n++) {
        if (this.notes[n].noteOffEventId === ev.eventId) {
          pairedNote = this.notes[n];
          break;
        }
      }
      if (pairedNote !== null && pairedNote.noteOnEventId > 0 && pairedNote.noteOnEventId <= this.ackedCursor) {
        this.pending.splice(i, 1);
        pairedNote.finished = true;
        pairedNote.durationNanos = null; // UNKNOWN — swept at resume, never fabricated
        sweptUnknown++;
      }
    }
    // Also close locally-held open notes: the resume swept EVERY held voice.
    for (const voiceKey in this.keyGeneration) {
      const open = this.keyGeneration[voiceKey];
      if (open !== undefined && open !== null) {
        open.finished = true;
        open.durationNanos = null; // UNKNOWN — honest, commit refuses until re-recorded
        sweptUnknown++;
        delete this.keyGeneration[voiceKey];
      }
    }
    this.drainAcked();
    if (sweptUnknown > 0) {
      this.logLine("resume swept " + sweptUnknown + " voice(s) to UNKNOWN duration (never fabricated); " + resumeValue.releasedCount + " held voice(s) listed by the backend");
    }
  }

  /** Retire unsent note events with a surfaced count (never a silent drop). */
  private retireUnsentNotes(reason: string): number {
    let retiredEvents = 0;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.state !== "acked") {
        n.state = "acked"; // terminal: nothing further will be sent for them
        n.retired = true; // provably absent from the backend take
        retiredEvents += n.noteOffEventId > 0 ? 2 : n.noteOnEventId > 0 ? 1 : 0;
      }
    }
    this.notesUnknownRetired += retiredEvents > 0 ? 1 : 0;
    this.retiredUnsentNotes += retiredEvents;
    this.logLine(reason + " — retired " + retiredEvents + " unsent event(s); total retired " + this.retiredUnsentNotes);
    return retiredEvents;
  }

  private notesUnknownRetired = 0;
  private retiredUnsentNotes = 0;
  private retiredRefusedEvents = 0;
  private uncapturedHits = 0;
  private leftBehindTakes = 0;
  private simulationAuthority = false;
  private transportAnchorSamples = -1; // the anchor the simulation was armed at (-1 = never)
  private projectNote = ""; // bootstrap outcome for the UI (no credentials)
  private trackEndSamples: { [key: string]: number } = {}; // authoritative clip ends per track (name AND id keys)
  private lastCommitEndSamples = -1; // the engine-echoed `end` of the last landed clip
  private lastNoteActivityNanos = 0; // idle-phrase clock
  private bootstrapDone = false; // once per pairing
  private captureBlocked = false;
  // ---- commit/rollover boundary: no silent loss ------------------------------
  // Hits that land while a commit is in flight (or a landed commit awaits its
  // rollover) MUST NOT enter the already-committed take: they are buffered for
  // the NEXT take (bounded) and transferred with fresh event ids once the new
  // session is open — intra-phrase timing preserved, nothing fabricated,
  // nothing replayed, overflow counted.
  private nextTakeBuffer: BufferedHit[] = [];
  private bufferedVoice: { [voiceKey: string]: BufferedHit } = {};
  private policyDurationNs: { [voiceKey: string]: number } = {}; // declared per-pad SAMPLE-DURATION POLICY
  private noteSeq = 0; // generation-exact note handles
  private stuckTimeoutSamples = -1; // REAL int from the live_open reply (-1 = backend did not expose it)
  private sampleRate = -1; // REAL int from the live_open reply
  private stuckNegotiated = false; // the open request carried stuck_timeout_seconds and was accepted
  private maxDeclaredPolicyNs = 0; // the largest registered declared duration (coverage check)
  private sentNoteOns: Array<{ handle: number; tsNs: number }> = []; // this session's sent note-on timeline (sweep-substitution model)
  private notCapturableNotes = 0; // long-sample notes rejected BEFORE sending (retained locally, visible)
  private nonFaithfulNotes = 0; // notes the engine substituted with its stuck-note policy bound (commit withheld — not exact)
  private staleFinishesIgnored = 0; // finishNote(handle) calls naming an already-closed generation
  private policyClosedNotes = 0; // notes closed by the labelled SAMPLE-DURATION POLICY
  private notCapturableLongNs = 0; // the declared duration of the most recent not-capturable note (status)
  private bufferingActive = false;
  private flushBusy = false; // a flush/reconcile request is in flight (commit gate)
  private reconcileBusy = false;
  private commitWanted = false; // a commit trigger was withheld by the drain gate; fires when clean
  private rolloverDeferred = false; // a landed commit awaits a CLEAN queue before close/open
  private captureBlockedReason = "";
  private ingestRefusalStreak = 0;
  private autoCommitLatched = false;
  private commitPosted = false; // one commit POST per take, ever
  private rolloverScheduledFor = 0; // guard: exactly one rollover per committed take
  private rollover: Promise<void> = Promise.resolve();

  /** Test/observability hook: resolves when background close/reopen chains settle. */
  quiesce(): Promise<void> {
    return this.rollover;
  }

  private setBearer(token: string): void {
    const t = this.transportAsBearer();
    if (t !== null) {
      t.bearerToken = token;
    }
  }

  private clearBearer(): void {
    const t = this.transportAsBearer();
    if (t !== null) {
      t.bearerToken = null;
    }
  }

  private transportAsBearer(): BearerCapableTransport | null {
    const t = this.env.transport as BearerCapableTransport;
    if (t === null || t === undefined) {
      return null;
    }
    return t;
  }

  // ---- capabilities ----------------------------------------------------------

  private capabilitiesKnown = false;
  // The authoritative server commit bound. null (or the flag false) means the
  // capabilities reply did NOT carry a well-formed max_notes_per_commit — the
  // ceiling then falls back to the configured threshold and is SURFACED as
  // unverified. A value above 999 is treated as malformed (a bound must never
  // RAISE the client past its known-safe configured ceiling).
  private serverMaxNotesPerCommit: number | null = null;
  private serverCapAuthoritative = false;
  private takeCaptureSupported = true;
  private takeToClipSupported = true;
  private automaticSavingSupported = true;
  private recoverySupported = true;

  async refreshCapabilities(): Promise<boolean> {
    if (!this.cfg.onlineMode) {
      return false;
    }
    if (!this.hasToken) {
      return false; // unpaired: capabilities are a privileged read — never sent
    }
    const reply = await this.rawRequest("GET", "/v1/capabilities", null, true);
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      if (reply.outcome === "ok") {
        const env = errorEnvelopeOf(reply);
        this.setLastError(
          env !== null ? env.code : "http_" + reply.status,
          "capabilities unavailable: " + (env !== null ? env.message : "HTTP " + reply.status) + " — capture stays local until this answers"
        );
      }
      return false;
    }
    const parsed = this.parseObject<CapabilitiesCore>(reply.bodyText, (obj) => {
      const supported = obj["supported"];
      if (supported === null || typeof supported !== "object") {
        return { ok: false as const, problem: "capabilities reply had no supported map" };
      }
      const limits = obj["limits"];
      let maxNotes: number | null = null; // UNKNOWN unless well-formed — never a silent 999 default
      if (limits !== null && typeof limits === "object") {
        const v = (limits as { [key: string]: unknown })["max_notes_per_commit"];
        if (isSafeInt(v) && (v as number) > 0 && (v as number) <= 999) {
          maxNotes = v as number; // a bound above 999 is malformed: it must never RAISE the ceiling
        }
      }
      const opSupported = (name: string): boolean => {
        const op = (supported as { [key: string]: unknown })[name];
        if (op === null || typeof op !== "object") {
          return false;
        }
        return (op as { [key: string]: unknown })["supported"] === true;
      };
      return {
        ok: true as const,
        value: {
          noteCapture: opSupported("note_capture"),
          takeToClip: opSupported("take_to_clip"),
          automaticSaving: opSupported("automatic_saving"),
          recovery: opSupported("recovery"),
          maxNotesPerCommit: maxNotes,
          transport: obj["transport"],
        },
      };
    });
    const capsProblem = parseProblem(parsed);
    if (capsProblem !== null) {
      this.setLastError("capabilities_shape", "capabilities reply not understood: " + capsProblem);
      return false;
    }
    const caps = expectParsed(parsed);
    this.takeCaptureSupported = caps.noteCapture;
    this.takeToClipSupported = caps.takeToClip;
    this.automaticSavingSupported = caps.automaticSaving;
    this.recoverySupported = caps.recovery;
    this.serverMaxNotesPerCommit = caps.maxNotesPerCommit;
    this.serverCapAuthoritative = caps.maxNotesPerCommit !== null;
    if (!this.serverCapAuthoritative) {
      // FAIL CLOSED, VISIBLY: without a well-formed server bound the ceiling is
      // the configured threshold (already clamped below 999) — and the status
      // says so. If a bank-active backend ever refuses an over-cap commit, the
      // take is PRESERVED (events stay in the session; the refusal surfaces).
      this.setLastError(
        "commit_cap_unverified",
        "the capabilities reply carries no well-formed max_notes_per_commit — the commit ceiling falls back to the configured " +
          this.cfg.autoCommitNotes + " notes and is NOT verified against the backend"
      );
    }
    // The transport advertisement: the capabilities reply names
    // transport.mode === "headless_simulation_only" when (and only when) the
    // labelled headless simulation exists. That advertisement — never an
    // assumption — is what authorises the client's constrained simulation
    // arming below. No real-audio or real-clock claim is made anywhere.
    const transportCap = caps.transport;
    this.simulationAuthority =
      transportCap !== null &&
      typeof transportCap === "object" &&
      (transportCap as { [key: string]: unknown })["mode"] === "headless_simulation_only";
    this.capabilitiesKnown = true;
    if (!caps.noteCapture) {
      this.setLastError(
        "unsupported_operation",
        "the connected backend does not support note capture — local monitor continues; nothing will be claimed as captured"
      );
      return false;
    }
    return true;
  }

  // ---- capture session -------------------------------------------------------

  /**
   * Open a fresh capture session (a new generation ⇒ a new session id). The
   * numeric trackId is resolved STRICTLY from the take readback before any
   * event is built — if it cannot be proven, capture is blocked with an
   * explicit reason instead of guessing a track.
   */
  async startCapture(trackRef: string | number): Promise<boolean> {
    this.currentTrackRef = trackRef;
    if (!this.cfg.onlineMode) {
      this.beginLocalTake();
      this.setPhase("local_only", "JUDGE MODE local take running — capture is local-only, never backend-labelled");
      return true;
    }
    if (this.capturing) {
      return true;
    }
    if (!this.tokenLive()) {
      if (!this.tokenEverIssued) {
        // NEVER PAIRED: awaiting a one-time code — honestly NOT a token expiry.
        this.setPhase("awaiting_pair", "enter one-time code supplied for this session");
      } else {
        this.setPhase("token_expired", "token expired — pair again (queued notes are kept)");
      }
      return false;
    }
    if (!this.serverCapAuthoritative) {
      // P1-2 FAIL CLOSED (parent choice): no backend admission without an
      // authoritative max_notes_per_commit — notes stay local (bounded
      // buffer, visibly unsynced) until the companion advertises the cap.
      this.setLastError("commit_cap_unverified", "capture refuses to open a backend session — the server cap is unverified (no well-formed max_notes_per_commit); notes stay buffered locally, the local monitor still plays them");
      return false;
    }
    if (this.capabilitiesKnown && !this.takeCaptureSupported) {
      this.setLastError("unsupported_operation", "the connected backend does not support note capture — refusing to open a capture session (local monitor continues)");
      return false;
    }
    if (this.pending.length > 0 || this.uncertainInFlight) {
      // DEFENSE-IN-DEPTH: startCapture must never reset a queue holding
      // unresolved captured events — refuse with the data intact.
      this.setLastError("start_blocked_unresolved", "startCapture refused — " + this.pending.length + " unresolved event(s) are still syncing and an unobserved reply may be outstanding; nothing was closed or reset");
      return false;
    }
    if (this.captureBlocked) {
      this.setLastError("capture_blocked", "capture is latched off for this session: " + this.captureBlockedReason);
      return false;
    }
    // THE LABELLED HEADLESS SIMULATION (constrained mode): arm the append
    // anchor BEFORE opening — note capture refuses with ClockStopped while the
    // transport is stopped, and the engine's clock anchors the take at the
    // armed position. Authorised ONLY by the capabilities advertisement
    // (transport.mode === "headless_simulation_only"); never claims real
    // audio or a real clock; never touches a desktop transport or user data.
    // Without the advertisement this refuses — nothing is faked.
    if (this.capabilitiesKnown && !this.simulationAuthority) {
      this.setLastError("no_simulation_authority", "the companion does not advertise the labelled headless transport simulation (transport.mode = headless_simulation_only) — note capture cannot be armed; nothing was faked");
      return false;
    }
    if (!(await this.armTransportAt(this.computeAppendAnchor()))) {
      return false;
    }
    let generation = this.sessionGeneration;
    let openedSessionId = -1;
    let openedBodyText = "";
    // PR17: each fresh open REQUESTS the stuck-note window
    // (stuck_timeout_seconds, default 2.0 s — fits the declared one-shot
    // durations with headroom). An OLD companion rejects the field with a
    // validation error: retry ONCE without it (progressive safeguard) and
    // surface that long samples need a compatible backend — never a silent
    // 1 s retry that would claim exactness.
    let requestStuckTimeout = this.cfg.requestedStuckTimeoutSeconds > 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      generation++;
      const sessionIdAttempt = generation;
      const openBody: { [key: string]: unknown } = { session: sessionIdAttempt, track: trackRef };
      if (requestStuckTimeout) {
        openBody["stuck_timeout_seconds"] = this.cfg.requestedStuckTimeoutSeconds;
      }
      const openReply = await this.rawRequest(
        "POST",
        "/v1/live/sessions",
        JSON.stringify(openBody),
        true
      );
      if (!this.consumeAuthFailure(openReply)) {
        return false;
      }
      if (openReply.outcome !== "ok") {
        this.handleRequestFailure(openReply, "open capture session");
        return false;
      }
      if (openReply.status === 200) {
        openedSessionId = sessionIdAttempt;
        openedBodyText = openReply.bodyText;
        break;
      }
      const openEnv = errorEnvelopeOf(openReply);
      const openMessage = openEnv !== null ? openEnv.message : "";
      if (
        requestStuckTimeout &&
        (openReply.status === 422 || openReply.status === 400) &&
        openEnv !== null &&
        (openEnv.code === "validation_error" ||
          openMessage.indexOf("stuck_timeout") !== -1 ||
          JSON.stringify(openEnv.details !== undefined ? openEnv.details : "").indexOf("stuck_timeout") !== -1)
      ) {
        // OLD companion: the stuck-timeout request field is not supported.
        // Progressive safeguard: retry ONCE without the field — the session
        // then runs the engine's 1 s default window, so LONG-DECLARED notes
        // are conservatively retained (visible) and never a false 1 s clip.
        // The status names the compatible-backend requirement.
        requestStuckTimeout = false;
        this.stuckNegotiated = false;
        this.logLine("this companion does not support stuck_timeout_seconds (needs a PR17-compatible backend) — retrying the open without it; long-declared notes stay retained");
        continue;
      }
      if (openEnv !== null && openEnv.code === "backend_error" && openMessage.indexOf("is already open") !== -1) {
        this.leftBehindTakes++;
        this.logLine(
          "session id " + sessionIdAttempt + " is already open on the backend (a previous take was left there — " +
          "it is NOT resumed and NOT discarded): trying the next id (" + (5 - attempt - 1) + " attempts left)"
        );
        continue;
      }
      this.handleRequestFailure(openReply, "open capture session");
      return false;
    }
    if (openedSessionId < 0) {
      this.setLastError("open_ids_exhausted", "every candidate session id is already open on the backend (" + this.leftBehindTakes + " left-behind take(s) counted) — the operator should close them or restart the companion; nothing was resumed or discarded");
      return false;
    }
    const sessionId = openedSessionId;
    let openTrackId = -1;
    const parsedOpen = this.parseObject<{ session: number; track: number }>(openedBodyText, (obj) => {
      if (!isSafeInt(obj["session"]) || (obj["session"] as number) !== sessionId) {
        return { ok: false as const, problem: "open reply did not confirm our session id" };
      }
      // The REAL engine's open reply carries the RESOLVED numeric track id
      // (live/mod.rs: json!({"session", "track": resolve_track(...), …})).
      if (!isSafeInt(obj["track"]) || (obj["track"] as number) < 0) {
        return { ok: false as const, problem: "open reply did not expose the resolved numeric track id" };
      }
      return { ok: true as const, value: { session: sessionId, track: obj["track"] as number } };
    });
    const openProblem = parseProblem(parsedOpen);
    if (openProblem !== null) {
      this.setLastError("open_shape", "open reply not understood: " + openProblem);
      return false;
    }
    openTrackId = expectParsed(parsedOpen).track;
    // The REAL stuck-note window ints (engine-declared in the same reply —
    // never a capability guess). Unknown ⇒ surfaced; policy notes are then
    // conservatively retained (not sent) until the window is knowable.
    const parsedLimits = this.parseObject<{ stuck: number; rate: number }>(openedBodyText, (obj) => {
      const hasStuck = isSafeInt(obj["stuck_timeout_samples"]) && (obj["stuck_timeout_samples"] as number) > 0;
      const hasRate = isSafeInt(obj["sample_rate"]) && (obj["sample_rate"] as number) > 0;
      if (!hasStuck || !hasRate) {
        return { ok: false as const, problem: "open reply lacked stuck_timeout_samples/sample_rate" };
      }
      return {
        ok: true as const,
        value: { stuck: obj["stuck_timeout_samples"] as number, rate: obj["sample_rate"] as number },
      };
    });
    const limitsProblem = parseProblem(parsedLimits);
    if (limitsProblem === null) {
      const limits = expectParsed(parsedLimits);
      this.stuckTimeoutSamples = limits.stuck;
      this.sampleRate = limits.rate;
      this.stuckNegotiated = requestStuckTimeout; // the accepted open carried the requested window
    } else {
      this.stuckTimeoutSamples = -1;
      this.sampleRate = -1;
      this.logLine("open reply carried no stuck-note window ints — long-declared notes are retained (not sent) until the window is knowable");
    }
    this.sentNoteOns = [];
    // Cross-verify against the take readback: two independent reads must agree
    // before any event is built with the id. No readback ⇒ no trackId ⇒ no events.
    const trackResolved = await this.resolveTrackId(sessionId);
    if (!trackResolved) {
      return false;
    }
    if (this.trackId !== openTrackId) {
      this.setLastError("track_mismatch", "the open reply (track " + openTrackId + ") and the take readback (track " + this.trackId + ") disagree — refusing to guess which is real; capture blocked");
      return false;
    }
    this.sessionGeneration = generation;
    this.sessionId = sessionId;
    this.originNanos = this.env.realtimeNanos();
    this.notes = [];
    this.pending = [];
    this.nextEventId = 1;
    this.ackedCursor = 0;
    this.uncertainInFlight = false;
    this.keyGeneration = {};
    // NOTE: commitReceipt is NOT reset here — it is the standing EVIDENCE of
    // the last landed commit (surfaced until the next commit replaces it).
    // The per-take "already committed" gate is commitPosted.
    this.commitAwaitingReadback = false;
    this.commitPollTries = 0;
    this.commitPosted = false; // a fresh take may commit exactly once
    this.commitWanted = false; // a stale withheld trigger from the OLD take must never fire on the fresh one
    this.autoCommitLatched = false;
    this.captureBlocked = false;
    this.captureBlockedReason = "";
    this.ingestRefusalStreak = 0;
    this.rolloverScheduledFor = 0;
    this.lastNoteActivityNanos = this.env.realtimeNanos();
    this.capturing = true;
    this.beginLocalTake();
    this.setPhase("capturing", "capture session " + sessionId + " open on track id " + this.trackId + " (timing: one monotonic lens clock, no drift correction claimed)");
    // Any hits buffered across the commit/rollover boundary transfer NOW, as
    // fresh event ids of THIS take (provably never sent — no replay, no loss).
    this.transferBufferedIntoFreshTake();
    return true;
  }

  /**
   * Move the bounded next-take buffer into the freshly opened session: fresh
   * event ids (these events were NEVER sent — provably not a replay), real
   * durations (finishAbs − onsetAbs, exactly as performed), and intra-phrase
   * deltas preserved; the earliest buffered note lands a small fixed offset
   * after the new origin — the between-boundary gap is POLICY (the same
   * append-anchor rule as the transport), never a measured continuity claim.
   * Unfinished held notes transfer open and pair with their real finish later.
   */
  private transferBufferedIntoFreshTake(): void {
    if (this.nextTakeBuffer.length === 0) {
      this.bufferingActive = false;
      return;
    }
    const entries = this.nextTakeBuffer.splice(0, this.nextTakeBuffer.length);
    for (const v in this.bufferedVoice) {
      delete this.bufferedVoice[v];
    }
    // EXACT-FIDELITY GATE at transfer: hits whose declared policy exceeds the
    // engine's stuck window, or whose finished span already exceeds it, are
    // NOT capturable with exact fidelity — retained (counted), never enqueued.
    const faithful: BufferedHit[] = [];
    for (const b of entries) {
      const longPolicy = b.policyNs > 0 && this.stuckKnown() && b.policyNs > this.stuckWindowNs();
      const longSpan = b.finished && this.stuckKnown() && b.finishAbsNanos - b.onsetAbsNanos > this.stuckWindowNs();
      if (longPolicy || longSpan) {
        this.notCapturableNotes++;
        this.logLine("buffered hit retained at transfer — exceeds the stuck window (not capturable with exact fidelity); count " + this.notCapturableNotes);
        continue;
      }
      faithful.push(b);
    }
    if (faithful.length === 0) {
      this.bufferingActive = false;
      this.lastNoteActivityNanos = this.env.realtimeNanos();
      return;
    }
    const kept = faithful;
    let earliest = Infinity;
    for (const b of kept) {
      if (b.onsetAbsNanos < earliest) {
        earliest = b.onsetAbsNanos;
      }
    }
    const BASE_OFFSET_NS = 50_000_000; // the transferred phrase starts 50 ms into the new take
    let lastRel = BASE_OFFSET_NS;
    for (const b of kept) {
      const relOnset = Math.max(1, (b.onsetAbsNanos - earliest) + BASE_OFFSET_NS);
      const note: LocalNote = {
        instrument: b.instrument,
        pad: b.pad,
        key: b.key,
        channel: b.channel,
        velocity: b.velocity,
        handle: ++this.noteSeq,
        onsetAbsNanos: this.originNanos + relOnset, // the transferred phrase's performed position (policy deadlines anchor here)
        policyNs: b.policyNs, // the pad's policy carries across the boundary
        durationSource: b.finished ? "trusted" : "none",
        notCapturable: false,
        nonFaithful: false,
        onsetNanos: relOnset,
        durationNanos: b.finished ? Math.max(1, b.finishAbsNanos - b.onsetAbsNanos) : null, // the REAL delta, unmodified
        finished: b.finished,
        state: "local",
        retired: false,
        noteOnEventId: 0,
        noteOffEventId: 0,
      };
      this.notes.push(note);
      this.queueNoteOn(note);
      if (b.finished) {
        this.queueNoteOff(note); // pairs with the fresh note-on id; real duration preserved
        lastRel = Math.max(lastRel, relOnset + note.durationNanos);
      } else {
        // Still held at the boundary: transfer OPEN — the real finish pairs
        // later through keyGeneration (no sweep, no fabricated length); the
        // carried policy still closes it if the pad declared one.
        this.keyGeneration[b.channel + ":" + b.key] = note;
      }
    }
    this.bufferingActive = false;
    this.lastNoteActivityNanos = this.originNanos + lastRel; // the idle boundary measures from the transferred phrase's end
    this.logLine("transferred " + entries.length + " buffered hit(s) into the fresh take — fresh ids, intra-phrase timing preserved (boundary gap is policy)");
  }

  /**
   * A typed commit REFUSAL means the take was NOT committed: the buffered
   * hits belong to the still-open session — deliver them back at their exact
   * original session-relative times (nothing shifted, nothing lost).
   */
  private deliverBufferedBackToCurrentTake(): void {
    if (this.nextTakeBuffer.length === 0) {
      return;
    }
    const entries = this.nextTakeBuffer.splice(0, this.nextTakeBuffer.length);
    for (const v in this.bufferedVoice) {
      delete this.bufferedVoice[v];
    }
    for (const b of entries) {
      const relOnset = Math.max(1, b.onsetAbsNanos - this.originNanos); // the ORIGINAL session-relative time — exact
      const note: LocalNote = {
        instrument: b.instrument,
        pad: b.pad,
        key: b.key,
        channel: b.channel,
        velocity: b.velocity,
        handle: ++this.noteSeq,
        onsetAbsNanos: this.originNanos + relOnset,
        policyNs: b.policyNs,
        durationSource: b.finished ? "trusted" : "none",
        notCapturable: false,
        nonFaithful: false,
        onsetNanos: relOnset,
        durationNanos: b.finished ? Math.max(1, b.finishAbsNanos - b.onsetAbsNanos) : null,
        finished: b.finished,
        state: "local",
        retired: false,
        noteOnEventId: 0,
        noteOffEventId: 0,
      };
      this.notes.push(note);
      this.queueNoteOn(note);
      if (b.finished) {
        this.queueNoteOff(note);
      } else {
        this.keyGeneration[b.channel + ":" + b.key] = note;
      }
    }
    this.logLine("delivered " + entries.length + " buffered hit(s) BACK into the still-open uncommitted take at their original times (the refusal left the take intact)");
  }

  private async resolveTrackId(sessionId: number): Promise<boolean> {
    const takeReply = await this.rawRequest("GET", "/v1/live/sessions/" + sessionId + "/take", null, true);
    if (!this.consumeAuthFailure(takeReply)) {
      return false;
    }
    if (takeReply.outcome !== "ok" || takeReply.status !== 200) {
      this.handleRequestFailure(takeReply, "resolve track id via take readback");
      return false;
    }
    const parsedTake = this.parseTakeReply(takeReply.bodyText);
    const takeProblem = parseProblem(parsedTake);
    if (takeProblem !== null) {
      this.setLastError("take_shape", "take readback not understood: " + takeProblem);
      return false;
    }
    const takeValue = expectParsed(parsedTake);
    if (!isSafeInt(takeValue.session) || (takeValue.session as number) !== sessionId) {
      this.setLastError("take_shape", "take readback answered for a different session — refusing to use it; capture blocked");
      return false;
    }
    if (!isSafeInt(takeValue.track) || (takeValue.track as number) < 0) {
      this.setLastError("track_unresolved", "take readback did not expose a numeric track id — refusing to guess one; capture blocked");
      return false;
    }
    this.trackId = takeValue.track as number;
    return true;
  }

  /**
   * Stop capture and release held voices. An uncommitted take is NEVER closed
   * silently: without an explicit `{ discardUncommitted: true }` a take that
   * holds completed/queued work is left OPEN and the refusal is surfaced (the
   * caller may commit-and-wait, or pass the explicit discard, which retires
   * the unsent work with visible counters before closing). A take whose
   * commit already landed (or an empty one) closes without any flag.
   */
  async stopCapture(opts?: { discardUncommitted?: boolean }): Promise<boolean> {
    // Never race a scheduled close/open of a committed take: the rollover may
    // already be closing this session and opening the next one. Settle it
    // FIRST, then evaluate what is actually open — no double close.
    await this.rollover;
    if (!this.capturing) {
      return true;
    }
    if (!this.cfg.onlineMode) {
      this.capturing = false;
      this.setPhase("local_only", "local take stopped (judge mode — nothing was sent anywhere)");
      return true;
    }
    const hasUncommittedWork = this.completedNoteCount() > 0 || this.pending.length > 0 || this.heldCount() > 0;
    if (hasUncommittedWork && this.commitReceipt === null && !(opts !== undefined && opts.discardUncommitted === true)) {
      this.setLastError(
        "uncommitted_take",
        "capture session " + this.sessionId + " holds an UNCOMMITTED take (" + this.completedNoteCount() + " completed note(s), " + this.pending.length + " queued event(s), " + this.heldCount() + " held) — it was NOT closed. Commit it first, or call stopCapture({ discardUncommitted: true }) to abandon it explicitly (the abandoned work is retired with visible counters)",
      );
      return false;
    }
    if (hasUncommittedWork && this.commitReceipt === null) {
      this.retireUnsentNotes("explicit discard of the uncommitted take");
    }
    const sessionId = this.sessionId;
    const reply = await this.rawRequest("DELETE", "/v1/live/sessions/" + sessionId, null, true);
    this.capturing = false;
    this.keyGeneration = {};
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      // Uncertain close: the id is dead locally either way (never reused), so
      // no later take can be confused with this one.
      this.handleRequestFailure(reply, "close capture session (session id retired locally regardless)");
      return false;
    }
    this.setPhase("paired", "capture session " + sessionId + " closed; held voices released");
    return true;
  }


  // ---- safe project bootstrap (recover only a demonstrably empty document) --

  /**
   * After the FIRST pairing: if the companion proves recovery+automatic-saving
   * support and its project store holds saves, decide from the AUTHORITATIVE
   * inspect reply whether the live document is demonstrably empty (zero clips
   * on every track). Recover ONLY then — the fresh process would otherwise
   * capture over nothing and the operator's saved material would stay on disk
   * unopened. A document with ANY material is NEVER auto-recovered (a blind
   * recover would replace a live document): the actionable state is surfaced
   * and the explicit explicitOpenLastSave() remains the operator's action.
   * An unparseable inspect can't prove emptiness → no recover, surfaced.
   */
  private async bootstrapProject(): Promise<void> {
    if (!this.cfg.onlineMode || !this.capabilitiesKnown) {
      return;
    }
    if (!this.recoverySupported || !this.automaticSavingSupported) {
      this.projectNote = "recovery or automatic saving is not supported by this companion — nothing to restore";
      return;
    }
    const saves = await this.fetchSavesQuiet();
    if (saves === null) {
      this.projectNote = "the saves listing did not answer — recovery not attempted";
      return;
    }
    if (saves.count === 0) {
      this.projectNote = "no saved sessions in the project store yet — starting from the live document";
      return;
    }
    const inspect = await this.fetchInspectQuiet();
    if (inspect === null) {
      this.projectNote =
        "the project store holds " + saves.count + " save(s) but the document state could not be read — " +
        "NOT recovering automatically; use the explicit open-last-save action";
      this.lastErrorCode = "bootstrap_unproven";
      return;
    }
    // "Empty" is the AUTHORITATIVE fresh-document marker: a EMPTY TRACKS ARRAY
    // (tracks: []). Zero clips on existing tracks is NOT emptiness — those
    // tracks can carry instrument plugins, mixer settings and manual edits
    // that were never saved; auto-recovering would silently replace them. If
    // tracks exist at all → NO automatic recover (the explicit
    // explicitOpenLastSave() remains the operator's action); if the inspect
    // cannot be parsed → fail closed, no recover, surfaced.
    if (inspect.totalTracks > 0) {
      this.projectNote =
        "the live document already holds " + inspect.totalTracks + " track(s) (" + inspect.totalClips +
        " clip(s)) — NOT recovering over it (saves exist: " + saves.count + "); use the explicit open-last-save action";
      this.lastErrorCode = "bootstrap_material_present";
      return;
    }
    // tracks: [] + saves exist + recovery proved: a genuinely fresh document.
    await this.performRecover("document has no tracks (fresh)");
  }

  /** The explicit operator action: open the newest save regardless of emptiness. */
  async explicitOpenLastSave(): Promise<boolean> {
    return await this.performRecover("explicit open-last-save");
  }

  private async performRecover(reason: string): Promise<boolean> {
    const reply = await this.rawRequest("POST", "/v1/live/recover", JSON.stringify({}), true);
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      const env = reply.outcome === "ok" ? errorEnvelopeOf(reply) : null;
      this.setLastError(
        env !== null ? env.code : "recover_failed",
        "recover (" + reason + ") refused: " + (env !== null ? env.message : "HTTP " + reply.status)
      );
      return false;
    }
    const parsed = this.parseObject<{ name: string }>(reply.bodyText, (obj) => {
      const save = obj["save"];
      if (save === null || typeof save !== "object") {
        return { ok: false as const, problem: "recover reply had no save object" };
      }
      const name = (save as { [key: string]: unknown })["name"];
      if (typeof name !== "string" || name.length === 0) {
        return { ok: false as const, problem: "recover reply save had no basename" };
      }
      return { ok: true as const, value: { name: name } };
    });
    const problem = parseProblem(parsed);
    if (problem !== null) {
      this.setLastError("recover_shape", "recover reply not understood: " + problem);
      return false;
    }
    const name = expectParsed(parsed).name;
    this.projectNote = "recovered the newest save (" + name + ") — " + reason;
    this.logLine("recovered " + name + " (" + reason + ")");
    // The recovered document REPLACES the live one: the append anchors must
    // follow the RECOVERED material (authoritative re-inspect) — for EVERY
    // recover path, bootstrap and explicit alike.
    await this.refreshTrackEndsQuiet();
    return true;
  }

  private async fetchSavesQuiet(): Promise<{ count: number } | null> {
    const reply = await this.rawRequest("GET", "/v1/live/saves", null, true);
    if (!this.consumeAuthFailure(reply)) {
      return null;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      return null; // 501 unsupported surfaced elsewhere; not fatal here
    }
    const parsed = this.parseSavesReply(reply.bodyText);
    const problem = parseProblem(parsed);
    if (problem !== null) {
      return null;
    }
    return { count: expectParsed(parsed).length };
  }

  /**
   * GET /v1/session/inspect?detail=summary — the AUTHORITATIVE document read.
   * Strict parse of tracks[].clips[] (clip objects carry start/end in the
   * engine's inspect reply); records per-track max clip end (name AND numeric
   * id keys) for the append anchor, or null when the reply cannot be proven.
   */
  private async fetchInspectQuiet(): Promise<{ totalTracks: number; totalClips: number; tracksWithClips: number } | null> {
    const reply = await this.rawRequest("GET", "/v1/session/inspect?detail=summary", null, true);
    if (!this.consumeAuthFailure(reply)) {
      return null;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      return null;
    }
    const parsed = this.parseObject<{ totalTracks: number; totalClips: number; tracksWithClips: number }>(reply.bodyText, (obj) => {
      const tracks = obj["tracks"];
      if (tracks === null || tracks === undefined || !Array.isArray(tracks)) {
        return { ok: false as const, problem: "inspect reply had no tracks array" };
      }
      const ends: { [key: string]: number } = {};
      let totalTracks = tracks.length;
      let totalClips = 0;
      let tracksWithClips = 0;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i] as { [key: string]: unknown };
        const clips = t["clips"];
        if (clips === null || clips === undefined || !Array.isArray(clips)) {
          return { ok: false as const, problem: "inspect track " + i + " had no clips array" };
        }
        let trackEnd = -1;
        for (let c = 0; c < clips.length; c++) {
          const clip = clips[c] as { [key: string]: unknown };
          if (!isSafeInt(clip["end"])) {
            return { ok: false as const, problem: "inspect clip " + c + " on track " + i + " had no numeric end" };
          }
          totalClips++;
          if ((clip["end"] as number) > trackEnd) {
            trackEnd = clip["end"] as number;
          }
        }
        if (trackEnd >= 0) {
          tracksWithClips++;
          if (typeof t["name"] === "string") {
            ends[t["name"] as string] = Math.max(ends[t["name"] as string] !== undefined ? ends[t["name"] as string] : -1, trackEnd);
          }
          if (isSafeInt(t["id"])) {
            ends["#" + (t["id"] as number)] = Math.max(ends["#" + (t["id"] as number)] !== undefined ? ends["#" + (t["id"] as number)] : -1, trackEnd);
          }
        }
      }
      this.trackEndSamples = ends;
      return { ok: true as const, value: { totalTracks: totalTracks, totalClips: totalClips, tracksWithClips: tracksWithClips } };
    });
    const problem = parseProblem(parsed);
    if (problem !== null) {
      this.setLastError("inspect_shape", "inspect reply not understood: " + problem + " — anchors cannot be proven from it");
      return null;
    }
    return expectParsed(parsed);
  }

  /** Refresh the authoritative clip ends WITHOUT the emptiness decision. */
  private async refreshTrackEndsQuiet(): Promise<void> {
    await this.fetchInspectQuiet();
  }

  /**
   * The append anchor for the NEXT session: the earliest sample position that
   * cannot overlap existing material on the capture track — the maximum clip
   * `end` the backend itself reports (bootstrap inspect after recover; the
   * landed commit receipt's `end` after each take), never below the previous
   * anchor. BETWEEN-PHRASE POLICY (explicit, no drift/continuity claims):
   * APPEND — each new take's first note-on maps to this position via the
   * labelled headless simulation; performed timing INSIDE a phrase is
   * preserved exactly (session-relative timestamps, engine-clock-mapped);
   * the gap BETWEEN phrases is a policy boundary, not measured time.
   */
  private computeAppendAnchor(): number {
    let anchor = 0;
    const ref = this.currentTrackRef;
    const byName = typeof ref === "string" ? this.trackEndSamples[ref] : undefined;
    const byId = this.trackId >= 0 ? this.trackEndSamples["#" + this.trackId] : undefined;
    if (byName !== undefined && byName > anchor) {
      anchor = byName;
    }
    if (byId !== undefined && byId > anchor) {
      anchor = byId;
    }
    if (this.lastCommitEndSamples > anchor) {
      anchor = this.lastCommitEndSamples;
    }
    if (this.transportAnchorSamples > anchor) {
      anchor = this.transportAnchorSamples;
    }
    return anchor;
  }

  /**
   * Arm the labelled headless simulation at the append anchor. ONLY ever
   * called when the capability advertisement (`transport.mode ===
   * "headless_simulation_only"`) authorises it; never claims real audio, a
   * real clock, or touches any desktop transport or user data.
   */
  private async armTransportAt(anchor: number): Promise<boolean> {
    if (!this.simulationAuthority) {
      this.setLastError("no_simulation_authority", "the companion does not advertise the labelled headless transport simulation — capture cannot be armed safely; nothing was faked");
      return false;
    }
    if (!isSafeInt(anchor) || anchor < 0) {
      this.setLastError("anchor_invalid", "append anchor " + anchor + " is not a safe sample position — refusing to arm the transport");
      return false;
    }
    const reply = await this.rawRequest(
      "POST",
      "/v1/live/transport/simulate",
      JSON.stringify({ playing: true, position: anchor }),
      true
    );
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      this.handleRequestFailure(reply, "arm the labelled headless simulation at " + anchor);
      return false;
    }
    const parsed = this.parseObject<{ position: number }>(reply.bodyText, (obj) => {
      // The real handler echoes {playing, position}; when the reply omits them
      // we proceed WITHOUT claiming verification (the anchor evidence is the
      // commit contract's overlap check, not this echo).
      if (!isSafeInt(obj["position"])) {
        return { ok: true as const, value: { position: -1 } };
      }
      return { ok: true as const, value: { position: obj["position"] as number } };
    });
    const problem = parseProblem(parsed);
    if (problem !== null) {
      this.setLastError("simulate_shape", "simulation reply not understood: " + problem);
      return false;
    }
    const echoed = expectParsed(parsed).position;
    if (echoed >= 0 && echoed !== anchor) {
      this.setLastError("anchor_mismatch", "the simulation holds position " + echoed + " but the append anchor is " + anchor + " — refusing to capture (overlap would be unprovable)");
      return false;
    }
    this.transportAnchorSamples = anchor;
    return true;
  }


  // ---- note capture (called by the capture controller) -----------------------

  /**
   * A pad was hit: the real note-on, timed on the monotonic lens clock.
   * `channel` is the Lens's own MIDI channel convention (beat = 9, melodic = 0).
   * While no capture session is open (rollover in flight, or the next open
   * failed), the hit is COUNTED as uncaptured — surfaced, never silent.
   */
  noteOn(instrument: string, pad: number, key: number, velocity: number, channel: number): number {
    if (velocity <= 0 || velocity > 127) {
      // Velocity 0 is refused at commit (indistinguishable from note-off);
      // refuse locally with the same honesty instead of clamping.
      this.logLine("refused note-on with velocity " + velocity + " (0 is a note-off; >127 invalid)");
      return -1;
    }
    if (channel < 0 || channel > 15) {
      this.logLine("refused note-on with channel " + channel + " (0..15 only)");
      return -1;
    }
    const handle = ++this.noteSeq;
    // THE RUNTIME COMMIT-CAP GATE (authoritative server max_notes_per_commit —
    // never a hardcoded 999/990 guess). Over-budget or UNKNOWN-cap hits are
    // NEVER discarded: they route into the bounded NEXT-TAKE buffer with full
    // identity (instrument/pad/key/channel/velocity, absolute onset, measured
    // duration from a later noteOff/finish — the same buffering contract as a
    // commit boundary) and transfer into a fresh take with fresh event ids
    // once the old take has committed (or once a valid cap arrives). Buffer
    // overflow is honestly uncapturedHits — never a fake "retained"/"saved".
    if (this.cfg.onlineMode && !this.bufferingActive && !this.captureBlocked) {
      const capUnknown = !this.serverCapAuthoritative;
      const overBudget = this.capturing && this.serverCapAuthoritative && this.takeNoteFootprint() + 1 > this.commitNoteCeiling();
      if (capUnknown || overBudget) {
        if (overBudget && this.commitGatesOpen()) {
          // The slice is at the ceiling and committable RIGHT NOW: start the
          // commit — the hit buffers below and lands in the fresh take.
          this.logLine("take reached the commit-note ceiling " + this.commitNoteCeiling() + " (server max_notes_per_commit " + this.serverMaxNotesPerCommit + ") — committing; the new hit buffers for the next take");
          void this.commitTake();
        }
        this.bufferHitForNextTake(handle, instrument, pad, key, channel, velocity, capUnknown ? "the server cap is UNVERIFIED (no backend admission without an authoritative max_notes_per_commit)" : "the take is at the commit-note ceiling " + this.commitNoteCeiling());
        return handle;
      }
    }
    if (this.cfg.onlineMode && this.bufferingActive) {
      // A commit is in flight (or a landed commit awaits its rollover): this
      // hit belongs to the NEXT take. Buffer it (bounded) — never into the
      // already-committed take, never dropped silently, never fabricated.
      this.bufferHitForNextTake(handle, instrument, pad, key, channel, velocity, "the commit settles");
      return handle;
    }
    if (this.cfg.onlineMode && (!this.capturing || this.captureBlocked)) {
      // No open session can receive this note (rollover in flight / next open
      // failed / capture latched): COUNT it — never a silent drop.
      this.uncapturedHits++;
      this.logLine("hit NOT captured (no open capture session) — count " + this.uncapturedHits + "; the local monitor still played it");
      return handle;
    }
    const voiceKey = channel + ":" + key;
    const declaredNs = this.policyDurationNs[voiceKey] !== undefined ? this.policyDurationNs[voiceKey] : 0;
    const previous = this.keyGeneration[voiceKey];
    const nowNanos = this.env.realtimeNanos();
    // EXACT-FIDELITY PRE-SEND GATE (real ints from live_open): a declared
    // duration LONGER than the engine's stuck-note window cannot be captured
    // faithfully — the engine closes such notes at exactly the window (BY ITS
    // OWN POLICY) the moment any later note-on sweeps past, substituting a
    // non-faithful 1 s-class note. Rejected BEFORE SENDING: retained locally
    // (visible, counted), the local monitor unaffected — no false 1 s clip.
    if (
      declaredNs > 0 &&
      (!this.stuckKnown() || declaredNs > this.stuckWindowNs())
    ) {
      this.notCapturableNotes++;
      this.notCapturableLongNs = declaredNs;
      this.logLine(
        "declared duration " + Math.round(declaredNs / 1e9 * 1000) / 1000 + " s exceeds the engine's stuck-note window (" +
        Math.round(this.stuckWindowNs() / 1e9 * 1000) / 1000 + " s) — NOT capturable with exact fidelity; retained locally (count " +
        this.notCapturableNotes + "); the local monitor still played it"
      );
      return handle;
    }
    if (previous !== undefined && previous !== null) {
      // Retrigger cuts the previous sound: its audible end is NOW (real,
      // observed, client-issued) — a CUT, not a measured natural callback.
      // EXACT-FIDELITY CHECK: if the cut lands beyond the stuck window, the
      // new note-on (sent immediately after the cut-off) runs the engine's
      // mid-session sweep FIRST — the previous voice closes at exactly the
      // window (BY THE ENGINE'S OWN POLICY) and the cut-off would orphan.
      // Retain the cut-off (never send a non-faithful note-off), mark the
      // substitution, surface — and still open the new hit: the local
      // monitor keeps playing and capture continues for capturable notes.
      const cutRel = this.sessionRelative(nowNanos);
      const cutSpan = cutRel - previous.onsetNanos;
      // The FIFO EXCEPTION (provable): the engine's NoteOff arm NEVER sweeps —
      // a cut-off processed before the new note-on closes the previous voice
      // at its TRUE cut offset, faithful even beyond the window. The cut is
      // only non-faithful when an earlier QUEUED note-on (any voice) already
      // sits at ≥ prev.onset + window — that on triggered the mid-session
      // sweep which substituted the previous note (window-length policy
      // bound), and the cut-off would orphan. Unsent/retained ons never swept
      // ⇒ excluded; unconfirmed ons are ambiguous ⇒ treated as swept.
      const sweptByEarlier = this.sentNoteOns.some(
        (o) => o.handle !== previous.handle && o.tsNs >= previous.onsetNanos + this.stuckWindowNs()
      );
      if (this.stuckKnown() && cutSpan > this.stuckWindowNs() && sweptByEarlier) {
        previous.finished = true;
        previous.durationNanos = this.stuckWindowNs(); // the engine's substituted policy bound
        previous.durationSource = "cut";
        previous.nonFaithful = true;
        this.nonFaithfulNotes++;
        delete this.keyGeneration[voiceKey];
        this.setLastError("nonfaithful_note", "a retrigger landed after a previous note exceeded the stuck-note window with an interleaved note-on — the engine substitutes it with the window-length policy note; the cut was NOT sent and exact-fidelity commits are withheld");
      } else {
        // FIFO exception: [cut-off, new-on] in one ordered batch closes the
        // previous voice at its TRUE cut — full fidelity, exactly as performed.
        this.finishOpenNote(previous, nowNanos, "cut");
      }
    }
    const note: LocalNote = {
      instrument: instrument,
      pad: pad,
      key: key,
      channel: channel,
      velocity: velocity,
      handle: handle,
      onsetAbsNanos: nowNanos,
      policyNs: declaredNs,
      durationSource: "none",
      notCapturable: declaredNs > 0 && this.stuckKnown() && declaredNs > this.stuckWindowNs(),
      nonFaithful: false,
      onsetNanos: this.sessionRelative(nowNanos),
      durationNanos: null,
      finished: false,
      state: "local",
      retired: false,
      noteOnEventId: 0,
      noteOffEventId: 0,
    };
    this.notes.push(note);
    this.keyGeneration[voiceKey] = note;
    this.lastNoteActivityNanos = nowNanos;
    this.queueNoteOn(note);
    // Any OTHER still-held note that THIS note-on's sweep now substitutes
    // (held ≥ window at this onset) is marked non-faithful: the engine closes
    // it at exactly the window BY POLICY, so its future note-off would orphan
    // — retained (never sent), commit gate engages until explicitly resolved.
    for (const vk in this.keyGeneration) {
      const z = this.keyGeneration[vk];
      if (z === undefined || z === null || z.handle === note.handle) {
        continue;
      }
      const heldRel = this.sessionRelative(nowNanos) - z.onsetNanos;
      if (this.stuckKnown() && heldRel >= this.stuckWindowNs()) {
        z.finished = true;
        z.durationNanos = this.stuckWindowNs();
        z.durationSource = "cut";
        z.nonFaithful = true;
        this.nonFaithfulNotes++;
        delete this.keyGeneration[vk];
      }
    }
    return handle;
  }

  /**
   * TRUSTED pad-owner signal: the pad owner (driver / a future per-play
   * generation-mapped binding) asserts THIS voice's current sound ended now.
   * The runtime `setOnFinish` is deliberately NEVER forwarded here (it fires
   * on manual stop with no generation identity — untrusted, see the P1
   * investigation in SoundcraftCaptureController). Closes the CURRENT open
   * generation on the voice with its real observed end time.
   */
  noteFinished(key: number, channel: number): void {
    const voiceKey = channel + ":" + key;
    const note = this.keyGeneration[voiceKey];
    if (note === undefined || note === null) {
      // A note held in the NEXT-TAKE buffer (hit during a commit boundary):
      // complete it with its REAL finish time — no fabricated duration.
      const buffered = this.bufferedVoice[voiceKey];
      if (buffered !== undefined && buffered !== null && !buffered.finished) {
        buffered.finished = true;
        buffered.finishAbsNanos = this.env.realtimeNanos();
        this.lastNoteActivityNanos = buffered.finishAbsNanos;
        delete this.bufferedVoice[voiceKey];
      }
      return;
    }
    const nowNanos = this.env.realtimeNanos();
    this.lastNoteActivityNanos = nowNanos;
    const finishRel = this.sessionRelative(nowNanos);
    if (!this.trustedSpanFaithful(note, finishRel)) {
      // The engine's mid-session sweep (triggered by a later note-on at
      // ≥ onset + window) has ALREADY substituted this note with the stuck
      // policy bound — the off would orphan. Retain: never send it, mark the
      // note non-faithful (the engine holds a window-length policy note, not
      // the performed length), withhold exact-fidelity commits, surface.
      note.finished = true;
      note.durationNanos = this.stuckKnown() ? this.stuckWindowNs() : null; // the engine's substituted bound (or unknown if unknowable)
      note.durationSource = "none";
      note.nonFaithful = true;
      this.nonFaithfulNotes++;
      delete this.keyGeneration[voiceKey];
      this.setLastError(
        "nonfaithful_note",
        "a note exceeded the engine's stuck-note window AND another note-on forced its policy substitution — the off was NOT sent and the take cannot be saved with exact fidelity (withheld); the local monitor kept playing"
      );
      return;
    }
    this.finishOpenNote(note, nowNanos, "trusted");
  }

  /**
   * GENERATION-EXACT finish: closes ONLY the note named by its handle. A call
   * naming an already-closed (stale) generation — e.g. a delayed runtime
   * stop-callback for a retriggered sound, at +1 ms or +5 s — is provably
   * identified, IGNORED, and counted: it can never close a different
   * generation, never fabricate a ~0 duration, never fake a save.
   */
  finishNote(handle: number): boolean {
    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.handle === handle) {
        if (note.finished) {
          this.staleFinishesIgnored++;
          this.logLine("stale finish for note " + handle + " IGNORED (already closed — stale callbacks can never close another generation); ignored count " + this.staleFinishesIgnored);
          return false;
        }
        const nowNanos = this.env.realtimeNanos();
        this.lastNoteActivityNanos = nowNanos;
        const finishRel = this.sessionRelative(nowNanos);
        if (!this.trustedSpanFaithful(note, finishRel)) {
          note.finished = true;
          note.durationNanos = this.stuckKnown() ? this.stuckWindowNs() : null;
          note.durationSource = "none";
          note.nonFaithful = true;
          this.nonFaithfulNotes++;
          delete this.keyGeneration[note.channel + ":" + note.key];
          this.setLastError("nonfaithful_note", "a note exceeded the stuck-note window and was policy-substituted — its off was NOT sent; exact-fidelity commits withheld");
          return false;
        }
        this.finishOpenNote(note, nowNanos, "trusted");
        return true;
      }
    }
    // Not found among captured notes: an unknown/very-old generation (or a
    // transferred note whose handle was re-issued at the boundary). It can
    // never close anything — ignored and counted, same as a stale finish.
    this.staleFinishesIgnored++;
    this.logLine("finish for unknown handle " + handle + " IGNORED (cannot close another generation); ignored count " + this.staleFinishesIgnored);
    return false;
  }

  /**
   * Register the pad's declared SAMPLE-DURATION POLICY (the one-shot asset's
   * own declared duration, from AudioComponent.duration — an engine-declared
   * fact, explicitly labelled as a POLICY and never claimed as a measured
   * natural-callback measurement). A note on this voice that is not closed by
   * a retrigger cut or a trusted finish closes at exactly onset + policy.
   */
  /**
   * The REAL stuck-note window in nanoseconds, from the live_open reply's own
   * ints (stuck_timeout_samples / sample_rate — engine-declared, never
   * guessed). -1 when the backend did not expose them.
   */
  private stuckWindowNs(): number {
    if (this.stuckTimeoutSamples <= 0 || this.sampleRate <= 0) {
      return -1;
    }
    return Math.round((this.stuckTimeoutSamples * 1e9) / this.sampleRate);
  }

  private stuckKnown(): boolean {
    return this.stuckTimeoutSamples > 0 && this.sampleRate > 0;
  }

  /**
   * Exact-fidelity span check against the REAL engine window: a note whose
   * on→off span fits entirely inside the window is captured faithfully. A
   * span beyond the window is faithful ONLY when solo (no later note-on
   * forced the engine's mid-session sweep — the sweep runs on note-ons, not
   * note-offs); overlapped long spans are substituted by the engine's
   * stuck-note policy bound (1 s) — NOT exact, commit withheld.
   */
  private trustedSpanFaithful(note: LocalNote, finishRelNanos: number): boolean {
    if (!this.stuckKnown()) {
      return true; // engine-verbatim honesty downstream (no window to reason about)
    }
    const span = finishRelNanos - note.onsetNanos;
    if (span <= this.stuckWindowNs()) {
      return true;
    }
    // Beyond the window: faithful only if NO OTHER queued/sent note-on (this
    // note's own on never sweeps itself) sits at ≥ onset + window — such an
    // on triggers the engine's mid-session sweep which substitutes this note
    // with the window-length policy bound (never measured). Unsent/retained
    // ons never swept ⇒ excluded. An on whose batch is still unconfirmed is
    // ambiguous ⇒ treated as swept (conservative, never understates).
    const swept = this.sentNoteOns.some(
      (o) => o.handle !== note.handle && o.tsNs >= note.onsetNanos + this.stuckWindowNs()
    );
    return !swept;
  }

  setPadPolicyDurationNs(key: number, channel: number, durationNs: number): void {
    if (!isSafeInt(durationNs) || durationNs <= 0) {
      return; // no usable declared duration: the note stays held/unknown honestly
    }
    this.policyDurationNs[channel + ":" + key] = durationNs;
    if (durationNs > this.maxDeclaredPolicyNs) {
      this.maxDeclaredPolicyNs = durationNs;
    }
  }

  private finishOpenNote(note: LocalNote, atAbsNanos: number, source: "trusted" | "policy" | "cut"): void {
    note.finished = true;
    // Duration from ABSOLUTE monotonic clock times (finishAbs − onsetAbs): the
    // REAL delta, immune to session-origin changes at rollover boundaries.
    note.durationNanos = Math.max(1, atAbsNanos - note.onsetAbsNanos);
    note.durationSource = source;
    if (source === "policy") {
      this.policyClosedNotes++;
    }
    delete this.keyGeneration[note.channel + ":" + note.key];
    this.queueNoteOff(note);
    this.maybeAutoCommit(false);
  }

  private sessionRelative(realtimeNanos: number): number {
    return Math.max(0, realtimeNanos - this.originNanos);
  }

  private buildEvent(payload: WireEvent["payload"], timestampNanos: number): WireEvent {
    return {
      sessionId: this.sessionId,
      eventId: this.nextEventId++,
      surfaceId: this.currentSurfaceId,
      trackId: this.trackId,
      timestampNs: timestampNanos,
      payload: payload,
    };
  }

  private currentSurfaceId = 0;

  private queueNoteOn(note: LocalNote): void {
    if (!this.capturing || this.trackId < 0 || note.notCapturable) {
      return; // local take only / not capturable with exact fidelity — nothing is claimed
    }
    this.currentSurfaceId = surfaceIdFor(note.instrument);
    if (this.pending.length >= this.cfg.pendingEventQueueMax) {
      // Bounded queue: overflow is COUNTED and surfaced, never dropped silently.
      this.overflowDroppedNotes++;
      this.logLine("capture queue full — hit not queued for backend (count " + this.overflowDroppedNotes + "); local monitor unaffected");
      return;
    }
    const ev = this.buildEvent(
      { type: "noteOn", channel: note.channel, key: note.key, velocity: note.velocity },
      note.onsetNanos
    );
    note.state = "queued";
    note.noteOnEventId = ev.eventId;
    this.sentNoteOns.push({ handle: note.handle, tsNs: note.onsetNanos }); // queued = will be sent FIFO (the sweep model's sent side)
    this.pending.push(ev);
  }

  private queueNoteOff(note: LocalNote): void {
    if (!this.capturing || this.trackId < 0 || note.notCapturable) {
      return;
    }
    if (note.state === "local") {
      // Its note-on never entered the queue — a note-off alone would be an
      // orphan (refused by the backend). Everything ALREADY queued or acked
      // MUST still deliver its off: acked-then-finished is the COMMON case
      // (one-shot samples outlive the flush interval).
      return;
    }
    if (this.pending.length >= this.cfg.pendingEventQueueMax) {
      this.overflowDroppedNotes++;
      // The note-on is queued; without its note-off the backend holds the
      // voice (a finalize sweep marks it unknown duration — honestly refused
      // at commit, never fabricated).
      this.logLine("capture queue full — note-off not queued (voice will sweep unknown; count " + this.overflowDroppedNotes + ")");
      return;
    }
    const ev = this.buildEvent(
      { type: "noteOff", channel: note.channel, key: note.key },
      note.onsetNanos + (note.durationNanos !== null ? note.durationNanos : 0)
    );
    note.noteOffEventId = ev.eventId;
    this.pending.push(ev);
  }

  // ---- the pump: flush batches, reconcile uncertainty, settle commits -------

  /** Called each frame (throttled by the controller) — the ONLY network driver. */
  async pump(): Promise<void> {
    if (this.busy) {
      return;
    }
    const now = this.env.nowSecs();
    if (now < this.retryNotBeforeSecs) {
      return;
    }
    if (this.cfg.onlineMode && this.hasToken && !this.tokenLive() && this.phase !== "token_expired") {
      this.setPhase("token_expired", "token reached its bounded lifetime — pair again (queued notes are kept)");
      return;
    }
    if (!this.cfg.onlineMode) {
      this.refreshPlaylistLocalOnly();
      return;
    }
    this.busy = true;
    try {
      if (this.uncertainInFlight) {
        await this.reconcile();
      } else if (this.capturing && this.pending.length > 0 && now - this.lastFlushSecs >= this.cfg.flushIntervalSeconds) {
        await this.flushBatch();
      }
      if (this.commitAwaitingReadback) {
        await this.pollCommitReadback();
      }
      if (this.pendingSaveRetrySessionId > 0 && now - this.lastFlushSecs >= this.cfg.commitPollIntervalSeconds) {
        await this.scopedSaveRetry();
      }
      // The IDLE PHRASE boundary: after the last note activity has settled for
      // idlePhraseSeconds (all KNOWN note-offs are in — the held/unknown gates
      // below still refuse an uncommittable slice), commit the phrase. This is
      // what makes ordinary short playing save without any manual action; the
      // note-count ceiling trigger stays as the bounded-slice backstop.
      if (
        this.cfg.idlePhraseSeconds > 0 &&
        this.lastNoteActivityNanos > 0 &&
        this.env.realtimeNanos() - this.lastNoteActivityNanos >= this.cfg.idlePhraseSeconds * 1e9
      ) {
        this.maybeAutoCommit(true);
      }
      // The SAMPLE-DURATION POLICY sweep: an open note whose declared policy
      // deadline has passed closes at EXACTLY onset + policy (deterministic,
      // generation-exact, no callbacks involved). Also applies to buffered
      // boundary hits so the buffer never holds a note past its own policy.
      this.sweepPolicyClosures();
      // A commit withheld by the drain gate fires the moment the queue is
      // clean; a landed commit's rollover waits for the same cleanliness.
      if (this.commitWanted && this.commitGatesOpen()) {
        this.commitWanted = false;
        void this.commitTake();
      }
      if (this.rolloverDeferred && this.rolloverCanProceed()) {
        this.rolloverDeferred = false;
        this.scheduleRolloverOnce();
      }
      if (now - this.lastSavesRefreshSecs >= this.cfg.savesRefreshIntervalSeconds) {
        await this.refreshSaves();
      }
    } finally {
      this.busy = false;
    }
  }

  private async flushBatch(): Promise<void> {
    this.lastFlushSecs = this.env.nowSecs();
    if (!this.capturing || this.pending.length === 0 || this.captureBlocked) {
      return; // capture latched: nothing is POSTed for this session any more
    }
    const batch = this.pending.slice(0, Math.min(this.cfg.captureBatchMaxEvents, this.pending.length));
    const reply = await this.rawRequest(
      "POST",
      "/v1/live/sessions/" + this.sessionId + "/events",
      JSON.stringify({ events: batch }),
      true
    );
    if (!this.consumeAuthFailure(reply)) {
      return;
    }
    if (reply.outcome === "deadline" || reply.outcome === "network_error") {
      // Reply not observed: the batch MAY have applied. Never resend blindly —
      // reconcile via the journal first.
      this.uncertainInFlight = true;
      this.setLastError(
        reply.outcome === "deadline" ? "ingest_unobserved" : "offline",
        reply.outcome === "deadline"
          ? "ingest reply not observed in time — reconciling via journal before anything is resent"
          : "companion unreachable (" + reply.problem + ") — notes stay queued, nothing is dropped"
      );
      if (reply.outcome === "network_error") {
        this.setPhase(this.capturing ? "capturing" : this.phase, "offline — capture continues locally; " + this.pending.length + " event(s) queued");
      }
      return;
    }
    if (reply.status !== 200) {
      await this.handleIngestRefusal(reply, batch);
      return;
    }
    const parsed = this.parseObject<IngestReply>(reply.bodyText, (obj) => {
      if (!isSafeInt(obj["cursor"]) || !isSafeInt(obj["accepted"])) {
        return { ok: false as const, problem: "ingest reply missing accepted/cursor" };
      }
      return {
        ok: true as const,
        value: { accepted: obj["accepted"] as number, cursor: obj["cursor"] as number },
      };
    });
    const ingestProblem = parseProblem(parsed);
    if (ingestProblem !== null) {
      // A malformed success is an uncertainty, not an ack.
      this.uncertainInFlight = true;
      this.setLastError("ingest_shape", "ingest reply not understood: " + ingestProblem + " — reconciling via journal");
      return;
    }
    const ingestValue = expectParsed(parsed);
    this.ackedCursor = Math.max(this.ackedCursor, ingestValue.cursor);
    // A well-formed success reply is itself the authoritative observation:
    // uncertainty is cleared without needing the journal readback.
    this.uncertainInFlight = false;
    this.ingestRefusalStreak = 0;
    this.drainAcked();
    if (ingestValue.accepted !== batch.length) {
      this.logLine("ingest accepted " + ingestValue.accepted + " of " + batch.length + " (cursor " + ingestValue.cursor + ")");
    }
  }


  /**
   * A non-200 ingest reply. Semantics come from the REAL engine
   * (crates/automation/src/live/mod.rs, `ingest`): a batch is parsed and
   * validated WHOLE before anything applies, then events apply in order and a
   * failing event stops the batch with the accepted prefix journaled ("N
   * accepted before it") — and a ClockStopped head is STILL journaled
   * (journal.append precedes take.record). So:
   *  - validation_error (422): the WHOLE batch is provably refused → retire
   *    it with counters + the verbose reason (resending proven-dead events
   *    would be a poison loop).
   *  - backend_error (400): reconcile the journal ONCE → drain the applied
   *    prefix; if the head of the refused batch is still unadopted it is the
   *    proven refusal point → retire it (+ its paired events) with the
   *    reason; the unattempted rest stays deliverable. Three consecutive
   *    refusals latch capture off (reason surfaced, remainder retired) — no
   *    infinite POST storm.
   *  - 401/429/503 keep their own paths: nothing is retired on an
   *    unobserved/unavailable backend — those events are not proven dead.
   */
  private async handleIngestRefusal(reply: TransportReply, batch: WireEvent[]): Promise<void> {
    const env = errorEnvelopeOf(reply);
    const code = env !== null ? env.code : "http_" + reply.status;
    const message = env !== null ? env.message : "HTTP " + reply.status;
    if (code === "too_many_requests" || reply.status === 503 || reply.status === 401) {
      // Unproven outcomes keep their dedicated handling; nothing is retired.
      this.setLastError(code, "ingest not applied: " + message);
      return;
    }
    const headId = batch.length > 0 ? batch[0].eventId : -1;
    if (code === "validation_error") {
      // Validated WHOLE before anything applies (live/mod.rs): every event of
      // this batch is provably refused. Retire the batch — never resend.
      const removed = this.retireEvents(new Set(batch.map((e) => e.eventId)), "validation_error: " + message);
      this.setLastError("validation_error", "ingest batch provably refused whole (validated before applying) — " + removed + " event(s) retired with their paired notes: " + message);
      return;
    }
    // 400 backend_error (and anything else typed): reconcile the journal ONCE
    // before any resend, then classify the refusal by the engine's OWN stable
    // contract — the failing event is reported as
    // "events[i]: … (N accepted before it)" (live/mod.rs, verbatim format):
    //  * the accepted prefix (indices < N) is journaled — the journal cursor
    //    adopts it (drained by the reconcile above);
    //  * the event at index N was attempted and failed: if the cursor ADOPTED
    //    its id, the engine journaled it despite the failure (ClockStopped:
    //    journal append precedes take.record) — nothing is provably dead, do
    //    not retire; if the cursor did NOT adopt it, it was attempted, refused,
    //    and NOT journaled — provably dead → retire it with its paired events.
    //  * events after index N were never attempted — they stay deliverable.
    // Reconcile the journal ONCE first: the applied prefix is provably in the
    // backend (ids ≤ cursor) — drained here — and the cursor position is what
    // tells a journaled-despite-failure head from a refused-and-dead one.
    const cursorBefore = this.ackedCursor;
    await this.reconcile();
    if (this.uncertainInFlight) {
      // The journal did not answer: nothing is proven — keep everything queued
      // (no resend, no retirement). The next pump reconciles again instead.
      return;
    }
    const acceptedMatch = /([0-9]+) accepted before it/.exec(message);
    let refusalIndex = -1;
    if (acceptedMatch !== null) {
      const parsedAccepted = parseInt(acceptedMatch[1], 10);
      if (isSafeInt(parsedAccepted) && parsedAccepted >= 0 && parsedAccepted < batch.length) {
        refusalIndex = parsedAccepted;
      }
    }
    if (refusalIndex >= 0) {
      const refusalEvent = batch[refusalIndex];
      if (refusalEvent.eventId > this.ackedCursor) {
        // Attempted, refused, NOT journaled: provably dead. Retire it (with
        // its paired events) — resending would hit the identical refusal.
        const retireIds: Set<number> = new Set<number>([refusalEvent.eventId]);
        if (refusalEvent.payload.type === "noteOn") {
          for (let n = 0; n < this.notes.length; n++) {
            if (this.notes[n].noteOnEventId === refusalEvent.eventId && this.notes[n].noteOffEventId > 0) {
              retireIds.add(this.notes[n].noteOffEventId);
            }
          }
        }
        const removed = this.retireEvents(retireIds, "backend_error: " + message);
        this.setLastError("ingest_refused", "ingest refused at event " + refusalEvent.eventId + " (index " + refusalIndex + " of the batch) — " + removed + " event(s) retired with their paired notes: " + message);
      }
      // (Adopted-by-journal case: nothing is retired — the event lives in the
      // backend journal even though the take never recorded it.)
    }
    this.ingestRefusalStreak++;
    if (this.ingestRefusalStreak >= 3) {
      // LATCH: three consecutive refused batches — capture is not working for
      // this session (e.g. the transport never plays). Retire the remainder
      // with the reason and stop POSTing: no storm, no silent discard.
      const remaining = new Set<number>(this.pending.map((e) => e.eventId));
      const removed = this.retireEvents(remaining, "capture latched after 3 refused batches: " + message);
      this.captureBlocked = true;
      this.captureBlockedReason = "ingest refused " + this.ingestRefusalStreak + " time(s) in a row — the last refusal: " + message + "; " + removed + " queued event(s) retired (counted)";
      this.setLastError("capture_blocked", this.captureBlockedReason);
    }
  }

  /**
   * Remove the named events from the pending queue as PROVABLY REFUSED:
   * counters go up, paired notes are marked so their state stays coherent
   * (a retired note-on retires its note-off and vice versa), and nothing is
   * resent. Every removal is counted in retiredRefusedEvents.
   */
  private retireEvents(eventIds: Set<number>, reason: string): number {
    let removed = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const ev = this.pending[i];
      if (!eventIds.has(ev.eventId)) {
        continue;
      }
      this.pending.splice(i, 1);
      removed++;
      this.retiredRefusedEvents++;
      for (let n = 0; n < this.notes.length; n++) {
        const note = this.notes[n];
        if (note.noteOnEventId === ev.eventId || note.noteOffEventId === ev.eventId) {
          note.state = "acked"; // terminal: nothing further will be sent for it
          note.retired = true; // PROVABLY absent from the backend take — excluded from the commit gates
          // PROVABLY never applied ⇒ it never triggered a sweep: remove from
          // the sent-onset model so later cut decisions stay exact.
          for (let si = this.sentNoteOns.length - 1; si >= 0; si--) {
            if (this.sentNoteOns[si].handle === note.handle) {
              this.sentNoteOns.splice(si, 1);
            }
          }
          if (note.noteOffEventId === ev.eventId) {
            // The on was applied but this off was refused: the voice stays
            // open server-side (swept to UNKNOWN duration later — honestly
            // refused at commit). Still held → keep it OUT of the gates.
            note.durationNanos = null;
            note.finished = true;
          }
          delete this.keyGeneration[note.channel + ":" + note.key];
          break;
        }
      }
    }
    if (removed > 0) {
      this.logLine("retired " + removed + " event(s) as provably refused (" + reason + "); total retired " + this.retiredRefusedEvents);
    }
    return removed;
  }

  /** Drop queued events the backend journal provably holds (eventId ≤ cursor). */
  private drainAcked(): void {
    while (this.pending.length > 0 && this.pending[0].eventId <= this.ackedCursor) {
      const ev = this.pending.shift();
      if (ev !== undefined && ev !== null && ev.payload.type === "noteOff") {
        this.markNoteAcked(ev.eventId);
      } else if (ev !== undefined && ev !== null && ev.payload.type === "noteOn") {
        this.markNoteOnAcked(ev.eventId);
      }
    }
  }

  private markNoteOnAcked(eventId: number): void {
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].noteOnEventId === eventId) {
        this.notes[i].state = "acked";
        return;
      }
    }
  }

  private markNoteAcked(eventId: number): void {
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].noteOffEventId === eventId) {
        this.notes[i].state = "acked";
        return;
      }
    }
  }

  /**
   * Resolve a lost ingest reply with the backend journal: everything with
   * eventId ≤ the server's cursor is provably applied (ids strictly increase);
   * ONLY the remainder is resent. Note-ons are never replayed on reconnect.
   */
  private async reconcile(): Promise<void> {
    if (this.reconcileBusy) {
      return;
    }
    this.reconcileBusy = true;
    try {
      await this.reconcileInner();
    } finally {
      this.reconcileBusy = false;
    }
  }

  private async reconcileInner(): Promise<void> {
    const reply = await this.rawRequest(
      "GET",
      "/v1/live/sessions/" + this.sessionId + "/journal?since=" + this.ackedCursor,
      null,
      true
    );
    if (!this.consumeAuthFailure(reply)) {
      return;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      if (reply.outcome === "deadline" || reply.outcome === "network_error") {
        this.setLastError("reconcile_unresolved", "journal readback unanswered — staying unsynced, resending nothing");
      } else {
        const env = errorEnvelopeOf(reply);
        this.setLastError("reconcile_refused", "journal readback refused: " + (env !== null ? env.message : "HTTP " + reply.status));
      }
      return;
    }
    const parsed = this.parseObject<{ maxSeen: number }>(reply.bodyText, (obj) => {
      const events = obj["events"];
      if (events === null || events === undefined || !Array.isArray(events)) {
        return { ok: false as const, problem: "journal reply had no events array" };
      }
      let maxSeen = this.ackedCursor;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i] as { [key: string]: unknown };
        if (isSafeInt(ev["eventId"]) && (ev["eventId"] as number) > maxSeen) {
          maxSeen = ev["eventId"] as number;
        }
      }
      return { ok: true as const, value: { maxSeen: maxSeen } };
    });
    const journalProblem = parseProblem(parsed);
    if (journalProblem !== null) {
      this.setLastError("journal_shape", "journal reply not understood: " + journalProblem + " — staying unsynced");
      return;
    }
    const journalValue = expectParsed(parsed);
    this.ackedCursor = Math.max(this.ackedCursor, journalValue.maxSeen);
    const before = this.pending.length;
    this.drainAcked();
    this.uncertainInFlight = false;
    this.setLastError("", "reconciled — journal cursor " + this.ackedCursor + "; " + (before - this.pending.length) + " event(s) confirmed applied, " + this.pending.length + " still to send");
  }

  // ---- commit ----------------------------------------------------------------

  /**
   * Commit the take to ONE editable MIDI clip, then confirm the save. The
   * POST is sent EXACTLY ONCE per take: uncertainty is settled by the take
   * readback (the receipt appears there once landed) or by `already_committed`
   * carrying the receipt — never by stacking another commit.
   */
  async commitTake(): Promise<boolean> {
    if (!this.cfg.onlineMode) {
      this.setLastError("local_only", "judge mode — no commit is claimed; the take stays local-only");
      return false;
    }
    if (!this.serverCapAuthoritative) {
      // P1-2 FAIL CLOSED: no guessed commit against an unknown server bound.
      // The take's notes stay preserved locally (pending/buffered, visibly
      // unsynced) until the companion advertises a well-formed cap.
      this.setLastError("commit_cap_unverified", "NO COMMIT — the server cap is unverified (no well-formed max_notes_per_commit); the take's notes stay preserved locally and visibly unsynced");
      return false;
    }
    if (!this.capturing) {
      this.setLastError("not_capturing", "no open capture session to commit");
      return false;
    }
    if (this.commitPosted) {
      return false; // EXACTLY ONE commit POST per take, ever — even after
      // polls give up, even as new note-offs arrive, even after a refusal.
    }
    if (this.nonFaithfulNotes > 0) {
      // A note was substituted by the engine's stuck-note policy bound: the
      // take cannot be saved with exact fidelity — refusing is the honest
      // answer (never claim an exact saved note that is not exact).
      this.setLastError("nonfaithful_note", "commit withheld — the take contains a note the engine substituted with its stuck-note policy bound (not the performed length); discard the take explicitly or wait for a configurable-timeout backend");
      return false;
    }
    // THE DRAIN GATE: a commit goes out only when EVERY captured event of this
    // take is synced (applied + acked) and no flush/reconcile is in flight —
    // otherwise the committed-take rollover would reset unsent events (silent
    // loss). A trigger that fires while the queue is unresolved is WITHHELD
    // (commitWanted): the pump fires it the moment the queue is clean. No
    // notes are dropped or retired by this gate — ever.
    if (this.pending.length > 0 || this.uncertainInFlight || this.flushBusy || this.reconcileBusy) {
      this.commitWanted = true;
      this.setLastError(
        "commit_queue_not_drained",
        "commit withheld — " + this.pending.length + " captured event(s) are not synced yet" +
        (this.uncertainInFlight ? " and an unobserved reply is being reconciled" : "") +
        "; the queue drains first, then the commit goes out (nothing is dropped)"
      );
      return false;
    }
    if (!this.takeToClipSupported) {
      this.setLastError("unsupported_operation", "the connected backend cannot take-to-clip — nothing is faked");
      return false;
    }
    if (this.commitInFlight) {
      return false; // exactly one commit POST per take, ever
    }
    this.commitInFlight = true;
    this.commitPosted = true; // the POST is going out once; every later gate reads this
    this.bufferingActive = true; // hits from NOW belong to the NEXT take (bounded buffer, honest display)
    this.setPhase("commit_pending", "commit sent once — outcome settles via the take readback");
    const reply = await this.rawRequest(
      "POST",
      "/v1/live/sessions/" + this.sessionId + "/take/commit",
      JSON.stringify({}),
      true
    ).finally(() => {
      this.commitInFlight = false;
    });
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok") {
      // Outcome unknown. Never resend the POST: poll the readback.
      this.commitAwaitingReadback = true;
      this.commitPollTries = 0;
      this.setPhase("commit_unknown", "commit reply not observed (" + reply.problem + ") — settling via the take readback, not resending");
      return false;
    }
    if (reply.status === 409) {
      return this.handleCommitConflict(reply);
    }
    if (reply.status !== 200) {
      const env = errorEnvelopeOf(reply);
      const code = env !== null ? env.code : "http_" + reply.status;
      const message = env !== null ? env.message : "commit refused (HTTP " + reply.status + ")";
      this.lastErrorCode = code;
      if (reply.status === 503 && code === "backend_busy") {
        // Pending, not failed: a commit may be in flight — settle via readback.
        this.commitAwaitingReadback = true;
        this.commitPollTries = 0;
        this.setPhase("commit_unknown", "backend busy — a commit may be in flight; the take readback settles it");
        return false;
      }
      if (reply.status === 504 && code === "commit_timeout") {
        // The companion's OWN HTTP bound spoke first: the outcome is UNKNOWN
        // (the backend may still land it). Never re-POST — settle via the
        // take readback; the receipt path schedules the rollover when it lands.
        this.commitAwaitingReadback = true;
        this.commitPollTries = 0;
        this.setPhase("commit_unknown", "the companion timed the commit out (504 commit_timeout) — its outcome is unknown; the take readback settles it, no blind retry");
        return false;
      }
      // Engine refusals arrive verbatim (open notes, UNKNOWN durations,
      // velocity 0, empty/overflow take, overlap, >999 notes, stale document).
      // LATCH auto-commit for this take: a refusal is a typed statement about
      // the slice as it stood — re-firing as more notes land would be a storm
      // against the same refusal.
      this.autoCommitLatched = true;
      this.bufferingActive = false;
      this.deliverBufferedBackToCurrentTake(); // the take is NOT committed: the buffered hits belong here, at their exact original times
      this.setPhase("commit_failed", message + " — the refusal states the way out; nothing was clamped or overwritten; auto-commit is latched for this take");
      return false;
    }
    const applied = this.applyCommitReply(reply.bodyText, "commit reply");
    if (!applied) {
      return false;
    }
    // A `pending` saved receipt authorised the scoped explicit retry: run it
    // BEFORE the rollover — closing this session would retire the retry's
    // scope (a closed/reused id is refused with 409), so the retry must not
    // race its own close.
    if (this.pendingSaveRetrySessionId > 0) {
      await this.scopedSaveRetry();
      if (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "unknown") {
        await this.settleUnknownSaveByListing();
      }
    }
    // Roll into a fresh bounded slice: capture never stops for the commit.
    this.scheduleRolloverOnce();
    return true;
  }

  /**
   * The COMPLETE gate for every commit trigger: a committable slice AND a
   * fully drained, certain outbound queue AND no flush/reconcile/buffer
   * transfer in flight AND no commit already posted/in-flight/awaiting/landed
   * for this take AND no refusal latch AND capture not latched. Anything less
   * would risk the committed-take rollover resetting unresolved events.
   */
  private commitGatesOpen(): boolean {
    return (
      this.capturing &&
      this.pending.length === 0 &&
      !this.uncertainInFlight &&
      !this.flushBusy &&
      !this.reconcileBusy &&
      !this.bufferingActive &&
      this.trackId >= 0 &&
      !this.commitPosted &&
      !this.commitInFlight &&
      !this.commitAwaitingReadback &&
      !this.autoCommitLatched &&
      !this.captureBlocked &&
      this.nonFaithfulNotes === 0 &&
      this.heldCount() === 0 &&
      this.unknownDurationCount() === 0
    );
  }

  /**
   * EXACTLY ONE rollover per committed take, from ANY receipt path (200
   * success, 409 already_committed recovery, readback settlement): closes the
   * committed session once and opens the next generation, so the next take
   * can actually commit. Guarded by rolloverScheduledFor — never a double
   * close, never a reset of the receipt evidence — and DEFERRED (never
   * silently skipped) while the outbound queue is unresolved: the pump
   * retries the moment the queue is clean, so no captured note is lost.
   */
  private scheduleRolloverOnce(): void {
    if (this.rolloverScheduledFor === this.sessionId || !this.capturing) {
      return;
    }
    if (!this.rolloverCanProceed()) {
      this.rolloverDeferred = true;
      this.logLine(
        "rollover deferred — " + this.pending.length + " event(s) still syncing" +
        (this.uncertainInFlight ? " (unobserved reply being reconciled)" : "") +
        "; the next take opens the moment the queue is clean (nothing is closed or reset while unresolved)"
      );
      return;
    }
    this.rolloverScheduledFor = this.sessionId;
    this.beginNextTakeAfterCommit();
  }

  /**
   * The rollover's own readiness: the OUTBOUND queue is drained and certain.
   * NOTE `bufferingActive` deliberately does NOT block the rollover — the
   * buffer holds hits destined for the NEXT take (transferred right after the
   * new session opens); blocking the rollover on it would deadlock the
   * boundary. Blocking here are only unresolved OUTBOUND events and in-flight
   * sync requests — never close or reset while those exist.
   */
  private rolloverCanProceed(): boolean {
    return this.pending.length === 0 && !this.uncertainInFlight && !this.flushBusy && !this.reconcileBusy;
  }

  /** 409 = the first commit landed (receipt in details) — success, not failure. */
  private async handleCommitConflict(reply: TransportReply): Promise<boolean> {
    const env = errorEnvelopeOf(reply);
    if (env !== null && env.code === "already_committed") {
      const details = env.details as { [key: string]: unknown } | null;
      const receiptObj = details !== null && details !== undefined && typeof details === "object" ? details["receipt"] : null;
      const receipt = this.parseReceipt(receiptObj);
      if (receipt !== null) {
        this.commitReceipt = receipt;
        this.commitAwaitingReadback = false;
        this.setPhase("commit_pending", "this take already committed (first reply was lost); receipt recovered — confirming the save now");
        await this.confirmSaveFromReadback();
        this.scheduleRolloverOnce(); // same treatment as a 200 success: the next take must open
        return true;
      }
      this.commitAwaitingReadback = true;
      this.setPhase("commit_unknown", "already-committed refused without a parseable receipt — settling via the take readback");
      return false;
    }
    if (env !== null && env.code === "take_gone") {
      this.setPhase("commit_failed", "the take was closed/reopened while the commit waited — recapture into a fresh session");
      return false;
    }
    this.setLastError(env !== null ? env.code : "http_409", "commit conflict: " + (env !== null ? env.message : "HTTP 409"));
    return false;
  }

  private parseReceipt(obj: unknown): CommitReceipt | null {
    if (obj === null || obj === undefined || typeof obj !== "object") {
      return null;
    }
    const rec = obj as { [key: string]: unknown };
    if (
      !isSafeInt(rec["clip"]) ||
      !isSafeInt(rec["track"]) ||
      !isSafeInt(rec["revision"])
    ) {
      return null;
    }
    const label = rec["undo_label"];
    return {
      clip: rec["clip"] as number,
      track: rec["track"] as number,
      revision: rec["revision"] as number,
      undo_label: typeof label === "string" && label.length > 0 ? label : "Take to MIDI Clip",
    };
  }

  private applyCommitReply(bodyText: string, source: string): boolean {
    const parsed = this.parseObject<CommitReply>(bodyText, (obj) => {
      if (obj["committed"] !== true) {
        return { ok: false as const, problem: source + " did not confirm committed:true — nothing is claimed" };
      }
      const receipt = this.parseReceipt(obj);
      if (receipt === null) {
        return { ok: false as const, problem: source + " lacked a well-typed receipt" };
      }
      return { ok: true as const, value: obj as unknown as CommitReply };
    });
    const commitProblem = parseProblem(parsed);
    if (commitProblem !== null) {
      // A malformed success proves nothing: the outcome is unknown, settle by
      // readback. No receipt is recorded, no badge is shown.
      this.commitAwaitingReadback = true;
      this.commitPollTries = 0;
      this.setLastError("commit_shape", commitProblem + " — outcome unknown; the take readback settles it");
      return false;
    }
    const commitValue = expectParsed(parsed);
    const receipt = this.parseReceipt(commitValue) as CommitReceipt;
    this.commitReceipt = receipt;
    this.commitAwaitingReadback = false;
    // The engine-echoed clip `end` is the AUTHORITATIVE append position for
    // the next take on this track (the rollover anchors past it).
    if (isSafeInt(commitValue["end"]) && (commitValue["end"] as number) > this.lastCommitEndSamples) {
      this.lastCommitEndSamples = commitValue["end"] as number;
    }
    const saved = commitValue["saved"];
    this.applySavedReceipt(saved, "commit reply");
    const savedStatus = this.lastSavedReceipt !== null ? this.lastSavedReceipt.status : "absent";
    if (this.lastSavedReceipt !== null && isSavedReceiptSaved(this.lastSavedReceipt)) {
      this.setPhase("saved_confirmed", "take committed (clip " + receipt.clip + ", track " + receipt.track + ", revision " + receipt.revision + ") — exact saved receipt: " + savedReceiptFileName(this.lastSavedReceipt));
    } else {
      // Commit landed; the save is honestly not confirmed.
      this.setPhase(
        "commit_pending",
        "take committed (clip " + receipt.clip + ") — save receipt: " + savedStatus + (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "pending" ? " — the scoped explicit save retry is authorised" : this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "unknown" ? " — GET /v1/live/saves settles it; no blind retry" : "")
      );
      if (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "pending") {
        this.pendingSaveRetrySessionId = this.sessionId; // scope-checked retry, exactly as the receipt named
      }
      if (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "unknown") {
        this.settleUnknownSaveByListing();
      }
    }
    return true;
  }

  private applySavedReceipt(saved: unknown, source: string): void {
    if (saved === null || saved === undefined || typeof saved !== "object") {
      this.lastSavedReceipt = { status: "unknown", reason: source + " carried no saved receipt" };
      return;
    }
    const rec = saved as { [key: string]: unknown };
    const status = rec["status"];
    if (status === "saved") {
      if (typeof rec["name"] !== "string" || !isSafeInt(rec["version"]) || !isSafeInt(rec["bytes"])) {
        this.lastSavedReceipt = { status: "unknown", reason: "saved receipt lacked name/version/bytes proofs" };
        return;
      }
      this.lastSavedReceipt = {
        status: "saved",
        name: rec["name"] as string,
        version: rec["version"] as number,
        bytes: rec["bytes"] as number,
      };
      this.addPlaylistEntry({
        name: rec["name"] as string,
        bytes: rec["bytes"] as number,
        modifiedMs: 0,
        source: "saved_receipt",
        savedBadge: true, // the ONLY path that sets the badge
      });
      this.savedBadgeCount++;
      return;
    }
    if (status === "pending" || status === "failed" || status === "disabled") {
      this.lastSavedReceipt = {
        status: status,
        reason: typeof rec["reason"] === "string" ? (rec["reason"] as string) : "",
      } as SavedReceipt;
      return;
    }
    if (status === "unknown") {
      this.lastSavedReceipt = {
        status: "unknown",
        name: typeof rec["name"] === "string" ? (rec["name"] as string) : undefined,
        reason: typeof rec["reason"] === "string" ? (rec["reason"] as string) : "the save outcome is unprovable",
      };
      return;
    }
    this.lastSavedReceipt = { status: "unknown", reason: "saved receipt had an unrecognised status" };
  }

  /** Poll GET take until the committed receipt appears or tries run out. NEVER re-POSTs. */
  private async pollCommitReadback(): Promise<void> {
    if (this.env.nowSecs() - this.lastFlushSecs < this.cfg.commitPollIntervalSeconds) {
      return;
    }
    this.lastFlushSecs = this.env.nowSecs();
    this.commitPollTries++;
    if (this.commitPollTries > this.cfg.commitPollMaxTries) {
      this.setPhase("commit_unknown", "commit outcome still unproven after " + this.cfg.commitPollMaxTries + " readbacks — it may still land; nothing is claimed (no blind retry was made)");
      this.commitAwaitingReadback = false;
      return;
    }
    const reply = await this.rawRequest("GET", "/v1/live/sessions/" + this.sessionId + "/take", null, true);
    if (!this.consumeAuthFailure(reply)) {
      return;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      return; // keep waiting; phase stays commit_unknown
    }
    const parsed = this.parseTakeReply(reply.bodyText);
    if ("problem" in parsed) {
      return;
    }
    const take = parsed.value;
    const receipt = this.parseReceipt(take["committed"]);
    if (receipt !== null) {
      this.commitReceipt = receipt;
      this.commitAwaitingReadback = false;
      this.setPhase("commit_pending", "commit receipt recovered from the take readback (clip " + receipt.clip + ") — confirming the save");
      await this.confirmSaveFromReadback();
      this.scheduleRolloverOnce(); // same treatment as a 200 success: the next take must open
    }
    // (No receipt yet: the readback answers but the commit has not landed —
    // keep polling within bounds; the tries cap above ends the wait honestly.)
  }

  /**
   * After a recovered/landed commit there is no `saved` field in the take
   * readback — the honest confirmation is the explicit, scope-checked save
   * retry the companion names for exactly this situation, or the saves
   * listing. We use the scoped retry when the receipt authorised it, else the
   * listing (readback entries never earn the badge).
   */
  private async confirmSaveFromReadback(): Promise<void> {
    if (this.automaticSavingSupported) {
      this.pendingSaveRetrySessionId = this.sessionId;
      await this.scopedSaveRetry();
      if (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "unknown") {
        this.settleUnknownSaveByListing();
      }
      if (this.lastSavedReceipt === null || this.lastSavedReceipt.status !== "saved") {
        // Fall back to the listing (badge stays off — readback is not a receipt).
        await this.refreshSaves();
      }
    } else {
      this.setPhase("commit_pending", "committed — automatic saving is not available on this companion (receipt says disabled honestly; no save is claimed)");
    }
  }

  /** The explicit POST /v1/live/sessions/{id}/save — admitted only from a receipt that named it. */
  private async scopedSaveRetry(): Promise<void> {
    if (this.pendingSaveRetrySessionId <= 0) {
      return;
    }
    const sessionId = this.pendingSaveRetrySessionId;
    this.pendingSaveRetrySessionId = 0; // one scoped attempt per authorisation
    const reply = await this.rawRequest(
      "POST",
      "/v1/live/sessions/" + sessionId + "/save",
      JSON.stringify({}),
      true
    );
    if (!this.consumeAuthFailure(reply)) {
      return;
    }
    if (reply.outcome === "deadline" || reply.outcome === "network_error") {
      this.lastSavedReceipt = { status: "unknown", reason: "save-retry reply not observed — GET /v1/live/saves settles it" };
      this.settleUnknownSaveByListing();
      return;
    }
    if (reply.status === 200) {
      const parsed = this.parseObject<{ saved: unknown }>(reply.bodyText, (obj) => {
        if (obj["saved"] === null || obj["saved"] === undefined) {
          return { ok: false as const, problem: "save reply carried no saved receipt" };
        }
        return { ok: true as const, value: { saved: obj["saved"] } };
      });
      const retryProblem = parseProblem(parsed);
      if (retryProblem === null) {
        this.applySavedReceipt(expectParsed(parsed).saved, "save-retry reply");
        if (this.lastSavedReceipt !== null && isSavedReceiptSaved(this.lastSavedReceipt)) {
          this.setPhase("saved_confirmed", "exact saved receipt: " + savedReceiptFileName(this.lastSavedReceipt));
        } else if (this.lastSavedReceipt !== null && this.lastSavedReceipt.status === "unknown") {
          this.settleUnknownSaveByListing();
        }
      } else {
        this.lastSavedReceipt = { status: "unknown", reason: retryProblem };
      }
      return;
    }
    const env = errorEnvelopeOf(reply);
    const code = env !== null ? env.code : "http_" + reply.status;
    const message = env !== null ? env.message : "HTTP " + reply.status;
    if (code === "take_gone" || code === "no_committed_take") {
      this.lastSavedReceipt = { status: "failed", reason: "the save scope retired (" + code + ") — the clip belongs to a replaced document; nothing was sent" };
      this.setLastError(code, message);
      return;
    }
    this.lastSavedReceipt = { status: "unknown", reason: "save-retry refused: " + message };
  }

  /** GET /v1/live/saves — settles an unknown by presence (never earns the badge). */
  private async settleUnknownSaveByListing(): Promise<void> {
    await this.refreshSaves();
    const unk = this.lastSavedReceipt;
    const unkName = unk !== null && unk.status === "unknown" && "name" in unk && typeof unk.name === "string" ? unk.name : "";
    if (unk !== null && unkName !== "") {
      let found = false;
      for (let i = 0; i < this.playlist.length; i++) {
        if (this.playlist[i].name === unkName) {
          found = true;
          break;
        }
      }
      if (found) {
        this.lastSavedReceipt = {
          status: "unknown",
          name: unkName,
          reason: "the save is now visible in GET /v1/live/saves (settled by listing) — the badge stays off: only an exact saved receipt earns it",
        };
        this.setPhase("commit_pending", "save settled by listing for " + unkName + " — visible, but no saved-receipt badge");
      } else {
        this.setPhase("commit_pending", "save still not visible in GET /v1/live/saves — outcome remains unknown, no retry was made");
      }
    }
  }

  /** GET /v1/live/saves — the growing playlist's backend side (basenames only). */
  async refreshSaves(): Promise<boolean> {
    if (!this.cfg.onlineMode) {
      this.refreshPlaylistLocalOnly();
      return false;
    }
    if (!this.hasToken) {
      // Unpaired (or pairing lost): NO privileged request is sent. This is not
      // an error and not an expiry — the phase stays with the pairing flow.
      return false;
    }
    this.lastSavesRefreshSecs = this.env.nowSecs();
    if (!this.automaticSavingSupported && this.capabilitiesKnown) {
      return false; // saving is off: the companion honestly reports 501 — don't hammer it
    }
    const reply = await this.rawRequest("GET", "/v1/live/saves", null, true);
    if (!this.consumeAuthFailure(reply)) {
      return false;
    }
    if (reply.outcome !== "ok" || reply.status !== 200) {
      return false; // surfaced by phase/error elsewhere; no fake entries
    }
    const parsed = this.parseSavesReply(reply.bodyText);
    const savesProblem = parseProblem(parsed);
    if (savesProblem !== null) {
      this.setLastError("saves_shape", "saves reply not understood: " + savesProblem);
      return false;
    }
    const savesValue = expectParsed(parsed);
    for (let i = 0; i < savesValue.length; i++) {
      const e = savesValue[i];
      this.addPlaylistEntry({ name: e.name, bytes: e.bytes, modifiedMs: e.modifiedMs, source: "backend_readback", savedBadge: false });
    }
    return true;
  }

  private parseSavesReply(bodyText: string): Parsed<Array<{ name: string; bytes: number; modifiedMs: number }>> {
    return this.parseObject<Array<{ name: string; bytes: number; modifiedMs: number }>>(bodyText, (obj) => {
      const saves = obj["saves"];
      if (saves === null || saves === undefined || !Array.isArray(saves)) {
        return { ok: false, problem: "saves reply had no saves array" };
      }
      const entries: Array<{ name: string; bytes: number; modifiedMs: number }> = [];
      for (let i = 0; i < saves.length; i++) {
        const e = saves[i] as { [key: string]: unknown };
        if (typeof e["name"] !== "string" || !isSafeInt(e["bytes"]) || !isSafeInt(e["modified_ms"])) {
          return { ok: false, problem: "saves entry " + i + " was not well-typed" };
        }
        entries.push({
          name: e["name"] as string,
          bytes: e["bytes"] as number,
          modifiedMs: e["modified_ms"] as number,
        });
      }
      return { ok: true, value: entries };
    });
  }

  private addPlaylistEntry(entry: PlaylistEntry): void {
    for (let i = 0; i < this.playlist.length; i++) {
      const existing = this.playlist[i];
      if (existing.name === entry.name) {
        // Badge can only ever turn ON via the exact receipt path (already true
        // at insert); a readback listing never upgrades an entry.
        if (entry.savedBadge && !existing.savedBadge) {
          existing.savedBadge = true;
          this.savedBadgeCount++;
        }
        return;
      }
    }
    this.playlist.push(entry);
  }

  private refreshPlaylistLocalOnly(): void {
    // Judge mode: the playlist shows ONLY this lens's local takes, clearly
    // labelled — never a backend claim, never a badge.
    if (this.playlist.length === 0 && this.commitReceipt === null && this.notes.length > 0) {
      this.playlist.push({
        name: "local take (judge mode — not saved anywhere)",
        bytes: 0,
        modifiedMs: 0,
        source: "local_only", // its OWN honest source — never a saved-receipt pseudo-entry
        savedBadge: false,
      });
    }
  }

  // ---- bounded slices: roll takes automatically -----------------------------

  private localTakeSize = 0;

  private beginLocalTake(): void {
    this.localTakeSize = 0;
  }

  /**
   * The labelled SAMPLE-DURATION POLICY sweep (deterministic, generation-exact:
   * every note carries its own handle and deadline; a closure touches only
   * that note). Runs in the pump; never stalls capture.
   */
  private sweepPolicyClosures(): void {
    const nowNanos = this.env.realtimeNanos();
    for (const voiceKey in this.keyGeneration) {
      const note = this.keyGeneration[voiceKey];
      if (note === undefined || note === null || note.finished) {
        continue;
      }
      const fitsWindow = !this.stuckKnown() || note.policyNs <= this.stuckWindowNs();
      if (note.policyNs > 0 && fitsWindow && nowNanos - note.onsetAbsNanos >= note.policyNs) {
        const deadlineAbs = note.onsetAbsNanos + note.policyNs;
        this.finishOpenNote(note, deadlineAbs, "policy"); // EXACTLY onset + declared duration (deadlineAbs is absolute) (fits the engine window)
      }
      // (policy > window with no trusted finish: stays HELD — closing it at
      // the window would be a non-faithful substitution; surfaced via held.)
    }
    for (let i = 0; i < this.nextTakeBuffer.length; i++) {
      const b = this.nextTakeBuffer[i];
      if (!b.finished && b.policyNs > 0 && nowNanos - b.onsetAbsNanos >= b.policyNs) {
        b.finished = true;
        b.finishAbsNanos = b.onsetAbsNanos + b.policyNs; // EXACTLY onset + declared duration
        delete this.bufferedVoice[b.channel + ":" + b.key];
        this.policyClosedNotes++;
      }
    }
  }

  private maybeAutoCommit(idleBoundary: boolean): void {
    if (!this.capturing) {
      return;
    }
    if (this.cfg.onlineMode && !this.serverCapAuthoritative) {
      // P1-2 FAIL CLOSED: without an authoritative server
      // max_notes_per_commit there is NO commit — the take's notes stay
      // preserved locally (visibly unsynced), never a guessed bound.
      this.setLastError("commit_cap_unverified", "server cap unverified — auto-save withheld (no commit without an authoritative max_notes_per_commit)");
      return;
    }
    this.localTakeSize = this.completedNoteCount();
    const threshold = idleBoundary ? 1 : this.commitNoteCeiling();
    if (this.localTakeSize < threshold) {
      return;
    }
    // Gate on a COMMITTABLE slice: the engine refuses open notes and
    // UNKNOWN-duration notes, so an auto-commit against them is a guaranteed
    // refusal — wait for real finishes instead of hammering. Notes whose
    // events were PROVABLY REFUSED (retired) do not exist in the backend take
    // and deliberately do NOT block the commit of the surviving notes.
    if (this.heldCount() > 0 || this.unknownDurationCount() > 0) {
      return;
    }
    // THE DRAIN GATE: withhold while captured events are unresolved — the
    // committed-take rollover must never reset unsent events. The withheld
    // commit is DEFERRED (commitWanted): the pump fires it the moment the
    // queue is clean. Nothing is dropped or retired here.
    if (this.pending.length > 0 || this.uncertainInFlight || this.flushBusy || this.reconcileBusy || this.bufferingActive) {
      this.commitWanted = true;
      return;
    }
    // Latches: one commit per take (posted, in flight, awaiting settlement,
    // or landed) — and a typed refusal stops auto-commit for this take.
    if (this.commitPosted || this.commitInFlight || this.commitAwaitingReadback || this.autoCommitLatched) {
      return;
    }
    this.logLine(
      (idleBoundary ? "idle phrase boundary (" + this.cfg.idlePhraseSeconds + "s after the last note) — committing " : "capture slice reached " + this.localTakeSize + " committable notes — committing (ceiling " + this.commitNoteCeiling() + (this.serverCapAuthoritative ? ", server max_notes_per_commit " + this.serverMaxNotesPerCommit : ", server cap UNVERIFIED") + ")")
    );
    void this.commitTake();
  }

  /**
   * After a landed commit, begin a fresh bounded slice. The previous session
   * id is retired by opening the NEXT generation — close-uncertainty of the
   * old id cannot contaminate the new take. On failure the old take simply
   * stays (honest; notes keep queuing into the same session until it closes).
   */
  private beginNextTakeAfterCommit(): void {
    if (this.pending.length > 0 || this.uncertainInFlight) {
      // DEFENSE-IN-DEPTH (reviewer-mandated): never close or reset a session
      // while captured events are unresolved. The rollover is deferred; the
      // pump re-arms it the moment the queue is clean — the data survives.
      this.rolloverDeferred = true;
      this.logLine("DEFENSE: rollover withheld — " + this.pending.length + " unresolved event(s); nothing was closed or reset");
      return;
    }
    const oldId = this.sessionId;
    // The rollover MUST carry the numeric track id: the real engine's
    // resolve_track reads an integer as a track ID and a string as a track
    // NAME (existing only) — String(trackId) would name-hunt for "7" and be
    // refused. The engine never creates tracks from live_open.
    const nextTrackRef: string | number = this.trackId >= 0 ? this.trackId : this.currentTrackRef;
    this.rollover = (async () => {
      const closeReply = await this.rawRequest("DELETE", "/v1/live/sessions/" + oldId, null, true);
      this.consumeAuthFailure(closeReply); // expiry handled; close outcome never blocks the new take
      this.capturing = false;
      const started = await this.startCapture(nextTrackRef);
      if (!started) {
        // The buffered hits STAY buffered (never dropped): a later successful
        // startCapture transfers them. Hits during the failed-open window are
        // counted (uncapturedHits). The old take was committed and saved.
        this.setLastError(this.lastErrorCode !== "" ? this.lastErrorCode : "reopen_failed", "next capture slice could not open — " + this.detail + "; " + this.nextTakeBuffer.length + " buffered hit(s) preserved for the next session");
        return;
      }
      this.transferBufferedIntoFreshTake();
    })();
  }

  // ---- shared plumbing -------------------------------------------------------

  private async rawRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    bodyJson: string | null,
    withAuth: boolean
  ): Promise<TransportReply> {
    if (!this.cfg.onlineMode) {
      return {
        outcome: "local_only",
        status: 0,
        bodyText: "",
        retryAfterSeconds: 0,
        problem: "judge mode — no request was sent",
      };
    }
    if (withAuth && !this.tokenLive()) {
      if (!this.tokenEverIssued) {
        // NEVER PAIRED: no token ever existed in this client lifetime. This is
        // awaiting_pair/offline territory — NOT a token expiry. Refuse to send
        // the privileged request and leave the phase to the pairing flow (no
        // fake online behaviour, no bogus expired state, queues untouched).
        return {
          outcome: "network_error",
          status: 0,
          bodyText: "",
          retryAfterSeconds: 0,
          problem: "not paired — no token was ever issued; the authenticated request was not sent",
        };
      }
      this.hasToken = false;
      this.clearBearer();
      this.setPhase("token_expired", "token expired — pair again (queued notes are kept)");
      return {
        outcome: "network_error",
        status: 0,
        bodyText: "",
        retryAfterSeconds: 0,
        problem: "token expired before send",
      };
    }
    return await this.env.transport.request(method, path, bodyJson, withAuth);
  }

  /** Returns false when the caller must stop (token expiry handled inside). */
  private consumeAuthFailure(reply: TransportReply): boolean {
    if (reply.outcome === "ok" && reply.status === 401) {
      this.hasToken = false;
      this.clearBearer();
      this.tokenExpiresAtSecs = 0;
      const env = errorEnvelopeOf(reply);
      this.setPhase("token_expired", "companion says unauthorized (" + (env !== null ? env.message : "401") + ") — pair again; queues retained");
      return false;
    }
    if (reply.outcome === "ok" && reply.status === 429) {
      const wait = Math.max(1, reply.retryAfterSeconds);
      this.retryNotBeforeSecs = this.env.nowSecs() + wait;
      this.setLastError("too_many_requests", "rate limited — backing off " + wait + "s (Retry-After honoured; nothing dropped)");
      return false;
    }
    if (reply.outcome === "ok" && reply.status === 503) {
      const env = errorEnvelopeOf(reply);
      if (env !== null && (env.code === "backend_unavailable" || env.code === "backend_busy")) {
        // The companion fails closed when its backend dies: 503 until restart.
        if (env.code === "backend_unavailable") {
          this.setPhase("backend_down", "the companion's SoundCraft backend is gone — it fails closed until an operator restarts; local capture continues, nothing is claimed");
        }
      }
      return true; // caller decides with the typed envelope
    }
    return true;
  }

  private handleRequestFailure(reply: TransportReply, action: string): void {
    if (reply.outcome === "deadline" || reply.outcome === "network_error") {
      this.setLastError(reply.outcome === "deadline" ? "unobserved" : "offline", action + " — no reply observed (" + reply.problem + "); nothing is assumed");
      if (reply.outcome === "network_error") {
        this.setPhase("offline", action + " failed — companion unreachable; local capture continues");
      }
      return;
    }
    const env = errorEnvelopeOf(reply);
    this.setLastError(env !== null ? env.code : "http_" + reply.status, action + " refused: " + (env !== null ? env.message : "HTTP " + reply.status));
  }

  private parseObject<T>(bodyText: string, build: (obj: { [key: string]: unknown }) => Parsed<T>): Parsed<T> {
    const raw = parseJsonBody(bodyText);
    if (!raw.ok) {
      return { ok: false, problem: raw.problem };
    }
    const obj = raw.value;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return { ok: false, problem: "reply was not a JSON object" };
    }
    return build(obj as { [key: string]: unknown });
  }

  private parseTakeReply(bodyText: string): Parsed<TakeReply> {
    return this.parseObject<TakeReply>(bodyText, (obj) => {
      if (!isSafeInt(obj["session"])) {
        return { ok: false, problem: "take reply missing session" };
      }
      // The REAL engine's TakeStatus is a serde TAGGED OBJECT
      // (#[serde(tag = "state", rename_all = "camelCase")] — performance.rs:456):
      // {"state":"localOnly"} | {"state":"reconciled","session_id":N}.
      // rename_all renames the VARIANTS; the inner field keeps its Rust name
      // `session_id` (snake_case). A plain string is NOT part of the wire
      // contract and is refused.
      const statusObj = obj["status"];
      if (statusObj === null || typeof statusObj !== "object" || Array.isArray(statusObj)) {
        return { ok: false, problem: "take reply status is not the tagged TakeStatus object" };
      }
      const state = (statusObj as { [key: string]: unknown })["state"];
      if (typeof state !== "string" || state.length === 0) {
        return { ok: false, problem: "take reply status missing its state tag" };
      }
      if (typeof obj["synced"] !== "boolean") {
        return { ok: false, problem: "take reply missing synced" };
      }
      const notes = obj["notes"];
      const held = obj["held"];
      if (!Array.isArray(notes) || !Array.isArray(held)) {
        return { ok: false, problem: "take reply missing notes/held arrays" };
      }
      const committedValue = obj["committed"];
      let committed: CommitReceipt | boolean = false;
      if (committedValue !== false && committedValue !== null && committedValue !== undefined) {
        const receipt = this.parseReceipt(committedValue);
        if (receipt !== null) {
          committed = receipt;
        } else if (committedValue !== true) {
          // An ill-typed receipt object is surfaced as data, never trusted.
          committed = false;
        }
      }
      return {
        ok: true,
        value: {
          session: obj["session"] as number,
          track: typeof obj["track"] === "number" ? (obj["track"] as number) : -1,
          status: statusObj as unknown as TakeStatusWire,
          synced: obj["synced"] as boolean,
          overflow: obj["overflow"] === true,
          unknown_duration: isSafeInt(obj["unknown_duration"]) ? (obj["unknown_duration"] as number) : 0,
          stale_document: obj["stale_document"] === true,
          committed: committed,
          notes: notes as Array<{ [key: string]: unknown }> as unknown as TakeReply["notes"],
          held: held as Array<{ [key: string]: unknown }> as unknown as TakeReply["held"],
          // The REAL engine serialises Option<EventId> as null on a fresh take.
          last_event_id: isSafeInt(obj["last_event_id"]) ? (obj["last_event_id"] as number) : 0,
        },
      };
    });
  }
}
