// SoundcraftCompanionTypes.ts — strict wire shapes for the SoundCraft Lens companion
// (agent-studio/src/companion at backend main c8e1bfb), plus the client's own state
// types. NEW file: nothing here edits or imports the five owned prototype scripts.
//
// Every wire type below mirrors ONE field name of the backend's JSON exactly
// (source: companion service.py/api.py at commit c8e1bfb). Unknown fields are
// rejected by the backend — the client never invents shapes, and replies are
// parsed strictly (wrong types are surfaced, never coerced).
//
// Privacy contract baked in here:
//  * NO type in this file carries a filesystem path. Saves are identified by
//    basename only (the server scrubs paths before a client ever sees them).
//  * The pairing code and bearer token live in memory only; no type here is
//    meant for storage, and nothing persists credentials.

// ---- JSON safety (mirrors companion MAX_JSON_INT = 2**53 - 1) ---------------

export const MAX_JSON_INT = 9007199254740991; // 2**53 - 1, safe in the Lens runtime too

// ---- event payloads (companion PAYLOAD_KEYS, validated, never clamped) ------

export type NoteOnPayload = {
  type: "noteOn";
  channel: number; // 0..15
  key: number; // 0..127
  velocity: number; // 1..127 sent (velocity 0 is refused at commit; we never send 0)
};

export type NoteOffPayload = {
  type: "noteOff";
  channel: number; // 0..15
  key: number; // 0..127
};

export type ExpressionPayload = {
  type: "expression";
  parameter: string; // 1..64 chars
  value: number; // finite, |value| <= 1e6
};

export type EventPayload = NoteOnPayload | NoteOffPayload | ExpressionPayload;

/**
 * One wire event. Exact shape: `{"sessionId","eventId","surfaceId","trackId",
 * "timestampNs","payload"}` — six keys, no more, no fewer (companion EVENT_KEYS).
 * eventId must strictly increase across the whole session (backend refuses
 * duplicates and replays); timestampNs is the note time on the Lens's single
 * monotonic capture clock (getRealTimeNanos, session-origin relative).
 */
export type WireEvent = {
  sessionId: number;
  eventId: number;
  surfaceId: number;
  trackId: number;
  timestampNs: number;
  payload: EventPayload;
};

// ---- pairing / health / capabilities ----------------------------------------

/** POST /v1/pair reply. The access token is held in memory ONLY (never stored). */
export type PairReply = {
  access_token: string;
  token_type: string; // "bearer"
  expires_in_s: number;
  paired_to: string;
};

/** GET /v1/health (no auth). */
export type HealthReply = {
  status: string;
  service: string;
  backend: { kind: string; connected: boolean };
};

/** One entry of capabilities.supported — `{"supported": true}` or `{"supported": false, "reason"}`. */
export type CapabilityOp = {
  supported: boolean;
  reason?: string;
};

/**
 * GET /v1/capabilities — only the fields the client consumes are named; the
 * reply carries more (unsupported, take_commit, transport, known_backend_gaps,
 * auth) which the client passes through as untrusted text when surfacing.
 */
export type CapabilitiesReply = {
  backend: { kind: string; connected: boolean };
  persistence: { [key: string]: unknown }; // policy strings + max_saves; display-only
  supported: {
    note_capture: CapabilityOp;
    take_to_clip: CapabilityOp;
    session_inspect: CapabilityOp;
    automatic_saving: CapabilityOp;
    recovery: CapabilityOp;
    [key: string]: CapabilityOp | unknown; // take_snapshot / proposal_readback and extras
  };
  limits: {
    max_events_per_batch: number;
    max_notes_per_commit: number;
    requests_per_minute: number;
    token_ttl_s: number;
    code_ttl_s: number;
    [key: string]: number | unknown;
  };
  [key: string]: unknown;
};

// ---- performance session lifecycle ------------------------------------------

/** POST /v1/live/sessions {session, track} reply (live_open). `track` is the
 * RESOLVED numeric track id (live/mod.rs `open`: `json!({"session", "track":
 * resolve_track(...), "sample_rate", …})` — never an echoed string; the real
 * engine resolves ids/names against existing tracks and never creates one). */
export type LiveOpenReply = {
  session: number;
  track: number;
  sample_rate: number;
  stuck_timeout_samples?: number;
  max_note_samples?: number;
  [key: string]: unknown;
};

/**
 * A note as the backend holds it after a noteOff (or a finalize sweep).
 * `duration === null` means UNKNOWN duration (a swept open note) — the engine
 * refuses to commit such notes and the client never invents a length for them.
 */
export type TakeNote = {
  key: number;
  velocity: number;
  channel: number;
  onset: number;
  duration: number | null;
  quantizedOnset?: number | null;
  [key: string]: unknown;
};

/** A voice the backend is holding (noteOn seen, noteOff not yet). */
export type HeldNote = {
  key: number;
  velocity: number;
  channel?: number;
  onset?: number;
  [key: string]: unknown;
};

/** A commit receipt — the backend's proof a take landed as ONE editable MIDI clip. */
export type CommitReceipt = {
  clip: number;
  track: number;
  revision: number;
  undo_label: string;
  [key: string]: unknown;
};

/**
 * The REAL take-buffer sync state (crates/live/src/performance.rs:456-464):
 * `#[serde(tag = "state", rename_all = "camelCase")] enum TakeStatus
 * { LocalOnly, Reconciled { session_id } }`. serde's rename_all renames the
 * VARIANTS (localOnly / reconciled) — inner Rust fields keep their names, so
 * the reconciled wire field is `session_id` (snake_case), NOT `sessionId`.
 * This is the CAPTURE BUFFER's status — entirely distinct from a clip-saved
 * receipt (`saved.status`), which lives on commit replies only.
 */
export type TakeStatusWire =
  | { state: "localOnly" }
  | { state: "reconciled"; session_id?: number }
  | { state: string; [key: string]: unknown }; // unknown future variants surface as data

/** GET /v1/live/sessions/{id}/take (live_take readback). */
export type TakeReply = {
  session: number;
  track: number; // the numeric track id (resolved here, used for event trackId)
  status: TakeStatusWire;
  synced: boolean;
  overflow: boolean;
  unknown_duration: number;
  stale_document: boolean;
  committed: CommitReceipt | boolean; // false until the take commits
  notes: TakeNote[];
  held: HeldNote[];
  last_event_id: number | null; // Option<EventId>: null on a fresh take
  [key: string]: unknown;
};

/** POST /v1/live/sessions/{id}/events (live_ingest) reply. */
export type IngestReply = {
  accepted: number;
  cursor: number; // highest applied eventId — the client's ack watermark
  [key: string]: unknown;
};

/** POST /v1/live/sessions/{id}/take/finalize reply (bounded close of the take). */
export type FinalizeReply = {
  notes: TakeNote[];
  quantized: number;
  unknown_duration: number;
  [key: string]: unknown;
};

/** GET /v1/live/sessions/{id}/journal?since=N reply — the applied-event tail. */
export type JournalReply = {
  events: WireEvent[];
  [key: string]: unknown;
};

/** POST /v1/live/sessions/{id}/resume reply — reconnect; held voices are LISTED for release. */
export type ResumeReply = {
  released: Array<{ key: number; velocity?: number; [key: string]: unknown }>;
  unknown_duration: number;
  cursor: number;
  [key: string]: unknown;
};

/** DELETE /v1/live/sessions/{id} (live_close) reply. */
export type CloseReply = {
  notes: number;
  released: Array<{ key: number; [key: string]: unknown }>;
  unknown_duration: number;
  [key: string]: unknown;
};

/** POST /v1/live/transport/simulate — the backend's LABELLED headless-only simulation
 * (live/mod.rs `headless_transport`: json!({"playing", "position"})). The client uses it
 * ONLY to arm capture at a proven non-overlapping anchor; it never claims real audio,
 * a real clock, or touches a desktop transport. */
export type TransportSimulateReply = {
  playing: boolean;
  position: number;
  [key: string]: unknown;
};

// ---- take commit + automatic save -------------------------------------------

/**
 * The `saved` receipt attached to a commit reply (and returned by the explicit
 * save retry). Discriminated on `status` — the Lens's saved badge may only ever
 * be shown for the exact `saved` variant, never inferred from anything else.
 */
export type SavedReceiptSaved = {
  status: "saved";
  name: string; // basename only — the server scrubs paths
  version: number;
  bytes: number;
  audio_files_written?: number;
};

/** The commit landed but its automatic save did not start (channel busy). The retry endpoint is named. */
export type SavedReceiptPending = {
  status: "pending";
  reason: string;
  retry_after_s?: number;
};

/** The save was attempted and provably failed; the commit itself DID land. */
export type SavedReceiptFailed = {
  status: "failed";
  reason: string;
};

/** The save outcome is unprovable; GET /v1/live/saves settles it. Never retried blindly. */
export type SavedReceiptUnknown = {
  status: "unknown";
  name?: string;
  reason: string;
};

/** No project root is configured on the companion; the clip lives in backend memory only. */
export type SavedReceiptDisabled = {
  status: "disabled";
  reason: string;
};

export type SavedReceipt =
  | SavedReceiptSaved
  | SavedReceiptPending
  | SavedReceiptFailed
  | SavedReceiptUnknown
  | SavedReceiptDisabled;

/** The `saved` receipt guard: true ONLY for the exact saved variant. */
export function isSavedReceiptSaved(receipt: SavedReceipt): boolean {
  return receipt !== null && receipt !== undefined && receipt.status === "saved";
}

/**
 * POST /v1/live/sessions/{id}/take/commit reply — the engine's own fields
 * (session_saved is the engine saying a commit is NOT a save), plus the
 * companion's `saved` receipt. Any field the client cannot strictly parse is
 * kept under `unparsed` as untrusted data rather than guessed.
 */
export type CommitReply = {
  session: number;
  track: number;
  track_name: string;
  clip: number;
  start: number;
  end: number;
  length: number;
  count: number;
  notes_truncated: boolean;
  committed: boolean;
  undo_label: string;
  revision: number;
  session_saved: boolean;
  saved?: SavedReceipt;
  [key: string]: unknown;
};

// ---- persistence readback / recovery ----------------------------------------

/** One saved session in GET /v1/live/saves — basename facts only, oldest first. */
export type SaveEntry = {
  name: string;
  bytes: number;
  modified_ms: number;
};

export type SavesReply = {
  count: number;
  saves: SaveEntry[];
  newest: string | null;
  [key: string]: unknown;
};

/** POST /v1/live/recover reply — the server picks the file; the client sends no path. */
export type RecoverReply = {
  save: SaveEntry;
  opened: { [key: string]: unknown }; // backend's own open reply (session name, tracks, missing media)
  [key: string]: unknown;
};

// ---- error envelope ----------------------------------------------------------

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

// ---- client state machine ----------------------------------------------------

/**
 * The visible phases. Transitions are produced ONLY by the client after an
 * observed reply — the UI never guesses a phase. "saved_confirmed" is entered
 * exclusively on an exact `saved` receipt (status === "saved").
 */
export type CompanionPhase =
  | "config_error" // inspector inputs unusable (e.g. base URL missing in online mode)
  | "local_only" // judge mode: local monitor + local capture only, NEVER backend-labelled
  | "offline" // online mode but no usable network reply yet / transport failing
  | "awaiting_pair" // reachable; needs the user-visible one-time pairing code
  | "connecting" // pairing exchange in flight
  | "paired" // token live, no capture session yet
  | "capturing" // session open, notes flowing
  | "commit_pending" // commit sent (or outcome unknown) — awaiting the settle receipt
  | "saved_confirmed" // exact saved receipt observed
  | "commit_failed" // backend refusal relayed verbatim; take state stated in detail
  | "commit_unknown" // outcome unprovable (timeout / lost reply) — readback settles it
  | "token_expired" // 401 or TTL passed; queues retained until re-pair
  | "backend_down"; // latched 503 fail-closed — restart the companion to recover

/** What the client knows about local-vs-backend sync right now (no silent gaps). */
export type UnsyncedState = {
  unsentEvents: number; // queued locally, provably never applied server-side
  ackedEvents: number; // confirmed in the backend journal (cursor watermark)
  uncertainInFlight: boolean; // a reply was lost — reconcile (journal) before any resend
  notesUnknownDuration: number; // completed-but-swept or unfinishable notes (commit refuses these)
  heldNotes: number; // noteOns the backend holds without a note-off
  overflowDroppedNotes: number; // hits that exceeded the bounded capture window (surfaced, never silent)
  retiredUnsentEvents: number; // events retired because their session provably ceased (surfaced, never silent)
  retiredRefusedEvents: number; // events retired because the backend PROVABLY refused them (counter + reason)
  uncapturedHits: number; // hits that landed while no capture session was open AND the buffer could not take them
  bufferedHits: number; // hits preserved in the bounded next-take buffer across a commit/rollover boundary
  staleFinishesIgnored: number; // generation-unsafe finish calls provably identified and ignored (never close another generation)
  policyClosedNotes: number; // notes closed by the labelled SAMPLE-DURATION POLICY (declared asset duration)
  stuckKnown: boolean; // the engine's live_open exposed the real stuck-note window ints
  stuckWindowNs: number; // the REAL stuck-note window in ns (-1 unknown)
  notCapturableNotes: number; // long-declared notes rejected BEFORE sending (retained locally, visible)
  nonFaithfulNotes: number; // engine-substituted notes present: exact-fidelity commits withheld
  leftBehindTakes: number; // open sessions left on the backend after an already-open id refusal (never resumed, never discarded silently)
  captureBlockedReason: string; // verbatim refusal when capture is latched off; "" while clean
  lastAckedEventId: number;
};

/** A strict, typed parse outcome — the client never coerces a wrong shape. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * Narrowing helpers that stay correct under the Lens project's non-strict
 * tsconfig (boolean-discriminant narrowing is unreliable without
 * strictNullChecks; `in`-narrowing is not). Use parseProblem → expectParsed.
 */
export function parseProblem<T>(parsed: Parsed<T>): string | null {
  return "problem" in parsed ? parsed.problem : null;
}

export function expectParsed<T>(parsed: Parsed<T>): T {
  if ("problem" in parsed) {
    throw new Error(parsed.problem);
  }
  return parsed.value;
}

/**
 * The saved file's name — but ONLY when the receipt itself is the exact
 * `saved` variant. A pending/unknown/failed receipt never yields a name to
 * badge with (an `unknown` receipt's `name` is settlement data, not a badge).
 */
export function savedReceiptFileName(receipt: SavedReceipt): string {
  if ("name" in receipt && receipt.status === "saved" && typeof receipt.name === "string") {
    return receipt.name;
  }
  return "";
}

/** Stable surface ids: fixed registry for the three prototype instruments, hash for the rest. */
export const SURFACE_ID_REGISTRY: { [instrument: string]: number } = {
  beat: 1,
  bass: 2,
  chord: 3,
};

export function surfaceIdFor(instrumentType: string): number {
  const known = SURFACE_ID_REGISTRY[instrumentType];
  if (known !== undefined && known !== null) {
    return known;
  }
  // FNV-1a (32-bit, positive) — stable across runs for unknown instrument names.
  let hash = 0x811c9dc5;
  for (let i = 0; i < instrumentType.length; i++) {
    hash ^= instrumentType.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % 100000000; // stays far inside the safe-integer event field
}
