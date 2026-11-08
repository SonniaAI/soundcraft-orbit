// soundcraft-playlist-panel-presentation.test.mjs — lightweight receipt for the
// PlaylistPanel presentation layer (PlaylistPanel.ts + PlaylistPanelPresentation.ts).
// Run with the repo's Node (≥22.18):
//
//   node Assets/Scripts/tests/soundcraft-playlist-panel-presentation.test.mjs
//
// Pure Node: the presentation helper and the REAL client are loaded through the
// same documented pipeline as the workflow test (strip decorator lines, re-point
// import specifiers to transformed temp copies, then Node's stripTypeScriptTypes).
// Snapshot fixtures are REAL StatusDetail objects from a real
// SoundcraftCompanionClient instance (constructor is pure TS) — the helper is fed
// actual field shapes, never hand-fabricated ones. No Lens runtime, no network,
// no local backend, no cargo.
//
// Honesty contract under test:
//  * LOCAL monitor data (bus clock + hits) and BACKEND counts (snapshot) are
//    rendered by separate functions and never merged;
//  * SAVED wording is minted ONLY from savedBadgeCount / the exact `saved`
//    receipt; pending/unknown/failed/disabled/malformed receipts mint nothing;
//  * backend readback listings grow the playlist COUNT, never the badge;
//  * a prior saved receipt never claims the current take ("(earlier save)"),
//    never hides buffered/held/unsynced work, never clears anything;
//  * every phase (offline / unknown / failed / expired / down …) renders its
//    shipped label verbatim; no code path can say "ALL SAVED";
//  * the null-snapshot fallback is honest local-only wording;
//  * the 90 s bar is a rolling VIEW window — pure display math, capture
//    continues (caption states it), nothing is capped;
//  * PlaylistPanel polls getStatusSnapshot() 4 Hz and NEVER writes
//    onSnapshot / statusText / the session clock.

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
const scriptsDir = path.resolve(here, "..")

// ---- load the shipped modules (mechanical transforms only) ------------------
// Same pipeline as soundcraft-capture-controller-workflow.test.mjs: strip
// decorator lines, re-point import specifiers to the transformed temp copies,
// then Node's stripTypeScriptTypes (elides the type-only imports). Function
// bodies are the EXACT shipped code.
const tmpDir = scriptsDir
const moduleMap = {
  "./PlaylistPanelPresentation": ".pp-presentation.mjs",
  "./SoundcraftCompanionClient": ".pp-client.mjs",
  "./SoundcraftCompanionHttp": ".pp-http.mjs",
  "./SoundcraftCompanionTypes": ".pp-types.mjs",
  "./SoundcraftConnectionStatus": ".pp-status.mjs",
  "./SoundcraftBus": ".pp-bus-stub.mjs",
}

function elideTypeOnlyImports(src) {
  const masked = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*"/g, "")
    .replace(/import\s*\*\s*as\s*\w+\s*from\s*"[^"]*"/g, "")
    .replace(/import\s+\w+\s*from\s*"[^"]*"/g, "")
  return src.replace(/import\s*\{([^}]*)\}\s*from\s*("[^"]*")/g, (whole, names, from) => {
    const kept = names
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .filter((n) => new RegExp("\\b" + n.replace(/\s+as\s+\w+$/, "") + "\\b").test(masked))
    return kept.length > 0 ? "import { " + kept.join(", ") + " } from " + from : ""
  })
}

const tmpFiles = Object.values(moduleMap)
let pp = null
let statusMod = null
let clientMod = null
try {
  globalThis.BaseScriptComponent = class BaseScriptComponent {}
  fs.writeFileSync(path.join(tmpDir, ".pp-bus-stub.mjs"), "// test-only no-op stub for the SIK-bound bus (pure view math never touches it)\nexport class SoundcraftBus { static onHit = { add() {}, remove() {} }; static instruments = [] }\n")
  for (const [specifier, tmpName] of Object.entries(moduleMap)) {
    if (tmpName === ".pp-bus-stub.mjs") continue
    let src = fs.readFileSync(path.join(tmpDir, specifier.replace("./", "") + ".ts"), "utf8")
    src = src
      .split("\n")
      .filter((line) => !/^\s*@/.test(line)) // decorator lines out (none exist in the loaded set today)
      .join("\n")
    for (const [sp, tn] of Object.entries(moduleMap)) {
      src = src.split('from "' + sp + '"').join('from "./' + tn + '"')
    }
    fs.writeFileSync(path.join(tmpDir, tmpName), elideTypeOnlyImports(stripTypeScriptTypes(src, { mode: "strip" })))
  }
  pp = await import(pathToFileURL(path.join(tmpDir, ".pp-presentation.mjs")).href)
  statusMod = await import(pathToFileURL(path.join(tmpDir, ".pp-status.mjs")).href)
  clientMod = await import(pathToFileURL(path.join(tmpDir, ".pp-client.mjs")).href)
} finally {
  for (const f of tmpFiles) {
    const p = path.join(tmpDir, f)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

const { labelForPhase, ALL_PHASES } = statusMod

// ---- REAL snapshot factory (transformed copy of the shipped client class) ----
const { SoundcraftCompanionClient, DEFAULT_CONFIG } = clientMod

function makeRealSnapshot(overrides = {}) {
  // A REAL client instance produces a REAL StatusDetail. Overrides only set
  // documented tracked fields (a phantom key fails LOUD here).
  const client = new SoundcraftCompanionClient(
    {
      transport: {
        request: () =>
          Promise.resolve({ outcome: "local_only", status: 0, bodyText: "", retryAfterSeconds: 0, problem: "test transport — no request" }),
      },
      nowSecs: () => 0,
      realtimeNanos: () => 0,
      timer: { arm: () => ({ cancel: () => {} }) },
      log: () => {},
    },
    { ...DEFAULT_CONFIG, onlineMode: true }
  )
  const s = client.snapshot()
  for (const k of Object.keys(overrides)) {
    assert.ok(k in s, "override field does not exist on the real StatusDetail: " + k)
    s[k] = overrides[k]
  }
  return s
}

const receiptSaved = (version, name = "orbit_take.json") => ({ status: "saved", name, version, bytes: 1234 })
const entrySaved = (name) => ({ name, bytes: 1234, modifiedMs: 1, source: "saved_receipt", savedBadge: true })
const entryReadback = (name) => ({ name, bytes: 100, modifiedMs: 2, source: "backend_readback", savedBadge: false })

// ── 1 · fixed copy ────────────────────────────────────────────────────────────
check("panel title is exactly SOUNDCRAFT ORBIT", () => {
  assert.equal(pp.PANEL_TITLE, "SOUNDCRAFT ORBIT")
})

check("demo labels are short and name the bundled demo", () => {
  const stop = pp.demoLabel(true)
  const play = pp.demoLabel(false)
  assert.equal(play, "▶ PLAY demo (bundled)")
  assert.equal(stop, "■ STOP demo")
  assert.ok(play.length <= 24 && stop.length <= 24, "labels must stay short: " + play.length + "/" + stop.length)
  assert.ok(play.includes("bundled"), "the demo must stay labelled bundled")
})

check("clear note claims the LOCAL view only", () => {
  const note = pp.CLEAR_NOTE
  assert.ok(note.includes("LOCAL view only"), note)
  assert.ok(note.includes("backend session/document untouched"), note)
  assert.ok(!/never persisted/i.test(note), "the old absolute 'never persisted' claim is gone")
})

// ── 2 · local take line (bus data ONLY) ───────────────────────────────────────
check("take line shows local clock + hits and nothing else", () => {
  assert.equal(pp.takeLine(42, 17), "TAKE 0:42 · 17 hits")
  assert.equal(pp.takeLine(0, 0), "TAKE 0:00 · 0 hits")
  assert.ok(!/saved|SIMULATED|unsent|held|buffered/i.test(pp.takeLine(42, 17)), "no backend words on the local line")
})

check("view caption appears only past 90 s and says capture continues", () => {
  assert.ok(!pp.takeLine(89.9, 1).includes("view"))
  const capped = pp.takeLine(90.1, 1)
  assert.ok(capped.includes("90 s view"), capped)
  assert.ok(capped.includes("capture continues"), capped)
  assert.ok(!/cap\b|limit/i.test(capped), "caption must never read as a cap: " + capped)
})

// ── 3 · rolling 90 s VIEW window (never a capture cap) ────────────────────────
check("bar view window rolls every 90 s", () => {
  assert.equal(pp.barViewStart(0), 0)
  assert.equal(pp.barViewStart(45), 0)
  assert.equal(pp.barViewStart(89.99), 0)
  assert.equal(pp.barViewStart(90), 90)
  assert.equal(pp.barViewStart(179.9), 90)
  assert.equal(pp.barViewStart(180), 180)
})

check("bar view fraction keeps advancing past 90 s and stays in range", () => {
  assert.equal(pp.barViewFrac(45), 0.5)
  assert.equal(pp.barViewFrac(135), 0.5, "view continues past the first window")
  assert.equal(pp.barViewFrac(90), 0)
  for (const t of [0, 1, 30, 90, 179, 1000, 10000]) {
    const f = pp.barViewFrac(t)
    assert.ok(f >= 0 && f <= 1, "frac out of range at t=" + t)
  }
})

check("tick index maps hits into the current view window only", () => {
  assert.equal(pp.tickIndex(10, 0, 90, 16), 1)
  assert.equal(pp.tickIndex(89, 0, 90, 16), 15)
  assert.equal(pp.tickIndex(95, 90, 90, 16), 0, "hit in the new window maps fresh")
  assert.equal(pp.tickIndex(10, 90, 90, 16), -1, "hit from an older window is out of view")
  assert.equal(pp.tickIndex(90, 0, 90, 16), -1, "window edge is exclusive")
})

// ── 4 · null-snapshot fallback is honest local-only ───────────────────────────
check("null snapshot rows claim nothing about any backend", () => {
  const rows = pp.backendRows(null)
  assert.ok(rows.statusRow.includes("LOCAL MONITOR ONLY"), rows.statusRow)
  assert.ok(rows.statusRow.includes("not saved"), rows.statusRow)
  assert.ok(rows.playlistRow.includes("no backend linked"), rows.playlistRow)
  assert.ok(!/\bSAVED\b/.test(rows.statusRow + " " + rows.playlistRow), "no SAVED badge claim without a controller")
  assert.ok(!/ALL SAVED/i.test(rows.statusRow + " " + rows.playlistRow))
})

// ── 5 · real snapshot renders its actual phase ────────────────────────────────
check("a real client snapshot renders its actual phase label verbatim", () => {
  const s = makeRealSnapshot()
  assert.ok(ALL_PHASES.includes(s.phase), "fixture phase must be a real phase: " + s.phase)
  const rows = pp.backendRows(s)
  const label = labelForPhase(s.phase)
  assert.ok(rows.statusRow.indexOf(label) === 0, "row must open with the shipped label: " + rows.statusRow)
})

// ── 6 · SAVED badge + version guard ──────────────────────────────────────────
check("SAVED count and version render only through the exact-receipt guard", () => {
  const s = makeRealSnapshot({
    phase: "saved_confirmed",
    savedBadgeCount: 2,
    lastSavedReceipt: receiptSaved(7),
    playlist: [entrySaved("orbit_take.json"), entrySaved("orbit_take_v2.json")],
  })
  const rows = pp.backendRows(s)
  assert.ok(rows.playlistRow.includes("SAVED 2"), rows.playlistRow)
  assert.ok(rows.playlistRow.includes("v7"), rows.playlistRow)
  assert.ok(!rows.playlistRow.includes("(earlier save)"), "a settled take needs no earlier-save marker")
  assert.equal(pp.savedVersionLabel(receiptSaved(0)), "v0", "version 0 is a well-formed number")
})

check("stripTrailingSaved removes only the deterministic suffix", () => {
  const s = makeRealSnapshot({ savedBadgeCount: 3 })
  const full = statusMod.compactSummary(s)
  assert.ok(full.endsWith(" · SAVED 3"), full)
  assert.equal(pp.stripTrailingSaved(full), full.slice(0, -" · SAVED 3".length))
  assert.equal(pp.stripTrailingSaved("CAPTURING · unsent 0"), "CAPTURING · unsent 0", "no suffix, no change")
})

check("pending/unknown/failed/disabled receipts mint no badge and no version", () => {
  for (const receipt of [
    { status: "pending", reason: "channel busy" },
    { status: "unknown", name: "x.json", reason: "lost reply" },
    { status: "failed", reason: "disk" },
    { status: "disabled", reason: "no project root" },
    null,
  ]) {
    const s = makeRealSnapshot({ savedBadgeCount: 0, lastSavedReceipt: receipt, playlist: [] })
    const row = pp.backendPlaylistRow(s)
    assert.ok(!/\bSAVED\b/.test(row), receipt === null ? "null" : receipt.status + " → " + row)
    assert.ok(!/v\d/.test(row), "no version without an exact saved receipt: " + row)
    assert.equal(pp.savedVersionLabel(receipt), "")
  }
})

check("malformed saved receipts mint no version", () => {
  assert.equal(pp.savedVersionLabel({ status: "saved", name: "n", version: "7", bytes: 1 }), "", "string version refused")
  assert.equal(pp.savedVersionLabel({ status: "saved", name: "n", version: NaN, bytes: 1 }), "", "NaN refused")
  assert.equal(pp.savedVersionLabel({ status: "saved", name: "n", version: 7.5, bytes: 1 }), "", "non-integer version refused (client's isSafeInt proof)")
  assert.equal(pp.savedVersionLabel({ status: "saved", name: "n", bytes: 1 }), "", "missing version refused")
})

// ── 7 · prior receipt never claims the current take ──────────────────────────
check("a prior saved receipt leaves the live take unsaved with buffered work visible", () => {
  const base = makeRealSnapshot()
  const s = makeRealSnapshot({
    phase: "capturing",
    completedNotes: 3,
    heldNotes: 1,
    unsynced: { ...base.unsynced, bufferedHits: 2 },
    savedBadgeCount: 1,
    lastSavedReceipt: receiptSaved(5),
    playlist: [entrySaved("orbit_take.json")],
  })
  const rows = pp.backendRows(s)
  assert.ok(rows.statusRow.includes("CAPTURING"), rows.statusRow)
  assert.ok(!/\bSAVED\b/.test(rows.statusRow), "current-take row must not say SAVED: " + rows.statusRow)
  assert.ok(rows.statusRow.includes("buffered 2"), "buffered notes stay visible: " + rows.statusRow)
  assert.ok(rows.statusRow.includes("held 1"), "held notes stay visible: " + rows.statusRow)
  assert.ok(rows.playlistRow.includes("SAVED 1"), rows.playlistRow)
  assert.ok(rows.playlistRow.includes("v5 (earlier save)"), "prior receipt is marked earlier: " + rows.playlistRow)
  assert.ok(!/ALL SAVED/i.test(rows.statusRow + " " + rows.playlistRow))
})

check("an unsettled take without a badge still shows nothing saved about itself", () => {
  const base = makeRealSnapshot()
  const s = makeRealSnapshot({
    phase: "capturing",
    completedNotes: 4,
    unsynced: { ...base.unsynced, unsentEvents: 3 },
    savedBadgeCount: 0,
    lastSavedReceipt: null,
    playlist: [],
  })
  const rows = pp.backendRows(s)
  assert.ok(rows.playlistRow.includes("PLAYLIST 0"), rows.playlistRow)
  assert.ok(rows.playlistRow.includes("nothing saved yet"), rows.playlistRow)
  assert.ok(!/\bSAVED\b/.test(rows.statusRow + "\n" + rows.playlistRow))
})

check("saved_confirmed with buffered next-take hits marks the prior version (earlier save)", () => {
  // ACTUAL CLIENT STATE: the phase says saved_confirmed (exact receipt for the
  // just-committed take) while late hits sit preserved in the next-take
  // buffer — the prior receipt must NOT read as current.
  const base = makeRealSnapshot()
  const s = makeRealSnapshot({
    phase: "saved_confirmed",
    completedNotes: 3, // the just-committed notes
    unsynced: { ...base.unsynced, bufferedHits: 2 },
    savedBadgeCount: 1,
    lastSavedReceipt: receiptSaved(7),
    playlist: [entrySaved("orbit_take.json")],
  })
  assert.equal(pp.currentTakeUnsettled(s), true, "buffered live work must win over the phase short-circuit")
  const rows = pp.backendRows(s)
  assert.ok(rows.playlistRow.includes("SAVED 1"), rows.playlistRow)
  assert.ok(rows.playlistRow.includes("v7 (earlier save)"), "prior receipt must be marked earlier: " + rows.playlistRow)
  assert.ok(rows.statusRow.includes("buffered 2"), "buffered UNSAVED work stays visible: " + rows.statusRow)
  assert.ok(
    rows.statusRow.includes(labelForPhase("saved_confirmed")),
    "the receipt-backed phase label stays verbatim next to the pending work: " + rows.statusRow
  )
  assert.ok(!/ALL SAVED/i.test(rows.statusRow + "\n" + rows.playlistRow))
})

check("saved_confirmed stays unsettled under held/unsent/unknown/lost-reply work", () => {
  const base = makeRealSnapshot()
  const receipt = receiptSaved(7)
  const mk = (unsyncedOverrides, extra = {}) =>
    makeRealSnapshot({
      phase: "saved_confirmed",
      savedBadgeCount: 1,
      lastSavedReceipt: receipt,
      unsynced: { ...base.unsynced, ...unsyncedOverrides },
      ...extra,
    })
  assert.equal(pp.currentTakeUnsettled(mk({}, { heldNotes: 1 })), true, "held voices")
  assert.equal(pp.currentTakeUnsettled(mk({ unsentEvents: 4 })), true, "unsent events")
  assert.equal(pp.currentTakeUnsettled(mk({ notesUnknownDuration: 1 })), true, "unknown-duration notes")
  assert.equal(pp.currentTakeUnsettled(mk({ uncertainInFlight: true })), true, "lost reply")
  assert.ok(pp.backendPlaylistRow(mk({ bufferedHits: 1 })).includes("(earlier save)"))
})

check("clean saved_confirmed keeps the just-saved version normal and listings badge-free", () => {
  const s = makeRealSnapshot({
    phase: "saved_confirmed",
    completedNotes: 5, // the just-committed notes — legitimately saved
    savedBadgeCount: 1,
    lastSavedReceipt: receiptSaved(7),
    playlist: [entrySaved("orbit_take.json")],
  })
  assert.equal(pp.currentTakeUnsettled(s), false)
  const rows = pp.backendRows(s)
  assert.ok(rows.playlistRow.includes("SAVED 1"), rows.playlistRow)
  assert.ok(rows.playlistRow.includes("v7"), rows.playlistRow)
  assert.ok(!rows.playlistRow.includes("(earlier save)"), "just-saved notes are not earlier work: " + rows.playlistRow)
  // a backend readback listing arriving in the same state grows the playlist,
  // never the badge
  const s2 = makeRealSnapshot({
    phase: "saved_confirmed",
    completedNotes: 5,
    savedBadgeCount: 1,
    lastSavedReceipt: receiptSaved(7),
    playlist: [entrySaved("orbit_take.json"), entryReadback("backend_listed.json")],
  })
  const row2 = pp.backendPlaylistRow(s2)
  assert.ok(row2.includes("PLAYLIST 2"), row2)
  assert.ok(row2.includes("SAVED 1"), "listing must not mint a badge: " + row2)
  assert.ok(row2.includes("listed 1 (no badge)"), row2)
})

// ── 8 · readback listings never create badges ────────────────────────────────
check("backend readback growth stays listed without badges", () => {
  const s = makeRealSnapshot({
    phase: "saved_confirmed",
    savedBadgeCount: 1,
    lastSavedReceipt: receiptSaved(4),
    playlist: [entryReadback("a.json"), entryReadback("b.json"), entrySaved("orbit_take.json")],
  })
  const row = pp.backendPlaylistRow(s)
  assert.ok(row.includes("PLAYLIST 3"), row)
  assert.ok(row.includes("SAVED 1"), "badge count stays receipt-backed: " + row)
  assert.ok(row.includes("listed 2 (no badge)"), "listed entries are explicit: " + row)
  assert.equal(pp.listedNoBadgeCount(s), 2)
})

check("judge-mode local playlist row is listed, never saved", () => {
  const s = makeRealSnapshot({
    phase: "local_only",
    playlist: [{ name: "local take (judge mode — not saved anywhere)", bytes: 0, modifiedMs: 0, source: "local_only", savedBadge: false }],
  })
  const row = pp.backendPlaylistRow(s)
  assert.ok(row.includes("PLAYLIST 1"), row)
  assert.ok(row.includes("listed 1 (no badge)"), row)
  assert.ok(!/\bSAVED\b/.test(row), row)
})

// ── 9 · phase visibility + no false ALL SAVED ────────────────────────────────
check("every phase renders its shipped label verbatim", () => {
  for (const phase of ALL_PHASES) {
    const s = makeRealSnapshot({ phase })
    const row = pp.backendStatusRow(s)
    assert.ok(row.includes(labelForPhase(phase)), phase + " → " + row)
  }
})

check("no code path can produce ALL SAVED, even with heavy unsynced state", () => {
  const base = makeRealSnapshot()
  for (const phase of ALL_PHASES) {
    const s = makeRealSnapshot({
      phase,
      unsynced: { ...base.unsynced, unsentEvents: 5, uncapturedHits: 2, bufferedHits: 3 },
      heldNotes: 2,
    })
    const joined = pp.backendRows(s).statusRow + "\n" + pp.backendRows(s).playlistRow
    assert.ok(!/all saved/i.test(joined), "false ALL SAVED at phase " + phase)
    if (s.unsynced.unsentEvents > 0) {
      assert.ok(joined.includes("unsent 5"), "unsynced stays visible at " + phase + ": " + joined)
    }
  }
})

check("failure phases stay visible with their error wording", () => {
  for (const phase of ["offline", "commit_unknown", "commit_failed", "token_expired", "backend_down"]) {
    const s = makeRealSnapshot({ phase })
    assert.ok(pp.backendStatusRow(s).includes(labelForPhase(phase)), phase)
  }
})

// ── 10 · local vs backend separation ─────────────────────────────────────────
check("local hit counts never leak into backend rows", () => {
  const local = pp.takeLine(5, 99)
  assert.ok(local.includes("99 hits"), local)
  const s = makeRealSnapshot({ phase: "capturing" })
  const rows = pp.backendRows(s)
  assert.ok(!rows.statusRow.includes("99"), "local hits must not appear in the status row")
  assert.ok(!rows.playlistRow.includes("99"), "local hits must not appear in the playlist row")
})

check("backend counters never leak into the local take line", () => {
  const s = makeRealSnapshot({ phase: "capturing" })
  const line = pp.takeLine(12, 4)
  const joined = pp.backendRows(s).statusRow
  assert.ok(joined.includes("unsent"), "sanity: backend row carries the ledger")
  assert.ok(!line.includes("unsent"), "local line must stay backend-free")
  assert.ok(!/\bSAVED\b/.test(line), "local line must stay badge-free")
})

// ── 11 · source contracts (PlaylistPanel.ts wiring) ──────────────────────────
const panelSrc = fs.readFileSync(path.resolve(scriptsDir, "PlaylistPanel.ts"), "utf8")
const helperSrc = fs.readFileSync(path.resolve(scriptsDir, "PlaylistPanelPresentation.ts"), "utf8")

check("panel polls getStatusSnapshot 4 Hz with an optional typed @input", () => {
  assert.match(panelSrc, /@input/)
  assert.match(panelSrc, /captureController: SoundcraftCaptureController = null/)
  assert.match(panelSrc, /getStatusSnapshot\(\)/)
  assert.match(panelSrc, /0\.25/, "the 0.25 s throttle IS the 4 Hz poll")
  assert.match(panelSrc, /captureController !== null/)
})

check("panel never writes onSnapshot, statusText, or the session clock", () => {
  assert.doesNotMatch(panelSrc, /\.onSnapshot\s*=/, "no onSnapshot overwrite/chaining")
  assert.doesNotMatch(panelSrc, /\.statusText\s*=/, "controller.statusText belongs to the ConnectionUI")
  assert.doesNotMatch(panelSrc, /SoundcraftBus\.sessionTime\s*=[^=]/, "the panel reads the clock, never writes it")
})

check("panel copy is shortened per contract", () => {
  assert.match(panelSrc, /PANEL_TITLE/)
  assert.ok(!panelSrc.includes("mini DAW"), "title overflow removed")
  assert.ok(!panelSrc.includes("SIMULATED"), "the unconditional SIMULATED claim is gone")
  assert.ok(!panelSrc.includes("SESSION_CAP"), "90 s is now the helper's rolling VIEW window")
  assert.match(panelSrc, /CLEAR_NOTE/, "clear prints the honest local-only note")
  assert.match(panelSrc, /barViewStart/, "the bar uses the rolling view window")
})

check("presentation helper stays pure (no scene/runtime surface)", () => {
  assert.doesNotMatch(helperSrc, /@component|@input/, "no decorators — pure module")
  assert.doesNotMatch(helperSrc, /SceneObject|AudioComponent|RenderMeshVisual|getTransform|vec3|Material/, "no Lens runtime types")
  const valueImports = [...helperSrc.matchAll(/^import(?!\s+type)\s*\{([^}]*)\}\s*from\s*"([^"]*)"/gm)]
  assert.deepEqual(
    valueImports.map((m) => m[2]),
    ["./SoundcraftConnectionStatus"],
    "the only value import is the shipped pure status module"
  )
})

check("helper bakes the honesty wording contracts", () => {
  assert.ok(helperSrc.includes("ALL SAVED") === false || helperSrc.includes("can produce \"ALL SAVED\""), "comment-level only")
  assert.match(helperSrc, /BAR_VIEW_SECS = 90/)
  assert.match(helperSrc, /VIEW window only|VIEW ONLY/i, "documented as view-only")
})

// ── report ────────────────────────────────────────────────────────────────────
for (const name of PASS) {
  console.log("PASS · " + name)
}
console.log(PASS.length + " checks passed — playlist panel presentation receipt is truthful.")
