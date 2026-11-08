// debug_probe_b.ts — independent-review P3 regressions + faithful-schema
// probes (against the REAL c8e1bfb Rust engine semantics, not only the fake).

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
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
  ScriptedTransport,
  settle,
  takeReply,
  test,
  sourcePath } from "./harness";

const fs = require("fs");
const TRACK = 7;

function routeAll(t: ScriptedTransport): void {
  t.router = (req) => {
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
    return null;
  };
}

function hit(client: SoundcraftCompanionClient, clock: FakeClock, nanos: number, key: number, channel: number): number {
  clock.nanos = nanos;
  client.noteOn("beat", 0, key, 100, channel);
  clock.nanos = nanos + 40_000_000;
  client.noteFinished(key, channel);
  return nanos + 40_000_000;
}

export const tests: Array<ReturnType<typeof test>> = [
  // B1 — the REAL resume reply carries `last_event_id` (no `cursor`): parse it.
  test("B1 resume cursor parsed from the real reply field last_event_id (no `cursor` in the wire shape)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
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
        return { kind: "ok", status: 200, body: ingestReply(0, 0) };
      }
      if (req.path === "/v1/live/sessions/1/resume") {
        return { kind: "ok", status: 200, body: { session: 1, resumed: true, released: [], swept: 0, unknown_duration: 0, notes: 0, unknown_notes: 0, overflow: false, status: { state: "reconciled", session_id: 1 }, cursor: 5, journal_last_event_id: 5, last_event_id: 5 } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    const reOk = await c.pair("B7K2-9MXP"); // re-pair mid-capture → resume path
    assert(reOk, "re-paired");
    assertEqual(c.snapshot().unsynced.lastAckedEventId, 5, "cursor adopted from last_event_id (the real field)");
  }),

  // B2 — the REAL take reply has `last_event_id: null` on a fresh take
  // (Option<EventId> serialises as null): must parse, not fail.
  test("B2 take readback with last_event_id null parses (fresh take, faithful schema)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
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
        return {
          kind: "ok",
          status: 200,
          body: { session: 1, track: TRACK, status: { state: "localOnly" }, synced: true, overflow: false, unknown_duration: 0, stale_document: false, committed: false, notes: [], held: [], last_event_id: null },
        };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens");
    assert(started, "capture started despite last_event_id null");
  }),

  // B3 — HTTP redirects must be REFUSED at the protocol level (redirect:
  // "error"), not after the fact: a followed redirect would already have sent
  // the Authorization header to the redirect target.
  test("B3 fetch requests set redirect:'error' (refuse before forwarding credentials)", async () => {
    const src = fs.readFileSync(
      sourcePath("SoundcraftCompanionHttp.ts"),
      "utf-8"
    );
    assert(/redirect["']?\s*:\s*["']error["']/.test(src), "fetch options carry redirect: 'error'");
    assert(src.indexOf('redirect: "follow"') === -1, "no redirect: follow anywhere");
  }),

  // B4 — no pairing-code inspector input may exist: an authored scene value
  // cannot be removed at runtime, so pairing is memory/UI-only via
  // submitPairingCode().
  test("B4 controller has NO pairingCode @input (scene values cannot be blanked at runtime)", async () => {
    const src = fs.readFileSync(
      sourcePath("SoundcraftCaptureController.ts"),
      "utf-8"
    );
    assert(src.indexOf("pairingCode") === -1, "no pairingCode input/field anywhere in the controller");
    assert(src.indexOf("submitPairingCode") !== -1, "pairing stays available via the public submitPairingCode API");
  }),

  // B5 — stopCapture NEVER silently closes an uncommitted take: an explicit
  // discard flag (or a landed commit) is required; refusing keeps the session
  // open and surfaces why.
  test("B5 stopCapture refuses to close an uncommitted take without an explicit discard", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeAll(transport);
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_100_000_000, 36, 9);
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9);
    const refused = await c.stopCapture();
    assert(!refused, "uncommitted take is NOT closed by a bare stopCapture");
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE"), 0, "no DELETE was sent");
    assert(c.snapshot().capturingStillOpen === true, "the session is still open (surfaced, not silently dropped)");
    const discarded = await c.stopCapture({ discardUncommitted: true });
    assert(discarded, "explicit discard closes the session");
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE"), 1, "exactly one close after the explicit discard");
    assert(c.snapshot().unsynced.retiredUnsentEvents >= 4, "the discarded work is retired with a visible count");
    // And a COMMITTED take closes without any flag:
    const transport2 = new ScriptedTransport();
    const clock2: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c2 = new SoundcraftCompanionClient(makeEnv(transport2, clock2), makeConfig({ flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    transport2.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take" && req.method === "GET") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK, { committed: { clip: 9, track: TRACK, revision: 3, undo_label: "Take to MIDI Clip" }, lastEventId: 4 }) };
      }
      if (req.path === "/v1/live/sessions/1/events") {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
        let max = 0;
        for (const ev of body.events) {
          if (ev.eventId > max) {
            max = ev.eventId;
          }
        }
        return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
      }
      if (req.path === "/v1/live/sessions/1" && req.method === "DELETE") {
        return { kind: "ok", status: 200, body: { notes: 2, released: [], unknown_duration: 0 } };
      }
      return null;
    };
    await c2.pair("A7K2-9MXP");
    await c2.startCapture("Lens");
    nanos = hit(c2, clock2, 1_100_000_000, 36, 9);
    nanos = hit(c2, clock2, nanos + 10_000_000, 38, 9);
    clock2.nowSecs = 100.55;
    await c2.pump(); // drain first — the commit goes out only with the queue clean
    await settle();
    transport2.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 9, saved: { status: "saved", name: "b5-v1.scraft", version: 1, bytes: 64 } }) });
    clock2.nowSecs = 100.6;
    await c2.commitTake();
    await settle();
    const closed = await c2.stopCapture();
    assert(closed, "a committed take closes without a discard flag");
    assertEqual(transport2.countRequestsBy((r) => r.method === "DELETE" && r.path === "/v1/live/sessions/1"), 1, "one close for the committed take");
  }),

  // B6 — hits that land while no capture session is open (rollover in flight,
  // or the next open failed) are COUNTED (uncapturedHits), never silent.
  test("B6 uncaptured hits during rollover/open failure are counted and surfaced", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ autoCommitNotes: 2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        // The FIRST open succeeds; every LATER open fails (rollover target gone).
        if (transport.countRequestsBy((r) => r.path === "/v1/live/sessions" && r.method === "POST") > 1) {
          return { kind: "ok", status: 400, body: errorBody("backend_error", "too many open performance sessions (limit 1)") };
        }
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
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
      if (req.path === "/v1/live/sessions/1" && req.method === "DELETE") {
        return { kind: "ok", status: 200, body: { notes: 2, released: [], unknown_duration: 0 } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "disabled", reason: "no project root" } }) });
    let nanos = hit(c, clock, 1_100_000_000, 36, 9);
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9); // threshold → commit → rollover open FAILS
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assert(c.snapshot().sessionId === 1, "no new generation opened (open refused)");
    nanos = hit(c, clock, nanos + 120_000_000, 40, 9); // a hit while the rollover/open is unresolved
    const s = c.snapshot();
    // The reviewer's PREFERRED outcome: the hit is BUFFERED for the next take
    // (preserved, honestly displayed) — not counted as lost.
    assert(s.unsynced.bufferedHits >= 1, "the hit is BUFFERED for the next session (preserved, honestly displayed)");
    assert(s.unsynced.uncapturedHits === 0, "nothing was counted as lost while the buffer could still take it");
  }),

  // B7 — judge-mode playlist entries carry their OWN honest source
  // ("local_only"), never the receipt source.
  test("B7 local-only playlist entry uses source 'local_only' (no pseudo saved_receipt)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ onlineMode: false }));
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_100_000_000, 36, 9);
    hit(c, clock, nanos + 10_000_000, 38, 9);
    clock.nowSecs = 100.6;
    await c.pump();
    const entries = c.snapshot().playlist;
    assert(entries.length >= 1, "the local take is listed");
    assert(entries.every((e) => e.source === "local_only"), "its source is 'local_only', not a receipt pseudo-source");
    assert(entries.every((e) => e.savedBadge === false), "no badge without a backend");
  }),

  // B8 — the REAL engine validates a batch WHOLE before applying
  // (live/mod.rs: "Validated whole before anything applies"): a
  // validation_error 422 proves the ENTIRE batch was refused → retire the
  // whole batch with counters + reason (no resend of proven-dead events).
  test("B8 validation_error retires the whole proven-refused batch with reason (real all-or-nothing semantics)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
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
        return {
          kind: "ok",
          status: 422,
          body: errorBody("validation_error", "invalid request", [{ path: "events[0].trackId", message: "must be between 0 and 9007199254740991" }]),
        };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_100_000_000, 36, 9);
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    clock.nowSecs = 101.6;
    await c.pump();
    await settle();
    const s = c.snapshot();
    assert(s.unsynced.retiredRefusedEvents >= 4, "the whole proven-refused batch is retired with a count");
    assertEqual(s.unsynced.unsentEvents, 0, "nothing stays queued to poison future flushes");
    assert(s.unsynced.captureBlockedReason.indexOf("validation_error") !== -1 || s.lastErrorCode === "validation_error" || s.detail.length > 0, "the refusal reason is surfaced");
    const posts = transport.countRequestsBy((r) => r.path.indexOf("/events") !== -1);
    assertEqual(posts, 1, "no resend of the proven-dead batch");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
