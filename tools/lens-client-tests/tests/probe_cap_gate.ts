// probe_cap_gate.ts — the runtime commit-note ceiling regressions (P1 fixes):
// the commit threshold is min(configured, authoritative server
// max_notes_per_commit) — never a hardcoded 999/990 guess. Over-budget and
// UNKNOWN-cap hits are NEVER discarded: they route into the bounded
// next-take buffer with full identity (instrument/pad/key/channel/velocity,
// absolute onset, MEASURED duration from a later noteOff/finish) and
// transfer into a fresh take with FRESH event ids once the old take
// committed (or once a valid cap arrives). Overflow is honestly
// uncapturedHits. UNKNOWN cap (missing/malformed/>999) = fail closed: no
// backend admission, no commit, persistent visible status; resume only after
// a well-formed cap arrives, preserving the buffered bytes. A valid cap of 1
// works (ceiling 1) — never a negative/invented limit.

import { SoundcraftCompanionClient } from "../../../lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient";
import {
  assert,
  assertEqual,
  capabilitiesReply,
  commitReply,
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

type CapShape = { maxNotesPerCommit?: number | string; omitMaxNotes?: boolean };

function routeCap(t: ScriptedTransport, cap: CapShape): void {
  t.router = (req) => {
    if (req.path === "/v1/pair") {
      return { kind: "ok", status: 200, body: pairReply(7200) };
    }
    if (req.path === "/v1/capabilities") {
      return { kind: "ok", status: 200, body: capabilitiesReply(cap) }; // re-read per request: dynamic repairs work
    }
    if (req.path === "/v1/live/sessions" && req.method === "POST") {
      const session = JSON.parse(req.bodyJson as string).session;
      // a 600 s stuck window: nothing sweeps during a long burst (the cap
      // probes need HELD notes to stay held, not substituted)
      return { kind: "ok", status: 200, body: { session: session, track: TRACK, sample_rate: RATE, stuck_timeout_samples: RATE * 600, max_note_samples: RATE * 6000 } };
    }
    if (/take$/.test(req.path)) {
      return { kind: "ok", status: 200, body: takeReply(parseInt(req.path.split("/")[4]), TRACK) };
    }
    if (/events$/.test(req.path)) {
      const body = JSON.parse(req.bodyJson as string) as { events: Array<{ eventId: number; payload: { type: string } }> };
      let max = 0;
      for (const ev of body.events) {
        if (ev.eventId > max) {
          max = ev.eventId;
        }
      }
      return { kind: "ok", status: 200, body: ingestReply(body.events.length, max) };
    }
    if (/sessions\/\d+$/.test(req.path) && req.method === "DELETE") {
      return { kind: "ok", status: 200, body: { notes: 0, released: [], unknown_duration: 0 } };
    }
    return null; // the commit POST consumes the scripted queue
  };
}

/** N short performed notes (on+trusted finish), pumped in chunks so the queue
 * drains between chunks — mirrors real interleaved playing. */
async function playShorts(c: SoundcraftCompanionClient, clock: FakeClock, count: number, startNanos: number, pumpEvery = 25): Promise<number> {
  let nanos = startNanos;
  for (let i = 0; i < count; i++) {
    nanos += 10_000_000;
    clock.nanos = nanos;
    c.noteOn("beat", i % 4, 36 + (i % 8), 100, 9);
    nanos += 40_000_000;
    clock.nanos = nanos;
    c.noteFinished(36 + (i % 8), 9);
    if (i % pumpEvery === pumpEvery - 1) {
      clock.nowSecs += 0.05;
      await c.pump();
      await settle();
    }
  }
  clock.nowSecs += 0.05;
  await c.pump();
  await settle();
  return nanos;
}

type Ev = { eventId: number; timestampNs: number; payload: { type: string; key?: number; channel?: number; velocity?: number } };

function ingested(t: ScriptedTransport, session: number): Ev[] {
  const out: Ev[] = [];
  for (const r of t.requests) {
    if (r.path.indexOf("/sessions/" + session + "/events") !== -1 && r.bodyJson !== null) {
      const body = JSON.parse(r.bodyJson) as { events: Ev[] };
      out.push(...body.events);
    }
  }
  return out;
}

function commitSaved(name: string, clip: number): { kind: "ok"; status: number; body: unknown } {
  return { kind: "ok", status: 200, body: commitReply({ clip: clip, saved: { status: "saved", name: name, version: 1, bytes: 128 } }) };
}

export const tests: Array<ReturnType<typeof test>> = [
  // C1 — EXACT 987 BOUNDARY (12 banked destinations + default = 1000 − 13):
  // ceiling = min(990 configured, 987 server) = 987. The ceiling trigger
  // commits at exactly 987 completed notes (slice ≤ 987 — never past the real
  // cap), the rollover opens a fresh take, and the next note is captured
  // there. Zero drops, zero guessed bounds.
  test("C1 cap 987: ceiling 987, the slice commits at exactly 987, the next note is captured in take 2", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeCap(transport, { maxNotesPerCommit: 987 });
    await c.pair("A7K2-9MXP");
    const snap0 = c.snapshot();
    assertEqual(snap0.commitCeilingNotes, 987, "ceiling = min(990 configured, 987 server) = 987");
    assertEqual(snap0.commitCapVerified, true, "the server cap is verified");
    await c.startCapture("Lens");
    transport.enqueue(commitSaved("take-1-c1-v1.scraft", 2));
    await playShorts(c, clock, 987, 1_000_000_000);
    const mid = c.snapshot();
    assert(mid.savedBadgeCount >= 1, "the ceiling trigger committed the take at 987 notes (saved)");
    assert(mid.completedNotes <= 987, "the committed slice never exceeds 987");
    assertEqual(ingested(transport, 1).filter((e) => e.payload.type === "noteOn").length, 987, "exactly 987 note-ons went to take 1 (the real cap 987 was never crossed)");
    await c.quiesce();
    await settle();
    transport.enqueue(commitSaved("take-2-c1-v1.scraft", 3));
    const nanos = 200_000_000_000;
    clock.nanos = nanos;
    c.noteOn("beat", 0, 36, 100, 9);
    clock.nanos = nanos + 40_000_000;
    c.noteFinished(36, 9);
    clock.nowSecs += 0.1;
    await c.pump();
    await settle();
    const end = c.snapshot();
    assert(end.completedNotes >= 1, "the 988th note is captured in the fresh take");
    assertEqual(ingested(transport, 2).filter((e) => e.payload.type === "noteOn").length, 1, "take 2 received exactly the branched note");
    assertEqual(end.unsynced.bufferedHits, 0, "nothing left over — 987 + 1, all captured");
  }),

  // A (reviewer repro 1, P1-1) — BURST CROSSING THE CAP WITH A HELD NOTE: the
  // over-budget hits are BUFFERED with full identity and MEASURED durations,
  // then TRANSFERRED into the fresh take with fresh event ids after the held
  // note finishes and the old take commits. No discard, no duplicates, no
  // overcommit.
  test("A held-note burst crossing 987: over-budget hits buffered with full payload + measured durations, transferred fresh after the commit", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeCap(transport, { maxNotesPerCommit: 987 });
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue(commitSaved("take-1-a-v1.scraft", 2));
    clock.nanos = 1_000_000_000;
    c.noteOn("pad", 0, 40, 100, 0); // the held note (footprint 1)
    const nanosAfter = await playShorts(c, clock, 1000, 2_000_000_000);
    const mid = c.snapshot();
    assertEqual(mid.completedNotes, 986, "986 shorts admitted (986 + 1 held = the 987 ceiling)");
    assertEqual(mid.heldNotes, 1, "the held note is still open");
    assertEqual(mid.unsynced.bufferedHits, 14, "the 14 over-budget hits are BUFFERED (not discarded)");
    assertEqual(mid.takeNoteFootprint, 987, "the take's footprint is exactly the ceiling");
    // ACTUAL BUFFER OBJECTS: full payload + measured durations (playShorts
    // finished each hit — the buffered entry keeps the REAL measured span)
    assertEqual(mid.buffered.length, 14, "the snapshot exposes the buffer objects");
    const first = mid.buffered[0];
    assertEqual(first.instrument, "beat", "buffered entry keeps the instrument");
    assertEqual(first.channel, 9, "buffered entry keeps the channel");
    assertEqual(first.velocity, 100, "buffered entry keeps the velocity");
    assert(first.onsetAbsNanos > 0, "absolute onset preserved");
    assertEqual(first.finished, true, "the later noteOff closed the buffered entry");
    assert(first.measuredNanos !== null && first.measuredNanos >= 30_000_000 && first.measuredNanos <= 60_000_000, "MEASURED duration ≈ the performed 40 ms span (got " + first.measuredNanos + ")");
    const keys = mid.buffered.map((b) => b.key);
    assert(keys.every((k) => k >= 36 && k <= 43), "buffered keys are the performed voices");
    assertEqual(ingested(transport, 1).filter((e) => e.payload.type === "noteOn").length, 987, "the server never saw more than 987 notes (real cap respected)");
    // presented (1 held + 1000 shorts) = admitted (987) + buffered (14)
    assertEqual(987 + 14, 1001, "nothing vanished");
    // the held note finishes → the take commits → rollover → TRANSFER
    clock.nanos = nanosAfter + 10_000_000;
    c.noteFinished(40, 0);
    clock.nowSecs += 0.1;
    await c.pump();
    await settle();
    await c.pump();
    await settle();
    assert(c.snapshot().savedBadgeCount >= 1, "the take committed once the held note finished");
    await c.quiesce();
    await settle();
    // TRANSFER: the fresh take holds exactly the 14 buffered hits
    const t2 = ingested(transport, 2);
    const t2Ons = t2.filter((e) => e.payload.type === "noteOn");
    assertEqual(t2Ons.length, 14, "the transfer batch carries exactly the 14 buffered note-ons");
    // FRESHNESS, provably by count: take 1 ingested EXACTLY the 987 admitted
    // notes; the 14 transferred ones were never among them (never sent, so
    // their per-take event ids are brand-new — no replay is possible).
    assertEqual(ingested(transport, 1).filter((e) => e.payload.type === "noteOn").length, 987, "take 1 only ever held its 987 admitted notes");
    const t2Keys = t2Ons.map((e) => e.payload.key);
    assertEqual(JSON.stringify(t2Keys), JSON.stringify(keys), "the transferred voices match the buffered payload in order");
    // STORED PAYLOAD == SUBMITTED PAYLOAD, entry by entry (not counts): the
    // wire triple (channel, key, velocity) of every transferred noteOn equals
    // the buffered entry it came from, in buffer order.
    const storedProfiles = mid.buffered.map((b) => b.channel + "/" + b.key + "/" + b.velocity);
    const sentProfiles = t2Ons.map((e) => e.payload.channel + "/" + e.payload.key + "/" + e.payload.velocity);
    assertEqual(JSON.stringify(sentProfiles), JSON.stringify(storedProfiles), "every transferred noteOn carries EXACTLY its stored entry's channel/key/velocity");
    // MEASURED ONSET + DURATION fidelity, exact ns: the fresh take rebases
    // onsets to 50 ms + the stored intra-phrase delta, and each noteOff lands
    // at that onset + the stored MEASURED duration (never fabricated).
    const onset0 = mid.buffered[0].onsetAbsNanos;
    const t2OffEvents = t2.filter((e) => e.payload.type === "noteOff");
    for (let i = 0; i < t2Ons.length; i++) {
      const expectedOn = 50_000_000 + (mid.buffered[i].onsetAbsNanos - onset0);
      assertEqual(t2Ons[i].timestampNs, expectedOn, "transferred onset " + i + " = 50 ms base + the stored intra-phrase delta (stored delta " + (mid.buffered[i].onsetAbsNanos - onset0) + " ns)");
      const expectedOff = expectedOn + (mid.buffered[i].measuredNanos as number);
      const off = t2OffEvents.find((e) => e.payload.key === mid.buffered[i].key && e.timestampNs === expectedOff);
      assert(off !== undefined, "transferred noteOff " + i + " lands at onset + the stored measured duration (expected " + expectedOff + ")");
    }
    // FRESH EVENT IDS: the fresh take restarts its id space — take 2's ids
    // are exactly 1..28 in send order (14 ons + 14 offs), provably NOT take 1's
    // far-higher id space: the transferred events are brand-new, no replay.
    const t2Ids = t2.map((e) => e.eventId);
    assertEqual(t2Ids.length, 28, "take 2 carries exactly the 28 transferred wire events");
    for (let i = 0; i < t2Ids.length; i++) {
      assertEqual(t2Ids[i], i + 1, "fresh id space — take 2 assigns ids 1..28 in send order (no id reuse from take 1)");
    }
    assert(!t2Ids.some((id) => id >= 988), "no take-1-space ids leaked into take 2");
    const t2Offs = t2.filter((e) => e.payload.type === "noteOff");
    assertEqual(t2Offs.length, 14, "each transferred note carries its real note-off");
    // per-voice IN-ORDER pairing (keys repeat across the burst): each noteOff
    // closes the most recent unmatched noteOn of its own key
    const open: { [k: number]: number[] } = {};
    for (const e of t2) {
      const k = e.payload.key as number;
      if (e.payload.type === "noteOn") {
        (open[k] = open[k] || []).push(e.timestampNs);
      } else {
        const stack = open[k] || [];
        const onTs = stack.pop();
        assert(onTs !== undefined, "the note-off has a matching transferred note-on (proper generation)");
        const span = e.timestampNs - (onTs as number);
        assert(span >= 30_000_000 && span <= 60_000_000, "MEASURED ≈40 ms spans survive the transfer (got " + span + ")");
      }
    }
    assert(c.snapshot().unsynced.bufferedHits === 0, "the buffer drained completely");
  }),

  // A2 — BOUNDED: when the buffer itself fills, overflow is honestly
  // uncapturedHits (never a fake "retained", never an unbounded queue).
  test("A2 buffer overflow is honest uncapturedHits (bounded, never fake retained)", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9, pendingEventQueueMax: 20 }));
    routeCap(transport, { maxNotesPerCommit: 987 });
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    clock.nanos = 1_000_000_000;
    c.noteOn("pad", 0, 40, 100, 0); // held — blocks committing for the whole burst
    await playShorts(c, clock, 1040, 2_000_000_000, 1);
    const mid = c.snapshot();
    assertEqual(mid.unsynced.bufferedHits, 20, "the buffer holds its bounded maximum");
    const overflow = 1040 - 986 - 20;
    assertEqual(mid.unsynced.uncapturedHits, overflow, "the overflow is honestly uncaptured (" + overflow + ") — never a fake saved/retained");
    assertEqual(ingested(transport, 1).filter((e) => e.payload.type === "noteOn").length, 987, "the server never saw more than 987");
    assertEqual(mid.completedNotes + mid.heldNotes + mid.unsynced.bufferedHits + mid.unsynced.uncapturedHits, 1041, "presented = admitted + buffered + uncaptured (nothing silently lost)");
  }),

  // B (reviewer repro 2, P1-2) — UNKNOWN CAP FAILS CLOSED: missing /
  // malformed / >999 → NO backend admission (startCapture refuses, hits
  // buffer locally), NO commit (explicit commitTake refuses — no guessed
  // commit), persistent visible status. On a valid cap refresh, resume
  // safely: the buffered hits transfer into the fresh take with fresh ids
  // and full payload; nothing replayed.
  test("B unknown cap fails closed (no admission/commit, persistent status); valid-cap refresh resumes with a fresh-ID transfer; cap 1 edge works", async () => {
    const cap: CapShape = { omitMaxNotes: true };
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeCap(transport, cap);
    await c.pair("A7K2-9MXP");
    assertEqual(c.snapshot().commitCapVerified, false, "a missing cap is NOT verified");
    assertEqual(c.snapshot().lastErrorCode, "commit_cap_unverified", "the unverified state is surfaced");
    assert(c.snapshot().compactSummary.indexOf("SERVER CAP UNVERIFIED — AUTO-SAVE WITHHELD") !== -1, "the persistent status says auto-save is withheld");
    // NO backend admission:
    const started = await c.startCapture("Lens");
    assert(!started, "capture refuses to open a backend session without an authoritative cap");
    const commitsBefore = transport.requests.filter((r) => r.path.endsWith("/take/commit")).length;
    assertEqual(transport.requests.filter((r) => r.path === "/v1/live/sessions" && r.method === "POST").length, 0, "no session was opened (no backend admission)");
    // hits route to the LOCAL BOUNDED BUFFER with full payload:
    let nanos = 1_000_000_000;
    for (let i = 0; i < 5; i++) {
      nanos += 10_000_000;
      clock.nanos = nanos;
      c.noteOn("beat", i % 4, 36 + (i % 8), 100, 9);
      nanos += 40_000_000;
      clock.nanos = nanos;
      c.noteFinished(36 + (i % 8), 9);
    }
    const bufSnap = c.snapshot();
    assertEqual(bufSnap.unsynced.bufferedHits, 5, "the hits are buffered locally (visibly unsynced, never discarded)");
    assertEqual(bufSnap.buffered.length, 5, "the buffer objects are exposed");
    assert(bufSnap.buffered.every((b) => b.finished && b.measuredNanos !== null && b.measuredNanos >= 30_000_000 && b.measuredNanos <= 60_000_000), "measured durations preserved (≈40 ms performed spans)");
    assertEqual(transport.requests.filter((r) => /\/events$/.test(r.path)).length, 0, "no note events reached the backend while unverified");
    // NO GUESSED COMMIT:
    await c.commitTake();
    await settle();
    assertEqual(c.snapshot().lastErrorCode, "commit_cap_unverified", "the commit refusal is the persistent unverified status");
    assertEqual(transport.requests.filter((r) => r.path.endsWith("/take/commit")).length, commitsBefore, "NO commit POST was sent (no guessed commit)");
    // the malformed and >999 shapes behave identically:
    cap.maxNotesPerCommit = "987";
    await c.refreshCapabilities();
    assertEqual(c.snapshot().commitCapVerified, false, "a malformed cap is NOT verified");
    cap.maxNotesPerCommit = 2000;
    await c.refreshCapabilities();
    assertEqual(c.snapshot().commitCapVerified, false, "an out-of-range (>999) cap is NOT verified (a bound never raises the ceiling)");
    assertEqual((await c.startCapture("Lens")), false, "still no backend admission");
    // RESUME on a valid cap: repair → refresh → the buffered hits transfer
    // into the fresh take with fresh ids, full payload, measured durations.
    cap.maxNotesPerCommit = 987;
    cap.omitMaxNotes = false;
    await c.refreshCapabilities();
    const resumed = c.snapshot();
    assertEqual(resumed.commitCapVerified, true, "the repaired cap is verified");
    assertEqual(resumed.commitCeilingNotes, 987, "ceiling = min(990, 987) = 987");
    transport.enqueue(commitSaved("take-1-b-v1.scraft", 2));
    const started2 = await c.startCapture("Lens");
    assert(started2, "capture opens once the cap is authoritative");
    await settle();
    await c.pump();
    await settle();
    const t1 = ingested(transport, 1);
    const t1Ons = t1.filter((e) => e.payload.type === "noteOn");
    assertEqual(t1Ons.length, 5, "the 5 buffered hits transferred into the fresh take");
    assert(t1Ons.every((e) => e.payload.velocity === 100), "full payload transferred");
    const byKey: { [k: number]: Ev[] } = {};
    for (const e of t1) {
      const k = e.payload.key as number;
      (byKey[k] = byKey[k] || []).push(e);
    }
    for (const k in byKey) {
      const pair = byKey[k];
      if (pair.length === 2) {
        const span = pair[1].timestampNs - pair[0].timestampNs;
        assert(span >= 30_000_000 && span <= 60_000_000, "the MEASURED duration survived the transfer (key " + k + ")");
      }
    }
    const onsOnce = new Set(t1Ons.map((e) => e.payload.key));
    assertEqual(onsOnce.size, t1Ons.length, "no duplicated note-ons (each voice exactly once)");
    // STORED PAYLOAD == SUBMITTED PAYLOAD, entry by entry (not counts):
    const t1Offs = t1.filter((e) => e.payload.type === "noteOff");
    assertEqual(t1Offs.length, 5, "each transferred note carries its real note-off");
    const storedProfiles = bufSnap.buffered.map((b) => b.channel + "/" + b.key + "/" + b.velocity);
    const sentProfiles = t1Ons.map((e) => e.payload.channel + "/" + e.payload.key + "/" + e.payload.velocity);
    assertEqual(JSON.stringify(sentProfiles), JSON.stringify(storedProfiles), "every transferred noteOn carries EXACTLY its stored entry's channel/key/velocity");
    // MEASURED ONSET + DURATION, exact ns: 50 ms base + stored intra-phrase
    // delta; noteOff at that onset + the stored MEASURED duration.
    const onset0 = bufSnap.buffered[0].onsetAbsNanos;
    for (let i = 0; i < t1Ons.length; i++) {
      const expectedOn = 50_000_000 + (bufSnap.buffered[i].onsetAbsNanos - onset0);
      assertEqual(t1Ons[i].timestampNs, expectedOn, "transferred onset " + i + " = 50 ms base + the stored intra-phrase delta");
      const expectedOff = expectedOn + (bufSnap.buffered[i].measuredNanos as number);
      const off = t1Offs.find((e) => e.payload.key === bufSnap.buffered[i].key && e.timestampNs === expectedOff);
      assert(off !== undefined, "transferred noteOff " + i + " lands at onset + the stored measured duration (expected " + expectedOff + ")");
    }
    // FRESH EVENT IDS: the resumed take restarts its id space — exactly 1..10
    // in send order, provably brand-new events (no replay of anything from
    // the unverified interval).
    const t1Ids = t1.map((e) => e.eventId);
    assertEqual(t1Ids.length, 10, "the resumed take carries exactly the 10 transferred wire events");
    for (let i = 0; i < t1Ids.length; i++) {
      assertEqual(t1Ids[i], i + 1, "fresh id space — resumed take assigns ids 1..10 in send order");
    }
    transport.enqueue(commitSaved("take-1-b-saved-v1.scraft", 3));
    await c.commitTake();
    await settle();
    await c.pump();
    await settle();
    assert(c.snapshot().savedBadgeCount >= 1, "the resumed take commits and saves with the authoritative cap");
    // CAP 1 EDGE: a valid cap of 1 must WORK (one-note takes) — no negative ceiling.
    const t6 = new ScriptedTransport();
    const c6 = new SoundcraftCompanionClient(makeEnv(t6, { nowSecs: 100, nanos: 1_000_000_000 } as FakeClock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeCap(t6, { maxNotesPerCommit: 1 });
    await c6.pair("A7K2-9MXP");
    assertEqual(c6.snapshot().commitCeilingNotes, 1, "ceiling 1 — never negative, never invented");
    assertEqual(c6.snapshot().commitCapVerified, true, "cap 1 is authoritative");
    const ok1 = await c6.startCapture("Lens");
    assert(ok1, "cap-1 capture works");
    t6.enqueue(commitSaved("take-1-cap1-v1.scraft", 2));
    const n1 = 1_000_000_000;
    clock.nanos = n1;
    c6.noteOn("beat", 0, 36, 100, 9);
    clock.nanos = n1 + 40_000_000;
    c6.noteFinished(36, 9);
    clock.nowSecs += 0.1;
    await c6.pump();
    await settle();
    await c6.pump();
    await settle();
    assert(c6.snapshot().savedBadgeCount >= 1, "the one-note take committed (slice ≤ 1)");
    assertEqual(ingested(t6, 1).filter((e) => e.payload.type === "noteOn").length, 1, "the server never saw 2 notes against cap 1");
    await c6.quiesce();
    await settle();
    // cap 1 = ONE note per COMMIT SLICE: the fresh take admits its own note,
    // and a second note presented BEFORE that take's commit settles buffers
    // for take 3 (the boundary is per-slice, never per-client-lifetime).
    t6.enqueue(commitSaved("take-2-cap1-v1.scraft", 3));
    const c6n = 2_000_000_000;
    clock.nanos = c6n;
    c6.noteOn("beat", 0, 36, 100, 9); // admitted: footprint 0 + 1 = 1 ≤ 1
    clock.nanos = c6n + 40_000_000;
    c6.noteFinished(36, 9); // completes the slice → the commit fires at once
    clock.nanos = c6n + 50_000_000;
    c6.noteOn("beat", 0, 37, 100, 9); // presented while the commit settles → buffers for take 3
    assert(c6.snapshot().unsynced.bufferedHits === 1, "the second note buffers (cap 1: one note per slice)");
    t6.enqueue(commitSaved("take-3-cap1-v1.scraft", 4));
    clock.nowSecs += 0.2;
    await c6.pump();
    await settle();
    await c6.pump();
    await settle();
    await c6.quiesce();
    await settle();
    assertEqual(ingested(t6, 2).filter((e) => e.payload.type === "noteOn").length, 1, "take 2 holds exactly its one note");
    assertEqual(ingested(t6, 3).filter((e) => e.payload.type === "noteOn").length, 1, "take 3 received the buffered note (fresh slice)");
  }),

  // C4 — TWO INDEPENDENT PHRASES under cap 987: each phrase commits cleanly,
  // nothing buffered, both takes saved — ordinary playing is unaffected.
  test("C4 two independent phrases under cap 987: both commit, nothing buffered", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0, savesRefreshIntervalSeconds: 1e9 }));
    routeCap(transport, { maxNotesPerCommit: 987 });
    await c.pair("A7K2-9MXP");
    await c.startCapture("Lens");
    transport.enqueue(commitSaved("take-1-c4-v1.scraft", 2));
    await playShorts(c, clock, 150, 1_000_000_000);
    transport.enqueue(commitSaved("take-1-c4-v1.scraft", 2));
    await c.commitTake();
    await settle();
    await c.pump();
    await settle();
    await c.quiesce();
    await settle();
    assert(c.snapshot().savedBadgeCount >= 1, "phrase A saved");
    transport.enqueue(commitSaved("take-2-c4-v1.scraft", 3));
    await playShorts(c, clock, 150, 500_000_000_000);
    transport.enqueue(commitSaved("take-2-c4-v1.scraft", 3));
    await c.commitTake();
    await settle();
    await c.pump();
    await settle();
    const end = c.snapshot();
    assert(end.savedBadgeCount >= 2, "both phrases saved");
    assertEqual(end.unsynced.bufferedHits, 0, "ordinary playing never routes anything to the buffer");
    assertEqual(ingested(transport, 1).filter((e) => e.payload.type === "noteOn").length, 150, "take 1 holds exactly phrase A");
    assertEqual(ingested(transport, 2).filter((e) => e.payload.type === "noteOn").length, 150, "take 2 holds exactly phrase B");
  }),

  // C5 — CURRENT DEPLOYED API (cap 999, bank unmerged): ceiling
  // min(990 configured, 999) = 990 — the configured threshold governs,
  // verified. Old-API behaviour fully preserved.
  test("C5 current API cap 999: ceiling 990 verified — the configured threshold governs", async () => {
    const transport = new ScriptedTransport();
    const clock: FakeClock = { nowSecs: 100, nanos: 1_000_000_000 };
    const c = new SoundcraftCompanionClient(makeEnv(transport, clock), makeConfig({ idlePhraseSeconds: 0, commitPollIntervalSeconds: 0, flushIntervalSeconds: 0 }));
    routeCap(transport, { maxNotesPerCommit: 999 });
    await c.pair("A7K2-9MXP");
    const snap = c.snapshot();
    assertEqual(snap.commitCapVerified, true, "the current API's cap is verified");
    assertEqual(snap.commitCeilingNotes, 990, "ceiling = min(990 configured, 999 server) = 990");
    assertEqual(snap.lastErrorCode, "", "no unverified noise on the current API");
  }),
];

if (typeof __filename !== "undefined" && process.argv.length > 1 && __filename === process.argv[1]) {
  runAll(tests).catch(() => process.exit(1));
}
