// soundcraft-capture-controller-workflow.test.mjs — REAL-LOGIC tests for the
// SoundcraftCaptureController runtime workflow API. Run with the repo's Node
// (≥22.18; type stripping of .ts is native on this runtime):
//
//   node Assets/Scripts/tests/soundcraft-capture-controller-workflow.test.mjs
//
// HOW THE SHIPPED CODE IS LOADED (documented mechanical transforms only):
//   1. decorator lines (@component/@input/…) are removed — the Lens runtime
//      provides them; Node cannot parse them;
//   2. the SIK-bound `./SoundcraftBus` import is re-pointed to a no-op stub —
//      SIK package specifiers do not resolve in Node, and the pure workflow
//      gates never touch the bus;
//   3. TypeScript is lowered with Node's own TS support (transform mode, so
//      type-only imports are elided): run with
//
//   node --experimental-transform-types Assets/Scripts/tests/soundcraft-capture-controller-workflow.test.mjs
//   Everything else — in particular the bodies of the exported gate functions
//   and the endpoint validator — is the EXACT shipped code (real logic, not a
//   regex re-implementation). Snapshot inputs are built from a REAL
//   SoundcraftCompanionClient instance (constructor is pure TS) so the gates
//   are fed the actual field shapes, not hand-fabricated ones.
//   The class itself is never instantiated (it extends the shimmed
//   BaseScriptComponent); no Lens runtime, no network, no local backend.

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
// Node's native TS support does NOT elide type-only imports, so EVERY module
// needed here goes through the same documented pipeline: strip decorator
// lines (controller only), re-point import specifiers to the transformed
// temp copies (bus → no-op stub; SIK specifiers never resolve in Node),
// then Node's stripTypeScriptTypes in transform mode (elides type-only
// imports). Function bodies are the EXACT shipped code.
const tmpDir = scriptsDir
const moduleMap = {
  "./SoundcraftCaptureController": ".wf-controller.mjs",
  "./SoundcraftCompanionClient": ".wf-client.mjs",
  "./SoundcraftCompanionHttp": ".wf-http.mjs",
  "./SoundcraftCompanionTypes": ".wf-types.mjs",
  "./SoundcraftBus": ".wf-bus-stub.mjs",
}

/**
 * Elide type-only named imports. After Node's strip pass, type annotations are
 * GONE — so an imported name that appears nowhere outside import statements and
 * comments was a type-only import and must be removed before ESM linking (the
 * runtime module exports no such binding). Occurrence counting runs on a
 * comment-masked copy and ignores import statements wholesale. Value bindings
 * always survive (they are referenced by real code — a wrongly elided binding
 * would fail LOUD as a ReferenceError, never silently).
 */
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
let mod = null
let clientMod = null
try {
  globalThis.BaseScriptComponent = class BaseScriptComponent {}
  fs.writeFileSync(path.join(tmpDir, ".wf-bus-stub.mjs"), "// test-only no-op stub for the SIK-bound bus (pure gates never touch it)\nexport class SoundcraftBus { static onHit = { add() {}, remove() {} }; static instruments = [] }\n")
  for (const [specifier, tmpName] of Object.entries(moduleMap)) {
    if (tmpName === ".wf-bus-stub.mjs") continue
    let src = fs.readFileSync(path.join(tmpDir, specifier.replace("./", "") + ".ts"), "utf8")
    if (specifier === "./SoundcraftCaptureController") {
      src = src
        .split("\n")
        .filter((line) => !/^\s*@/.test(line)) // 1 · decorator lines out
        .join("\n")
    }
    for (const [sp, tn] of Object.entries(moduleMap)) {
      src = src.split('from "' + sp + '"').join('from "./' + tn + '"')
    }
    fs.writeFileSync(path.join(tmpDir, tmpName), elideTypeOnlyImports(stripTypeScriptTypes(src, { mode: "strip" })))
  }
  mod = await import(pathToFileURL(path.join(tmpDir, ".wf-controller.mjs")).href)
  clientMod = await import(pathToFileURL(path.join(tmpDir, ".wf-client.mjs")).href)
} finally {
  for (const f of tmpFiles) {
    const p = path.join(tmpDir, f)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

// ---- REAL client shapes (transformed copy of the shipped client class) ------
const { SoundcraftCompanionClient, DEFAULT_CONFIG } = clientMod

function makeRealSnapshot(overrides = {}) {
  // A REAL client instance produces a REAL StatusDetail — the gates are fed
  // actual field shapes. Overrides only set documented tracked fields.
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

// ── 1 · endpoint validation (real shipped validator) ─────────────────────────
check("https endpoint with host and path is accepted and normalized", () => {
  const r = mod.validateHttpEndpointStrict("https://machine.tailnet.ts.net:8443/companion/")
  assert.equal(r.ok, true, r.problem)
  assert.equal(r.normalized, "https://machine.tailnet.ts.net:8443/companion/")
})

check("bare https host and uppercase scheme are accepted", () => {
  const a = mod.validateHttpEndpointStrict("HTTPS://Machine.Example.com")
  assert.equal(a.ok, true, a.problem)
  assert.equal(a.normalized, "https://Machine.Example.com")
})

check("http:// is refused (https only)", () => {
  const r = mod.validateHttpEndpointStrict("http://machine.example.com")
  assert.equal(r.ok, false)
  assert.match(r.problem, /https/)
})

check("user:password@ userinfo is refused", () => {
  const r = mod.validateHttpEndpointStrict("https://user:pass@machine.example.com")
  assert.equal(r.ok, false)
  assert.match(r.problem, /credentials never ride in URLs/)
})

check("query strings and fragments are refused", () => {
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com/?x=1").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com/#frag").ok, false)
})

check("whitespace/control characters and empty/oversized input are refused", () => {
  assert.equal(mod.validateHttpEndpointStrict("").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("  ").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com /x").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com\n/evil").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://" + "a".repeat(400)).ok, false)
  assert.equal(mod.validateHttpEndpointStrict("not a url").ok, false)
})

check("bad ports and single-label hosts are refused; dotted/IP-style hosts pass", () => {
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com:0").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com:99999").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://h.example.com:abc").ok, false)
  const single = mod.validateHttpEndpointStrict("https://localhost/x")
  assert.equal(single.ok, false, "even localhost is refused — the companion must be a routable dotted name")
  assert.match(single.problem, /no dot/)
  assert.equal(mod.validateHttpEndpointStrict("https://singlelabel").ok, false)
  assert.equal(mod.validateHttpEndpointStrict("https://100.64.1.9/x").ok, true)
})

// ── 2 · note sanitizer ───────────────────────────────────────────────────────
check("workflow notes strip URLs and withhold credential-shaped content", () => {
  assert.equal(mod.sanitizeWorkflowNote("failed for https://secret.tailnet.ts.net/x"), "failed for <endpoint>")
  assert.match(mod.sanitizeWorkflowNote("bearer eyJabc"), /withheld/)
  assert.match(mod.sanitizeWorkflowNote("synthetic JWT prefix: eyJnot-a-real-token"), /withheld/)
  assert.match(mod.sanitizeWorkflowNote("access_token leaked"), /withheld/)
  assert.equal(mod.sanitizeWorkflowNote("clean note"), "clean note")
  const long = mod.sanitizeWorkflowNote("x".repeat(500))
  assert.ok(long.length <= 220, "note must be length-capped")
})

// ── 3 · explicit open-last-save gate (the real decision logic) ───────────────
check("null snapshot / judge mode / unconfigured placeholder refuse up front", () => {
  assert.equal(mod.gateExplicitOpenLastSaved(null, false).allowed, false)
  const s = makeRealSnapshot()
  const j = mod.gateExplicitOpenLastSaved(s, true)
  assert.equal(j.allowed, false)
  assert.equal(j.code, "judge_mode")
  const p = makeRealSnapshot({ localOnly: true })
  const pr = mod.gateExplicitOpenLastSaved(p, false)
  assert.equal(pr.allowed, false)
  assert.equal(pr.code, "not_configured")
})

check("ANY preserved work refuses without state change (no discard)", () => {
  const cases = [
    { phase: "commit_pending" },
    { phase: "commit_unknown" },
    { unsynced: { unsentEvents: 2 } },
    { heldNotes: 1 },
    { unsynced: { notesUnknownDuration: 1 } },
    { unsynced: { bufferedHits: 1 } },
    { unsynced: { uncertainInFlight: true } },
  ]
  for (const ov of cases) {
    const d = mod.gateExplicitOpenLastSaved(makeRealSnapshot(ov), false)
    assert.equal(d.allowed, false, "must refuse on " + JSON.stringify(ov))
    assert.equal(d.code, "data_present", "refusal must be data_present for " + JSON.stringify(ov))
    assert.equal(d.needCloseFirst, false)
  }
})

check("unsettled save receipts refuse; a prior SAVED badge is NOT treated as current empty", () => {
  const pending = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ lastSavedReceipt: { status: "pending", reason: "x" } }), false)
  const unknown = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ lastSavedReceipt: { status: "unknown", reason: "x" } }), false)
  assert.equal(pending.allowed, false)
  assert.equal(unknown.allowed, false)
  const saved = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ lastSavedReceipt: { status: "saved", name: "take.mid", version: 1, bytes: 3 } }), false)
  const failed = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ lastSavedReceipt: { status: "failed", reason: "disk full" } }), false)
  assert.equal(saved.allowed, true, "a settled SAVED receipt must not block")
  assert.equal(failed.allowed, true, "a settled FAILED receipt must not block (settled = proven)")
})

check("clean idle state is allowed; a safe open session asks for an awaited close", () => {
  const idle = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ phase: "paired", capturingStillOpen: false }), false)
  assert.equal(idle.allowed, true)
  assert.equal(idle.needCloseFirst, false)
  const open = mod.gateExplicitOpenLastSaved(makeRealSnapshot({ phase: "paired", capturingStillOpen: true }), false)
  assert.equal(open.allowed, true)
  assert.equal(open.needCloseFirst, true, "empty open session must be closed first via awaited stopCapture")
})

check("completed/acked notes of an OPEN session are arbitrated, never snapshot-guessed", () => {
  // A COMMITTED take closes cleanly (stopCapture true); an UNCOMMITTED one
  // refuses inside the client (false). The gate must therefore allow the
  // close attempt and let the awaited boolean decide — pre-refusing on
  // completed/acked would make the committed path unusable.
  const d = mod.gateExplicitOpenLastSaved(
    makeRealSnapshot({ phase: "capturing", capturingStillOpen: true, completedNotes: 3, unsynced: { ackedEvents: 3 } }),
    false
  )
  assert.equal(d.allowed, true)
  assert.equal(d.needCloseFirst, true)
})

// ── 4 · configure-endpoint gate (the real decision logic) ────────────────────
const ENDPOINT = "https://machine.tailnet.ts.net:8443/companion/"
const ENDPOINT2 = "https://other.example.com:9000/"

check("judge mode / missing module / invalid endpoint refuse outright", () => {
  const s = makeRealSnapshot({ phase: "paired" })
  assert.equal(mod.gateConfigureEndpoint(ENDPOINT, "", false, s, true, true).allowed, false)
  assert.equal(mod.gateConfigureEndpoint(ENDPOINT, "", false, s, false, false).code, "no_internet_module")
  assert.equal(mod.gateConfigureEndpoint("http://x.example.com", "", false, s, false, true).code, "invalid_endpoint")
  assert.equal(mod.gateConfigureEndpoint(ENDPOINT, "", false, null, false, true).code, "no_status")
})

check("same endpoint + real client pairs in place (token and buffers preserved)", () => {
  const d = mod.gateConfigureEndpoint(ENDPOINT, ENDPOINT, true, makeRealSnapshot({ phase: "paired" }), false, true)
  assert.equal(d.allowed, true)
  assert.equal(d.action, "pair_existing")
})

check("first real endpoint after the unconfigured placeholder rebuilds (dead-end rescue)", () => {
  const d = mod.gateConfigureEndpoint(ENDPOINT, "", false, makeRealSnapshot({ localOnly: true, phase: "config_error" }), false, true)
  assert.equal(d.allowed, true)
  assert.equal(d.action, "rebuild_client")
  assert.equal(d.code, "initial_endpoint")
})

check("endpoint REPLACEMENT over any preserved work or an open session refuses", () => {
  const base = { phase: "paired" }
  const cases = [
    { unsynced: { unsentEvents: 1 } },
    { heldNotes: 2 },
    { unsynced: { bufferedHits: 1 } },
    { unsynced: { notesUnknownDuration: 1 } },
    { unsynced: { uncertainInFlight: true } },
    { phase: "commit_unknown" },
    { lastSavedReceipt: { status: "unknown", reason: "x" } },
  ]
  for (const ov of cases) {
    const d = mod.gateConfigureEndpoint(ENDPOINT2, ENDPOINT, true, makeRealSnapshot({ ...base, ...ov }), false, true)
    assert.equal(d.allowed, false, "must refuse replacement on " + JSON.stringify(ov))
    assert.equal(d.code, "data_present", JSON.stringify(ov))
  }
  const open = mod.gateConfigureEndpoint(ENDPOINT2, ENDPOINT, true, makeRealSnapshot({ phase: "capturing", capturingStillOpen: true }), false, true)
  assert.equal(open.allowed, false)
  assert.equal(open.code, "session_open")
})

check("clean endpoint replacement is allowed and names the rebuild", () => {
  const d = mod.gateConfigureEndpoint(ENDPOINT2, ENDPOINT, true, makeRealSnapshot({ phase: "paired", capturingStillOpen: false }), false, true)
  assert.equal(d.allowed, true)
  assert.equal(d.action, "rebuild_client")
  assert.equal(d.normalized, ENDPOINT2)
})

// ── 5 · real-snapshot integration: the gates accept actual client shapes ────
check("a REAL client snapshot flows through both gates unchanged (shape compatibility)", () => {
  const realOffline = makeRealSnapshot() // phase "offline", localOnly false — real shape
  const a = mod.gateExplicitOpenLastSaved(realOffline, false)
  assert.equal(a.allowed, true, "a clean offline-online client may reopen")
  const b = mod.gateConfigureEndpoint(ENDPOINT, "", false, realOffline, false, true)
  assert.equal(b.allowed, true)
  assert.equal(b.action, "rebuild_client")
  const judgeClient = new SoundcraftCompanionClient(
    {
      transport: { request: () => Promise.resolve({ outcome: "local_only", status: 0, bodyText: "", retryAfterSeconds: 0, problem: "x" }) },
      nowSecs: () => 0,
      realtimeNanos: () => 0,
      timer: { arm: () => ({ cancel: () => {} }) },
      log: () => {},
    },
    { ...DEFAULT_CONFIG, onlineMode: false }
  )
  const c = mod.gateExplicitOpenLastSaved(judgeClient.snapshot(), false)
  assert.equal(c.allowed, false)
  assert.equal(c.code, "not_configured", "a local-mode client snapshot must hit the not_configured refusal")
})

// ── 6 · structural: the public methods actually route through the pure gates ─
check("the controller methods call the exported gates (shipped path, not a copy)", () => {
  const src = fs.readFileSync(path.resolve(scriptsDir, "SoundcraftCaptureController.ts"), "utf8")
  assert.ok(/explicitOpenLastSavedProject\(\)[\s\S]{0,600}?gateExplicitOpenLastSaved\(/.test(src), "explicitOpenLastSavedProject must call the real gate")
  assert.ok(/configureEndpointAndPair\(endpoint: string, code: string\)[\s\S]{0,900}?gateConfigureEndpoint\(/.test(src), "configureEndpointAndPair must call the real gate")
  assert.match(src, /public getStatusSnapshot\(\): StatusDetail \| null \{[\s\S]{0,200}?this\.client\.snapshot\(\)/, "getStatusSnapshot must return the scrubbed client snapshot")
  assert.ok(!/startCapture\(this\.captureTrack\)[\s\S]{0,200}explicitOpenLastSave\(\)/.test(src), "capture start must FOLLOW the recover, never precede it")
})

// ── 7 · REGRESSION P2: placeholder ≠ judge in the rendered status line ───────
// renderStatus runs on the ACTUAL stripped class (the controller instance is
// never attached to a scene, so onAwake never fires — no Lens runtime needed).
const controllerClass = mod.SoundcraftCaptureController

function renderWith(flags, snapshot) {
  const c = new controllerClass()
  c.statusText = { text: "" }
  c.judgeLocalOnlyMode = flags.judge
  c.renderStatus(snapshot)
  return c.statusText.text
}

check("REGRESSION P2: unconfigured placeholder renders SETUP REQUIRED and never relays judge-worded detail", () => {
  const s = makeRealSnapshot({ localOnly: true, phase: "local_only", detail: "judge mode — pairing is not used; nothing is claimed about a backend" })
  const line = renderWith({ judge: false }, s)
  assert.ok(line.includes("SETUP REQUIRED — enter HTTPS endpoint + one-time code; local playing not captured/saved"), line)
  assert.ok(!line.includes("judge mode — pairing is not used"), "judge-only client detail must not surface as a real mode claim: " + line)
  assert.ok(!line.includes("LOCAL-ONLY (judge"), line)
  assert.ok(line.includes("PHASE LOCAL_ONLY"), line)
})

check("REGRESSION P2: REAL judge mode keeps the judge descriptor and relays the judge-accurate detail", () => {
  const s = makeRealSnapshot({ localOnly: true, phase: "local_only", detail: "JUDGE MODE local take running — capture is local-only, never backend-labelled" })
  const line = renderWith({ judge: true }, s)
  assert.ok(line.includes("LOCAL-ONLY (judge mode — not backend)"), line)
  assert.ok(line.includes("JUDGE MODE local take running"), "judge-accurate detail stays relayed: " + line)
  assert.ok(!line.includes("SETUP REQUIRED"), line)
})

// ── result ────────────────────────────────────────────────────────────────────
console.log("PASS " + PASS.length + "/" + PASS.length + " checks:")
for (const name of PASS) {
  console.log("  ✓ " + name)
}
