// probe_p1.ts — P1 regressions: generation-safe note-off lifecycle.
// The runtime setOnFinish is STRUCTURALLY removed as a note-off source (its
// contract fires on manual stop with no generation identity and no timing
// guarantee); durations come from the explicitly-labelled SAMPLE-DURATION
// POLICY (the pad's declared asset duration), observed retrigger cuts, or a
// trusted generation-exact explicit finish — otherwise held/UNKNOWN, never
// saved. Every probe here fails against a pre-fix implementation.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  commitReply,
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
  sourcePath } from "./harness";

const fs = require("fs");
const TRACK = 7;
const CONTROLLER_PATH =
  sourcePath("SoundcraftCaptureController.ts");

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

function hit(client: SoundcraftCompanionClient, clock: FakeClock, nanos: number, key: number, channel: number): number {
  clock.nanos = nanos;
  client.noteOn("beat", 0, key, 100, channel);
  clock.nanos = nanos + 40_000_000;
  client.noteFinished(key, channel);
  return nanos + 40_000_000;
}

export const tests: Array<ReturnType<typeof test>> = [
  // T18 — the untrusted vector is STRUCTURALLY gone: the controller never
  // forwards the runtime stop-callback, and registers the pad's DECLARED
  // asset duration as the labelled SAMPLE-DURATION POLICY instead.
  test("T18 controller: no setOnFinish wiring; declared asset duration registered as the labelled policy", async () => {
    const src = fs.readFileSync(CONTROLLER_PATH, "utf-8");
    assert(src.indexOf(".setOnFinish(") === -1, "no runtime stop-callback is forwarded anywhere (untrusted vector structurally removed)");
    assert(src.indexOf("setPadPolicyDurationNs") !== -1, "the declared duration is registered as the labelled policy");
    assert(src.indexOf("audio.duration") !== -1, "the policy value is the ACTUAL declared asset duration");
  }),

  // T19 — SAMPLE-DURATION POLICY: a one-shot note with NO trusted finish
  // closes at EXACTLY onset + declared duration (0.3 s here) — a labelled
  // policy, never a measured natural callback — and the phrase auto-saves.
  test("T19 policy duration closes a one-shot at exactly onset + declared duration; phrase auto-saves", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> }> = [];
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
    c.setPadPolicyDurationNs(33, 0, 300_000_000); // the declared asset duration: 0.3 s
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t19-v1.scraft", version: 1, bytes: 100 } }) });
    const onset = 1_000_000_000;
    clock.nanos = onset;
    c.noteOn("bass", 0, 33, 100, 0); // NO trusted finish call at all
    clock.nanos = onset + 100_000_000;
    await c.pump(); // policy NOT yet elapsed → the note stays OPEN (held)
    assertEqual(c.snapshot().heldNotes, 1, "still open before the policy elapses");
    clock.nanos = onset + 300_000_000; // exactly the declared duration
    clock.nowSecs = 100.9;
    await c.pump(); // policy closes the note at EXACTLY onset + 0.3 s
    await settle();
    await c.pump(); // flush the policy note-off
    await settle();
    assertEqual(c.snapshot().heldNotes, 0, "closed by the policy");
    assertEqual(c.snapshot().policyClosedNotes, 1, "counted as a policy closure (labelled, never a natural-callback claim)");
    clock.nowSecs = 101.6;
    await c.pump(); // idle boundary commits the phrase (the reply was queued up-front)
    await settle();
    await c.quiesce();
    await settle();
    assertEqual(c.snapshot().savedBadgeCount, 1, "the policy-closed phrase auto-saved");
    const allEv = ingests.map((b) => b.events).flat();
    assertEqual(allEv.length, 2, "on + policy off (the off may trail in its own batch — the sweep runs after the flush)");
    assertEqual(allEv[1].payload.type, "noteOff", "the policy note-off went out");
    assertEqual(allEv[1].timestampNs - allEv[0].timestampNs, 300_000_000, "the policy duration is EXACTLY onset + declared duration (0.3 s)");
  }),

  // T20 — SYNC retrigger case: two immediate hits on the same voice (no
  // trusted finishes): the first closes at the OBSERVED CUT, the second at
  // its policy — both durations exact, no ~0 fabrication.
  test("T20 sync retrigger + policy: first note = observed cut delta, second = its policy duration", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> }> = [];
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
    c.setPadPolicyDurationNs(33, 0, 300_000_000);
    const t0 = 1_000_000_000;
    clock.nanos = t0;
    c.noteOn("bass", 0, 33, 100, 0); // hit 1
    const t1 = t0 + 120_000_000;
    clock.nanos = t1;
    c.noteOn("bass", 0, 33, 100, 0); // SYNC retrigger: hit 1 closes AT the cut, hit 2 opens
    clock.nanos = t1 + 300_000_000; // hit 2's policy elapses
    clock.nowSecs = 100.9;
    await c.pump(); // the sweep closes hit 2 at exactly onset + policy
    await settle();
    await c.pump(); // the swept note-off flushes
    await settle();
    assertEqual(ingests[0].events.length, 3, "batch 1: on1, off1 (cut), on2");
    const ing = ingests[0].events;
    assertEqual(ing[1].timestampNs - ing[0].timestampNs, 120_000_000, "hit 1 = the observed CUT delta (120 ms), never ~0");
    assertEqual(ing[2].timestampNs, t1 - 1_000_000_000, "hit 2's onset is the cut moment (session-relative; sync retrigger)");
    assertEqual(ingests[1].events.length, 1, "batch 2: hit 2's policy note-off");
    assertEqual(ingests[1].events[0].timestampNs - ing[2].timestampNs, 300_000_000, "hit 2 = its full declared policy duration");
  }),

  // T21 — generation-exact finishNote across the boundary: a STALE handle
  // (delayed +1 ms AND +6 ms after a retrigger — beyond any threshold) is
  // provably identified and IGNORED; the fresh note keeps its real duration;
  // and after a rollover the old session's handles can never close the
  // transferred fresh notes.
  test("T21 stale finishes at +1 ms and +6 ms after retrigger are identified and ignored; fresh note unaffected; no cross-generation close", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    const ingests: Array<{ events: Array<{ eventId: number; timestampNs: number; payload: { type: string } }> }> = [];
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
    // Normal path: a trusted handle + a STALE handle arriving +1 ms after the retrigger.
    const t0 = 1_000_000_000;
    clock.nanos = t0;
    const staleHandle = c.noteOn("bass", 0, 33, 100, 0); // generation 1 (will be cut)
    const tCut = t0 + 120_000_000;
    clock.nanos = tCut;
    const freshHandle = c.noteOn("bass", 0, 33, 100, 0); // generation 2 (the retrigger cuts generation 1 at the cut)
    clock.nanos = tCut + 1_000_000;
    assert(!c.finishNote(staleHandle), "the stale handle is IDENTIFIED (already closed by the cut) and ignored");
    clock.nanos = tCut + 6_000_000;
    assert(!c.finishNote(staleHandle), "still ignored at +6 ms — no threshold is relied upon");
    assertEqual(c.snapshot().staleFinishesIgnored, 2, "both stale attempts counted");
    const tFinish = tCut + 80_000_000;
    clock.nanos = tFinish;
    assert(c.finishNote(freshHandle), "the fresh generation closes normally");
    clock.nowSecs = 100.6;
    await c.pump();
    await settle();
    const ing = ingests[0].events;
    assertEqual(ing.length, 4, "on, off, on, off — nothing lost");
    assertEqual(ing[1].timestampNs - ing[0].timestampNs, 120_000_000, "generation 1 keeps its exact CUT duration");
    assertEqual(ing[3].timestampNs - ing[2].timestampNs, 80_000_000, "generation 2 keeps its exact REAL duration (never the stale ~0/+1 ms)");
    // ROLLOVER: the phrase auto-commits (idle boundary) and rolls into session 2;
    // the OLD session's closed handles can never close the transferred fresh notes.
    clock.nanos = tFinish + 400_000_000; // idle boundary elapsed
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t21-v1.scraft", version: 1, bytes: 100 } }) });
    clock.nowSecs = 101;
    await settle();
    await c.pump(); // flush → idle → the commit fires → consumed the queued reply
    await settle();
    await c.quiesce(); // the rollover completes (close 1, open 2)
    await settle();
    assertEqual(c.snapshot().sessionId, 2, "rolled into session 2");
    assertEqual(c.snapshot().savedBadgeCount, 1, "saved");
    // A STALE finish naming the OLD closed generation, after the rollover:
    assert(!c.finishNote(staleHandle), "ignored — the old generation stays closed");
    assertEqual(c.snapshot().staleFinishesIgnored, 3, "counted");
    // And the transferred/none state: no cross-generation close ever happened
    // (the ingested durations above are the proof).
  }),

  test("T22 no policy + no trusted finish: note stays HELD, commit withheld, then resolves on the trusted finish", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0.2, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    let commits = 0;
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
        commits += 0; // ingest, not commit
        return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
      }
      if (/^\/v1\/live\/sessions\/\d+\/take\/commit$/.test(req.path)) {
        commits++;
        return { kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t22-v1.scraft", version: 1, bytes: 100 } }) };
      }
      return null;
    };
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    // NO setPadPolicyDurationNs for this voice; the hit is never finished:
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0);
    clock.nanos = 1_000_000_000 + 600_000_000; // far past any idle boundary
    clock.nowSecs = 101.6;
    await c.pump();
    await settle();
    assertEqual(c.snapshot().heldNotes, 1, "the note is honestly HELD (no policy, no trusted finish)");
    assertEqual(commits, 0, "NO commit while the take holds an open note — never a false-saved note");
    // The trusted pad-owner finish resolves it → the idle boundary commits:
    clock.nanos = 1_000_000_000 + 700_000_000;
    c.noteFinished(33, 0);
    transport.enqueue({ kind: "ok", status: 200, body: commitReply({ clip: 42, saved: { status: "saved", name: "t22-v1.scraft", version: 1, bytes: 100 } }) });
    clock.nowSecs = 102.4;
    await c.pump(); // drains the on/off
    await settle();
    clock.nanos = 1_000_000_000 + 700_000_000 + 400_000_000; // idle elapsed since the trusted finish
    clock.nowSecs = 103; // idle boundary → commit fires
    await c.pump();
    await settle();
    assertEqual(commits, 1, "the commit fires once the note is honestly closable");
    assert(c.snapshot().savedBadgeCount === 1, "and it saves");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
