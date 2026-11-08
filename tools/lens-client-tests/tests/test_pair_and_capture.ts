// test_pair_and_capture.ts — pairing, credentials hygiene, capture wiring,
// batching, event-shape strictness, and bounded queues. Offline unit tests of
// the exact production client logic (no network, no fake backend claims).

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import { CompanionPhase } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionTypes";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  errorBody,
  FakeClock,
  ingestReply,
  liveOpenReply,
  makeConfig,
  makeEnv,
  pairReply,
  runAll,
  ScriptedTransport,
  takeReply,
  test,
} from "./harness";

export function makeOnline(overrides?: { config?: Partial<Parameters<typeof makeConfig>[0]> }): {
  transport: ScriptedTransport;
  clock: FakeClock;
  client: SoundcraftCompanionClient;
} {
  const transport = new ScriptedTransport();
  const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
  const client = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig(overrides !== undefined ? overrides.config : undefined));
  return { transport: transport, clock: clock, client: client };
}

/** Route the standard happy-path replies (pair → capabilities → open → take → ingest). */
export function routeStandard(
  t: ScriptedTransport,
  session: number,
  trackId: number,
  ingestCursor: (events: Array<Record<string, unknown>>) => number
): void {
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      return { kind: "ok", status: 200, body: liveOpenReply(session) };
    }
    if (req.path === "/v1/live/sessions/" + session + "/take" && req.method === "GET") {
      return { kind: "ok", status: 200, body: takeReply(session, trackId) };
    }
    if (req.path === "/v1/live/sessions/" + session + "/events") {
      const body = JSON.parse(req.bodyJson as string) as { events: Array<Record<string, unknown>> };
      return { kind: "ok", status: 200, body: ingestReply(body.events.length, ingestCursor(body.events)) };
    }
    return null;
  };
}

export const tests: Array<ReturnType<typeof test>> = [
  test("pair: happy path sets an in-memory bearer token and reaches paired phase", async () => {
    const { transport, clock, client } = makeOnline();
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      return null;
    };
    const ok = await client.pair("A7K2-9MXP");
    assert(ok, "pair succeeded");
    assertEqual(client.snapshot().phase, "paired" as CompanionPhase, "phase is paired");
    assert(transport.bearerToken !== null && transport.bearerToken.length > 0, "token lives in the transport's memory field");
    const pairReq = transport.requests.find((r) => r.path === "/v1/pair");
    assert(pairReq !== undefined, "pair request recorded");
    assertEqual(JSON.parse(pairReq!.bodyJson as string), { code: "A7K2-9MXP" }, "pair body carries only the code");
    assert(pairReq!.withAuth === false, "pair is unauthenticated (the code is the credential)");
    assert(clock.nowSecs === 100, "clock untouched");
  }),

  test("pair: wrong code refused → awaiting_pair, token never set", async () => {
    const { transport, client } = makeOnline();
    transport.enqueue({ kind: "ok", status: 401, body: errorBody("unauthorized", "no such pairing code") });
    const ok = await client.pair("WRONG-0000");
    assert(!ok, "pair refused");
    assertEqual(client.snapshot().phase, "awaiting_pair" as CompanionPhase, "phase awaiting_pair");
    assert(transport.bearerToken === null, "no token in memory");
  }),

  test("pair: 429 honours Retry-After, no token set", async () => {
    const { transport, client, clock } = makeOnline();
    transport.enqueue({ kind: "ok", status: 429, body: errorBody("too_many_requests", "pairing rate limited"), retryAfterSeconds: 30 });
    const ok = await client.pair("A7K2-9MXP");
    assert(!ok, "pair refused");
    assert(client.snapshot().retryNotBeforeSecs >= clock.nowSecs + 30, "Retry-After honoured");
    assert(transport.bearerToken === null, "no token set");
  }),

  test("pair: deadline (lost reply) says the single-use code may be burned — never pretends success", async () => {
    const { transport, client } = makeOnline();
    transport.enqueue({ kind: "deadline" });
    const ok = await client.pair("A7K2-9MXP");
    assert(!ok, "pair not confirmed");
    assertEqual(client.snapshot().phase, "offline" as CompanionPhase, "phase offline");
    assert(client.snapshot().detail.indexOf("may be burned") !== -1, "honest single-use warning");
    assert(transport.bearerToken === null, "no token on an unobserved reply");
  }),

  test("capture: generation 1 = session id 1; open body is exactly {session, track}; requests authenticated", async () => {
    const { transport, client } = makeOnline();
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    const started = await client.startCapture("Lens");
    assert(started, "capture started");
    assertEqual(client.snapshot().sessionId, 1, "session id 1");
    const openReq = transport.requests.find((r) => r.path === "/v1/live/sessions" && r.method === "POST");
    assert(openReq !== undefined, "open request sent");
    // PR17 contract: each fresh open REQUESTS the stuck-note window.
    assertEqual(JSON.parse(openReq!.bodyJson as string), { session: 1, track: "Lens", stuck_timeout_seconds: 2.0 }, "exact open shape (session, track, requested stuck window)");
    assert(openReq!.withAuth === true, "capture requests carry the bearer");
  }),

  test("capture: never guesses a trackId the readback did not prove; capture blocked with explicit reason", async () => {
    const { transport, client } = makeOnline();
    transport.router = (req) => {
      if (req.path === "/v1/pair") {
        return { kind: "ok", status: 200, body: pairReply(7200) };
      }
      if (req.path === "/v1/capabilities") {
        return { kind: "ok", status: 200, body: capabilitiesReply() };
      }
      if (req.path === "/v1/live/sessions" && req.method === "POST") {
        return { kind: "ok", status: 200, body: liveOpenReply(1) };
      }
      if (req.path === "/v1/live/sessions/1/take") {
        return { kind: "ok", status: 200, body: { session: 1, track: "Lens", status: { state: "localOnly" }, synced: true, overflow: false, unknown_duration: 0, stale_document: false, committed: false, notes: [], held: [], last_event_id: 0 } };
      }
      return null;
    };
    await client.pair("A7K2-9MXP");
    const started = await client.startCapture("Lens");
    assert(!started, "capture blocked");
    assert(client.snapshot().detail.indexOf("track id") !== -1, "refusal names the track id");
    assertEqual(transport.countRequestsBy((r) => r.path.indexOf("/events") !== -1), 0, "no event sent without a proven trackId");
  }),

  test("events: exact six-field wire shape, ids strictly increase, real duration from the observed finish", async () => {
    const { transport, client, clock } = makeOnline();
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    clock.nanos = 1_200_000_000;
    client.noteOn("beat", 0, 36, 100, 9);
    clock.nanos = 1_550_000_000;
    client.noteFinished(36, 9);
    clock.nanos = 1_700_000_000;
    client.noteOn("bass", 1, 36, 100, 0);
    clock.nowSecs = 100.6;
    await client.pump();
    const ingests = transport.bodiesOf((r) => r.path === "/v1/live/sessions/1/events") as Array<{ events: Array<Record<string, unknown>> }>;
    assert(ingests.length === 1, "exactly one batch");
    const events = ingests[0].events;
    assertEqual(events.length, 3, "noteOn, noteOff, noteOn");
    for (const ev of events) {
      assertEqual(Object.keys(ev).sort(), ["eventId", "payload", "sessionId", "surfaceId", "timestampNs", "trackId"], "exact wire fields");
    }
    assertEqual(events[0].payload, { type: "noteOn", channel: 9, key: 36, velocity: 100 }, "beat note-on: GM channel 9, real velocity");
    assertEqual(events[1].payload, { type: "noteOff", channel: 9, key: 36 }, "note-off matches the voice");
    assertEqual((events[1].timestampNs as number) - (events[0].timestampNs as number), 350_000_000, "duration = the REAL observed finish delta (350 ms)");
    assert((events[2].eventId as number) > (events[1].eventId as number), "ids strictly increase");
    assertEqual(events[0].surfaceId, 1, "beat → surfaceId 1");
    assertEqual(events[2].surfaceId, 2, "bass → surfaceId 2");
    assertEqual(events[0].trackId, 7, "trackId is the proven numeric id");
  }),

  test("retrigger closes the previous voice at the observed cut time (no fabricated tail)", async () => {
    const { transport, client, clock } = makeOnline();
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    clock.nanos = 1_000_000_000;
    client.noteOn("beat", 0, 36, 100, 9);
    clock.nanos = 1_100_000_000;
    client.noteOn("beat", 0, 36, 100, 9); // retriggers: the first sound is cut NOW
    clock.nowSecs = 100.6;
    await client.pump();
    const events = (transport.bodiesOf((r) => r.path === "/v1/live/sessions/1/events")[0] as any).events;
    assertEqual(events.length, 3, "noteOn + cut-closing noteOff + the retriggering noteOn");
    assertEqual(events[1].payload.type, "noteOff", "the cut voice closed");
    assertEqual(events[1].timestampNs - events[0].timestampNs, 100_000_000, "duration = the real audible cut (100 ms)");
  }),

  test("batching: 20 notes travel in bounded batches, never per-note", async () => {
    const { transport, client, clock } = makeOnline({ config: { captureBatchMaxEvents: 8 } });
    routeStandard(transport, 1, 7, (events) => events.length);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    for (let i = 0; i < 20; i++) {
      clock.nanos += 10_000_000;
      client.noteOn("chord", i % 4, 48 + i, 100, 0);
      clock.nanos += 30_000_000;
      client.noteFinished(48 + i, 0);
    }
    clock.nowSecs = 100.6;
    await client.pump();
    assertEqual(transport.countRequestsBy((r) => r.path === "/v1/live/sessions/1/events"), 1, "one flush, not 40 requests");
    const body = transport.bodiesOf((r) => r.path === "/v1/live/sessions/1/events")[0] as any;
    assertEqual(body.events.length, 8, "batch bound respected (8 of 40 queued)");
    assertEqual(client.snapshot().unsynced.unsentEvents, 32, "the rest stays queued, dropped by nobody");
  }),

  test("bounded queue: overflow counted + surfaced, nothing vanishes silently", async () => {
    const { transport, client, clock } = makeOnline({ config: { pendingEventQueueMax: 4 } });
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    for (let i = 0; i < 6; i++) {
      clock.nanos += 10_000_000;
      client.noteOn("beat", i % 4, 40 + i, 100, 9);
    }
    const s = client.snapshot();
    assertEqual(s.unsynced.overflowDroppedNotes, 2, "overflow counted");
    assertEqual(s.unsynced.unsentEvents, 4, "bounded window holds 4");
  }),

  test("velocity 0 refused locally — never clamped, never sent", async () => {
    const { transport, client } = makeOnline();
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    const before = client.snapshot().unsynced.unsentEvents;
    client.noteOn("beat", 0, 36, 0, 9);
    assertEqual(client.snapshot().unsynced.unsentEvents, before, "velocity-0 note-on refused");
  }),

  test("unknown-duration notes: a pad without audio finish stays held; unknown count surfaces honestly", async () => {
    const { transport, client, clock } = makeOnline();
    routeStandard(transport, 1, 7, () => 0);
    await client.pair("A7K2-9MXP");
    await client.startCapture("Lens");
    clock.nanos += 10_000_000;
    client.noteOn("beat", 3, 39, 100, 9); // no noteFinished call: no duration is invented
    const s = client.snapshot();
    assertEqual(s.heldNotes, 1, "held voice counted");
    assertEqual(s.unsynced.notesUnknownDuration, 0, "not yet unknown — it is still OPEN (commit will refuse open notes; nothing is fabricated)");
    client.noteFinished(39, 9); // the real finish arrives late
    assertEqual(client.snapshot().heldNotes, 0, "voice closed by the real finish");
    assertEqual(client.snapshot().completedNotes, 1, "one completable note with a real duration");
  }),
];

declare var __filename: string;
if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
