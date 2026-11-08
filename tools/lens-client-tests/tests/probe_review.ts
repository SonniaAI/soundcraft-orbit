// probe_review.ts — independent-review regressions R1–R8. Every probe fails
// against the pre-fix implementation and passes after. Wired into run.ts.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import { isSavedReceiptSaved } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionTypes";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  commitReply,
  errorBody,
  FakeClock,
  ingestReply,
  journalReply,
  liveOpenReply,
  makeConfig,
  makeEnv,
  pairReply,
  runAll,
  savesReply,
  ScriptedTransport,
  settle,
  takeReply,
  test,
  sourcePath } from "./harness";

const fs = require("fs");
const SESSION = 1;
const TRACK = 7;

/** Full-route router: pair/capabilities/open(any session)/take(any session)/ingest(cursor=max). */
function routeAll(t: ScriptedTransport, opts?: { noEvents?: boolean; knownTracks?: Array<number | string> }): void {
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      const body = JSON.parse(req.bodyJson as string) as { session: number; track: number | string };
      if (opts !== undefined && opts.knownTracks !== undefined) {
        const known = opts.knownTracks.some((k) => k === body.track);
        if (!known) {
          // Faithful to the real engine: live_open NEVER creates tracks.
          return { kind: "ok", status: 400, body: errorBody("backend_error", "no track named " + JSON.stringify(body.track)) };
        }
      }
      return { kind: "ok", status: 200, body: liveOpenReply(body.session) };
    }
    if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
      const sid = parseInt(req.path.split("/")[4]);
      return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
    }
    if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path) && (opts === undefined || !opts.noEvents)) {
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
    return null;
  };
}

function hitN(client: SoundcraftCompanionClient, clock: FakeClock, count: number, startNanos: number, keyBase: number, channel: number): number {
  let nanos = startNanos;
  for (let i = 0; i < count; i++) {
    nanos += 10_000_000;
    clock.nanos = nanos;
    client.noteOn("beat", i % 4, keyBase + (i % 8), 100, channel);
    nanos += 40_000_000;
    clock.nanos = nanos;
    client.noteFinished(keyBase + (i % 8), channel);
  }
  return nanos;
}

export const tests: Array<ReturnType<typeof test>> = [
  // R1 — PadInstrument identity fix: the name fallback must WRITE the field,
  // otherwise every panel stays "beat" (scene authors all three as the default).
  test("R1 PadInstrument writes the derived instrumentType back to the field (scene defaults are all 'beat')", async () => {
    const src = fs.readFileSync(
      sourcePath("PadInstrument.ts"),
      "utf-8"
    );
    assert(src.indexOf("this.instrumentType = type;") !== -1, "onAwake assigns this.instrumentType = type after the name fallback");
  }),

  // R2 — a note-off must still be queued when its note-on was already acked
  // (1 s sample vs 0.5 s flush: acked-then-finish is the COMMON case).
  test("R2 note-off queues after an acked note-on (only never-queued 'local' is skipped)", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeAll(transport);
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    clock.nanos = 1_100_000_000;
    c.noteOn("beat", 0, 36, 100, 9);
    clock.nowSecs = 100.6;
    await c.pump(); // flush acks the note-on (cursor = 1)
    assertEqual(c.snapshot().unsynced.ackedEvents, 1, "note-on acked");
    clock.nanos = 1_600_000_000;
    c.noteFinished(36, 9); // the REAL finish arrives after the ack
    clock.nowSecs = 101.2;
    await c.pump();
    const offSent = transport.bodiesOf((r) => r.path.indexOf("/events") !== -1).some((b) => {
      const events = (b as { events: Array<{ payload: { type: string } }> }).events;
      return events.some((e) => e.payload.type === "noteOff");
    });
    assert(offSent, "the note-off WAS sent after its note-on was acked");
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "nothing left behind");
  }),

  // R3 — a commit receipt recovered via the readback (or a 409) must schedule
  // the SAME rollover as a 200 success: exactly one close, next take opens,
  // receipt evidence preserved.
  test("R3 recovered commit receipt schedules the rollover exactly once (no double close, receipt kept, next take commits)", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9, flushIntervalSeconds: 0, autoCommitNotes: 2 }));
    let commitLanded = false;
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK, commitLanded ? { committed: { clip: 42, track: TRACK, revision: 9, undo_label: "Take to MIDI Clip" }, lastEventId: 4 } : undefined) };
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
        return { kind: "ok", status: 200, body: { notes: 2, released: [], unknown_duration: 0 } };
      }
      return null; // commit POST hits the scripted queue
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "deadline" }); // commit reply LOST (queued before the threshold fires)
    hitN(c, clock, 2, 1_000_000_000, 36, 9); // threshold → the take's ONE commit POST → deadline
    clock.nowSecs = 100.6;
    await c.commitTake(); // refused by the posted-once latch — never a second POST
    commitLanded = true; // the backend kept running; the readback now shows it
    transport.enqueue({ kind: "ok", status: 200, body: { session: SESSION, committed: { clip: 42, track: TRACK, revision: 9, undo_label: "Take to MIDI Clip" }, saved: { status: "saved", name: "take-1-r3-v1.scraft", version: 1, bytes: 256 } } });
    clock.nowSecs = 101.6;
    await settle();
    await c.pump(); // flush drains → the withheld commit fires (deadline → unknown)
    await settle();
    await c.pump(); // the poll settles the unknown via the readback receipt → save → rollover
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE" && r.path === "/v1/live/sessions/1"), 1, "exactly ONE close of the committed session");
    assert(transport.countRequestsBy((r) => r.method === "POST" && r.path === "/v1/live/sessions") === 2, "the NEXT take opened (rollover like a 200 success)");
    assert(c.snapshot().sessionId === 2, "now capturing into generation 2");
    assert(c.snapshot().savedBadgeCount === 1, "saved evidence preserved through the rollover");
    assert(isSavedReceiptSaved(c.snapshot().lastSavedReceipt as any), "receipt status NOT reset");
    assert(c.snapshot().commitReceipt !== null, "commit receipt preserved");
    // The next take can actually commit (fresh slice, gated gates open):
    const before = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 43, saved: { status: "saved", name: "take-2-r3-v1.scraft", version: 1, bytes: 300 } }) });
    hitN(c, clock, 2, 2_000_000_000, 40, 9);
    clock.nowSecs = 103;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    const after = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    assert(after === before + 1, "the NEXT take's commit went through (exactly one more)");
    assert(c.snapshot().commitReceipt !== null && (c.snapshot().commitReceipt as any).clip === 43, "new receipt recorded");
  }),

  // R4 — resume drops a pending note-off ONLY when its paired note-on is
  // proven applied (noteOnEventId ≤ adopted cursor), channel-agnostic, with
  // the swept voice marked UNKNOWN. Unsent PAIRS stay deliverable.
  test("R4 resume: off dropped only when its on is acked (channel-agnostic); unsent pairs survive; unknown visible", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
      }
      if (req.path === "/v1/live/sessions/1/events") {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
        // Accept ONLY the first event: cursor 1 = note1's on acked, its off pending.
        return { kind: "ok", status: 200, body: ingestReply(1, Math.min(1, body.events.length)) };
      }
      if (req.path === "/v1/live/sessions/1/resume") {
        // REAL engine shape: last_event_id (no `cursor`), HeldVoice has no velocity.
        return { kind: "ok", status: 200, body: { session: 1, resumed: true, released: [{ track: TRACK, channel: 9, key: 36 }], swept: 1, unknown_duration: 1, notes: 0, unknown_notes: 0, overflow: false, status: { state: "reconciled", session_id: 1 }, cursor: 1, journal_last_event_id: 1, last_event_id: 1 } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    clock.nanos = 1_100_000_000;
    c.noteOn("beat", 0, 36, 100, 9); // id1
    clock.nanos = 1_150_000_000;
    c.noteFinished(36, 9); // id2 (pending)
    clock.nanos = 1_300_000_000;
    c.noteOn("bass", 1, 40, 100, 0); // id3
    clock.nanos = 1_350_000_000;
    c.noteFinished(40, 0); // id4 (pending, PAIR still unsent)
    clock.nowSecs = 100.6;
    await c.pump(); // flush: server applies id1 only, cursor 1
    assertEqual(c.snapshot().unsynced.ackedEvents, 1, "only the first event applied");
    // 401 → token_expired, then re-pair → resume (real reply shape).
    transport.enqueue({ kind: "ok", status: 401, body: errorBody("unauthorized", "expired") });
    clock.nowSecs = 100.9;
    await c.pump();
    const reOk = await c.pair("B7K2-9MXP");
    assert(reOk, "re-paired");
    const s = c.snapshot();
    assertEqual(s.unsynced.lastAckedEventId, 1, "cursor adopted from the real resume reply (last_event_id)");
    assertEqual(s.unsynced.notesUnknownDuration, 1, "the acked-on/swept voice is visibly UNKNOWN duration");
    assertEqual(s.unsynced.unsentEvents, 2, "the unsent PAIR (ids 3,4) survived — still deliverable");
    const dropped = transport.countRequestsBy((r) => r.path.indexOf("/events") !== -1);
    clock.nowSecs = 200.6;
    await c.pump();
    await settle();
    const resent = transport.bodiesOf((r) => r.path.indexOf("/events") !== -1) as Array<{ events: Array<{ eventId: number; payload: { type: string } }> }>;
    const allIds = resent.slice(dropped).flat().flatMap((b) => b.events.map((e) => e.eventId));
    assert(!allIds.includes(2), "the swept voice's late note-off (id2) was never resent");
    assert(allIds.includes(3) && allIds.includes(4), "the intact pair (3,4) WAS delivered");
  }),

  // R5 — a commit whose outcome is unknown is NEVER re-POSTed: exactly one
  // commit per take even as new note-offs keep arriving and polls give up.
  test("R5 unknown-commit outcome: exactly one POST per take forever, settlement only by readback", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ autoCommitNotes: 2, commitPollIntervalSeconds: 0, commitPollMaxTries: 2, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) }; // NEVER shows committed (outcome stays unknown)
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
      return null; // commit POST hits the scripted deadline queue
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "deadline" });
    let nanos = hitN(c, clock, 2, 1_000_000_000, 36, 9); // crosses the threshold → auto commit → deadline
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    clock.nowSecs = 102;
    await c.pump(); // poll 1
    await settle();
    clock.nowSecs = 104;
    await c.pump(); // poll 2
    await settle();
    clock.nowSecs = 106;
    await c.pump(); // poll 3 → maxTries(2) exhausted → outcome stays unknown
    await settle();
    assert(c.snapshot().phase === "commit_unknown" as any, "still unknown after the polls give up");
    nanos = hitN(c, clock, 2, nanos, 44, 9); // NEW finishes AFTER the give-up
    clock.nowSecs = 108;
    await c.pump();
    await settle();
    const commits = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    assertEqual(commits, 1, "EXACTLY one commit POST for this take, even after polls give up and notes keep finishing");
    assert(c.snapshot().phase === "commit_unknown" as any, "still honestly unknown — nothing was claimed");
  }),

  // R6 — mid-batch ingest refusal: journal-reconcile the prefix ONCE, retire
  // the proven refusal point (+ its pair) with counters and the verbose
  // reason, keep the provably-unattempted rest deliverable. No poison loop.
  test("R6 partial ingest refusal: prefix reconciled, refusal point retired with reason, rest delivered", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    let refuseAt = 2; // backend applies ids 1..2 then refuses at index 2 (eventId 3)
    let refuseMessage = "events[2]: the transport is stopped; there is no timeline position to map to (2 accepted before it)";
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/journal/.test(req.path)) {
        return { kind: "ok", status: 200, body: journalReply(2) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
        const refused = body.events.some((e) => e.eventId === 3);
        if (refused) {
          return { kind: "ok", status: 400, body: errorBody("backend_error", refuseMessage) };
        }
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
    hitN(c, clock, 3, 1_000_000_000, 36, 9); // 6 events: 1..6; backend refuses at 3
    clock.nowSecs = 100.6;
    await settle();
    await c.pump(); // the refused flush + the journal reconcile + the retirement
    await settle();
    const s = c.snapshot();
    assert(s.unsynced.retiredRefusedEvents >= 2, "the refusal point AND its pair were retired (counted)");
    assertEqual(s.unsynced.lastAckedEventId, 2, "the applied prefix (1,2) was adopted from the journal");
    assertEqual(s.unsynced.unsentEvents, 2, "the provably-unattempted rest (5,6) is still deliverable");
    assert(s.lastErrorCode !== "" || s.unsynced.retiredRefusedEvents > 0, "the refusal is surfaced");
    clock.nowSecs = 101.6;
    await c.pump(); // the fresh batch (5,6) goes out
    await settle();
    assertEqual(c.snapshot().unsynced.lastAckedEventId, 6, "the fresh batch applied");
    const resent = transport.bodiesOf((r) => r.path.indexOf("/events") !== -1) as Array<{ events: Array<{ eventId: number }> }>;
    const lastBatch = resent[resent.length - 1].events.map((e) => e.eventId);
    assert(!lastBatch.includes(3) && !lastBatch.includes(4), "retired events are never resent");
    assert(lastBatch.includes(5) && lastBatch.includes(6), "unattempted events were delivered in a fresh batch");
    const commits = transport.countRequestsBy((r) => r.path.indexOf("/events") !== -1);
    assert(commits <= 4, "bounded request count — no poison loop");
  }),

  // R6b — ClockStopped: the real engine JOURNALS the head before recording
  // fails, so the cursor adopts it; repeated refusals latch after 3 with the
  // remaining events retired (reason + counter) — no infinite POST storm.
  test("R6b ClockStopped storms latch: head adopted via journal, rest retired with reason after 3 refusals", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    let journaled = 0; // the real engine journals the event even when recording fails (ClockStopped)
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/journal/.test(req.path)) {
        return { kind: "ok", status: 200, body: journalReply(journaled) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
        journaled = Math.max(journaled, body.events[0].eventId); // head journaled, then refused
        return { kind: "ok", status: 400, body: errorBody("backend_error", "events[0]: the transport is stopped; there is no timeline position to map to (0 accepted before it)") };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    hitN(c, clock, 3, 1_000_000_000, 36, 9); // 6 events
    for (let i = 1; i <= 8; i++) {
      clock.nowSecs = 100 + i * 0.6;
      await c.pump();
      await settle();
    }
    const posts = transport.countRequestsBy((r) => r.path.indexOf("/events") !== -1);
    assert(posts <= 5, "POSTs stopped after the latch (3 refusals + bounded retries), observed " + posts);
    const s = c.snapshot();
    assert(s.unsynced.captureBlockedReason !== "" && s.unsynced.captureBlockedReason.indexOf("transport is stopped") !== -1, "the latch names the real refusal verbatim");
    assert(s.unsynced.retiredRefusedEvents > 0, "the latched remainder is retired with a count, not discarded silently");
    assertEqual(s.unsynced.unsentEvents, 0, "nothing left queued");
  }),

  // R7 — auto-commit is gated on a COMMITTABLE slice (no held, no unknown
  // durations) and latches after a typed refusal: no storms.
  test("R7 auto-commit gated on held/unknown; refusal latches auto-commit for the take", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ autoCommitNotes: 2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeAll(transport);
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    // 1 HELD note FIRST, then 2 completions crossing the threshold: the slice
    // is NOT committable while the voice is held — no auto POST.
    let nanos = 1_000_000_000;
    clock.nanos = nanos;
    c.noteOn("beat", 2, 44, 100, 9); // held open — commit would be refused
    nanos = hitN(c, clock, 2, nanos + 10_000_000, 36, 9);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 0, "no commit attempted while a note is held");
    // Release the held voice → gate opens → exactly one auto commit.
    clock.nanos = nanos + 60_000_000;
    c.noteFinished(44, 9);
    clock.nowSecs = 101.2;
    await c.pump();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "auto-commit fired once the slice became committable");
    // A typed refusal latches: further completions never re-fire.
    transport.enqueue({ kind: "ok", status: 400, body: errorBody("backend_error", "take commit refused: track `Lens` already holds 1 overlapping clip there (samples 0..100): a take is never committed over existing material") });
    clock.nowSecs = 101.8;
    await c.pump(); // delivers the refusal
    await settle();
    const afterRefusal = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    assertEqual(afterRefusal, 1, "one commit attempt");
    nanos = hitN(c, clock, 3, nanos + 120_000_000, 50, 9); // far past the threshold again
    clock.nowSecs = 103;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "the refusal latch stops auto-commit storms for this take");
  }),

  // R8 — the rollover must send the NUMERIC track id (JS "7" is a track NAME
  // to the real engine's resolve_track: names must already exist; the engine
  // never creates tracks). startCapture accepts string | number.
  test("R8 rollover sends the numeric trackId; startCapture accepts string | number; unknown names are refused faithfully", async () => {
    const { transport, client, clock } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ autoCommitNotes: 2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const openBodies: Array<{ session: number; track: number | string }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const body = JSON.parse(req.bodyJson as string) as { session: number; track: number | string };
        openBodies.push(body);
        // Faithful resolve_track: integer must name an EXISTING id; strings are names.
        if (typeof body.track === "string" && body.track !== "Lens") {
          return { kind: "ok", status: 400, body: errorBody("backend_error", "no track named " + JSON.stringify(body.track)) };
        }
        if (typeof body.track === "number" && body.track !== TRACK) {
          return { kind: "ok", status: 400, body: errorBody("backend_error", "no track " + body.track + " in the open session") };
        }
        return { kind: "ok", status: 200, body: { session: body.session, track: TRACK, sample_rate: 48000, stuck_timeout_samples: 48000, max_note_samples: 480000 } };
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
        return { kind: "ok", status: 200, body: { notes: 2, released: [], unknown_duration: 0 } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens"); // string name (operator-configured)
    assert(started, "capture started with a track NAME");
    assertEqual(typeof openBodies[0].track, "string", "first open carries the configured name");
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "take-1-r8-v1.scraft", version: 1, bytes: 128 } }) });
    hitN(c, clock, 2, 1_000_000_000, 36, 9);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assert(openBodies.length >= 2, "the rollover opened the next take");
    const rolloverBody = openBodies[1];
    assertEqual(rolloverBody.track, TRACK, "rollover track value is the resolved id");
    assertEqual(typeof rolloverBody.track, "number", "rollover track is a NUMBER (a string '7' would be a track NAME to resolve_track)");
    assert(c.snapshot().sessionId === 2 && c.snapshot().phase === "capturing" as any, "next generation capturing");
    // A numeric startCapture is also legal (operator configured an id):
    const { transport: t2, client: c2, clock: ck2 } = { transport: new ScriptedTransport(), clock: { nowSecs: 100, nanos: 0 } as FakeClock, client: null as unknown as SoundcraftCompanionClient };
    const c3 = new SoundcraftCompanionClient(makeEnv(t2, ck2), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    routeAll(t2);
    await c3.pair("A7K2-9MXP");
    const startedNumeric = await c3.startCapture(TRACK);
    assert(startedNumeric, "startCapture accepts a numeric track id");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
