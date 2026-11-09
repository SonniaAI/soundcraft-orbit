// SoundcraftKeyboardModel.ts — PURE keyboard entry model for the PREVIEW-ONLY
// on-screen keyboard (SoundcraftPreviewKeyboard). No imports, no Lens types,
// no network: every buffer transformation is a pure string→string function so
// the shipped logic is directly Node-testable
// (tests/soundcraft-keyboard-model.test.mjs) and the UIKit layer stays dumb.
//
// WHY: the AR keyboard does not appear in Lens Studio Preview with the SPECS
// 27 simulation, and injected/gesture "typing" would otherwise fall through to
// the mini-DAW test shortcuts (DawManager.onKey). The on-screen pad routes
// every keystroke through THIS model instead; buffers live in UI memory only
// (never logged, never persisted, cleared when consumed).
//
// ENDPOINT: lowercase/uppercase letters, digits, '.', '-', '/', '_' plus the
// "https://" auto-prefix button (applies on an EMPTY buffer only — the scheme
// is never injected mid-URL). Arbitrary valid HTTP/S port/path stay possible
// (full alphabet + the punctuation keys; no endpoint is ever guessed).
//
// PAIR CODE: the server's one-time code alphabet
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I/O/0/1 confusables — mirrors the
// sibling security.py which .strip().uppercase()s the code), 8 chars shown
// 4-4 with an auto hyphen. The RAW buffer stores only alphabet chars
// (uppercase, filtered); the hyphen is DISPLAY formatting, never stored.

export const SERVER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const SERVER_CODE_ALNUM_LENGTH = 8 // 4 + display hyphen + 4
export const ENDPOINT_MAX_LEN = 200
export const ENDPOINT_PREFIX = "https://"

/** Characters allowed into the one-time code buffer (uppercase alphabet). */
export function isServerCodeChar(ch: string): boolean {
  return typeof ch === "string" && ch.length === 1 && SERVER_CODE_ALPHABET.indexOf(ch) !== -1
}

/** The code buffer rendered for the field: uppercase alphabet only, capped at
 * 8 chars, displayed 4-4 with a hyphen once more than 4 chars are present. */
export function formatCodeBuffer(raw: string): string {
  const clean = sanitizeCodeRaw(raw)
  if (clean.length <= 4) {
    return clean
  }
  return clean.slice(0, 4) + "-" + clean.slice(4)
}

/** Normalize/keep only what the server alphabet accepts, uppercased, capped. */
export function sanitizeCodeRaw(raw: string): string {
  let out = ""
  const s = typeof raw === "string" ? raw.toUpperCase() : ""
  for (let i = 0; i < s.length && out.length < SERVER_CODE_ALNUM_LENGTH; i++) {
    if (isServerCodeChar(s.charAt(i))) {
      out += s.charAt(i)
    }
  }
  return out
}

export type KeyAction =
  | { kind: "char"; ch: string }
  | { kind: "backspace" }
  | { kind: "clear" }
  | { kind: "prefixUrl" }

/** Apply one key action to the ENDPOINT buffer. Pure: returns a new string. */
export function applyEndpointAction(buffer: string, action: KeyAction): string {
  const b = typeof buffer === "string" ? buffer : ""
  if (action.kind === "backspace") {
    return b.length > 0 ? b.slice(0, b.length - 1) : b
  }
  if (action.kind === "clear") {
    return ""
  }
  if (action.kind === "prefixUrl") {
    // EMPTY-ONLY (contract): the scheme button is a helpful default for an
    // EMPTY buffer. It NEVER injects into an existing entry — the operator
    // may already have typed a host, or a scheme in any casing; injecting
    // would double it. Non-empty → unchanged, whatever the casing.
    if (b.length === 0) {
      return ENDPOINT_PREFIX
    }
    return b
  }
  if (b.length >= ENDPOINT_MAX_LEN) {
    return b
  }
  const ch = action.ch
  if (typeof ch !== "string" || ch.length !== 1) {
    return b
  }
  return b + ch
}

/** Apply one key action to the CODE raw buffer. Pure: returns a new string.
 * Characters outside the server alphabet are dropped (the alphabet has no
 * I/O/0/1 — typed confusables never silently enter the code). */
export function applyCodeAction(buffer: string, action: KeyAction): string {
  const b = sanitizeCodeRaw(buffer)
  if (action.kind === "backspace") {
    return b.length > 0 ? b.slice(0, b.length - 1) : b
  }
  if (action.kind === "clear") {
    return ""
  }
  if (action.kind === "prefixUrl") {
    return b // no URL prefix on a pairing code
  }
  const ch = typeof action.ch === "string" ? action.ch.toUpperCase() : ""
  if (ch.length !== 1 || !isServerCodeChar(ch)) {
    return b
  }
  if (b.length >= SERVER_CODE_ALNUM_LENGTH) {
    return b
  }
  return b + ch
}

/** Endpoint pad character rows (lowercase base; the UI applies Caps).
 * 10-column rows so every key stays ≥2.5 cm wide inside the 27.2 cm content. */
export const ENDPOINT_CHAR_ROWS: string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "-"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "_", "/"],
]

/** Code pad character rows: the server alphabet as 4 rows of 8 (≥3 cm keys). */
export const CODE_CHAR_ROWS: string[][] = [
  ["A", "B", "C", "D", "E", "F", "G", "H"],
  ["J", "K", "L", "M", "N", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X", "Y", "Z"],
  ["2", "3", "4", "5", "6", "7", "8", "9"],
]

/** Endpoint pad CONTROL-row keys (rendered after the character rows). The ':'
 * entry is the custom host:port path — the Keys enum has no punctuation
 * members, so the on-screen key is the only way to type it. */
export const ENDPOINT_CONTROL_KEYS: string[] = ["Aa", "https://", ":", "⌫", "CLR", "DONE"]
