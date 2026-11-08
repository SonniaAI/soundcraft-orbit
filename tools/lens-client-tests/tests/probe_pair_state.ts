// probe_pair_state.ts — never-paired vs token-expired regressions (fail pre-fix,
// pass after): a client that NEVER paired must never (a) send a privileged
// (authenticated) request — saves/capabilities stay unsent while unpaired,
// (b) enter the `token_expired` phase (no token ever existed — the honest
// state is awaiting_pair/offline), or (c) surface terminal/CLI wording. A
// client whose REAL token reaches its bounded lifetime still gets
// `token_expired`, with the queued notes retained. Offline mode never fakes
// online. The pairing code appears ONLY in the /v1/pair body — never logged,
// never in any other request, and no token value ever appears in a request.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  FakeClock,
  ingestReply,
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

function routePaired(t: ScriptedTransport): void {
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok" as const, status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok" as const, status: 200, body: capabilitiesReply() };
    }
    if (req.path === "/v1/live/saves") {
      return { kind: "ok" as const, status: 200, body: { count: 0, saves: [], newest: null } };
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      const session = JSON.parse(req.bodyJson as string).session;
      return {
        kind: "ok" as const,
        status: 200,
        body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: RATE * 2, max_note_samples: RATE * 20 },
      };
    }
    if (/take$/.test(req.path)) {
      return { kind: "ok" as const, status: 200, body: takeReply(parseInt(req.path.split("/")[4]), TRACK) };
    }
    if (/events$/.test(req.path)) {
      const body = JSON.parse(req.bodyJson as string);
      let max = 0;
      for (const ev of body.events) {
        if (ev.eventId > max) {
          max = ev.eventId;
        }
      }
      return { kind: "ok" as const, status: 200, body: ingestReply(body.events.length, max) };
    }
    return null;
  };
}

export const tests: Array<ReturnType<typeof test>> = [
  // PS1 — NEVER PAIRED, pump past 30 s: NO privileged (or any) request is
  // sent, the phase honestly stays offline/awaiting-pair, and NO
  // token_expired ever appears. The user-facing text carries no terminal/CLI
  // wording.
  test("PS1 unpaired pump 35 s: zero requests, no token_expired, no CLI wording", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ savesRefreshIntervalSeconds: 1, idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0 }));
    for (let i = 0; i <= 35; i++) {
      clock.nowSecs = 100 + i;
      await c.pump();
      await settle();
      assert(c.snapshot().phase !== "token_expired", "never-paired pump must not set token_expired (iteration " + i + ")");
    }
    assertEqual(transport.requests.length, 0, "ZERO requests while unpaired (saves/caps privileged reads are never sent)");
    const snap = c.snapshot();
    assert(snap.phase === "offline" || snap.phase === "awaiting_pair", "the never-paired state stays offline/awaiting_pair (got " + snap.phase + ")");
    assert(snap.detail.indexOf("terminal") === -1, "no terminal/CLI wording in the user-facing detail");
    assert(snap.detail.indexOf("one-time code") !== -1, "the detail directs to the one-time code");
    assertEqual(snap.unsynced.unsentEvents, 0, "nothing fabricated into the queues while unpaired");
  }),

  // PS2 — startCapture while NEVER paired: refuses honestly as awaiting_pair
  // (the pre-fix bug put token_expired here), sends nothing.
  test("PS2 unpaired startCapture: awaiting_pair (never token_expired), nothing sent", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0 }));
    const started = await c.startCapture("Lens");
    assert(!started, "capture refuses while never paired");
    const snap = c.snapshot();
    assertEqual(snap.phase, "awaiting_pair", "the phase is awaiting_pair (NOT token_expired)");
    assert(snap.detail.indexOf("one-time code") !== -1, "the detail directs to the one-time code");
    assert(snap.detail.indexOf("terminal") === -1, "no terminal/CLI wording");
    assertEqual(transport.requests.length, 0, "no request left the client");
  }),

  // PS3 — pair → REAL token issued → runs → token reaches its bounded
  // lifetime → `token_expired` IS the honest phase, and the queued notes are
  // retained. The pairing code travels ONLY in the /v1/pair body; the token
  // value never appears in any request line.
  test("PS3 pair then real expiry: token_expired valid, queues retained, code only in /v1/pair", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const CODE = "PS3-ONE-TIME";
    const c = new SoundcraftCompanionClient(
      makeEnv(transport, clock),
      makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 1e9, savesRefreshIntervalSeconds: 1e9, tokenExpirySafetySeconds: 7000 })
    );
    routePaired(transport);
    const paired = await c.pair(CODE);
    assert(paired, "pairing succeeds");
    const started = await c.startCapture("Lens");
    assert(started, "capture starts on the paired session");
    clock.nanos = 1_000_000_000;
    c.noteOn("bass", 0, 33, 100, 0); // stays PENDING (flushInterval 1e9) — the retained queue
    const requestsBeforeExpiry = transport.requests.length;
    const unsentBefore = c.snapshot().unsynced.unsentEvents;
    assert(unsentBefore >= 1, "the note sits in the unsynced queue");
    // Advance past the REAL bounded lifetime (7200 s − 7000 s safety = 200 s).
    clock.nowSecs = 100 + 201;
    await c.pump();
    await settle();
    const snap = c.snapshot();
    assertEqual(snap.phase, "token_expired", "a REAL issued-token expiry is honestly token_expired");
    assertEqual(c.snapshot().unsynced.unsentEvents, unsentBefore, "the queued note is retained through the expiry");
    assertEqual(transport.requests.length, requestsBeforeExpiry, "the expiry pump sent nothing new");
    // Privacy invariants on the recorded wire traffic: the one-time code
    // travels ONLY in the /v1/pair body, and the bearer token value appears in
    // NO recorded request line (it lives only in the transport's auth header).
    const pairBodies = transport.requests.filter((r) => r.path === "/v1/pair");
    assertEqual(pairBodies.length, 1, "exactly one pair request");
    assert((pairBodies[0].bodyJson as string).indexOf(CODE) !== -1, "the one-time code appears in the pair request body");
    const tokenValue = (transport as unknown as { bearerToken?: string }).bearerToken ?? "";
    assert(tokenValue.length > 0, "the transport holds the bearer token (memory only)");
    for (const r of transport.requests.filter((x) => x.path !== "/v1/pair")) {
      assert((r.bodyJson === null ? "" : r.bodyJson).indexOf(CODE) === -1, "the one-time code NEVER appears outside /v1/pair (" + r.path + ")");
      assert(r.path.indexOf(CODE) === -1, "the code never leaks into a path");
      assert((r.bodyJson === null ? "" : r.bodyJson).indexOf(tokenValue) === -1, "no token value in any non-pair request (" + r.path + ")");
      assert(r.path.indexOf(tokenValue) === -1, "no token value in any path");
    }
  }),

  // PS4 — offline (judge mode): the pump never fakes online behaviour, sends
  // nothing, and stays local_only.
  test("PS4 offline pump: no requests, stays local_only, no token_expired", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ onlineMode: false, savesRefreshIntervalSeconds: 1, idlePhraseSeconds: 0 }));
    for (let i = 0; i < 10; i++) {
      clock.nowSecs = 100 + i;
      await c.pump();
      await settle();
    }
    assertEqual(transport.requests.length, 0, "offline mode contacts nothing");
    assertEqual(c.snapshot().phase, "local_only", "the phase stays local_only (no fake online)");
    assert(c.snapshot().phase !== "token_expired", "never token_expired offline");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
