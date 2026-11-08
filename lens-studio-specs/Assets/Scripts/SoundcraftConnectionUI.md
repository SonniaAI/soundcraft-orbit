# SoundcraftConnectionUI — pairing/status panel (delivery notes)

**Files owned by this work stream (new, no owned file touched):**

| File | Role |
|---|---|
| `Assets/Scripts/SoundcraftConnectionUI.ts` | UIKit pairing/status panel (`@component`) |
| `Assets/Scripts/SoundcraftConnectionStatus.ts` | PURE phase→label/severity/summary mapping (no Lens APIs) |
| `Assets/Scripts/tests/soundcraft-connection-status.test.mjs` | Unit checks for the pure module (`node Assets/Scripts/tests/soundcraft-connection-status.test.mjs` — 49/49 pass on Node ≥22.18 via native type stripping; no build chain) |
| `Assets/Scripts/SoundcraftConnectionUI.md` | This document |

**Status:** WIRED AND PREVIEW-VERIFIED (2026-11-05, scene-wiring pass). The
panel is instantiated in the scene (`SoundcraftRoot/ConnectionPanel` at
(36, 16, −66), wired to `SoundcraftRoot/CaptureController`), compiles clean
(`RecompileTypeScriptTool` → `succeeded`, 0 errors), and runs clean in Preview
(`RunAndCollectLogsTool` → 0 errors; both wiring log lines fire; a preview
pinch on BeatPanel/Pad0 moved the status counters). The `onSnapshot` hookup
is implemented inside `SoundcraftConnectionUI.ts` itself
(`tryWireController()`: idempotent, race-safe across OnStart ×
Frame.onInitialized, chains any pre-existing consumer, unsubscribes in
`onWillDestroy()` only if the hook is still ours).

**Two runtime contracts discovered while wiring (must keep):**

1. **Every controller `@input` must hold a non-null scene binding.** The
   TS→JS input check (`checkUndefined` in `*_c.js`) throws
   `Input <name> was not provided` for `null == undefined` — "optional"
   inputs are fatal when empty. Scene resolution: `statusText` → a disabled
   `CaptureController/StatusSink` Text (pre-takeover write target; the UI
   repoints `controller.statusText` at start, logged), `captureRoot` →
   `SoundcraftRoot` (correct scan scope). The "Leave Status Text UNSET"
   guidance below is WRONG at runtime — do not restore it.
2. **`SoundcraftConnectionUI` sets `autoDiscoverItemsOnStart = false` on both
   FlexLayouts it creates.** `buildContent` runs inside `Frame.onInitialized`,
   BEFORE the layouts' own OnStart; with discovery on, the first explicit
   `addItems` throws ("Cannot add items while autoDiscoverItemsOnStart is
   enabled…") and aborts the whole panel build. Explicit flexChild
   registration is this panel's single ownership model.

**Known frozen-client quirk (reported, NOT fixed — client is reviewed/frozen):
~30 s after start, the unpaired online client flips its phase from `offline`
to `token_expired` on its own: `pump()` → `refreshSaves()` (every 30 s,
unconditional in online mode) → `rawRequest(GET /v1/live/saves, withAuth=true)`
→ `!tokenLive()` short-circuits BEFORE any network request and
`setPhase("token_expired", "token expired — pair again (queued notes are
kept)")`. No token was ever issued, so the label is imprecise; the state is
otherwise honest (no request sent, no fake saved, queue clean, pair CTA
shown). Status as delivered: initial `PHASE OFFLINE / not connected — pair
with the code shown in the companion terminal`, then the client's own
`token_expired` wording after the first 30 s saves tick.

---

## 1 · What works today (no controller edits)

The controller (`SoundcraftCaptureController`) exposes exactly two public
methods — `submitPairingCode(code)` and `stopCapture()` — plus its public
`statusText: Text` field. The panel uses only these:

* **Big one-touch Pair button** → reads the `TextInputField` text, calls
  `controller.submitPairingCode(code)`, clears the field immediately.
* **Status row** → on OnStart the panel assigns its multi-line status Text to
  `controller.statusText` (public field assignment, typed, no casts). From then
  on the **controller** renders the truthful status (phase, monitor label,
  detail, unsynced ledger, receipt-only SAVED count + playlist) into the panel
  at its existing cadence (`refreshStatusNow` + 2 Hz throttled refresh).
* **Collapse toggle** → removes/re-adds the FlexItems of the entry rows (item
  count change = relayout; no object is ever destroyed, so the controller's
  Text handle stays valid). Collapsed size ≈ header + compact line — place the
  panel near the playlist (see wiring) so the collapsed state sits beside it,
  never in front of the system keyboard zone.

## 2 · What does NOT work today (honest gaps + required adapter callbacks)

The UI cannot observe the client's phase, because the controller holds its
`SoundcraftCompanionClient` privately and `submitPairingCode` returns `void`.
Consequences, all honest:

1. **No auto-collapse after pairing yet.** The compact line stays at the idle
   placeholder and the panel stays expanded until the user taps ▾. The seam
   exists: `SoundcraftConnectionUI.applyStatus(s: StatusDetail)` is public and
   fully implemented (compact summary, severity tint, auto-collapse on
   paired-family phases, auto-re-expand when a code is needed again, manual
   toggle always wins).
   **Required adapter (2 lines, AFTER the controller author's P1/P2 fixes
   land, added by the parent — not by this stream):**
   ```ts
   // SoundcraftCaptureController: new optional field + one call in renderStatus()
   onSnapshot: ((s: StatusDetail) => void) | null = null
   // …inside renderStatus(s), first line:
   if (this.onSnapshot !== null) this.onSnapshot(s)
   ```
   Then wire once (parent script or scene init): `controller.onSnapshot = (s) => connectionUI.applyStatus(s)`.

2. **No "Connect / Check" button.** No controller API exists for a health
   check, and `submitPairingCode("")` would stomp the client's phase to
   `awaiting_pair` even while paired — so it is deliberately NOT used as a
   fake "check". Required (if wanted later): a controller passthrough such as
   `checkConnection()` calling `client.refreshCapabilities()` + `client.pump()`.
   Not invented here.

3. **No manual "Retry unsent" button.** The client's `pump()` already
   auto-retries only provably-unsent events; there is no manual retry API on
   the controller. Required (if wanted later): a controller passthrough.
   Until then the status row's `unsent N` counter is the truth, and nothing in
   this UI clears or discards unsynced notes — that capability does not exist
   here at all.

4. **No Stop button.** `controller.stopCapture()` exists but was not asked for;
   omitting avoids accidental session closes mid-performance. Trivial to add
   later as one more collapsed-row button if the parent wants it.

## 3 · Scene wiring instructions (apply ONLY on parent GO)

Scene facts (current `Scene.scene`): `PlaylistPanel` at (0, 10, −66), 34×14 cm;
BeatPanel (−27, −13, −52); BassPanel (27, −12, −52); ChordPanel (0, −30, −56).
No controller or connection-panel object exists yet.

1. **Capture controller object** (root level, e.g. under the workspace root):
   * Create SceneObject `CaptureController` (empty).
   * Add ScriptComponent → `Assets/Scripts/SoundcraftCaptureController.ts`.
   * Operator-set, non-secret: `Internet Module` ← the Lens's
     InternetModule asset; `Companion Base URL` ← the HTTPS companion endpoint
     (host must be in the project's allowed domains); `Capture Track` default;
     `Judge Local-Only Mode` OFF for real pairing.
   * **No authored pairing code exists or is allowed, ever** — the controller
     has no pairing-code input (it was removed); the one-time code is supplied
     by the operator for the session and entered ONLY at runtime through this
     panel, living in memory only.
   * **Every @input needs a non-null binding at runtime** (see Status note 1
     above): `Status Text` → the disabled `CaptureController/StatusSink` Text
     (the UI takes the field over at start, logged: "controller.statusText now
     points at the connection panel status row"); `Capture Root` →
     `SoundcraftRoot`.

2. **Connection panel object:**
   * Create root SceneObject `ConnectionPanel` at **(36, 16, −66)** — right of
     the playlist, above the system-keyboard zone (keyboard appears low in the
     view when the field is tapped; keep the panel above y ≈ −8 at this depth).
   * Add ScriptComponent → `Assets/Scripts/SoundcraftConnectionUI.ts`.
   * Wire `Capture Controller` ← the controller's ScriptComponent from step 1.
     This is the ONLY required wiring.
   * Do NOT add a Canvas component (the script creates its own) and do NOT
     change the panel's scale.

3. **Verify (only after wiring — never claim before):**
   * `RecompileTypeScriptTool` → `succeeded`.
   * `RunAndCollectLogsTool` → expect
     `[ConnectionUI] controller.statusText now points at the connection panel
     status row …` and the controller's own discovery lines; no stack traces.
   * Pair flow: the operator supplies a fresh one-time pairing code for this
     session → tap the
     field → AR keyboard → type code → tap PAIR → field clears, hint line
     shows the submitted note → controller status row shows
     `PHASE PAIRED/CONNECTING → CAPTURING` per the client.
   * `CapturePanelScreenshotTool` (PreviewPanel) for visual review; then drive
     a pad hit and confirm the unsynced counters move.

## 4 · Security / hygiene contract (enforced in code + unit checks)

* Pairing code: never an `@input`, never persisted, read at tap time, field
  cleared on submit, collapse stashes it in a local string only; the sole log
  line is length-only (`length N, field cleared`).
* Bearer tokens: never displayed, accepted, stored, or logged anywhere in this
  module; the pure module's output shapes cannot carry them (unit-checked:
  no `bearer`/`access_token`/token-ish substrings in any rendered string).
* Saved badge: the panel never fabricates one. `SAVED n` appears only from the
  client's receipt-backed `savedBadgeCount`; `saveAckSnippet` says SAVED only
  for the exact `status === "saved"` receipt variant (unit-checked, incl.
  pending/failed/unknown/disabled wording).
* No fake endpoint, no auto-clearing of unsynced notes, no recording console,
  no chat, no instrument-button rebuild — master controls and play-first
  autostart stay exactly as the owned prototype has them.
* **Note faithfulness is displayed as DISTINCT labeled segments, never
  summed.** The client's `StatusDetail` now carries `stuckKnown`,
  `stuckWindowNs`, `stuckWindowSecsLabel`, `notCapturableNotes`,
  `nonFaithfulNotes`, plus its own `compactSeverity`/`compactSummary`. This
  panel renders the fields — not the client's strings — as:
  - `LONG NOTES NOT CAPTURED N` ← `notCapturableNotes` (long samples rejected
    before sending; retained locally, UNSAVED — never a saved badge),
  - `TIMING UNCERTAIN N – save withheld` ← `nonFaithfulNotes` (engine
    substituted at the stuck window; exact-fidelity commits withheld),
  - `WINDOW UNKNOWN` ← whenever `stuckKnown` is not exactly true (false,
    missing, or malformed — fail-closed).
  All three are warn-worthy in EVERY phase — including `capturing` and
  `saved_confirmed` — and are never conflated with the unsynced
  MISSED HITS / DROPPED NOTES / RETIRED EVENTS counters (they may overlap;
  they are shown separately, with no combined total). The segments render in
  the compact line, which is visible in both the collapsed and expanded panel
  states. The client's own `compactSeverity` ("ok"/"warn" only) is deliberately
  NOT consumed by the tint: it drops phase severity and would downgrade
  failing phases (e.g. offline); the UI keeps `severityForSummary`, a strict
  superset of the client's warn condition, so it can only warn more, never
  less. The client's `compactSummary` string is likewise not displayed
  verbatim — its wording does not carry the mandated labels; the UI builds
  the mandated segments from the fields.
* **Loss counters keep their units and are never summed.** The client counts
  different things: `uncapturedHits` counts HITS (landed while no capture
  session was open — rollover/open failure), `overflowDroppedNotes` counts
  NOTES (past the bounded capture window), and `retiredUnsentEvents` counts
  EVENTs (note-on + note-off may be 2 events per note) — so the panel renders
  them as separate counters, `MISSED HITS x · DROPPED NOTES y · RETIRED
  EVENTS z`, only when non-zero, in BOTH the collapsed compact line and the
  expanded ledger (`unsyncedSummary`). There is no cross-unit total anywhere.
  While any of the three is positive — or unknown-duration notes are — the
  compact tint escalates to the warn color, even when the phase itself is
  green `capturing` (`severityForSummary`); error phases stay error and clean
  `capturing` stays green. A malformed counter (undefined/NaN/negative) renders
  as absent and is treated as unprovable for the tint — it never yields a
  fabricated 0/green claim. Unsaved hits are never rendered as a saved badge:
  `SAVED n` appears only from the receipt-backed `savedBadgeCount`, and the
  save-ack snippet says SAVED only for the exact `status === "saved"` receipt.

## 5 · Tunables (all with hints/widgets/defaults)

Layout: panel width 30, expanded height 28.5, collapsed height 8.5, focal
distance 66 (type roles scale to the panel depth), status row 7.0, input row
2.6, pair row 3.4. Labels: title, pair button label, code placeholder, idle
compact line, empty-code hint, submitted hint, footer note. Colors: severity
OK / info / warn / error / neutral (`vec4` + ColorWidget).

## 6 · Honest unit checks (run any time)

```
node Assets/Scripts/tests/soundcraft-connection-status.test.mjs
```

Covers: exhaustive unique uppercase labels per phase (unknown phase → verbatim
passthrough), SAVED claimed only with receipt wording, exhaustive severity map,
exact paired-like / code-needed sets, verbatim unsynced ledger with per-unit
loss surfacing (MISSED HITS / DROPPED NOTES / RETIRED EVENTS — never summed,
no field hiding, only non-zero counters render), per-variant save-ack honesty,
and the credential-hygiene scan over the extended snapshot shape. Regressions
pin the collapsed-state contract: `capturing` + any loss counter stays warn
with its own unit label (never green, never a saved badge), retired events and
unknown-duration notes stay visible collapsed, error phases are never
downgraded, clean `capturing` stays green, and malformed counters render as
absent without ever claiming green. Note-faithfulness regressions: distinct
`LONG NOTES NOT CAPTURED N` / `TIMING UNCERTAIN N – save withheld` /
`WINDOW UNKNOWN` segments, warn in every phase when any is present (including
capturing and saved_confirmed), no conflation or combined totals with the
unsynced counters, fail-closed on missing/malformed stuck fields, and
not-captured long notes never labelled saved. Current result: **49/49 PASS**.
