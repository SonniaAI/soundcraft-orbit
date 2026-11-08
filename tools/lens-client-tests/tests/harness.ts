// harness.ts — zero-dependency test runner + the stubbed environment the pure
// client runs against. NO network, NO Lens runtime: the exact production
// SoundcraftCompanionClient logic is driven with a scripted transport and a
// fake clock. Nothing here fakes a backend deployment or Preview evidence —
// these are unit-level tests of the client's own contract.

import { CompanionTransport, DeadlineTimer, TransportReply } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionHttp";
import { ClientEnv, CompanionConfig, DEFAULT_CONFIG, SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error("ASSERT FAILED: " + message);
  }
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error("ASSERT EQUAL FAILED: " + message + "\n  expected: " + b + "\n  actual:   " + a);
  }
}

/** Let every scheduled microtask AND pending macrotask callbacks drain. */
export function settle(ms?: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms !== undefined ? ms : 10);
  });
}

export type Test = { name: string; fn: () => Promise<void> | void };

export function test(name: string, fn: () => Promise<void> | void): Test {
  return { name: name, fn: fn };
}

export async function runAll(tests: Test[]): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log("  ok  " + t.name);
    } catch (e) {
      failed++;
      console.log("FAIL  " + t.name + "\n      " + (e instanceof Error ? e.message : String(e)));
    }
  }
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    throw new Error(failed + " test(s) failed");
  }
}

// ---- the stub environment -----------------------------------------------------

export type ScriptedReply =
  | { kind: "ok"; status: number; body: unknown; retryAfterSeconds?: number }
  | { kind: "network_error"; problem?: string }
  | { kind: "deadline" };

export type RecordedRequest = {
  method: string;
  path: string;
  bodyJson: string | null;
  withAuth: boolean;
};

/**
 * A transport that plays back scripted replies in order and records every
 * request. Tests inspect the record to prove what was sent — and what was
 * never sent again.
 */
export class ScriptedTransport implements CompanionTransport {
  bearerToken: string | null = null;
  requests: RecordedRequest[] = [];
  private script: ScriptedReply[] = [];
  /** Overrides the next reply based on the request about to be sent (for routing by path). */
  router: ((req: RecordedRequest, index: number) => ScriptedReply | null) | null = null;

  enqueue(reply: ScriptedReply): void {
    this.script.push(reply);
  }

  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    bodyJson: string | null,
    withAuth: boolean
  ): Promise<TransportReply> {
    const record: RecordedRequest = { method: method, path: path, bodyJson: bodyJson, withAuth: withAuth };
    this.requests.push(record);
    const routed = this.router !== null ? this.router(record, this.requests.length - 1) : null;
    const fallback: ScriptedReply = { kind: "ok", status: 200, body: {} };
    const reply = routed !== null ? routed : this.script.length > 0 ? (this.script.shift() as ScriptedReply) : fallback;
    if (reply.kind === "ok") {
      return Promise.resolve({
        outcome: "ok",
        status: reply.status,
        bodyText: JSON.stringify(reply.body),
        retryAfterSeconds: reply.retryAfterSeconds !== undefined ? reply.retryAfterSeconds : 0,
        problem: "",
      });
    }
    if (reply.kind === "network_error") {
      return Promise.resolve({
        outcome: "network_error",
        status: 0,
        bodyText: "",
        retryAfterSeconds: 0,
        problem: reply.problem !== undefined ? reply.problem : "fetch failed before any reply",
      });
    }
    return Promise.resolve({
      outcome: "deadline",
      status: 0,
      bodyText: "",
      retryAfterSeconds: 0,
      problem: "no reply in time — outcome unknown",
    });
  }

  countRequestsBy(predicate: (r: RecordedRequest) => boolean): number {
    let n = 0;
    for (const r of this.requests) {
      if (predicate(r)) {
        n++;
      }
    }
    return n;
  }

  bodiesOf(predicate: (r: RecordedRequest) => boolean): unknown[] {
    const out: unknown[] = [];
    for (const r of this.requests) {
      if (predicate(r)) {
        out.push(r.bodyJson !== null ? JSON.parse(r.bodyJson) : null);
      }
    }
    return out;
  }
}

export type FakeClock = {
  nowSecs: number;
  nanos: number;
};

export function makeEnv(
  transport: CompanionTransport,
  clock: FakeClock
): ClientEnv {
  const timer: DeadlineTimer = {
    arm: (seconds: number, onFire: () => void) => {
      // Tests drive time manually; armed callbacks only record.
      armedCallbacks.push({ atSecs: clock.nowSecs + seconds, onFire: onFire });
      return { cancel: () => {} };
    },
  };
  const armedCallbacks: Array<{ atSecs: number; onFire: () => void }> = [];
  const env: ClientEnv = {
    transport: transport,
    nowSecs: () => clock.nowSecs,
    realtimeNanos: () => clock.nanos,
    timer: timer,
    log: () => {}, // quiet in tests
  };
  (env as any).armedCallbacks = armedCallbacks;
  return env;
}

export function makeConfig(overrides?: Partial<CompanionConfig>): CompanionConfig {
  const cfg: CompanionConfig = {
    onlineMode: true,
    captureBatchMaxEvents: DEFAULT_CONFIG.captureBatchMaxEvents,
    flushIntervalSeconds: DEFAULT_CONFIG.flushIntervalSeconds,
    idlePhraseSeconds: DEFAULT_CONFIG.idlePhraseSeconds,
    requestedStuckTimeoutSeconds: DEFAULT_CONFIG.requestedStuckTimeoutSeconds,
    autoCommitNotes: DEFAULT_CONFIG.autoCommitNotes,
    commitPollIntervalSeconds: DEFAULT_CONFIG.commitPollIntervalSeconds,
    commitPollMaxTries: DEFAULT_CONFIG.commitPollMaxTries,
    savesRefreshIntervalSeconds: DEFAULT_CONFIG.savesRefreshIntervalSeconds,
    pendingEventQueueMax: DEFAULT_CONFIG.pendingEventQueueMax,
    tokenExpirySafetySeconds: DEFAULT_CONFIG.tokenExpirySafetySeconds,
  };
  if (overrides !== undefined) {
    for (const k in overrides) {
      (cfg as unknown as Record<string, unknown>)[k] = (overrides as Record<string, unknown>)[k];
    }
  }
  return cfg;
}

// ---- companion reply fixtures (strict shapes from backend c8e1bfb) ------------

export function pairReply(expiresInS: number): unknown {
  return {
    access_token: "test-token-" + Math.floor(Math.random() * 1e9),
    token_type: "bearer",
    expires_in_s: expiresInS,
    paired_to: "this companion process (restart invalidates every credential)",
  };
}

export function capabilitiesReply(
  opts?: {
    noteCapture?: boolean;
    takeToClip?: boolean;
    autoSave?: boolean;
    maxNotesPerCommit?: number | string; // override the advertised commit-note cap (number = well-formed; string = malformed)
    omitMaxNotes?: boolean; // omit the field entirely (unknown-cap shape)
  }
): unknown {
  const o = opts !== undefined ? opts : {};
  const op = (supported: boolean): unknown => (supported ? { supported: true } : { supported: false, reason: "test reason" });
  const limits: { [key: string]: unknown } = {
    max_events_per_batch: 4096,
    max_notes_per_commit: o.maxNotesPerCommit !== undefined ? o.maxNotesPerCommit : 999,
    requests_per_minute: 120,
    token_ttl_s: 7200,
    code_ttl_s: 300,
  };
  if (o.omitMaxNotes === true) {
    delete limits["max_notes_per_commit"];
  }
  return {
    backend: { kind: "test", connected: true },
    transport: { mode: "headless_simulation_only", note: "note capture needs a playing transport; on this backend only the labelled simulation can provide one" },
    persistence: { enabled: o.autoSave !== false, policy: "test" },
    supported: {
      note_capture: op(o.noteCapture !== false),
      take_to_clip: op(o.takeToClip !== false),
      automatic_saving: op(o.autoSave !== false),
      recovery: op(o.autoSave !== false),
      session_inspect: { supported: true },
    },
    limits: limits,
  };
}

/** Faithful to the REAL engine (live/mod.rs `open`): `track` is the RESOLVED numeric id. */
export function liveOpenReply(session: number, resolvedTrackId?: number): unknown {
  const track = resolvedTrackId !== undefined ? resolvedTrackId : 7;
  return { session: session, track: track, sample_rate: 48000, stuck_timeout_samples: 48000, max_note_samples: 480000 };
}

export function takeReply(session: number, trackId: number, extra?: { committed?: unknown; held?: unknown[]; lastEventId?: number }): unknown {
  const e = extra !== undefined ? extra : {};
  return {
    session: session,
    track: trackId,
    status: { state: "localOnly" },
    synced: true,
    overflow: false,
    unknown_duration: 0,
    stale_document: false,
    committed: e.committed !== undefined ? e.committed : false,
    notes: [],
    held: e.held !== undefined ? e.held : [],
    last_event_id: e.lastEventId !== undefined ? e.lastEventId : 0,
  };
}

export function ingestReply(accepted: number, cursor: number): unknown {
  return { accepted: accepted, cursor: cursor };
}

export function journalReply(maxEventId: number): unknown {
  const events = [];
  for (let id = 1; id <= maxEventId; id++) {
    events.push({
      sessionId: 1,
      eventId: id,
      surfaceId: 1,
      trackId: 7,
      timestampNs: id * 1000000,
      payload: { type: "noteOn", channel: 0, key: 36, velocity: 100 },
    });
  }
  return { events: events };
}

export function commitReply(opts?: { saved?: unknown; clip?: number }): unknown {
  const o = opts !== undefined ? opts : {};
  const base: { [key: string]: unknown } = {
    track: 7,
    track_name: "Lens",
    clip: o.clip !== undefined ? o.clip : 42,
    start: 1000000,
    end: 5000000,
    length: 4000000,
    count: 4,
    notes_truncated: false,
    notes: [],
    session: 1,
    committed: true,
    undo_label: "Take to MIDI Clip",
    revision: 9,
    session_saved: false,
  };
  if (o.saved !== undefined) {
    base["saved"] = o.saved;
  }
  return base;
}

export function errorBody(code: string, message: string, details?: unknown): unknown {
  const err: { [key: string]: unknown } = { code: code, message: message };
  if (details !== undefined) {
    err["details"] = details;
  }
  return { error: err };
}

export function savesReply(names: string[]): unknown {
  return {
    count: names.length,
    saves: names.map((n, i) => ({ name: n, bytes: 100 + i, modified_ms: 1700000000000 + i })),
    newest: names.length > 0 ? names[names.length - 1] : null,
  };
}

/** Drive the client through pair + capabilities + open + track resolve. Returns when capturing. */
export async function startCapturing(
  client: SoundcraftCompanionClient,
  transport: ScriptedTransport,
  session: number
): Promise<void> {
  transport.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      return { kind: "ok", status: 200, body: liveOpenReply(session) };
    }
    if (new RegExp("^/v1/live/sessions/" + session + "/take$").test(req.path) && req.method === "GET") {
      return { kind: "ok", status: 200, body: takeReply(session, 7) };
    }
    return null;
  };
  const paired = await client.pair("ABCD-1234");
  assert(paired, "pairing succeeded");
  const started = await client.startCapture("Lens");
  assert(started, "capture started");
}

/**
 * Resolve a project source file (lens-studio-specs/Assets/Scripts/...) from
 * wherever this suite is running: npm test runs with the package root as the
 * working directory, but the compiled tests may also be invoked directly from
 * dist/ — so walk up from this file's directory until the project tree is
 * found. Never uses absolute machine paths.
 */
export function sourcePath(...segments: string[]): string {
  const suffix = "lens-studio-specs/Assets/Scripts/" + segments.join("/");
  const fsMod = require("fs");
  let dir: string = __dirname;
  for (let up = 0; up < 10; up++) {
    const candidate = dir + "/" + suffix;
    try {
      fsMod.accessSync(candidate);
      return candidate;
    } catch (e) {
      dir = dir + "/..";
    }
  }
  return suffix; // last resort: package-root relative (npm test cwd)
}
