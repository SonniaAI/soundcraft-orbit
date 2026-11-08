// probe_round2.ts — second-review regressions: the REAL engine shapes and
// behaviours (504 envelope, already-open ids, tagged TakeStatus, safe
// bootstrap recover, labelled headless-simulation anchoring, idle phrase
// auto-commit, typed onSnapshot). Every probe fails against the pre-fix
// implementation and passes after; wired into run.ts.

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
    if (req.path.indexOf("/transport/simulate") !== -1) {
      const body = JSON.parse(req.bodyJson as string);
      return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
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
  // T1 — the REAL TakeStatus is a serde tagged object; both variants parse.
  // serde rename_all renames the VARIANTS; the Reconciled field keeps its Rust
  // name: {"state":"reconciled","session_id":N} (NOT sessionId).
  test("T1 take readback with the real tagged TakeStatus (localOnly AND reconciled) parses; capture proceeds", async () => {
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
        // REAL engine: status is the tagged TakeStatus object; last_event_id null on a fresh take.
        return { kind: "ok", status: 200, body: { session: 1, track: TRACK, status: { state: "localOnly" }, synced: true, overflow: false, unknown_duration: 0, stale_document: false, committed: false, notes: [], held: [], last_event_id: null } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens");
    assert(started, "capture proceeds against the real tagged status object");
    // And a RECONCILED variant with the REAL serde field name session_id:
    const transport2 = new ScriptedTransport();
    const clock2: FakeClock = { nowSecs: 100, nanos: 0 };
    const c2 = new SoundcraftCompanionClient(makeEnv(transport2, clock2), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
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
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: { session: 1, track: TRACK, status: { state: "reconciled", session_id: 1 }, synced: true, overflow: false, unknown_duration: 0, stale_document: false, committed: false, notes: [], held: [], last_event_id: null } };
      }
      return null;
    };
    await c2.pair("A7K2-9MXP");
    assert(await c2.startCapture("Lens"), "reconciled variant (session_id, snake_case) parses too");
  }),

  // T2 — an ACTUAL HTTP 504 commit_timeout envelope: unknown outcome, settle by
  // the readback, never a second POST, rollover when the receipt lands.
  test("T2 HTTP 504 commit_timeout: one POST, readback settlement, rollover on the recovered receipt", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
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
      return null; // the commit POST hits the scripted 504
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "ok", status: 504, body: errorBody("commit_timeout", "the take commit for session 1 did not complete within 45s — its outcome is unknown (it may still land). Do not retry blindly: the committed receipt appears in GET /v1/live/sessions/1/take once it lands") });
    let nanos = hit(c, clock, 1_000_000_000, 36, 9);
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9); // threshold → the ONE commit POST → real 504
    clock.nowSecs = 100.6;
    await settle();
    await c.pump();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "exactly one commit POST");
    assertEqual(c.snapshot().phase, "commit_unknown" as any, "504 → commit_unknown");
    commitLanded = true; // the backend kept running
    transport.enqueue({ kind: "ok", status: 200, body: { session: SESSION, committed: { clip: 42, track: TRACK, revision: 9, undo_label: "Take to MIDI Clip" }, saved: { status: "saved", name: "t2-v1.scraft", version: 1, bytes: 128 } } });
    clock.nowSecs = 102;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "STILL exactly one POST after settlement");
    assert(c.snapshot().commitReceipt !== null, "receipt recovered from the readback");
    assert(c.snapshot().sessionId === 2, "the rollover fired when the receipt landed");
    assert(c.snapshot().savedBadgeCount === 1, "badge from the exact saved receipt");
  }),

  // T3 — the REAL live.open refusal for an already-open id: try the next id
  // (bounded), COUNT the left-behind take, never resume or discard it.
  test("T3 already-open session id: bounded next-id retry, left-behind counted, stale record untouched", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    const openBodies: Array<{ session: number }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const body = JSON.parse(req.bodyJson as string) as { session: number };
        openBodies.push(body);
        if (body.session === 1) {
          // REAL message (live/mod.rs): "performance session 1 is already open (use `live.resume` to reconnect)"
          return { kind: "ok", status: 400, body: errorBody("backend_error", "performance session 1 is already open (use `live.resume` to reconnect)") };
        }
        return { kind: "ok", status: 200, body: liveOpenReply(body.session) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take$/.test(req.path) && req.method === "GET") {
        const sid = parseInt(req.path.split("/")[4]);
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens");
    assert(started, "capture opened on the NEXT id");
    assertEqual(openBodies.map((b) => b.session), [1, 2], "id 1 refused → id 2 tried");
    assertEqual(c.snapshot().sessionId, 2, "capturing as generation 2");
    assertEqual(c.snapshot().unsynced.leftBehindTakes, 1, "the left-behind take is COUNTED");
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/sessions/1/resume"), 0, "the stale record was NEVER auto-resumed");
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE" && r.path === "/v1/live/sessions/1"), 0, "the stale take was NEVER discarded");
  }),

  // T4 — the safe bootstrap: saves exist + the document is the AUTHORITATIVE
  // fresh document (tracks: []) → recover fires once; anchors follow the
  // recovered material.
  test("T4 bootstrap: saves exist + fresh document (tracks: []) → recover fires once; anchors follow the recovered material", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    const simulateBodies: Array<{ position: number }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/saves") {
        return { kind: "ok", status: 200, body: savesReply(["prev-run-v001.scraft"]) };
      }
      if (req.path.indexOf("/session/inspect") !== -1) {
        // AFTER a recover the document holds the previous run's clip ending at 480000;
        // BEFORE it the document is the AUTHORITATIVE fresh document: tracks: [].
        const recovered = transport.countRequestsBy((r) => r.path === "/v1/live/recover") > 0;
        return {
          kind: "ok",
          status: 200,
          body: {
            name: "Recovered",
            tracks: recovered
              ? [{ id: 33, name: "Lens", clips: [{ id: 1, name: "clip", start: 0, end: 480000, length: 480000 }] }]
              : [],
          },
        };
      }
      if (req.path === "/v1/live/recover") {
        return { kind: "ok", status: 200, body: { save: { name: "prev-run-v001.scraft", bytes: 1024, modified_ms: 1700000000000 }, opened: { session: "Recovered" } } };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
      }
      if (req.path.indexOf("/transport/simulate") !== -1) {
        const body = JSON.parse(req.bodyJson as string);
        simulateBodies.push({ position: body.position });
        return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP"); // bootstrap runs inside pairing
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/recover"), 1, "recover fired exactly once for the fresh document (tracks: [])");
    assert(c.snapshot().projectNote.indexOf("prev-run-v001") !== -1, "the recovered save is surfaced by basename");
    const started = await c.startCapture("Lens");
    assert(started, "capture opened after the bootstrap");
    assert(simulateBodies.length >= 1 && simulateBodies[simulateBodies.length - 1].position === 480000, "the simulation armed AFTER the recovered material (append anchor 480000)");
  }),

  // T5 — a document with MATERIAL is NEVER auto-recovered: actionable state,
  // zero recover POSTs, capture anchors after the existing material.
  test("T5 non-empty document: no blind recover; actionable state; anchor after existing clips", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    const simulateBodies: Array<{ position: number }> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/saves") {
        return { kind: "ok", status: 200, body: savesReply(["prev-run-v001.scraft", "prev-run-v002.scraft"]) };
      }
      if (req.path.indexOf("/session/inspect") !== -1) {
        return { kind: "ok", status: 200, body: { name: "Live", tracks: [{ id: 33, name: "Lens", clips: [{ id: 1, name: "c1", start: 0, end: 240000, length: 240000 }, { id: 2, name: "c2", start: 240000, end: 480000, length: 240000 }] }] } };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(JSON.parse(req.bodyJson as string).session) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: takeReply(1, TRACK) };
      }
      if (req.path.indexOf("/transport/simulate") !== -1) {
        const body = JSON.parse(req.bodyJson as string);
        simulateBodies.push({ position: body.position });
        return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/recover"), 0, "NO recover into a document with material");
    assert(c.snapshot().projectNote.indexOf("1 track(s)") !== -1 && c.snapshot().projectNote.indexOf("2 clip(s)") !== -1, "the actionable state names the existing tracks and clips");
    const started = await c.startCapture("Lens");
    assert(started, "capture proceeds on the live document");
    assert(simulateBodies.length >= 1 && simulateBodies[simulateBodies.length - 1].position === 480000, "anchored AFTER the existing material (max clip end)");
  }),

  // T6 — the rollover arms the labelled simulation at the landed clip's `end`
  // (the engine-echoed authoritative anchor) before opening the next take.
  test("T6 rollover arms the simulation past the committed clip end on the SAME named track", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ autoCommitNotes: 2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const simulateBodies: Array<{ playing: boolean; position: number }> = [];
    const openTracks: Array<number | string> = [];
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        const body = JSON.parse(req.bodyJson as string) as { session: number; track: number | string };
        openTracks.push(body.track);
        return { kind: "ok", status: 200, body: liveOpenReply(body.session) };
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
      if (req.path.indexOf("/transport/simulate") !== -1) {
        const body = JSON.parse(req.bodyJson as string);
        simulateBodies.push({ playing: body.playing, position: body.position });
        return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t6-v1.scraft", version: 1, bytes: 100 } }) });
    // commitReply's clip end: start 1000000, end 5000000 (the harness fixture).
    let nanos = hit(c, clock, 1_000_000_000, 36, 9);
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9);
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assert(simulateBodies.length >= 2, "the simulation was armed for BOTH takes");
    assertEqual(simulateBodies[1].position, 5000000, "the rollover anchor is the landed clip's engine-echoed `end`");
    assertEqual(simulateBodies[1].playing, true, "armed playing (the labelled simulation, nothing else)");
    assertEqual(openTracks[1], TRACK, "the next take opened on the SAME NUMERIC track id");
    assert(c.snapshot().sessionId === 2, "next generation capturing");
  }),

  // T7 — the IDLE PHRASE boundary: a short played phrase auto-commits and
  // saves with NO manual commitTake (ordinary playing saves itself).
  test("T7 short phrase auto-commits at the idle boundary — no manual commit, no overlap on phrase 2", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
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
      if (req.path.indexOf("/transport/simulate") !== -1) {
        const body = JSON.parse(req.bodyJson as string);
        return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_000_000_000, 36, 9);
    clock.nowSecs = 100.6;
    await c.pump(); // flushes the events; idle clock not yet elapsed
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 0, "no commit before the idle boundary");
    clock.nanos = nanos + 300_000_000; // 300 ms of idle ≥ the 200 ms boundary
    clock.nowSecs = 100.9;
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t7-v1.scraft", version: 1, bytes: 100 } }) });
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "the idle boundary committed the phrase WITHOUT any manual call");
    assert(c.snapshot().savedBadgeCount === 1, "exact saved receipt earned");
    assert(c.snapshot().sessionId === 2, "rolled into the next take");
    // Phrase 2 on the rolled-over session — same path, no manual call:
    nanos = hit(c, clock, nanos + 500_000_000, 44, 9);
    clock.nanos = nanos + 300_000_000; // idle ≥ the boundary for phrase 2
    clock.nowSecs = 101.6;
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 43, saved: { status: "saved", name: "t7-v2.scraft", version: 1, bytes: 120 } }) });
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 2, "phrase 2 auto-committed too");
    assertEqual(c.snapshot().savedBadgeCount, 2, "both phrases saved");
  }),

  // T9 — without the transport advertisement the client REFUSES safely: no
  // faked simulation authority, zero capture requests.
  test("T9 no simulation advertisement → capture refuses safely with zero requests", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 0 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1e9 }));
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        const reply = capabilitiesReply() as { [key: string]: unknown };
        delete reply["transport"]; // a backend that does NOT advertise the simulation
        return { kind: "ok", status: 200, body: reply };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    const started = await c.startCapture("Lens");
    assert(!started, "capture refused without simulation authority");
    assert(c.snapshot().detail.indexOf("headless transport simulation") !== -1, "the refusal names the missing advertisement");
    assertEqual(transport.countRequestsBy((r) => r.path.indexOf("/live/sessions") !== -1), 0, "no session was opened");
  }),

  // T10 — the controller exposes the typed onSnapshot callback (no credentials)
  // and invokes it from its safe renderStatus path.
  test("T10 controller exposes onSnapshot and invokes it from renderStatus (source contract)", async () => {
    const src = fs.readFileSync(
      sourcePath("SoundcraftCaptureController.ts"),
      "utf-8"
    );
    assert(/onSnapshot\s*:\s*\(\s*s\s*:\s*StatusDetail\s*\)\s*=>\s*void(\s*=\s*null|\s*\|\s*null)/.test(src), "public onSnapshot: (s: StatusDetail) => void (null-initialised) exists");
    assert(src.indexOf("this.onSnapshot(s)") !== -1, "renderStatus invokes the callback behind a null guard");
    assert(src.indexOf("pairingCode") === -1, "still no pairing-code field");
  }),

  // T11 — zero clips on EXISTING tracks is NOT emptiness: instrument tracks,
  // plugin settings and mix edits can be unsaved configuration — auto-recover
  // must NOT fire; the explicit action remains available and the state visible.
  test("T11 tracks exist with zero clips → NO automatic recover (unsaved configuration is never clobbered)", async () => {
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
      if (req.path === "/v1/live/saves") {
        return { kind: "ok", status: 200, body: savesReply(["prev-run-v001.scraft"]) };
      }
      if (req.path.indexOf("/session/inspect") !== -1) {
        // A custom-mixed project: one instrument track (plugins/mix set), ZERO clips.
        return { kind: "ok", status: 200, body: { name: "Live", tracks: [{ id: 9, name: "Synth", clips: [], instrument: "SomeSynth" }, { id: 10, name: "Lens", clips: [] }] } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/recover"), 0, "NO recover over tracks that exist (even with zero clips)");
    assert(c.snapshot().projectNote.indexOf("2 track(s)") !== -1 && c.snapshot().projectNote.indexOf("NOT recovering") !== -1, "the actionable state names the tracks and the refusal");
  }),

  // T12 — a malformed inspect cannot prove emptiness: fail closed (no recover).
  test("T12 malformed inspect → fail closed, no recover, surfaced", async () => {
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
      if (req.path === "/v1/live/saves") {
        return { kind: "ok", status: 200, body: savesReply(["prev-run-v001.scraft"]) };
      }
      if (req.path.indexOf("/session/inspect") !== -1) {
        return { kind: "ok", status: 200, body: { detail: "summary", blob: "not-a-parseable-document" } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/recover"), 0, "fail closed — no recover on an unparseable inspect");
    assert(c.snapshot().lastErrorCode === "bootstrap_unproven" || c.snapshot().projectNote.indexOf("could not be read") !== -1, "the unprovable state is surfaced");
  }),

  // T13 — the reviewer's exact sequence: partial ingest refusal (head adopted,
  // remainder pending) + user silence → the commit is WITHHELD while the queue
  // is unresolved; it fires only after the queue drains (nothing discarded).
  test("T13 head-adopted refusal + remaining pending + silence: commit withheld until the queue drains", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    let refuses = true;
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
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/journal/.test(req.path)) {
        return { kind: "ok", status: 200, body: journalReply(2) }; // ids 1,2 applied; 3 was the refusal point
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
        const has3 = body.events.some((e) => e.eventId === 3);
        if (refuses && has3) {
          return { kind: "ok", status: 400, body: errorBody("backend_error", "events[2]: the transport is stopped; there is no timeline position to map to (2 accepted before it)") };
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
    let nanos = hit(c, clock, 1_000_000_000, 36, 9); // id1 id2 (journaled)
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9); // id3 id4 (the refusal lands here)
    nanos = hit(c, clock, nanos + 10_000_000, 44, 9); // id5 id6
    clock.nanos = nanos + 300_000_000; // idle boundary long elapsed + SILENCE (no new notes)
    clock.nowSecs = 100.6;
    await settle();
    await c.pump(); // refused flush + journal reconcile (prefix drained, refusal point retired)
    await settle();
    await c.pump(); // the remainder (5,6) is resent and applied → the queue drains
    await settle();
    await c.pump(); // idle elapsed with the queue CLEAN → the withheld commit fires
    await settle();
    const commitsAfterDrain = transport.countRequestsBy((r) => r.path.endsWith("/take/commit"));
    assertEqual(commitsAfterDrain, 1, "the commit fired exactly once — AFTER the queue resolved (never with unresolved events)");
    assert(c.snapshot().unsynced.retiredRefusedEvents >= 2, "the provably-refused events were retired with counters, not discarded silently");
    assert(c.snapshot().completedNotes >= 2, "the surviving notes are still real captures");
  }),

  // T14 — a reconcile that CANNOT resolve keeps the queue intact: no commit,
  // no rollover, nothing reset; the unresolved state persists visibly.
  test("T14 unresolved reconcile: pending preserved, commit withheld, rollover withheld — nothing reset", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    let flushCount = 0;
    let lostFlush = false;
    let commitLanded = false; // set once the losing flush has been scripted
    let resolved = false; // the journal starts answering with the applied prefix
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
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK, resolved && commitLanded ? { committed: { clip: 42, track: TRACK, revision: 9, undo_label: "Take to MIDI Clip" }, lastEventId: preserved } : undefined) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        flushCount++;
        if (resolved) {
          const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number }> };
          let max = 0;
          for (const ev of body.events) {
            if (ev.eventId > max) {
              max = ev.eventId;
            }
          }
          return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
        }
        if (!lostFlush) {
          return { kind: "ok", status: 200, body: ingestReply(0, 0) }; // applied, cursor stays 0
        }
        return { kind: "deadline" }; // the losing flush: no reply ever observed
      }
      if (/journal/.test(req.path)) {
        if (!resolved) {
          return { kind: "deadline" }; // the journal cannot answer while unresolved
        }
        return { kind: "ok", status: 200, body: journalReply(preserved) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/save$/.test(req.path) && req.method === "POST") {
        return { kind: "ok", status: 200, body: { session: parseInt(req.path.split("/")[4]), committed: { clip: 42, track: TRACK, revision: 9, undo_label: "Take to MIDI Clip" }, saved: { status: "saved", name: "t14-v1.scraft", version: 1, bytes: 100 } } };
      }
      if (/^\/v1\/live\/sessions\/\d+$/.test(req.path) && req.method === "DELETE") {
        return { kind: "ok", status: 200, body: { notes: 0, released: [], unknown_duration: 0 } };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take\/commit$/.test(req.path)) {
        if (!commitLanded) {
          return { kind: "deadline" }; // the losing commit: no reply ever observed
        }
        // (a landed-but-replayed commit is refused upstream; this test never re-POSTs)
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_000_000_000, 36, 9); // on+off queued
    clock.nowSecs = 100.4;
    await c.pump(); // flush applied (cursor 0 — nothing acked; events stay queued honestly)
    await settle();
    nanos = hit(c, clock, nanos + 10_000_000, 44, 9); // two more events queued
    lostFlush = true; // the NEXT flush's reply is lost (scripted directly)
    clock.nowSecs = 100.8;
    await c.pump(); // flush → deadline → uncertain latched
    await settle();
    const preserved = c.snapshot().unsynced.unsentEvents;
    assert(preserved > 0, "events preserved while unresolved");
    assert(c.snapshot().unsynced.uncertainInFlight, "uncertainty latched");
    clock.nanos = nanos + 400_000_000; // idle elapsed + silence
    clock.nowSecs = 101.6;
    await c.pump(); // reconcile journal → deadline → CANNOT resolve
    await settle();
    await c.pump(); // idle → the commit trigger withholds (queue unresolved)
    await settle();
    const s = c.snapshot();
    assertEqual(s.unsynced.unsentEvents, preserved, "NOTHING was reset while the reconcile could not resolve");
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 0, "NO commit while unresolved (withheld, not sent)");
    assertEqual(s.sessionId, 1, "NO rollover while unresolved");
    assert(s.unsynced.uncertainInFlight || s.unsynced.unsentEvents > 0, "the unresolved/unsynced state persists visibly");
    // Resolution arrives → the journal drains the queue → the withheld commit
    // fires (exactly once) and settles via the readback → save → badge.
    resolved = true;
    commitLanded = true;
    clock.nowSecs = 103;
    await settle();
    await c.pump(); // the journal resolves → the queue drains
    await settle();
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "drained once the journal resolved");
    commitLanded = true;
    clock.nowSecs = 104;
    await c.pump(); // the withheld commit fires (deadline scripted) → unknown
    await settle();
    await c.pump(); // the readback settles it via the recovered receipt → save → badge
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "the withheld commit fired AFTER resolution — exactly once");
    assertEqual(c.snapshot().savedBadgeCount, 1, "saved normally");
  }),

  test("T15 late input during an in-flight commit is buffered, then transferred with fresh ids and exact durations", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const commitBodies: Array<{ events?: Array<{ eventId: number; payload: { type: string } }> }> = [];
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
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; payload: { type: string; key?: number } }> };
        commitBodies.push(body);
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
      if (req.path.indexOf("/transport/simulate") !== -1) {
        const body = JSON.parse(req.bodyJson as string);
        return { kind: "ok", status: 200, body: { playing: body.playing, position: body.position } };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t15-v1.scraft", version: 1, bytes: 100 } }) });
    let nanos = hit(c, clock, 1_000_000_000, 36, 9); // phrase 1 (drained by the flush below)
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9);
    clock.nowSecs = 100.4;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "phrase 1 fully synced");
    // The commit goes out — and WHILE it is in flight, the user plays again:
    const commitPromise = c.commitTake(); // sync: bufferingActive=true at entry
    const lateStart = nanos + 10_000_000;
    clock.nanos = lateStart;
    c.noteOn("bass", 0, 33, 100, 0); // late hit #1 → BUFFER (never into the committed take)
    clock.nanos = lateStart + 80_000_000;
    c.noteFinished(33, 0); // real finish 80 ms later — real duration, unmodified
    clock.nanos = lateStart + 90_000_000;
    c.noteOn("bass", 1, 40, 100, 0); // still open at transfer → transfers OPEN
    const landed = await commitPromise;
    assert(landed, "the in-flight commit landed");
    assertEqual(c.snapshot().unsynced.bufferedHits, 2, "the late hits are buffered, honestly displayed");
    await settle();
    await c.quiesce();
    await settle();
    assert(c.snapshot().sessionId === 2, "the next session opened");
    assertEqual(c.snapshot().unsynced.bufferedHits, 0, "the buffer transferred into the fresh take");
    assertEqual(c.snapshot().unsynced.uncapturedHits, 0, "nothing was lost");
    clock.nowSecs = 101.6;
    await c.pump(); // the transferred events flush to the NEW session
    await settle();
    assertEqual(commitBodies.length, 2, "a second ingest batch went to the NEW session");
    const late = (commitBodies[1].events !== undefined ? commitBodies[1].events : []) as Array<{ eventId: number; timestampNs: number; payload: { type: string; key?: number } }>;
    assertEqual(late.length, 3, "the late notes transferred: on, off, and the still-open on");
    assert(late.every((e) => e.eventId >= 1), "fresh event ids (provably never sent — nothing replayed)");
    const off = late.find((e) => e.payload.type === "noteOff");
    const on = late.find((e) => e.payload.type === "noteOn" && e.payload.key === 33);
    assert(on !== undefined && off !== undefined, "the completed late note transferred as a pair");
    const dur = (off as { timestampNs: number }).timestampNs - (on as { timestampNs: number }).timestampNs;
    assertEqual(dur, 80_000_000, "the REAL 80 ms duration preserved exactly (no fabrication)");
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "NO second commit from the asynchronous return");
  }),

  // T16 — DEFENSE-IN-DEPTH: startCapture refuses while captured events are
  // unresolved, and the rollover withholds close/open — nothing reset.
  test("T16 defense-in-depth: startCapture and the rollover refuse while events are unresolved", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
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
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        return { kind: "ok", status: 200, body: ingestReply(0, 0) };
      }
      if (/journal/.test(req.path)) {
        return { kind: "deadline" }; // the uncertainty never resolves in this test
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    let nanos = hit(c, clock, 1_000_000_000, 36, 9);
    clock.nowSecs = 100.4;
    await c.pump();
    await settle();
    nanos = hit(c, clock, nanos + 10_000_000, 44, 9);
    transport.enqueue({ kind: "deadline" });
    clock.nowSecs = 100.8;
    await c.pump(); // uncertain latched, events preserved
    await settle();
    const preserved = c.snapshot().unsynced.unsentEvents;
    assert(preserved > 0, "events preserved");
    const reopened = await c.startCapture("Lens"); // already capturing → returns true WITHOUT touching state
    assert(reopened, "the already-open session is returned as-is");
    assertEqual(c.snapshot().sessionId, 1, "the session was NOT reset");
    assertEqual(c.snapshot().unsynced.unsentEvents, preserved, "the events were NOT reset (defense-in-depth invariant)");
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE"), 0, "nothing was closed behind the unresolved events");
    // And a landed commit in this state would defer its rollover (no DELETE):
    clock.nanos = nanos + 400_000_000;
    clock.nowSecs = 101.6;
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "disabled", reason: "no project root" } }) });
    await c.pump();
    await settle();
    assertEqual(transport.countRequestsBy((r) => r.method === "DELETE"), 0, "NO close while events are unresolved");
    assert(c.snapshot().sessionId === 1, "no rollover while events are unresolved");
  }),

  // T17 — P2: two same-channel/key hits during buffering — the retrigger
  // closes the first buffered hit at the OBSERVED cut (exact inter-hit delta),
  // the second pairs with its real finish (never a fabricated 1 s), no event
  // loss, no cross-generation contamination, no second commit.
  test("T17 buffered same-key retrigger: first noteOff = exact inter-hit delta, second pairs with its real finish, no loss", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const sessionBodies: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key: number } }> }> = [];
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
        return { kind: "ok", status: 200, body: takeReply(sid, TRACK) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/events$/.test(req.path)) {
        const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; timestampNs: number; payload: { type: string; key: number } }> };
        sessionBodies.push(body);
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
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t17-v1.scraft", version: 1, bytes: 100 } }) });
    let nanos = hit(c, clock, 1_000_000_000, 36, 9); // phrase 1 (drained by the flush below)
    nanos = hit(c, clock, nanos + 10_000_000, 38, 9);
    clock.nowSecs = 100.4;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().unsynced.unsentEvents, 0, "phrase 1 fully synced");
    // The commit goes out — and WHILE it is in flight, TWO hits on the SAME
    // channel/key land (a retrigger during buffering):
    const commitPromise = c.commitTake(); // sync: bufferingActive=true at entry
    const t0 = nanos + 10_000_000;
    clock.nanos = t0;
    c.noteOn("bass", 0, 33, 100, 0); // buffered hit A (unfinished)
    const t1 = t0 + 120_000_000;
    clock.nanos = t1;
    c.noteOn("bass", 0, 33, 100, 0); // RETRIGGER at t1: hit A closes AT t1, hit B opens
    const t2 = t1 + 80_000_000;
    clock.nanos = t2;
    c.noteFinished(33, 0); // hit B's REAL finish (80 ms after its onset — not a 1 s fabrication)
    const landed = await commitPromise;
    assert(landed, "the in-flight commit landed");
    assertEqual(c.snapshot().unsynced.bufferedHits, 2, "both buffered hits preserved (A closed at the cut, B finished)");
    await settle();
    await c.quiesce();
    await settle();
    assert(c.snapshot().sessionId === 2, "the next session opened");
    clock.nowSecs = 101.6;
    await c.pump(); // the transferred events flush to the NEW session
    await settle();
    assertEqual(sessionBodies.length, 2, "a second ingest batch went to the NEW session");
    const transferred = sessionBodies[1].events;
    assertEqual(transferred.length, 4, "hit A (on+off) + hit B (on+off) — 4 events, nothing lost");
    assertEqual(transferred.map((e) => e.payload.type), ["noteOn", "noteOff", "noteOn", "noteOff"], "strict on/off/on/off order");
    assert(transferred.every((e) => e.payload.key === 33), "all same voice (33) — no cross-generation contamination");
    const ids = transferred.map((e) => e.eventId);
    assertEqual(ids, [1, 2, 3, 4], "fresh sequential ids on the new session (provably never sent before)");
    const firstDelta = transferred[1].timestampNs - transferred[0].timestampNs;
    assertEqual(firstDelta, t1 - t0, "hit A's noteOff is the EXACT observed retrigger cut (inter-hit delta)");
    const secondDelta = transferred[3].timestampNs - transferred[2].timestampNs;
    assertEqual(secondDelta, t2 - t1, "hit B's duration is its REAL finish delta (80 ms), never a fabricated 1 s");
    assertEqual(c.snapshot().unsynced.uncapturedHits, 0, "nothing lost");
    assertEqual(transport.countRequestsBy((r) => r.path.endsWith("/take/commit")), 1, "no second commit from the boundary");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
