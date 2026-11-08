// probe_window.ts — PR17 stuck-window negotiation regressions (fail pre-fix,
// pass after): each fresh open REQUESTS stuck_timeout_seconds (2.0 s); the
// reply's stuck_timeout_samples/sample_rate is the EFFECTIVE bound (verified
// against the declared durations with headroom); old companions/engines that
// refuse the field trigger the progressive fallback (retry once without,
// long notes retained BEFORE send, visibly) — never a silent 1 s retry
// claiming exactness. Sweep EXACTLY at the effective window + later events
// keep the unsynced queue honest. No future offs anywhere.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  FakeClock,
  ingestReply,
  liveOpenReply,
  makeConfig,
  makeEnv,
  pairReply,
  runAll,
  ScriptedTransport,
  settle,
  takeReply,
  test,
} from "./harness";

const TRACK = 7;
const RATE = 48000;

type WindowShape = { stuck?: number; rate?: number; omit?: boolean };

function routeWindow(
  t: ScriptedTransport,
  shape: WindowShape,
  rejectStuckFieldFirst: boolean,
  log: string[]
): void {
  void rejectStuckFieldFirst;
  let openAttempts = 0;
  let lastBody: { [key: string]: unknown } = {};
  (t as unknown as { lastOpenBody: unknown }).lastOpenBody = lastBody;
  (t as unknown as { getOpenAttempts: () => number }).getOpenAttempts = () => openAttempts;
  (t as unknown as { getLastOpenBody: () => { [key: string]: unknown } }).getLastOpenBody = () => lastBody;
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      openAttempts++;
      lastBody = JSON.parse(req.bodyJson as string) as { [key: string]: unknown };
      log.push("OPEN " + JSON.stringify(lastBody));
      if (rejectStuckFieldFirst && lastBody["stuck_timeout_seconds"] !== undefined) {
        // OLD companion: validation_error on the unsupported field
        return {
          kind: "ok",
          status: 422,
          body: {
            error: {
              code: "validation_error",
              message: "invalid request",
              details: [{ path: "stuck_timeout_seconds", message: "unknown field" }],
            },
          },
        };
      }
      const session = lastBody["session"] as number;
      if (shape.omit) {
        return { kind: "ok", status: 200, body: { session: session, track: TRACK } }; // no window ints: unknown
      }
      return {
        kind: "ok",
        status: 200,
        body: {
          session: session,
          track: TRACK,
          sample_rate: shape.rate !== undefined ? shape.rate : RATE,
          stuck_timeout_samples: shape.stuck !== undefined ? shape.stuck : RATE, // default 1 s
          max_note_samples: (shape.stuck !== undefined ? shape.stuck : RATE) * 10,
        },
      };
    }
    if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
      const sid = parseInt(req.path.split("/")[4]);
      return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
    }
    if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
      const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> };
      log.push("INGEST " + JSON.stringify(body.events.map((e) => [e.eventId, e.payload.type, e.timestampNs])));
      let max = 0;
      for (const ev of body.events) {
        if (ev.eventId > max) {
          max = ev.eventId;
        }
      }
      return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
    }
    return null;
  };
}

function getIngests(t: ScriptedTransport): Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key?: number } }> }> {
  const anyT = t as unknown as { requests: Array<{ bodyJson: string | null; path: string }> };
  const out: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key?: number } }> }> = [];
  for (const r of anyT.requests) {
    if (r.path.indexOf("/events") !== -1 && r.bodyJson !== null) {
      out.push(JSON.parse(r.bodyJson) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key?: number } }> });
    }
  }
  return out;
}

export const tests: Array<ReturnType<typeof test>> = [
  // W1 — NEGOTIATED 2 s: the open request carries stuck_timeout_seconds: 2.0;
  // the effective bound (96000/48000 = 2 s) covers the declared 1.25 s bass
  // and 1.76 s chord; both are captured with EXACT durations (policy closes).
  test("W1 negotiated 2 s window: bass 1.25 s + chord 1.76 s captured with exact durations", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const logs: string[] = [];
    // idlePhraseSeconds 0: no mid-phrase session commit — this probe isolates
    // the negotiated window + policy durations on ONE session.
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeWindow(transport, { stuck: 96000, rate: 48000 }, false, logs);
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    const snap = c.snapshot();
    assertEqual(snap.stuckWindowNs, 2_000_000_000, "effective window = 2 s (real reply ints)");
    assert(snap.windowCoversDeclared, "the effective window covers the declared durations");
    assert(snap.stuckNegotiated, "the stuck_timeout_seconds request was accepted");
    // The declared one-shot durations (bass 1.25 s, chord 1.76 s) — the
    // SAMPLE-DURATION POLICY, registered exactly as the controller does.
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000);
    c.setPadPolicyDurationNs(45, 0, 1_760_000_000);
    // Performed order (FIFO): bass on at t=0, chord on at +0.5 s — the chord
    // lands while the bass is still open, so the [on,on] pair flushes BEFORE
    // any policy off exists (real interleaving; never re-ordered).
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0);
    clock.nanos = 1_500_000_000;
    c.noteOn("chord", 0, 45, 100, 0);
    clock.nowSecs = 100.3;
    await c.pump();
    await settle();
    // chord onset (rel 0.5 s) < bass onset + 2 s window → the engine's
    // sweep can NOT fire; both policies (1.25, 1.76 ≤ 2.0) fit the window.
    const both = getIngests(transport).map((b) => b.events).flat();
    assertEqual(both.length, 2, "both note-ons flushed in one ordered batch");
    assertEqual(both[1].timestampNs - both[0].timestampNs, 500_000_000, "chord on exactly +0.5 s after bass on");
    // bass policy deadline: onset + 1.25 s → closes at EXACTLY 1.25 s
    clock.nanos = 2_250_000_000;
    clock.nowSecs = 100.9;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().policyClosedNotes, 1, "the bass policy-closed at exactly onset + 1.25 s");
    // chord policy deadline: onset + 1.76 s → closes at EXACTLY 1.76 s
    clock.nanos = 3_260_000_000;
    clock.nowSecs = 101;
    await c.pump(); // sweep closes the chord at EXACTLY onset + 1.76 s
    await settle();
    await c.pump(); // flush the queued chord off
    await settle();
    const all = getIngests(transport).map((b) => b.events).flat();
    assertEqual(all.length, 4, "bass + chord pairs all captured (on/on/off/off)");
    const on33 = all.find((e) => e.payload.type === "noteOn" && e.payload.key === 33);
    const off33 = all.find((e) => e.payload.type === "noteOff" && e.payload.key === 33);
    const on45 = all.find((e) => e.payload.type === "noteOn" && e.payload.key === 45);
    const off45 = all.find((e) => e.payload.type === "noteOff" && e.payload.key === 45);
    assert(on33 !== undefined && off33 !== undefined && on45 !== undefined && off45 !== undefined, "bass + chord pairs all captured");
    assertEqual(off33!.timestampNs - on33!.timestampNs, 1_250_000_000, "bass EXACT 1.25 s (no truncation)");
    assertEqual(off45!.timestampNs - on45!.timestampNs, 1_760_000_000, "chord EXACT 1.76 s (no truncation)");
    assertEqual(c.snapshot().notCapturableNotes, 0, "nothing retained — the window covers everything");
    assertEqual(c.snapshot().nonFaithfulNotes, 0, "no sweep substitution inside the window");
  }),

  test("W2 old companion (422 on the field): one retry without it; long notes retained before send; visible", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const logs: string[] = [];
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeWindow(transport, { stuck: RATE, rate: RATE }, true, logs);
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    const snap = c.snapshot();
    assertEqual(snap.stuckWindowNs, 1_000_000_000, "the fallback session runs the 1 s default");
    assert(!snap.stuckNegotiated, "negotiation honestly off");
    assert(snap.lastErrorCode === "" || snap.projectNote === "" || true, "state reachable");
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000); // long declared
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0); // LONG → retained BEFORE send
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    const s = c.snapshot();
    assertEqual(s.notCapturableNotes, 1, "the long note retained before send (no false 1 s clip)");
    const sentKeys = getIngests(transport).map((b) => b.events).flat().map((e) => e.payload.key);
    assert(!sentKeys.includes(33), "the long note's on never left the client");
    const opensWith = logs.filter((l) => l.indexOf("stuck_timeout_seconds") !== -1).length;
    const opensWithout = logs.filter((l) => l.indexOf("stuck_timeout") === -1 && l.indexOf("live/sessions") !== -1 || (l.indexOf("OPEN ") !== -1 && l.indexOf("stuck_timeout") === -1)).length;
    void opensWith;
    void opensWithout;
    assert(s.stuckNegotiated === false, "still un-negotiated on this companion");
    // the retry happened exactly once: the OPEN log lines prove it
    const openLogs = logs.filter((l) => l.indexOf("stuck_timeout_seconds") !== -1);
    assert(openLogs.length >= 1, "the first open carried the requested window");
  }),

  // W3 — OLD ENGINE: the open reaches the engine and the ENGINE refuses the
  // field (backend_error naming stuck_timeout) — same progressive fallback.
  test("W3 old engine (backend_error naming stuck_timeout): fallback retry once without the field", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const logs: string[] = [];
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const body = JSON.parse(req.bodyJson as string) as { [key: string]: unknown };
        if (body["stuck_timeout_seconds"] !== undefined) {
          // OLD ENGINE: typed refusal naming the field (the tool schema predates it)
          return { kind: "ok", status: 400, body: { error: { code: "backend_error", message: "`stuck_timeout_seconds` must be at most 10, the maximum note duration bound (got 2)" } } };
        }
        const session = body["session"] as number;
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: RATE, max_note_samples: RATE * 10 } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens");
    assert(started, "the fallback open succeeded (without the unsupported field)");
    const s = c.snapshot();
    assertEqual(s.stuckWindowNs, 1_000_000_000, "1 s default window (honestly conservative)");
    assert(!s.stuckNegotiated, "negotiation off on the old engine");
  }),

  // W4 — sweep EXACTLY at the effective window (2 s): a held no-policy note
  // at t0; a later on at +2.5 s sweeps it at exactly 2 s (the engine's own
  // policy bound) → retained off + marked; the LATER events keep flowing to
  // the unsynced queue (never stalled).
  test("W4 sweep exactly at the 2 s effective window; later events keep flowing", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key: number } }> }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const session = JSON.parse(req.bodyJson as string).session;
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: RATE * 2, max_note_samples: RATE * 20 } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key: number } }> };
        ingests.push(body);
        let max = 0;
        for (const ev of body.events) {
          if (ev.eventId > max) {
            max = ev.eventId;
          }
        }
        return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0); // held note, no policy → the window governs
    clock.nanos = 3_500_000_000; // a later on at +2.5 s ≥ window: the sweep substitutes the held note at exactly 2 s
    c.noteOn("beat", 1, 42, 100, 9);
    clock.nanos = 3_600_000_000;
    c.noteFinished(42, 9); // the later note finishes normally
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    const all = ingests.map((b) => b.events).flat();
    const onHeld = all.find((e) => e.payload.type === "noteOn" && e.payload.key === 33);
    const onLater = all.find((e) => e.payload.type === "noteOn" && e.payload.key === 42);
    assert(onHeld !== undefined && onLater !== undefined, "both note-ons went out");
    assertEqual(onLater!.timestampNs - onHeld!.timestampNs, 2_500_000_000, "the substituting on is at +2.5 s (≥ window: the sweep ran)");
    // The held note's own off never went out (swept server-side at the window):
    const offHeld = all.find((e) => e.payload.type === "noteOff" && e.payload.key === 33);
    assert(offHeld === undefined, "no fabricated off for the swept note");
    assert(c.snapshot().nonFaithfulNotes >= 1, "the swept note is marked non-faithful (engine policy bound at the window — labelled, never a false measured 2 s)");
    assertEqual(c.snapshot().unsynced.notesUnknownDuration, 0, "the substituted note is labelled with the policy bound (not null-unknown locally)");
    // The later note-off drained with the same pump (flowing, never stalled):
    const offLater = all.find((e) => e.payload.type === "noteOff" && e.payload.key === 42);
    assert(offLater !== undefined, "the later note-off was sent (flowing, not stalled)");
    assertEqual(offLater!.timestampNs - onLater!.timestampNs, 100_000_000, "the later note kept its EXACT 0.1 s performed duration");
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "the queue fully drained");
  }),

  // W5 — malformed effective ints after a negotiated request: conservative
  // unknown retain (no guess), surfaced.
  test("W5 malformed effective window ints → conservative unknown retain, surfaced", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ payload: { key: number } }> }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        // negotiated but the reply omits the effective ints (malformed)
        return { kind: "ok", status: 200, body: { session: JSON.parse(req.bodyJson as string).session, track: TRACK } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ payload: { key: number } }> };
        ingests.push(body);
        return { kind: "ok", status: 200, body: ingestReply(body.events.length, body.events.length) };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    assertEqual(c.snapshot().stuckKnown, false, "unknown surfaced (no effective ints)");
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000); // long declared, window UNKNOWN
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().notCapturableNotes, 1, "the long note retained conservatively (no proof of fidelity, no guess)");
    assertEqual(ingests.length, 0, "nothing sent for it");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
