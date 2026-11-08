# Reproducibility — how a judge can run SoundCraft Orbit today

Updated 8 November 2026 (evening). Everything below states what can
actually be reproduced, with receipts. Claims are limited to **Lens Studio
Preview on a laptop**; nothing has been shown on Spectacles hardware, and
no SoundCraft backend round trip is involved.

## What is reproducible today (all receipt-backed)

1. **Open the Lens project and play it in Preview.** Native full compile
   succeeded (latest 21:23); a fresh runtime window shows no Lens startup
   exception, 12 pads / 3 panels register, the bundled demo loop starts.
   Receipts: `receipts/lens-preview-smoke-20261108.json`,
   `receipts/lens-native-preview-check-20261105.json`,
   `receipts/lens-play-first-framing-ux-20261106.json`.
2. **Automated LEAF smoke scenarios pass in Preview (4/4).** Run 8 Nov
   21:24 via the official LEAF MCP path, serially, judged by the Lens-side
   `DefaultLeafScenarioManager` PASSED lines:
   - `soundcraft-collider-local-geometry` — collider-local box geometry
     (an earlier failure was corrected **in the test**; production code
     was not relaxed),
   - `soundcraft-pinch-beat-pad-records-take` — correct beat/pad hit
     identity, pad + orb pulse, `AudioComponent.isPlaying` observed,
   - `soundcraft-drag-panel-world-fixed-restore` — drag moves the panel,
     world-fixed parent unchanged, transform restored,
   - `soundcraft-pan-toggle-reverses-spatial` — spatial/position/distance
     effect flags reverse and restore.
   **Limit:** LEAF overrides the SIK target, so these do not prove natural
   sibling-collider discrimination, real-hand tracking, audibility, or any
   backend effect. Broader LEAF coverage per the brief's done criteria is
   still pending.
3. **Portable client-test suite.** `tools/lens-client-tests`:
   `npm ci && npm test` — **87/87 pass** against actual source (see that
   folder's README/package.json for the pinned toolchain).
4. **Standalone unit tests (optional).** Node ≥ 22.18, one command per
   area, reported separately (no aggregated totals):
   `soundcraft-connection-status` 52 · `capture-controller-workflow` 22 ·
   `capture-duration-policy` 12 · `playlist-panel-presentation` 31 ·
   `open-confirm` 23 checks.

## Requirements

- **Lens Studio 5.23.2** (the `.esproj` pins this version).
- **No internet needed for assets.** All 7 SDK packages are vendored in
  `lens-studio-specs/Packages/*.lspkg` (SIK runtime reports 0.18.0), and
  the whole Assets + Packages tree is ordinary Git content (17,876,437
  bytes total, largest file 5,447,652 — no LFS pointers), so a plain
  GitHub ZIP download opens the same project.
- Node.js ≥ 22.18 only for the optional unit tests; npm for the portable
  suite.
- The project targets **Spectacles**; Preview device is configured to
  **SPECS 27 stereo, Interactive input, "Evening Outdoor"**
  (`receipts/specs-base-conversion-20261104.json`).
- The saved scene contains no private endpoints; the connection panel
  starts empty and OFFLINE until you supply your own companion URL.

## Steps

1. Open `lens-studio-specs/SoundcraftOrbit.esproj` in Lens Studio; let the
   editor compile (project compiles clean; a first open may need one
   recompile after asset import).
2. Enter **Interactive Preview**. The demo loop "VAPOR SUNSET" (bundled,
   original, 30.9 s) autostarts about 0.1 s in and is logged.
3. **Play primarily with CLICK / PINCH:** aim with the mouse at a pad on
   one of the three floating panels (Beat 2×2, Bass column, Chord row) and
   click (pinch) — each hit plays that pad's sound where the panel sits,
   pulses the orb, and grows the session take row automatically.
4. **Optional editor keyboard mirror exists** (`1-4` beat · `QWER` bass ·
   `ASDF` chords · `SPACE` demo · `P` pan link) — but the Preview's own
   `WASD`/`QE` navigation can overlap these keys, so treat the keyboard as
   an optional convenience, not the primary input and not a capture
   method. None of it applies on device.
5. **Move panels:** drag a panel by its plate; its world-fixed parent does
   not move, and its stereo pan follows placement while the per-panel Pan
   toggle link is on (toggling unlinks placement from pan).
6. **Connection truth panel:** starts LOCAL ONLY / SETUP REQUIRED with empty endpoint and
   one-time-code fields; a cleared code stays memory-only. Open-Last-Save
   is a two-distinct-tap control (within 300 ms–8 s) that preserves its
   data. Without a paired companion, the take stays explicitly
   local and unsaved; a `SAVED` badge
   can only appear from a receipt-backed backend save, which has never
   happened from this Lens.

## What is NOT reproducible / established today

- **No backend round trip.** No deployed companion service exists
  (backend PR #19 is open and Spark backend qualification passed, but there
  is no deployment). Pairing, capture, save, Open-Last-Save against a real service are
  untested by design of the current environment — no receipts can exist.
- **No hardware result.** No Spectacles device; hand-tracking feel,
  latency, room anchoring, on-device pan are untested. Preview
  measurements are not hardware results.
- **LEAF coverage is smoke-level** with an overridden target (see above).
- **Not fresh-clone runtime-tested.** All receipts come from the authoring
  working tree; a from-scratch clone has not yet been opened and runtime
  -verified. If a fresh clone misbehaves, compare against the receipt log
  excerpts (`SIK Version 0.18.0`, pad-registration lines) first.
- **Audio honesty:** the demo backing loop and UI blips are not part of
  any captured performance; local spatial monitoring does not preserve a
  pan-automation or exact backend-stereo mix. That pads play their
  assigned sources will be proven separately by a later Spark read-only
  job — not claimed now.
