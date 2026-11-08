// probe_p1_stuck.ts — stuck-note window exact-fidelity regressions. The REAL
// engine (crates/live/src/performance.rs) sweeps a note held ≥ stuck_timeout
// at EXACTLY the timeout as a POLICY bound (`Some(timeout)` — live/mod.rs
// sweep_stuck: "closes at exactly 1 s BY POLICY"), triggered by each note-on's
// onset; a later note-off for a swept voice orphans and refuses the batch.
// The client derives the window from the REAL live_open ints
// (stuck_timeout_samples / sample_rate) — never a capability guess — and:
//   * rejects long-DECLARED notes BEFORE sending (retained locally, visible),
//   * retains offs that would orphan (substituted notes withheld from saves),
//   * lets SOLO long notes (no later note-on → no sweep) capture FAITHFULLY.
// Each probe fails against a pre-fix client and passes after.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  commitReply,
  errorBody,
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
const STUCK = 48000; // the real CLI's 1 s window at 48 kHz

function routeAll(t: ScriptedTransport, stuckSamples?: number): void {
  const stuck = stuckSamples !== undefined ? stuckSamples : STUCK;
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      const session = JSON.parse(req.bodyJson as string).session;
      return {
        kind: "ok",
        status: 200,
        body: {
          session: session,
          track: TRACK,
          sample_rate: RATE,
          stuck_timeout_samples: stuck,
          max_note_samples: stuck * 10,
        },
      };
    }
    if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
      const sid = parseInt(req.path.split("/")[4]);
      return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
    }
    if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
      const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
      let max = 0;
      for (const ev of body.events) {
        if (ev.eventId > max) {
          max = ev.eventId;
        }
      }
      return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
    }
    if (/^\/v1\/live\/sessions\/\d+$/.test(req.path) && req.method === "DELETE") {
      return { kind: "ok", status: 200, body: { notes: 0, released: [], unknown_duration: 0 } };
    }
    if (req.path.indexOf("/transport/simulate") !== -1) {
      const body = JSON.parse(req.bodyJson as string);
      return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
    }
    return null;
  };
}

function hit(client: SoundcraftCompanionClient, clock: FakeClock, nanos: number, key: number, channel: number): void {
  clock.nanos = nanos;
  client.noteOn("beat", 0, key, 100, channel);
}

export const tests: Array<ReturnType<typeof test>> = [
  // T23 — a DECLARED duration longer than the engine's stuck window is
  // rejected BEFORE SENDING: retained locally, counted, visible; a SHORT
  // declared note on another voice captures normally; no false 1 s clip.
  test("T23 long declared duration rejected before send (real 1 s window ints); short policy unaffected", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeAll(transport);
    const ingests: Array<{ events: Array<{ payload: { key: number; type: string } }> }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const session = JSON.parse(req.bodyJson as string).session;
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: STUCK, max_note_samples: STUCK * 10 } };
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
    // BASS declared 1.25 s (> the 1 s window) — the reviewer's actual sample:
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000);
    // CHORD declared 1.76 s (> the window):
    c.setPadPolicyDurationNs(45, 0, 1_760_000_000);
    // SHORT kick 0.4 s (within the window):
    c.setPadPolicyDurationNs(36, 9, 400_000_000);
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0); // LONG → must NOT be sent
    clock.nanos = 1_100_000_000;
    c.noteOn("chordpad", 0, 45, 100, 0); // LONG → must NOT be sent
    clock.nanos = 1_200_000_000;
    c.noteOn("beat", 0, 36, 100, 9); // SHORT → captured
    clock.nanos = 1_600_000_000; // the short note's policy elapses
    clock.nowSecs = 101;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().notCapturableNotes, 2, "both long-declared notes rejected BEFORE sending (retained, visible)");
    const sentKeys = ingests.map((b) => b.events.map((e) => e.payload.key));
    const flat = sentKeys.flat();
    assert(!flat.includes(33), "the long bass note-on was never sent (no false 1 s clip possible)");
    assert(!flat.includes(45), "the long chord note-on was never sent");
    assert(flat.includes(36), "the short kick captured normally");
    // And the short note still auto-saves exactly:
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t23-v1.scraft", version: 1, bytes: 100 } }) });
    clock.nowSecs = 102;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(c.snapshot().savedBadgeCount, 1, "the short policy phrase auto-saved exactly");
    assert(c.snapshot().stuckKnown && c.snapshot().stuckWindowNs === 1_000_000_000, "the window came from the REAL live_open ints (1 s)");
  }),

  // T24 — a TRUSTED finish beyond the window on a SOLO note (no later
  // note-on → no sweep) is FAITHFUL: the off goes out at the real offset and
  // the duration is exact. Solo long notes are NOT rejected.
  test("T24 solo trusted long note (1.25 s > window) captures FAITHFULLY at its real finish", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const session = JSON.parse(req.bodyJson as string).session;
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: STUCK, max_note_samples: STUCK * 10 } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> };
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
    c.noteOn("bass", 0, 33, 100, 0); // SOLO: held 1.25 s, no other note-on ever
    clock.nanos = 2_250_000_000; // the trusted pad-owner finish at +1.25 s
    c.noteFinished(33, 0); // solo → NO sweep ran → faithful close at the real offset
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    assertEqual(ingests.length, 1, "one batch: on + off");
    assertEqual(ingests[0].events.length, 2, "on + off sent (solo long notes are faithful)");
    assertEqual(ingests[0].events[1].timestampNs - ingests[0].events[0].timestampNs, 1_250_000_000, "the EXACT 1.25 s duration left the client");
    assertEqual(c.snapshot().nonFaithfulNotes, 0, "no substitution claimed for a solo note");
  }),

  // T25 — the SWEEP-SUBSTITUTION case: a later note-on forces the engine's
  // policy sweep past a long-held note — its off would orphan and the engine
  // holds a substituted window-length note. The client detects this from its
  // OWN sent timeline, RETAINS the off, marks the note non-faithful, and
  // withholds exact-fidelity commits — never a false exact-saved note.
  test("T25 swept long note (overlap beyond window): off retained, substitution surfaced, exact commits withheld", async () => {
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
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: STUCK, max_note_samples: STUCK * 10 } };
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
    // Long note X (no declared policy — a held/performance note):
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0); // X onset at timeline 0
    // A LATER note-on at +1.5 s (≥ X.onset + 1 s window): the engine sweeps X
    // at exactly 1 s (policy substitution) when recording this note-on:
    clock.nanos = 2_500_000_000;
    c.noteOn("beat", 1, 42, 100, 9); // short note Y
    clock.nanos = 2_600_000_000;
    c.noteFinished(42, 9); // Y closes (0.1 s) — fine
    // The trusted finish for X arrives at +1.6 s — AFTER the sweep:
    clock.nanos = 2_600_000_000;
    c.noteFinished(33, 0); // X's real finish — but the engine already substituted it
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    // The off for X must NOT have been sent (it would orphan):
    const xOff = ingests.map((b) => b.events).flat().find((e) => e.payload.type === "noteOff" && e.payload.key === 33);
    assert(xOff === undefined, "the substituted note's off was RETAINED (never sent — no orphan, no refusal churn)");
    assertEqual(c.snapshot().nonFaithfulNotes, 1, "the substitution is surfaced (engine policy bound ≠ performed length)");
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "nothing pending: the retained off is accounted");
    // Exact-fidelity commits are withheld for this take:
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 99, saved: { status: "saved", name: "should-not-save.scraft", version: 1, bytes: 1 } }) });
    clock.nanos = 3_600_000_000; // idle elapsed
    clock.nowSecs = 101.6;
    await c.pump();
    await settle();
    const commitPosts = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    assertEqual(commitPosts, 0, "NO commit while a non-faithful substituted note is present (never claim exact)");
    assert(c.snapshot().savedBadgeCount === 0, "no false-saved badge");
  }),

  // T26 — window from the REAL ints adapts automatically when the backend
  // fix lands: a larger stuck timeout (2 s) makes the 1.25 s declared note
  // CAPTURABLE with exact fidelity — no client change needed.
  test("T26 larger backend stuck window (2 s) → 1.25 s declared note captures faithfully", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> }> = [];
    const NEW_STUCK = 96000; // 2 s at 48 kHz (the parent's backend fix shape)
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const session = JSON.parse(req.bodyJson as string).session;
        return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: NEW_STUCK, max_note_samples: NEW_STUCK * 10 } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> };
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
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000); // the actual bass 1.25 s
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0);
    clock.nanos = 2_250_000_000; // policy elapses (1.25 s < 2 s window)
    clock.nowSecs = 100.9;
    await c.pump(); // policy closes at exactly 1.25 s
    await settle();
    await c.pump();
    await settle();
    assertEqual(c.snapshot().notCapturableNotes, 0, "capturable under the larger window");
    const on = ingests[0].events[0];
    const off = ingests[ingests.length - 1].events.find((e) => e.payload.type === "noteOff");
    assert(on !== undefined && off !== undefined, "on + off captured");
    assertEqual(off!.timestampNs - on!.timestampNs, 1_250_000_000, "the EXACT 1.25 s duration captured under the 2 s window");
  }),

  // T27 — UNKNOWN window (a backend that does not expose the ints):
  // long-declared notes are conservatively retained before sending (no
  // false 1 s clip, no guess); the state is surfaced.
  test("T27 unknown stuck window: long declared notes retained conservatively before send (no guess)", async () => {
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
        // NO stuck_timeout_samples / sample_rate: unknown window
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
    c.setPadPolicyDurationNs(33, 0, 1_250_000_000); // long, window UNKNOWN
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().notCapturableNotes, 1, "conservatively retained before send (no proof of fidelity)");
    assertEqual(c.snapshot().stuckKnown, false, "the unknown window is surfaced");
    assertEqual(ingests.length, 0, "nothing sent for the unprovable note (no false 1 s clip, no guess)");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
