// soundcraft-connection-status.test.mjs — unit checks for the PURE phase→UI
// mapping (SoundcraftConnectionStatus.ts). Run with the repo's Node (≥22.18):
//
//   node Assets/Scripts/tests/soundcraft-connection-status.test.mjs
//
// Node's native type stripping executes the .ts module directly — no build
// chain, no project compilation, and the Lens project is not touched. The
// checks enforce the honesty contract: every phase has exactly one label,
// SAVED is claimed only with receipt wording, unsynced drops are never
// silenced, and no output ever echoes credential-ish strings.

import assert from "node:assert/strict"
import {
  ALL_PHASES,
  compactSummary,
  faithfulnessSegments,
  hasLoss,
  isPairInputNeeded,
  isPairedLike,
  labelForPhase,
  saveAckSnippet,
  severityForPhase,
  severityForSummary,
  unsyncedSummary,
} from "../SoundcraftConnectionStatus.ts"

const PASS = []

function check(name, fn) {
  fn()
  PASS.push(name)
}

const baseUnsynced = {
  unsentEvents: 0,
  ackedEvents: 0,
  uncertainInFlight: false,
  notesUnknownDuration: 0,
  heldNotes: 0,
  overflowDroppedNotes: 0,
  retiredUnsentEvents: 0,
  uncapturedHits: 0,
  lastAckedEventId: 0,
}

const baseSummary = {
  phase: "awaiting_pair",
  unsynced: baseUnsynced,
  savedBadgeCount: 0,
  lastSavedReceipt: null,
  stuckKnown: true,
  notCapturableNotes: 0,
  nonFaithfulNotes: 0,
}

// ── 1 · every phase maps to a unique, non-empty, uppercase label ────────────
check("every phase has a label", () => {
  for (const phase of ALL_PHASES) {
    const label = labelForPhase(phase)
    assert.ok(typeof label === "string" && label.length > 0, `label missing for ${phase}`)
    assert.equal(label, label.toUpperCase(), `label for ${phase} should be uppercase: ${label}`)
  }
})

check("labels are unique per phase", () => {
  const seen = new Set()
  for (const phase of ALL_PHASES) {
    const label = labelForPhase(phase)
    assert.ok(!seen.has(label), `duplicate label "${label}"`)
    seen.add(label)
  }
})

check("unknown phase passes through verbatim (honest fallback)", () => {
  assert.equal(labelForPhase("some_future_phase"), "SOME_FUTURE_PHASE")
})

// ── 1b · REGRESSION (P2): local_only is generic — placeholder ≠ judge ───────
check("REGRESSION P2: local_only label is generic LOCAL ONLY (the phase cannot prove judge mode)", () => {
  const label = labelForPhase("local_only")
  assert.equal(label, "LOCAL ONLY")
  assert.ok(!label.includes("JUDGE"), `local_only label must not claim judge mode: ${label}`)
})

check("REGRESSION P2: NO phase label claims JUDGE (placeholder shares local_only with real judge)", () => {
  for (const phase of ALL_PHASES) {
    assert.ok(!labelForPhase(phase).includes("JUDGE"), `label for ${phase} must not claim a mode the phase cannot prove`)
  }
})

check("REGRESSION P2: compactSummary for a local_only snapshot renders LOCAL ONLY without judge wording", () => {
  const line = compactSummary({ ...baseSummary, phase: "local_only" })
  assert.ok(line.startsWith("LOCAL ONLY"), line)
  assert.ok(!line.includes("JUDGE"), line)
})

// ── 2 · SAVED is claimed ONLY with receipt wording ──────────────────────────
check("saved_confirmed label says RECEIPT, never a bare SAVED", () => {
  const label = labelForPhase("saved_confirmed")
  assert.ok(label.includes("RECEIPT"), `saved label must carry receipt wording: ${label}`)
  assert.notEqual(label, "SAVED")
})

check("no other phase label claims SAVED", () => {
  for (const phase of ALL_PHASES) {
    if (phase === "saved_confirmed") continue
    assert.ok(!labelForPhase(phase).includes("SAVED"), `phase ${phase} must not claim SAVED`)
  }
})

// ── 3 · severity table is exhaustive and sane ───────────────────────────────
check("every phase has a known severity (no undefined leaks)", () => {
  const known = ["neutral", "info", "ok", "warn", "error"]
  for (const phase of ALL_PHASES) {
    assert.ok(known.includes(severityForPhase(phase)), `severity missing for ${phase}`)
  }
})

check("failure phases are error/warn, not ok", () => {
  for (const phase of ["config_error", "offline", "commit_failed", "backend_down"]) {
    assert.equal(severityForPhase(phase), "error", `${phase} should be error`)
  }
  for (const phase of ["awaiting_pair", "commit_unknown", "token_expired"]) {
    assert.equal(severityForPhase(phase), "warn", `${phase} should be warn`)
  }
})

// ── 4 · collapse / input-needed sets are exactly right ──────────────────────
check("paired-like set (collapse allowed) is exact", () => {
  const expectPairedLike = ["local_only", "paired", "capturing", "commit_pending", "saved_confirmed", "commit_failed", "commit_unknown"]
  for (const phase of ALL_PHASES) {
    assert.equal(isPairedLike(phase), expectPairedLike.includes(phase), `isPairedLike wrong for ${phase}`)
  }
})

check("token_expired and awaiting_pair are NEVER paired-like", () => {
  assert.equal(isPairedLike("token_expired"), false)
  assert.equal(isPairedLike("awaiting_pair"), false)
})

check("code input needed exactly for awaiting_pair / offline / token_expired", () => {
  const expectCode = ["awaiting_pair", "offline", "token_expired"]
  for (const phase of ALL_PHASES) {
    assert.equal(isPairInputNeeded(phase), expectCode.includes(phase), `isPairInputNeeded wrong for ${phase}`)
  }
})

// ── 5 · compact summary relays counts verbatim, claims nothing extra ────────
check("compact summary includes phase label and unsent count", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, unsentEvents: 3}}
  const line = compactSummary(s)
  assert.ok(line.includes("CAPTURING"), line)
  assert.ok(line.includes("unsent 3"), line)
})

check("compact summary shows SAVED n only when the receipt-backed count > 0", () => {
  const zero = compactSummary({...baseSummary, phase: "capturing", savedBadgeCount: 0})
  assert.ok(!zero.includes("SAVED"), zero)
  const two = compactSummary({...baseSummary, phase: "capturing", savedBadgeCount: 2})
  assert.ok(two.includes("SAVED 2"), two)
})

check("compact summary flags a lost reply only when uncertainInFlight", () => {
  const calm = compactSummary({...baseSummary, phase: "capturing"})
  assert.ok(!calm.includes("reply lost"), calm)
  const lost = compactSummary({...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncertainInFlight: true}})
  assert.ok(lost.includes("reply lost"), lost)
})

check("compact summary never echoes free-text detail (structured only)", () => {
  const s = {...baseSummary, detail: "SECRET-OPERATOR-DETAIL", phase: "offline"}
  assert.ok(!compactSummary(s).includes("SECRET-OPERATOR-DETAIL"))
})

// ── 6 · unsynced ledger surfaces every drop, never silently ─────────────────
check("overflow drops and retired events are surfaced loudly", () => {
  const line = unsyncedSummary({
    ...baseUnsynced,
    unsentEvents: 7,
    overflowDroppedNotes: 4,
    retiredUnsentEvents: 2,
    heldNotes: 1,
    notesUnknownDuration: 3,
  })
  assert.ok(line.includes("unsent 7"), line)
  assert.ok(line.includes("DROPPED NOTES 4"), line)
  assert.ok(line.includes("RETIRED EVENTS 2"), line)
  assert.ok(line.includes("held 1"), line)
  assert.ok(line.includes("unknown-duration 3"), line)
})

check("clean unsynced state renders a plain line without alarms", () => {
  const line = unsyncedSummary(baseUnsynced)
  for (const banned of ["NOT CAPTURED", "MISSED HITS", "DROPPED NOTES", "RETIRED EVENTS", "retired", "reply lost"]) {
    assert.ok(!line.includes(banned), `${banned} leaked into clean line: ${line}`)
  }
})

// ── 7 · save-ack snippet: only the exact saved receipt may say SAVED ────────
check("saved receipt → SAVED ✓ name (exact receipt)", () => {
  const out = saveAckSnippet({status: "saved", name: "take_04.mid", version: 1, bytes: 10})
  assert.ok(out.startsWith("SAVED ✓ take_04.mid"), out)
  assert.ok(out.includes("exact receipt"), out)
})

check("pending receipt never claims SAVED", () => {
  const out = saveAckSnippet({status: "pending", reason: "channel busy"})
  assert.ok(!out.includes("SAVED"), out)
  assert.ok(out.includes("PENDING"), out)
})

check("failed receipt states the commit landed but the save failed", () => {
  const out = saveAckSnippet({status: "failed", reason: "disk full"})
  assert.ok(out.includes("SAVE FAILED"), out)
  assert.ok(out.includes("commit landed"), out)
  assert.ok(!out.startsWith("SAVED"), out)
})

check("unknown receipt demands readback settlement, no badge", () => {
  const out = saveAckSnippet({status: "unknown", reason: "timeout"})
  assert.ok(out.includes("UNKNOWN"), out)
  assert.ok(out.includes("readback"), out)
  assert.ok(!out.includes("SAVED ✓"), out)
})

check("disabled receipt states backend-memory-only honestly", () => {
  const out = saveAckSnippet({status: "disabled", reason: "no project root"})
  assert.ok(out.includes("DISABLED"), out)
  assert.ok(!out.includes("SAVED ✓"), out)
})

check("null receipt yields empty string (silence is honest)", () => {
  assert.equal(saveAckSnippet(null), "")
})

// ── 8 · credential hygiene: no output ever carries token-ish strings ────────
check("no summary or snippet output echoes token/bearer/code material", () => {
  const s = {
    ...baseSummary,
    phase: "connecting",
    unsynced: {...baseUnsynced, unsentEvents: 1},
    lastSavedReceipt: {status: "saved", name: "take.mid", version: 1, bytes: 1},
  }
  const outputs = [compactSummary(s), unsyncedSummary(s.unsynced), saveAckSnippet(s.lastSavedReceipt)]
  for (const out of outputs) {
    for (const banned of ["bearer", "Bearer", "BEARER", "access_token", "token_type", "ey", "PAIR-CODE-XYZ"]) {
      assert.ok(!out.includes(banned), `output leaked "${banned}": ${out}`)
    }
  }
})

// ── 9 · REGRESSION: losses are loud, per-unit, even while "capturing" ───────
check("REGRESSION: capturing + uncapturedHits > 0 shows per-unit MISSED HITS in compact", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncapturedHits: 4}}
  const line = compactSummary(s)
  assert.ok(line.includes("MISSED HITS 4"), line)
  assert.ok(line.includes("CAPTURING"), line)
})

check("hits/notes/events are NEVER summed into a rendered total", () => {
  const s = {
    ...baseSummary,
    phase: "capturing",
    unsynced: {...baseUnsynced, uncapturedHits: 4, overflowDroppedNotes: 3, retiredUnsentEvents: 2},
  }
  for (const out of [compactSummary(s), unsyncedSummary(s.unsynced)]) {
    assert.ok(!out.includes("NOT CAPTURED"), `aggregate label leaked: ${out}`)
    assert.ok(!out.includes("9"), `cross-unit sum 4+3+2 must not render: ${out}`)
  }
})

check("REGRESSION: capturing + uncapturedHits > 0 escalates severity to warn (never green)", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncapturedHits: 4}}
  assert.equal(severityForSummary(s), "warn")
})

check("clean capturing stays ok/green", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: baseUnsynced}
  assert.equal(severityForSummary(s), "ok")
  assert.equal(hasLoss(baseUnsynced), false)
})

check("each loss counter escalates severity on its own (warn, never green)", () => {
  const missed = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncapturedHits: 1}}
  const dropped = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, overflowDroppedNotes: 2}}
  const retired = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, retiredUnsentEvents: 1}}
  for (const s of [missed, dropped, retired]) {
    assert.equal(severityForSummary(s), "warn")
    assert.equal(hasLoss(s.unsynced), true)
  }
})

check("escalation never downgrades an error phase", () => {
  const offlineClean = {...baseSummary, phase: "offline", unsynced: baseUnsynced}
  const offlineMissed = {...baseSummary, phase: "offline", unsynced: {...baseUnsynced, uncapturedHits: 6}}
  assert.equal(severityForSummary(offlineClean), "error")
  assert.equal(severityForSummary(offlineMissed), "error")
})

// ── 10 · REGRESSION: collapsed panel shows retired + unknown, per unit ──────
check("REGRESSION: retired events are visible in the compact line as RETIRED EVENTS", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, retiredUnsentEvents: 3}}
  const line = compactSummary(s)
  assert.ok(line.includes("RETIRED EVENTS 3"), line)
})

check("REGRESSION: dropped notes are visible in the compact line as DROPPED NOTES", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, overflowDroppedNotes: 5}}
  const line = compactSummary(s)
  assert.ok(line.includes("DROPPED NOTES 5"), line)
})

check("REGRESSION: unknown-duration notes are visible in the compact line and escalate to warn", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, notesUnknownDuration: 5}}
  const line = compactSummary(s)
  assert.ok(line.includes("unknown-duration 5"), line)
  assert.equal(severityForSummary(s), "warn")
})

check("expanded ledger renders every loss field with explicit units (no field hiding)", () => {
  const line = unsyncedSummary({...baseUnsynced, uncapturedHits: 4, overflowDroppedNotes: 3, retiredUnsentEvents: 2})
  assert.ok(line.includes("MISSED HITS 4"), line)
  assert.ok(line.includes("DROPPED NOTES 3"), line)
  assert.ok(line.includes("RETIRED EVENTS 2"), line)
})

check("only non-zero counters render (zero fields are omitted, not shown as 0)", () => {
  const line = compactSummary({...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncapturedHits: 4}})
  assert.ok(line.includes("MISSED HITS 4"), line)
  assert.ok(!line.includes("DROPPED NOTES"), line)
  assert.ok(!line.includes("RETIRED EVENTS"), line)
})

check("REGRESSION: unsaved hits never render as a saved badge", () => {
  const s = {...baseSummary, phase: "capturing", unsynced: {...baseUnsynced, uncapturedHits: 4}, savedBadgeCount: 0, lastSavedReceipt: null}
  const line = compactSummary(s)
  assert.ok(!line.includes("SAVED"), `unsaved hits must not badge: ${line}`)
})

check("severityForSummary agrees with severityForPhase on clean snapshots", () => {
  for (const phase of ALL_PHASES) {
    const s = {...baseSummary, phase, unsynced: baseUnsynced}
    assert.equal(severityForSummary(s), severityForPhase(phase), `clean-severity drift at ${phase}`)
  }
})

check("REGRESSION: malformed counters render as absent but NEVER claim green", () => {
  const u = {...baseUnsynced, uncapturedHits: undefined, overflowDroppedNotes: NaN, retiredUnsentEvents: -3}
  assert.equal(hasLoss(u), true, "malformed counters cannot prove clean")
  const s = {...baseSummary, phase: "capturing", unsynced: u}
  assert.equal(severityForSummary(s), "warn", "malformed counters must not yield green")
  const line = compactSummary(s)
  assert.ok(line.includes("unsent 0"), line)
  assert.ok(!line.includes("NaN"), line)
  assert.ok(!line.includes("MISSED HITS"), line)
  assert.ok(!line.includes("DROPPED NOTES"), line)
  assert.ok(!line.includes("RETIRED EVENTS"), line)
})

check("hasLoss is false only when every loss counter is a finite zero", () => {
  assert.equal(hasLoss(baseUnsynced), false)
  const u = {...baseUnsynced, uncapturedHits: 0, overflowDroppedNotes: 0, retiredUnsentEvents: 0}
  assert.equal(hasLoss(u), false)
})

// ── 11 · REGRESSION: note faithfulness (StatusDetail stuck fields) ──────────
check("REGRESSION: notCapturableNotes renders LONG NOTES NOT CAPTURED and warns while capturing", () => {
  const s = {...baseSummary, phase: "capturing", notCapturableNotes: 3}
  const line = compactSummary(s)
  assert.ok(line.includes("LONG NOTES NOT CAPTURED 3"), line)
  assert.equal(severityForSummary(s), "warn")
})

check("REGRESSION: nonFaithfulNotes renders TIMING UNCERTAIN N – save withheld (exact wording)", () => {
  const s = {...baseSummary, phase: "capturing", nonFaithfulNotes: 2}
  const line = compactSummary(s)
  assert.ok(line.includes("TIMING UNCERTAIN 2 – save withheld"), line)
  assert.equal(severityForSummary(s), "warn")
})

check("faithfulness fields never conflate with unsynced counters and never total", () => {
  const s = {
    ...baseSummary,
    phase: "capturing",
    notCapturableNotes: 3,
    unsynced: {...baseUnsynced, uncapturedHits: 5},
  }
  const line = compactSummary(s)
  assert.ok(line.includes("LONG NOTES NOT CAPTURED 3"), line)
  assert.ok(line.includes("MISSED HITS 5"), line)
  assert.ok(!line.includes("8"), `cross-field sum must not render: ${line}`)
})

check("overlapping-looking fields display separately with no combined count", () => {
  const s = {...baseSummary, phase: "capturing", notCapturableNotes: 3, unsynced: {...baseUnsynced, notesUnknownDuration: 3}}
  const line = compactSummary(s)
  assert.ok(line.includes("LONG NOTES NOT CAPTURED 3"), line)
  assert.ok(line.includes("unknown-duration 3"), line)
  assert.ok(!line.includes("6"), `combined count must not render: ${line}`)
})

check("REGRESSION: stuckKnown false shows WINDOW UNKNOWN and warns even while capturing", () => {
  const s = {...baseSummary, phase: "capturing", stuckKnown: false}
  const line = compactSummary(s)
  assert.ok(line.includes("WINDOW UNKNOWN"), line)
  assert.equal(severityForSummary(s), "warn")
})

check("stuckKnown true renders no WINDOW UNKNOWN", () => {
  const line = compactSummary({...baseSummary, phase: "capturing"})
  assert.ok(!line.includes("WINDOW UNKNOWN"), line)
  assert.deepEqual(faithfulnessSegments({...baseSummary, phase: "capturing"}), [])
})

check("REGRESSION: missing/malformed stuck fields fail closed (WINDOW UNKNOWN + warn, no green)", () => {
  const missing = {phase: "capturing", unsynced: baseUnsynced, savedBadgeCount: 0, lastSavedReceipt: null}
  assert.ok(compactSummary(missing).includes("WINDOW UNKNOWN"))
  assert.equal(severityForSummary(missing), "warn")
  const malformed = {...baseSummary, phase: "capturing", stuckKnown: "yes", notCapturableNotes: NaN}
  assert.ok(compactSummary(malformed).includes("WINDOW UNKNOWN"), compactSummary(malformed))
  assert.equal(severityForSummary(malformed), "warn")
  const line = compactSummary(malformed)
  assert.ok(!line.includes("NaN"), line)
  assert.ok(!line.includes("LONG NOTES"), line)
})

check("REGRESSION: faithfulness warnings hold even in saved_confirmed (saved prior)", () => {
  const s = {...baseSummary, phase: "saved_confirmed", notCapturableNotes: 2}
  const line = compactSummary(s)
  assert.ok(line.includes("SAVED ✓ (RECEIPT)"), line) // phase label keeps receipt wording
  assert.ok(line.includes("LONG NOTES NOT CAPTURED 2"), line)
  assert.equal(severityForSummary(s), "warn")
})

check("REGRESSION: not-captured long notes are never labelled saved", () => {
  const s = {...baseSummary, phase: "capturing", notCapturableNotes: 3, nonFaithfulNotes: 2, savedBadgeCount: 0, lastSavedReceipt: null}
  const line = compactSummary(s)
  assert.ok(!line.includes("SAVED"), `unsaved notes must not badge: ${line}`)
  assert.ok(line.includes("save withheld"), "nonFaithful segment must state save withheld")
})

check("faithfulness segments come through the compact line visible in both UI states", () => {
  const s = {...baseSummary, phase: "capturing", notCapturableNotes: 1, nonFaithfulNotes: 1, stuckKnown: false}
  const segs = faithfulnessSegments(s)
  assert.deepEqual(segs, ["LONG NOTES NOT CAPTURED 1", "TIMING UNCERTAIN 1 – save withheld", "WINDOW UNKNOWN"])
  for (const seg of segs) {
    assert.ok(compactSummary(s).includes(seg), `segment missing from compact: ${seg}`)
  }
})

check("credential scan covers the extended snapshot shape (no tokens)", () => {
  const s = {
    ...baseSummary,
    phase: "connecting",
    notCapturableNotes: 1,
    nonFaithfulNotes: 1,
    stuckKnown: false,
    unsynced: {...baseUnsynced, unsentEvents: 1},
    lastSavedReceipt: {status: "saved", name: "take.mid", version: 1, bytes: 1},
  }
  const outputs = [
    compactSummary(s),
    unsyncedSummary(s.unsynced),
    saveAckSnippet(s.lastSavedReceipt),
    faithfulnessSegments(s).join(" · "),
  ]
  for (const out of outputs) {
    for (const banned of ["bearer", "Bearer", "BEARER", "access_token", "token_type", "ey", "PAIR-CODE-XYZ"]) {
      assert.ok(!out.includes(banned), `output leaked "${banned}": ${out}`)
    }
  }
})

// ── result ────────────────────────────────────────────────────────────────────
console.log("PASS " + PASS.length + "/" + PASS.length + " checks:")
for (const name of PASS) {
  console.log("  ✓ " + name)
}
