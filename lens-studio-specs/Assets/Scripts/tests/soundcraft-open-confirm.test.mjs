// soundcraft-open-confirm.test.mjs — REAL-LOGIC tests for the pure two-step
// confirmation decision used by the guarded explicitOpenLastSavedProject
// affordance (SoundcraftConnectionUI). Run with the repo's Node (≥22.18;
// native TS transform):
//
//   node --experimental-transform-types Assets/Scripts/tests/soundcraft-open-confirm.test.mjs
//
// HOW THE SHIPPED CODE IS LOADED: SoundcraftOpenConfirm.ts is dependency-free
// (no imports, no decorators, no Lens types), so the ONLY transform is
// Node's own stripTypeScriptTypes (transform mode) — the tested decision
// function is the EXACT shipped code, not a re-implementation.
//
// WHAT IS COVERED (per the safety follow-up):
//  * duplicate onTriggerUp callbacks from ONE gesture/frame (0/1/20/100 ms
//    after arm) are IGNORED — they never advance to fire;
//  * a deliberate second tap (500 ms) FIRES;
//  * the 300 ms minimum separation boundary (299 ignore / 300 fire);
//  * the 8 s expiry boundary (7999/8000 fire / 8001 re-arm, never late-fire);
//  * expiry re-arm keeps the "two distinct taps" invariant intact;
//  * a stateful trigger sequence model: first tap arms WITHOUT calling the
//    controller, synthetic duplicates never advance, reset points work.
// No network, no backend, no mock SAVED — the helper is pure.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { stripTypeScriptTypes } from "node:module"

const PASS = []
function check(name, fn) {
  fn()
  PASS.push(name)
}

const here = import.meta.dirname
const srcPath = path.resolve(here, "..", "SoundcraftOpenConfirm.ts")
const src = fs.readFileSync(srcPath, "utf8")
const js = stripTypeScriptTypes(src, { mode: "strip" })
const tmpPath = path.resolve(here, ".open-confirm.mjs")
fs.writeFileSync(tmpPath, js)
const mod = await import(pathToFileURL(tmpPath).href)
const { openConfirmDecision, OPEN_CONFIRM_WINDOW_MS, OPEN_CONFIRM_MIN_SEPARATION_MS } = mod

// ---- constants ---------------------------------------------------------------
check("window is 8 s (matching the documented arm expiry)", () => {
  assert.equal(OPEN_CONFIRM_WINDOW_MS, 8000)
})
check("minimum separation is 300 ms (duplicate suppression floor)", () => {
  assert.equal(OPEN_CONFIRM_MIN_SEPARATION_MS, 300)
})

// ---- idle / first tap ----------------------------------------------------------
check("first tap on idle always ARMS (controller is not called on this branch)", () => {
  assert.equal(openConfirmDecision(null, 1000), "arm")
  assert.equal(openConfirmDecision(null, 0), "arm")
})
check("a corrupt/non-numeric arm timestamp is treated as idle → arm", () => {
  assert.equal(openConfirmDecision(Number.NaN, 1000), "arm")
})

// ---- duplicate suppression (the safety follow-up's core requirement) -----------
check("duplicate at 0 ms (same frame) is IGNORED", () => {
  assert.equal(openConfirmDecision(1000, 1000), "ignore")
})
check("duplicate at 1 ms is IGNORED", () => {
  assert.equal(openConfirmDecision(1000, 1001), "ignore")
})
check("duplicate at 20 ms is IGNORED", () => {
  assert.equal(openConfirmDecision(1000, 1020), "ignore")
})
check("duplicate at 100 ms is IGNORED", () => {
  assert.equal(openConfirmDecision(1000, 1100), "ignore")
})
check("duplicate at 299 ms (just under separation) is IGNORED", () => {
  assert.equal(openConfirmDecision(1000, 1299), "ignore")
})
check("a burst of synthetic duplicates NEVER advances to fire", () => {
  const offsets = [0, 5, 10, 16, 20, 33, 50, 100, 150, 250, 299]
  for (const off of offsets) {
    assert.equal(openConfirmDecision(1000, 1000 + off), "ignore", "offset " + off + "ms must be ignored")
  }
})

// ---- deliberate second tap -----------------------------------------------------
check("distinct tap at exactly 300 ms FIRES", () => {
  assert.equal(openConfirmDecision(1000, 1300), "fire")
})
check("deliberate tap at 500 ms FIRES", () => {
  assert.equal(openConfirmDecision(1000, 1500), "fire")
})

// ---- expiry boundary: late triggers NEVER fire, they re-arm ---------------------
check("tap at 7999 ms (inside window) FIRES", () => {
  assert.equal(openConfirmDecision(1000, 8999), "fire")
})
check("tap at exactly 8000 ms (window edge) FIRES", () => {
  assert.equal(openConfirmDecision(1000, 9000), "fire")
})
check("tap at 8001 ms is past expiry → RE-ARM (never a late fire)", () => {
  assert.equal(openConfirmDecision(1000, 9001), "arm")
})
check("tap far past expiry (60 s) → RE-ARM", () => {
  assert.equal(openConfirmDecision(1000, 61000), "arm")
})

// ---- purity ----------------------------------------------------------------------
check("decision is pure: identical inputs give identical outputs", () => {
  const a = openConfirmDecision(1000, 1500)
  const b = openConfirmDecision(1000, 1500)
  assert.equal(a, b)
  assert.equal(typeof a, "string")
})
check("decision never fabricates values outside arm/fire/ignore", () => {
  for (const d of [openConfirmDecision(null, 0), openConfirmDecision(0, 5), openConfirmDecision(0, 5000), openConfirmDecision(0, 90000)]) {
    assert.ok(d === "arm" || d === "fire" || d === "ignore", "unexpected decision " + String(d))
  }
})

// ---- stateful sequence model (mirrors the panel wiring) ---------------------------
// armedAt updates ONLY on "arm"; fire disarms; ignore changes nothing.
function model(taps) {
  let armedAt = null
  const calls = []
  for (const t of taps) {
    const d = openConfirmDecision(armedAt, t)
    if (d === "arm") armedAt = t
    else if (d === "fire") {
      armedAt = null
      calls.push(t)
    }
    // "ignore": nothing changes
  }
  return { armedAt, calls }
}
check("SCENARIO duplicate burst: first tap arms WITHOUT firing; synthetic duplicates never advance", () => {
  const { armedAt, calls } = model([0, 0, 16, 20, 100])
  assert.equal(armedAt, 0, "still armed at the ORIGINAL timestamp (duplicates changed nothing)")
  assert.deepEqual(calls, [], "no controller call happened")
})
check("SCENARIO deliberate second tap fires exactly once, after the armed state was visible", () => {
  const { armedAt, calls } = model([0, 20, 100, 500])
  assert.equal(armedAt, null, "disarmed after the fire")
  assert.deepEqual(calls, [500], "exactly one controller call, at the deliberate tap")
})
check("SCENARIO expired arm: late tap re-arms and a second tap is required again", () => {
  const { armedAt, calls } = model([0, 9000])
  assert.equal(armedAt, 9000, "the late tap re-armed a FRESH window instead of firing")
  assert.deepEqual(calls, [], "no fire across the expiry")
  const after = model([0, 9000, 9500])
  assert.deepEqual(after.calls, [9500], "the next distinct tap inside the fresh window fires")
  const stillGuarded = model([0, 9000, 9200])
  assert.deepEqual(stillGuarded.calls, [], "a 200 ms duplicate inside the fresh window is still ignored")
})
check("SCENARIO pair submit resets the arm (reset-on-submit)", () => {
  // panel semantics: any pair submit calls disarm → armedAt back to null
  let armedAt = 100 // armed at t=100
  const disarm = () => { armedAt = null }
  const taps = [200] // pair tapped at t=200
  for (const t of taps) {
    void t
    disarm()
  }
  assert.equal(armedAt, null, "arm cleared by the submit")
  assert.equal(openConfirmDecision(armedAt, 400), "arm", "next OPEN tap starts a FRESH arm, never fires")
})
check("SCENARIO collapse/expand resets the arm (reset-on-context-change)", () => {
  let armedAt = 100
  const onContextChange = () => { armedAt = null }
  onContextChange()
  assert.equal(openConfirmDecision(armedAt, 5000), "arm", "context change cleared the arm; next tap re-arms")
})

fs.rmSync(tmpPath, { force: true })
console.log("soundcraft-open-confirm: " + PASS.length + " checks passed")
for (const name of PASS) {
  console.log("  ✓ " + name)
}
