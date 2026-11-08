# SoundcraftCaptureController — Runtime Workflow API Contract

Owner lane: controller + this doc/tests only. Client (`SoundcraftCompanionClient.ts`,
review md5 `105f4e5d1dfb64eee697972779ded7cd`), Types, Http, UI, Scene, Playlist
are OTHER writers' lanes — this contract consumes only their existing public APIs.

## Why this exists

The bank CLI `ensure` creates 12 tracks at boot. The client's bootstrap only ever
auto-recovers a demonstrably `tracks: []` document, so on a banked restart the
client correctly surfaces "use the explicit open-last-save action" and does
nothing destructive. Until now that action existed only as
`client.explicitOpenLastSave()` — unreachable without the CLI. These controller
methods expose it (and runtime pairing) to a UI safely.

## Public API (controller methods; UI owner wires buttons next)

### `configureEndpointAndPair(endpoint: string, code: string): Promise<boolean>`

Runtime HTTPS endpoint + one-time pairing code — **no Inspector, no CLI**.
Resolves `true` only when the code was exchanged AND capture actually opened.

Endpoint rules (strict, string-level — the Lens runtime has no URL parser in
StudioLib.d.ts; string validation is the verified no-DOM route):
- `https://` only; no `user:pass@` userinfo; no query; no fragment;
  host[:1..65535 port]; host must be a routable dotted name (single-label hosts
  and even `localhost` are refused — the companion is never the Lens itself).
- Arbitrary `/path` prefix ALLOWED (the transport concatenates `baseUrl + path`,
  e.g. tunnel subpaths work).
- Private/tailnet hostnames accepted as-is for now; authored-scene sanitization
  is a separate later lane.

Behavior:
- judge mode → refuse (`judge_mode`); no Internet Module → refuse
  (`no_internet_module`); invalid endpoint → refuse (`invalid_endpoint`).
- SAME endpoint + a real (online) client → **pair in place** — the existing
  client, its bearer token, and its buffers are untouched.
- DIFFERENT endpoint (or the first endpoint after the unconfigured placeholder)
  → **rebuild**: allowed ONLY on a provably clean state (see refuse matrix);
  a fresh client is registered at the new endpoint with the EXACT current
  pipeline (7.0 s stuck-window request / 15 s deadline / 0.55 s spacing) and
  the discovered pad duration policies are re-registered onto it. The old
  token belonged to the old endpoint and is abandoned (memory-only, never
  logged). The inspector input is never written back.
- Pairing success → `startCapture(captureTrack)` only after actual success.
- Code/token are memory-only arguments: never logged, never stored on the
  controller, never written to any input or scene asset.
- **Pre-pair hits**: hits while unconfigured remain visible
  "NOT CAPTURED (no open session)" counts — the local monitor kept playing
  them; they are NEVER replayed or fake-saved. When a placeholder is replaced,
  its uncaptured count is carried into the status line
  ("pre-pair hits: N (never captured — local unsaved, NOT replayed)").

### `explicitOpenLastSavedProject(): Promise<boolean>`

The guarded operator reopen. Resolves `true` only when: any safe open session
was closed via an AWAITED `client.stopCapture()`, the recover actually
succeeded (the recovered document REPLACES the live one; the client refreshes
track ends itself), `refreshCapabilities()` was re-read, and capture actually
restarted on `captureTrack`.

**THE UI MUST CONFIRM WITH THE USER BEFORE CALLING** — this action replaces the
live document. This API never prompts, never discards, never destroys.

Refuse-first matrix (refusal changes NO state — no discard/destruction):

| Condition (from the real client snapshot) | Verdict |
|---|---|
| judge mode / unconfigured placeholder (`localOnly`) | refuse `judge_mode` / `not_configured` |
| `phase = backend_down` | refuse `backend_down` |
| commit in flight (`commit_pending`) or unsettled (`commit_unknown`) | refuse `data_present` |
| `unsentEvents > 0` (queued, not confirmed applied) | refuse `data_present` |
| `heldNotes > 0` (unfinished notes) | refuse `data_present` |
| `notesUnknownDuration > 0` | refuse `data_present` |
| `bufferedHits > 0` (next-take buffer) | refuse `data_present` |
| `uncertainInFlight` (lost reply) | refuse `data_present` |
| `lastSavedReceipt.status = pending / unknown` (unsettled save outcome; a prior SAVED badge is never treated as "current empty") | refuse `data_present` |
| open session with none of the above (empty, or a COMMITTED take) | close it first via awaited `stopCapture()`; a `false` return = uncommitted take, refuse with data intact |
| otherwise | proceed |

Deliberately NOT gates (visible lifetime loss/retention counters with no data
object behind them — the client never resets them, so gating would lock the
workflow forever): `uncapturedHits`, `overflowDroppedNotes`, `retiredUnsent/
RefusedEvents`, `staleFinishesIgnored`, `policyClosedNotes`, `notCapturableNotes`,
`nonFaithfulNotes`. `completed/acked` notes of an OPEN session are arbitrated by
the awaited close boolean, never snapshot-guessed (a committed take closes
cleanly; an uncommitted one refuses inside the client).

The bootstrap freshness guard is untouched: pairing still never recovers
implicitly; auto-recover remains the client's own `tracks: []`-only path.

### `getStatusSnapshot(): StatusDetail | null`

Poll-safe read-only getter for UI panels (playlist view etc.). Returns the
client's scrubbed snapshot — phases, counters, basenames, policy text — never a
credential, endpoint, or code. `null` before boot completes. No side effects.

### `onWorkflowNote: (note: string) => void` (public field hook)

Optional workflow-outcome hook for the UI; notes are pre-sanitized
(URLs stripped, credential-shaped content withheld, length-capped). A throwing
consumer cannot break capture. Outcomes also render in the controller's own
`statusText` as a `WORKFLOW: …` line. Failure reasons name blockers only —
never endpoints/codes/tokens.

### Pre-existing API (unchanged)

`submitPairingCode(code)`, `stopCapture()`, `onSnapshot` — plus the new
reentrancy rule: one state-changing workflow at a time (`submitPairingCode` no-ops while a workflow runs, and vice versa; the UI retries, never queues).

## UI owner requirements (next lane)

1. Confirm-before-call dialog for `explicitOpenLastSavedProject` (document
   replacement is the user's decision; confirm OUTSIDE this API).
2. Wire endpoint+code entry to `configureEndpointAndPair`; surface the typed
   refusal `code` + `reason` verbatim (they are pre-scrubbed).
3. Poll `getStatusSnapshot()` (or keep `onSnapshot`) for playlist/playlist-view;
   badges come ONLY from receipt wording, as before.
4. Judge-mode UI must not offer either method (they refuse by design).

## Tests / receipts

- `soundcraft-capture-controller-workflow.test.mjs` — real-logic: the shipped
  gate functions are loaded (decorators stripped mechanically, bus import
  stubbed, TS stripped; type-only imports elided) and exercised against REAL
  client snapshot shapes. Run: `node Assets/Scripts/tests/soundcraft-capture-controller-workflow.test.mjs`
- `soundcraft-capture-duration-policy.test.mjs` — 7.0 s window receipt (kept
  passing; source constants unchanged).
- `soundcraft-connection-status.test.mjs` — existing UI mapping suite (must
  stay green).
