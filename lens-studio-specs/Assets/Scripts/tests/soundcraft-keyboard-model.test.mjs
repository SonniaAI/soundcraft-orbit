// soundcraft-keyboard-model.test.mjs — REAL-LOGIC tests for the pure
// PREVIEW-only on-screen keyboard entry model (SoundcraftKeyboardModel.ts),
// used by the guarded endpoint / one-time-code fields in
// SoundcraftConnectionUI. Run with the repo's Node (≥22.18; native TS strip):
//
//   node Assets/Scripts/tests/soundcraft-keyboard-model.test.mjs
//
// HOW THE SHIPPED CODE IS LOADED: the model is dependency-free (no imports,
// no decorators, no Lens types), so the only transform is Node's native
// stripTypeScriptTypes — the tested functions are the EXACT shipped code.
//
// WHAT IS COVERED: the https:// prefix rule (empty buffer only, never
// doubled), char append + 200-char endpoint cap, backspace/clear on both
// buffers, the server code alphabet filter (no I/O/0/1, lowercase accepted,
// confusables dropped), the 8-char raw cap, and the 4-4 hyphen DISPLAY
// format. Also a contract scan: the keyboard UI source must never touch
// fetch/Network/scene — entry is UI-memory only. No network, no backend, no
// mock SAVED.

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
const srcPath = path.resolve(here, "..", "SoundcraftKeyboardModel.ts")
const src = fs.readFileSync(srcPath, "utf8")
const js = stripTypeScriptTypes(src, { mode: "strip" })
const tmpPath = path.resolve(here, ".keyboard-model.mjs")
fs.writeFileSync(tmpPath, js)
const mod = await import(pathToFileURL(tmpPath).href)
const {
  SERVER_CODE_ALPHABET,
  SERVER_CODE_ALNUM_LENGTH,
  ENDPOINT_MAX_LEN,
  ENDPOINT_PREFIX,
  isServerCodeChar,
  formatCodeBuffer,
  sanitizeCodeRaw,
  applyEndpointAction,
  applyCodeAction,
  ENDPOINT_CHAR_ROWS,
  ENDPOINT_CONTROL_KEYS,
  CODE_CHAR_ROWS,
} = mod

// ---- constants ---------------------------------------------------------------
check("server alphabet is the 32-char no-confusable set", () => {
  assert.equal(SERVER_CODE_ALPHABET, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
  assert.equal(SERVER_CODE_ALPHABET.length, 32)
  for (const banned of ["I", "O", "0", "1"]) {
    assert.equal(SERVER_CODE_ALPHABET.indexOf(banned), -1, banned + " must not be in the alphabet")
  }
})
check("code length is 8 (4-4)", () => {
  assert.equal(SERVER_CODE_ALNUM_LENGTH, 8)
})
check("endpoint prefix is https:// and endpoint cap is 200", () => {
  assert.equal(ENDPOINT_PREFIX, "https://")
  assert.equal(ENDPOINT_MAX_LEN, 200)
})

// ---- server code char filter ---------------------------------------------------
check("alphabet chars accepted (case-insensitive)", () => {
  assert.equal(isServerCodeChar("A"), true)
  assert.equal(isServerCodeChar("9"), true)
})
check("confusables and punctuation rejected", () => {
  assert.equal(isServerCodeChar("I"), false)
  assert.equal(isServerCodeChar("O"), false)
  assert.equal(isServerCodeChar("0"), false)
  assert.equal(isServerCodeChar("1"), false)
  assert.equal(isServerCodeChar("-"), false)
})

// ---- endpoint prefix rule (EMPTY-ONLY contract) ----------------------------------
check("https:// prefix applies on an EMPTY buffer ONLY", () => {
  assert.equal(applyEndpointAction("", { kind: "prefixUrl" }), "https://")
})
check("NON-EMPTY buffers are UNCHANGED by the scheme button (no injection, any casing)", () => {
  assert.equal(applyEndpointAction("example", { kind: "prefixUrl" }), "example")
  assert.equal(applyEndpointAction("HTTPS://x", { kind: "prefixUrl" }), "HTTPS://x")
  assert.equal(applyEndpointAction("https://host", { kind: "prefixUrl" }), "https://host")
  assert.equal(applyEndpointAction("host", { kind: "prefixUrl" }), "host")
})

// ---- endpoint char / cap / backspace / clear ---------------------------------------
check("endpoint chars append (digits, letters, punctuation)", () => {
  let b = "https://"
  for (const ch of "host-1.name_") {
    b = applyEndpointAction(b, { kind: "char", ch })
  }
  assert.equal(b, "https://host-1.name_")
})
check("endpoint buffer caps at 200 chars", () => {
  let b = ""
  for (let i = 0; i < 250; i++) b = applyEndpointAction(b, { kind: "char", ch: "a" })
  assert.equal(b.length, ENDPOINT_MAX_LEN)
})
check("endpoint backspace removes the last char and stops at empty", () => {
  assert.equal(applyEndpointAction("https://x", { kind: "backspace" }), "https://")
  assert.equal(applyEndpointAction("h", { kind: "backspace" }), "")
  assert.equal(applyEndpointAction("", { kind: "backspace" }), "")
})
check("endpoint clear empties the buffer", () => {
  assert.equal(applyEndpointAction("https://anything", { kind: "clear" }), "")
})

// ---- code raw buffer filter + cap -----------------------------------------------------
check("code chars are uppercased into the raw buffer", () => {
  assert.equal(sanitizeCodeRaw("a7k2"), "A7K2")
})
check("confusables are DROPPED, not stored", () => {
  assert.equal(sanitizeCodeRaw("IO01"), "")
  assert.equal(sanitizeCodeRaw("AI0O1"), "A")
  assert.equal(sanitizeCodeRaw("A7I2"), "A72")
})
check("raw buffer caps at 8 alphabet chars", () => {
  assert.equal(sanitizeCodeRaw("ABCDEFGHIJKLMNOP"), "ABCDEFGH")
})
check("code char action drops non-alphabet keys (hyphen typed by hand)", () => {
  assert.equal(applyCodeAction("A7K2", { kind: "char", ch: "-" }), "A7K2")
  assert.equal(applyCodeAction("A7K2", { kind: "char", ch: "I" }), "A7K2")
})
check("code char action caps at 8 raw chars", () => {
  let b = ""
  for (const ch of "ABCDEFGHJKLMNP") b = applyCodeAction(b, { kind: "char", ch })
  assert.equal(b, "ABCDEFGH")
})

// ---- 4-4 display hyphen -----------------------------------------------------------------
check("short code buffers show without hyphen", () => {
  assert.equal(formatCodeBuffer("A"), "A")
  assert.equal(formatCodeBuffer("A7K2"), "A7K2")
})
check("8-char buffer shows 4-4", () => {
  assert.equal(formatCodeBuffer("A7K29MX"), "A7K2-9MX")
  assert.equal(formatCodeBuffer("A7K29MXP"), "A7K2-9MXP")
})
check("5-char buffer splits 4-1", () => {
  assert.equal(formatCodeBuffer("A7K2M"), "A7K2-M")
})

// ---- code backspace / clear ----------------------------------------------------------------
check("code backspace removes the last RAW char and stops at empty", () => {
  assert.equal(applyCodeAction("A7K2", { kind: "backspace" }), "A7K")
  assert.equal(applyCodeAction("", { kind: "backspace" }), "")
})
check("code clear empties the raw buffer", () => {
  assert.equal(applyCodeAction("A7K29MXP", { kind: "clear" }), "")
})
check("backspace works on an already-formatted string (hyphen is not stored)", () => {
  assert.equal(applyCodeAction("A7K2-9M", { kind: "backspace" }), "A7K29")
})

// ---- pad layouts ------------------------------------------------------------------------------
check("endpoint pad rows cover digits + 26 letters + ./-/_/ and fit 10 columns", () => {
  const all = ENDPOINT_CHAR_ROWS.flat()
  assert.equal(ENDPOINT_CHAR_ROWS.length, 4)
  for (const row of ENDPOINT_CHAR_ROWS) assert.equal(row.length, 10)
  for (const need of "qwertyuiopasdfghjklzxcvbnm".split("")) {
    assert.ok(all.indexOf(need) !== -1, "missing letter " + need)
  }
  for (const need of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "-", "_", "/"]) {
    assert.ok(all.indexOf(need) !== -1, "missing endpoint key " + need)
  }
})
check("code pad rows are the full server alphabet as 4 rows of 8", () => {
  assert.equal(CODE_CHAR_ROWS.length, 4)
  const all = CODE_CHAR_ROWS.flat()
  assert.equal(all.length, 32)
  assert.equal(all.join(""), SERVER_CODE_ALPHABET)
})
check("':' has a DEDICATED on-screen CONTROL key (custom host:port entry exists)", () => {
  assert.ok(ENDPOINT_CONTROL_KEYS.indexOf(":") !== -1, "':' must be an on-screen control key")
  assert.ok(ENDPOINT_CONTROL_KEYS.indexOf("https://") !== -1, "scheme button must be present")
  assert.ok(ENDPOINT_CONTROL_KEYS.indexOf("CLR") !== -1 && ENDPOINT_CONTROL_KEYS.indexOf("DONE") !== -1)
})
check("punctuation keys '. - _ /' stay on the character rows", () => {
  const all = ENDPOINT_CHAR_ROWS.flat()
  for (const need of [".", "-", "_", "/"]) {
    assert.ok(all.indexOf(need) !== -1, "missing endpoint key " + need)
  }
})

// ---- purity + memory-only contract ------------------------------------------------------------
check("actions are pure: applying never mutates the caller's buffer string", () => {
  const before = "https://"
  const after = applyEndpointAction(before, { kind: "char", ch: "x" })
  assert.equal(before, "https://")
  assert.equal(after, "https://x")
})
check("CONTRACT: keyboard model/UI sources contain no network or persistence APIs", () => {
  const uiPath = path.resolve(here, "..", "SoundcraftPreviewKeyboard.ts")
  const uiSrc = fs.existsSync(uiPath) ? fs.readFileSync(uiPath, "utf8") : ""
  for (const [name, text] of [["model", src], ["ui", uiSrc]]) {
    if (text.length === 0) continue
    assert.ok(!/fetch|InternetModule|NetworkModule|require\(|global\.textInputSystem/i.test(text), name + " must not touch network/keyboard-system APIs")
    assert.ok(!/console\.log|print\(/i.test(text), name + " must not log typed characters")
  }
})
// SOURCE CONTRACT ONLY — the live next-frame behavior is validated by the
// parent's native QA; nothing here claims the dismiss was observed live.
check("CONTRACT: connection UI schedules an EDITOR-ONLY NEXT-frame native editMode(false)", () => {
  const uiPath = path.resolve(here, "..", "SoundcraftConnectionUI.ts")
  const ui = fs.readFileSync(uiPath, "utf8")
  assert.ok(ui.indexOf("DelayedCallbackEvent") !== -1, "the dismiss must be scheduled via a reusable DelayedCallbackEvent (next frame), never synchronously")
  assert.ok(ui.indexOf("editMode(false)") !== -1, "the deferred editMode(false) dismiss call must exist")
  assert.ok(/scheduleNativeExit\([\s\S]{0,400}isEditorPreview/.test(ui), "scheduling must be editor-gated")
  assert.ok(/deferredNativeExit\(\) \{[\s\S]{0,200}isEditorPreview/.test(ui), "the deferred dismiss must be editor-gated")
  assert.ok(!/onEditMode[^]*?{[^]*?editMode\(false\)/.test(ui.split("scheduleNativeExit")[0]), "editMode(false) must NOT run synchronously inside an onEditMode handler")
})
check("CONTRACT: lifetime cleanup clears the text-entry flag on destroy (P3 stuck-flag)", () => {
  const uiPath = path.resolve(here, "..", "SoundcraftConnectionUI.ts")
  const ui = fs.readFileSync(uiPath, "utf8")
  assert.ok(/onWillDestroy\(\)[\s\S]{0,400}textEntryActive = false/.test(ui), "onWillDestroy must clear SoundcraftBus.textEntryActive")
  assert.ok(/onWillDestroy\(\)[\s\S]{0,400}kbExitPendingField = null/.test(ui), "onWillDestroy must consume any pending native-exit")
})
check("CONTRACT: pad keys request Direct|Indirect targeting (Poke excluded)", () => {
  const kbPath = path.resolve(here, "..", "SoundcraftPreviewKeyboard.ts")
  const kb = fs.readFileSync(kbPath, "utf8")
  assert.ok(kb.indexOf("TargetingMode.Direct | TargetingMode.Indirect") !== -1, "the pad targeting mask must be Direct|Indirect")
  assert.ok(kb.indexOf("TargetingMode.Poke") === -1 && kb.indexOf("TargetingMode.All") === -1, "the pad must never set Poke/All targeting")
  assert.ok(/applyPendingTargetingModes[\s\S]{0,600}targetingMode = /.test(kb), "the mask must be applied to the pad keys' Interactable")
})
check("CONTRACT: the targeting mask exists ONLY in the preview keyboard source", () => {
  const others = [
    path.resolve(here, "..", "SoundcraftConnectionUI.ts"),
    path.resolve(here, "..", "SoundcraftKeyboardModel.ts"),
    path.resolve(here, "..", "SoundcraftBus.ts"),
    path.resolve(here, "..", "DawManager.ts"),
  ]
  for (const p of others) {
    if (!fs.existsSync(p)) continue
    const text = fs.readFileSync(p, "utf8")
    assert.ok(text.indexOf("targetingMode") === -1 && text.indexOf("TargetingMode") === -1, path.basename(p) + " must not set targeting modes (pad/instrument/Pair/Open untouched)")
  }
})

fs.rmSync(tmpPath, { force: true })
console.log("soundcraft-keyboard-model: " + PASS.length + " checks passed")
for (const name of PASS) {
  console.log("  ✓ " + name)
}
