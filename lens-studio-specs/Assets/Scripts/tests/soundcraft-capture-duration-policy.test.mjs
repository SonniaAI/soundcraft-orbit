// soundcraft-capture-duration-policy.test.mjs — lightweight receipt for the
// SoundcraftCaptureController SAMPLE-DURATION window policy. Run with the
// repo's Node (≥22.18):
//
//   node Assets/Scripts/tests/soundcraft-capture-duration-policy.test.mjs
//
// Pure Node: parses the ACTUAL pad WAV headers on disk, source-contract checks
// the controller/client text, and instantiates NOTHING (the controller carries
// Lens Studio decorators and the client owns network state — neither is
// imported). No SoundCraft runtime, no cargo, no local backend: the backend
// negotiation contract is CITED from the client source and the existing
// connection-status test, never re-implemented here.
//
// Honesty contract under test:
//  * every ACTUAL original pad (bass 1.864263 s mono, chord_1..4 5.219887 s
//    stereo @44100, beat ≤ 0.30 s) fits STRICTLY under the requested
//    stuck-timeout window, and the request is bounded ≤ 10 s — full-length
//    originals are captured, never shortened or truncated;
//  * a pad that GROWS past the window refuses honestly (documented
//    retention path: retained locally, gap surfaced — never a fabricated
//    measured finish, never a pre-queued future note-off);
//  * unknown/undeclared durations stay fail-closed ("unknown", never guessed).

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const PASS = []

function check(name, fn) {
  fn()
  PASS.push(name)
}

const here = import.meta.dirname
const sfxDir = path.resolve(here, "..", "..", "GeneratedSFX")
const controllerPath = path.resolve(here, "..", "SoundcraftCaptureController.ts")
const clientPath = path.resolve(here, "..", "SoundcraftCompanionClient.ts")
const existingTestPath = path.resolve(here, "soundcraft-connection-status.test.mjs")

const controllerSrc = fs.readFileSync(controllerPath, "utf8")
const clientSrc = fs.readFileSync(clientPath, "utf8")
const existingTestSrc = fs.readFileSync(existingTestPath, "utf8")

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse a canonical PCM WAV header by WALKING RIFF chunks (no fixed offsets). */
function parseWavHeader(filePath) {
  const b = fs.readFileSync(filePath)
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") {
    return { ok: false, problem: "not a RIFF/WAVE file" }
  }
  let off = 12
  let fmt = -1
  let channels = -1
  let sampleRate = -1
  let byteRate = -1
  let bits = -1
  let dataSize = -1
  while (off + 8 <= b.length) {
    const id = b.toString("latin1", off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === "fmt " && size >= 16) {
      fmt = b.readUInt16LE(off + 8)
      channels = b.readUInt16LE(off + 10)
      sampleRate = b.readUInt32LE(off + 12)
      byteRate = b.readUInt32LE(off + 16)
      bits = b.readUInt16LE(off + 22)
    } else if (id === "data") {
      dataSize = size
    }
    off += 8 + size + (size % 2) // chunks are word-aligned
    if (size === 0xffffffff) break // streamed/unbounded chunk: stop honestly
  }
  if (fmt !== 1 || channels <= 0 || sampleRate <= 0 || byteRate <= 0 || dataSize <= 0) {
    return { ok: false, problem: "header lacks PCM fmt/data fields (fmt=" + fmt + ")" }
  }
  const durationSecs = dataSize / byteRate
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
    return { ok: false, problem: "non-finite or non-positive duration" }
  }
  return { ok: true, fmt, channels, sampleRate, bits, dataSize, durationSecs }
}

/** The controller's documented SAMPLE-DURATION policy, mirrored for the receipt:
 * covered ⇒ full-length capture may be exact (backend reply stays the effective
 * bound) · refuse ⇒ honest retention (never truncated/fabricated) · unknown ⇒
 * fail-closed (no guessing). */
function classifyDurationPolicy(durationSecs, requestedSecs) {
  if (!(durationSecs > 0) || !Number.isFinite(durationSecs)) return "unknown"
  return durationSecs < requestedSecs ? "covered" : "refuse"
}

function readControllerConstant(name) {
  const m = new RegExp("const " + name + "\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;", "m").exec(controllerSrc)
  return m === null ? NaN : Number(m[1])
}

// ── 1 · actual pad WAVs parse honestly ────────────────────────────────────────
const PAD_FILE_PREFIXES = ["bass_", "chord_", "pad_"] // the pad sample sets discovery binds (ui_toggle/demo_vapor are not pads)
const padFiles = fs
  .readdirSync(sfxDir)
  .filter((f) => f.endsWith(".wav") && PAD_FILE_PREFIXES.some((p) => f.startsWith(p)))
  .sort()

check("the known original pad set is present on disk", () => {
  assert.ok(padFiles.length >= 12, "expected ≥ 12 pad WAVs (4 bass, 4 chord, 4 beat), found " + padFiles.length + ": " + padFiles.join(", "))
  for (const need of ["bass_a.wav", "chord_1.wav", "chord_4.wav", "pad_kick.wav"]) {
    assert.ok(padFiles.includes(need), "missing expected pad sample " + need)
  }
})

const parsed = {}
check("every pad WAV header parses with a positive finite duration", () => {
  for (const f of padFiles) {
    const h = parseWavHeader(path.join(sfxDir, f))
    assert.ok(h.ok, f + " refused to parse: " + h.problem)
    parsed[f] = h
  }
})

const MAX_ACTUAL_SECS = Math.max(...Object.values(parsed).map((h) => h.durationSecs))
const requested = readControllerConstant("REQUESTED_STUCK_TIMEOUT_SECONDS")
const ceiling = readControllerConstant("REQUESTED_STUCK_TIMEOUT_CEILING_SECONDS")

// ── 2 · THE CORE RECEIPT: actual WAV max < requested ≤ ceiling ≤ 10 ──────────
check("REGRESSION: every ACTUAL pad duration is strictly under the requested stuck window (full-length capture)", () => {
  assert.ok(Number.isFinite(requested) && requested > 0, "REQUESTED_STUCK_TIMEOUT_SECONDS missing/invalid in controller: " + requested)
  assert.ok(MAX_ACTUAL_SECS < requested, "longest actual pad " + MAX_ACTUAL_SECS.toFixed(6) + " s must be < requested window " + requested + " s — a chord would fail-closed again")
  for (const f of padFiles) {
    assert.ok(parsed[f].durationSecs < requested, f + " (" + parsed[f].durationSecs.toFixed(6) + " s) ≥ requested " + requested + " s")
  }
})

check("REGRESSION: the request is bounded — requested ≤ ceiling ≤ 10 s (no unbounded window)", () => {
  assert.ok(Number.isFinite(ceiling) && ceiling > 0, "REQUESTED_STUCK_TIMEOUT_CEILING_SECONDS missing/invalid in controller: " + ceiling)
  assert.ok(requested <= ceiling, "requested " + requested + " s exceeds its own ceiling " + ceiling + " s")
  assert.ok(ceiling <= 10, "ceiling must stay ≤ 10 s, is " + ceiling)
})

check("REGRESSION: cfgWithDefaults wires the controller-owned constants (DEFAULT_CONFIG's stale 2.0 s is gone)", () => {
  assert.match(controllerSrc, /requestedStuckTimeoutSeconds:\s*Math\.min\(\s*REQUESTED_STUCK_TIMEOUT_SECONDS,\s*REQUESTED_STUCK_TIMEOUT_CEILING_SECONDS\s*\)/, "cfgWithDefaults must clamp the controller constants")
  assert.ok(!controllerSrc.includes("DEFAULT_CONFIG.requestedStuckTimeoutSeconds"), "the stale DEFAULT_CONFIG.requestedStuckTimeoutSeconds path must not come back")
  assert.ok(!controllerSrc.includes("covers 1.25 s bass / 1.76 s chord"), "the false 'covers 1.25/1.76' header claim must stay gone (actual headers: bass 1.864263 s, chord 5.219887 s)")
})

// ── 3 · longer pads refuse honestly ──────────────────────────────────────────
check("a pad grown past the window classifies REFUSE (honest retention, never a silent clip)", () => {
  assert.equal(classifyDurationPolicy(7.5, requested), "refuse", "just past the window must refuse")
  assert.equal(classifyDurationPolicy(12.0, requested), "refuse", "far past the window must refuse")
  assert.equal(classifyDurationPolicy(MAX_ACTUAL_SECS, requested), "covered", "the longest ACTUAL pad must stay covered")
})

check("unknown/undeclared durations classify UNKNOWN (fail-closed, no guessing)", () => {
  assert.equal(classifyDurationPolicy(0, requested), "unknown")
  assert.equal(classifyDurationPolicy(-1, requested), "unknown")
  assert.equal(classifyDurationPolicy(NaN, requested), "unknown")
  assert.equal(classifyDurationPolicy(Infinity, requested), "unknown")
})

check("the controller documents the honest refusal path for a future longer pad", () => {
  assert.match(controllerSrc, /LONGER pad sample than the window is an honest refusal path/, "policy comment must name the refusal path")
  assert.match(controllerSrc, /never a silent clip/, "policy comment must never promise silent clipping")
})

// ── 4 · backend negotiation contract — CITED from the client source ──────────
// (citation, not a new local backend: the real open/retry flow is the client's
// own tested behaviour; here we only verify the cited contract text is present)
check("CITATION: the requested window flows verbatim into the live_open body (no constructor clamp of it)", () => {
  assert.match(clientSrc, /openBody\["stuck_timeout_seconds"\]\s*=\s*this\.cfg\.requestedStuckTimeoutSeconds/, "client must send the config value verbatim")
  const ctor = /constructor\(env: ClientEnv, cfg: CompanionConfig\) \{[\s\S]*?\n  \}/.exec(clientSrc)
  assert.ok(ctor !== null, "client constructor block not found")
  assert.ok(!ctor[0].includes("requestedStuckTimeoutSeconds"), "constructor must NOT clamp the explicit controller override — it currently preserves it and must stay that way")
})

check("CITATION: the effective bound is the backend's reply ints, and the old-backend safeguard stays fail-closed", () => {
  assert.match(clientSrc, /stuck_timeout_samples/, "client must read the effective stuck_timeout_samples from the open reply")
  assert.match(clientSrc, /does not support stuck_timeout_seconds/, "progressive-safeguard citation missing")
  assert.match(clientSrc, /long-declared notes stay retained/, "retention-not-truncation citation missing")
})

check("CITATION: the existing connection-status test owns the fail-closed WINDOW UNKNOWN coverage", () => {
  assert.ok(fs.existsSync(existingTestPath), "existing test file missing")
  assert.ok(existingTestSrc.includes("WINDOW UNKNOWN"), "cited test no longer covers the fail-closed window case")
})

check("CITATION: the controller still surfaces an unknown window honestly in status", () => {
  assert.match(controllerSrc, /CAPTURE WINDOW unknown \(backend did not declare it\)/, "fail-closed status copy must stay")
})

// ── receipt ───────────────────────────────────────────────────────────────────
const line = "-".repeat(76)
console.log(line)
console.log("SAMPLE-DURATION POLICY RECEIPT (Assets/GeneratedSFX headers @44100 Hz PCM)")
for (const f of padFiles) {
  const h = parsed[f]
  const tag = h.channels === 1 ? "mono" : h.channels === 2 ? "stereo" : h.channels + "ch"
  console.log(
    "  " + f.padEnd(16) + " " + h.durationSecs.toFixed(6) + " s  " + tag.padEnd(7) + " " + h.sampleRate + " Hz " + h.bits + "-bit  → " + classifyDurationPolicy(h.durationSecs, requested)
  )
}
console.log(line)
console.log(
  "  actual WAV max " + MAX_ACTUAL_SECS.toFixed(6) + " s  <  requested " + requested + " s  ≤  ceiling " + ceiling + " s  ≤  10 s : " +
    (MAX_ACTUAL_SECS < requested && requested <= Math.min(ceiling, 10) ? "OK" : "FAIL")
)
console.log(line)

// ── result ────────────────────────────────────────────────────────────────────
console.log("PASS " + PASS.length + "/" + PASS.length + " checks:")
for (const name of PASS) {
  console.log("  ✓ " + name)
}
