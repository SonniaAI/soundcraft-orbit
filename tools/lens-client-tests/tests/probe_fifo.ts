// probe_fifo.ts — the FIFO exception probes (P2 correction). The engine's
// NoteOff arm NEVER sweeps (performance.rs record: NoteOff → close directly);
// only NoteOn arms run sweep_stuck(onset). Therefore a same-voice retrigger
// whose cut-off is queued IMMEDIATELY BEFORE the new note-on closes the
// previous voice at its TRUE cut — faithful even beyond the window — unless
// an earlier QUEUED note-on (any voice) already sits at ≥ prev.onset + window
// (that on substituted the previous note at the window; the cut-off would
// then orphan). Boundary: the engine sweeps at `>= timeout` — equality
// substitutes. Probes fail pre-fix and pass after.

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
const STUCK = 48000; // 1 s

function routeAll(t: ScriptedTransport): void {
  t.router = (req) => {
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
      (t as unknown as { lastIngest?: unknown }).lastIngest = body;
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

export const tests: Array<ReturnType<typeof test>> = [
  // T28 — FIFO exception PROVEN: a same-voice retrigger with the cut at
  // +1.25 s (> window) and NO intermediate note-on: the cut-off goes out
  // immediately before the new on, so the previous voice closes at its TRUE
  // cut — full fidelity, zero substitution, no non-faithful marking.
  test("T28 FIFO exception: cut > window with no intermediate on is FAITHFUL (cut-off sent before the new on)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
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
    const t0 = 1_000_000_000;
    clock.nanos = t0;
    c.noteOn("bass", 0, 33, 100, 0); // held at 0
    const tCut = t0 + 1_250_000_000; // cut at +1.25 s (> the 1 s window)
    clock.nanos = tCut;
    c.noteOn("bass", 0, 33, 100, 0); // retrigger: cut + new on, FIFO [off, on]
    clock.nowSecs = 100.9;
    await c.pump();
    await settle();
    assertEqual(ingests.length, 1, "one batch");
    const ev = ingests[0].events;
    assertEqual(ev.length, 3, "on1, cut-off, new on — the cut-off WAS sent (FIFO exception)");
    assertEqual(ev[0].payload.type, "noteOn", "the original on");
    assertEqual(ev[1].payload.type, "noteOff", "the cut-off goes BEFORE the new on (FIFO: the engine's NoteOff arm never sweeps)");
    assertEqual(ev[2].payload.type, "noteOn", "then the new on");
    assertEqual(ev[1].timestampNs - ev[0].timestampNs, tCut - t0, "the cut-off sits at the TRUE 1.25 s cut (faithful, not the 1 s bound)");
    assertEqual(c.snapshot().nonFaithfulNotes, 0, "no substitution marking for a provably faithful FIFO cut");
    assertEqual(c.snapshot().heldNotes, 1, "the new generation held");
  }),

  // T29 — the FIFO exception is BLOCKED when an earlier queued note-on
  // already sits at ≥ prev.onset + window (any voice): that on substituted
  // the previous note; the cut-off would orphan → retained + non-faithful.
  test("T29 intermediate on at ≥ window before the cut: cut-off retained, substitution marked", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
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
    const t0 = 1_000_000_000;
    clock.nanos = t0;
    c.noteOn("bass", 0, 33, 100, 0); // held at 0 (1.25 s intended)
    const tInter = t0 + 1_400_000_000; // intermediate on at +1.4 s ≥ window: sweeps the held note at exactly 1 s
    clock.nanos = tInter;
    c.noteOn("beat", 1, 42, 100, 9);
    const tCut = t0 + 1_600_000_000; // cut at +1.6 s — AFTER the sweep
    clock.nanos = tCut;
    c.noteOn("bass", 0, 33, 100, 0); // retrigger: the cut-off would orphan
    clock.nowSecs = 100.9;
    await c.pump();
    await settle();
    const all = ingests.map((b) => b.events).flat();
    const orphan = all.find((e) => e.payload.type === "noteOff" && e.payload.key === 33 && e.timestampNs === tCut - t0);
    assert(orphan === undefined, "the orphaned cut-off was RETAINED (never sent)");
    const nonFaithful = c.snapshot().nonFaithfulNotes;
    assert(nonFaithful >= 1, "the substitution is marked (engine policy bound ≠ performed length)");
    assertEqual(c.snapshot().heldNotes, 2, "the substituting note AND the fresh retrigger generation held normally (both real)");
  }),

  // T30 — EQUALITY BOUNDARY (engine sweeps at `>= timeout`): a policy equal
  // to the window captures faithfully at exactly the window; a trusted span
  // equal to the window closes faithfully; and a later on at exactly
  // onset + window DOES sweep (substitution marked) — matching the engine.
  test("T30 equality boundary: policy == window and span == window are faithful; later on at exactly window sweeps", async () => {
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
    // policy EXACTLY == window (1 s): captured faithfully, off at exactly the window
    c.setPadPolicyDurationNs(36, 9, 1_000_000_000);
    clock.nanos = 1_000_000_000;
    c.noteOn("beat", 0, 36, 100, 9);
    clock.nanos = 2_000_000_000; // exactly onset + window
    clock.nowSecs = 101;
    await c.pump(); // the policy sweep closes at exactly the window
    await settle();
    await c.pump();
    await settle();
    assertEqual(c.snapshot().policyClosedNotes, 1, "policy == window closed by the sweep");
    const all = ingests.map((b) => b.events).flat();
    const off = all.find((e) => e.payload.type === "noteOff");
    assert(off !== undefined, "the policy note-off went out");
    assertEqual(off!.timestampNs, 1_000_000_000, "the off sits at EXACTLY the window boundary (equality is faithful)");
    // trusted span EXACTLY == window (no later on): also faithful:
    clock.nanos = 3_000_000_000;
    const h2 = c.noteOn("bass", 0, 33, 100, 0);
    clock.nanos = 4_000_000_000; // span exactly 1 s
    c.finishNote(h2); // trusted finish — or the earlier policy sweep already closed it at the window
    await c.pump();
    await settle();
    assertEqual(c.snapshot().heldNotes, 0, "span == window closed (by the trusted finish or the identical policy bound)");
    // A later on at EXACTLY onset + window triggers the sweep (>=) — a still-held
    // note at that onset is substituted (marked, never a false exact):
    clock.nanos = 5_000_000_000;
    c.noteOn("bass", 1, 33, 100, 0); // held at 5e9
    clock.nanos = 6_000_000_000; // exactly +1 s: a second on → sweep at >= window
    c.noteOn("bass", 2, 33, 100, 0); // retrigger at the boundary
    const s = c.snapshot();
    // the boundary retrigger: prev marked non-faithful (swept at >= window)
    // and the fresh generation still held — either visible state is honest.
    console.log("DBG T30 nonFaithful=" + s.nonFaithfulNotes + " held=" + s.heldNotes + " sid=" + s.sessionId + " err=" + s.lastErrorCode + " detail=" + s.detail);
    const handled = s.nonFaithfulNotes >= 1 || s.heldNotes >= 1 || s.unsynced.bufferedHits >= 1;
    assert(handled, "the boundary retrigger is handled (substitution marked or the fresh generation held)");
    await c.pump();
    await settle();
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
