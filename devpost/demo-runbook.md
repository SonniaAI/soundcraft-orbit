# Demo runbook + <3-minute video plan

Updated 8 November 2026. Built from what is **verified to work in Preview
today** (including the 8 Nov smoke receipt) — every shot below uses only
verified behavior, and unpaired playing stays visibly local and unsaved.
No backend-connected or hardware result is claimed by this local-only plan.

## Pre-flight (one time, before recording)

| Check | Command / action | Expected |
|---|---|---|
| P0 | Baseline already green — read `receipts/lens-preview-smoke-20261108.json` (4/4 LEAF smoke, 21:24; compile 21:23; runtime clean; scene saved with 0 private hosts at 16:57) | re-run only if the scene changed since |
| P1 | `cd tools/lens-client-tests && npm ci && npm test` | 87/87 pass vs actual source. Optional unit `.mjs` (Node ≥ 22.18), report per area: status 52 · workflow 22 · duration 12 · playlist 31 · open-confirm 23 |
| P2 | Open `lens-studio-specs/SoundcraftOrbit.esproj`, compile finishes, Preview refresh | zero Lens startup exceptions; `SIK Version 0.18.0`; interactables registered; demo "VAPOR SUNSET" rolling (two editor-side warnings — resource auth, LeafPlugin panel refresh — are editor-side and expected) |
| P3 | Frame the Preview: reset camera for setup, then look around the room-fixed instrument arc | Setup controls visible at origin; attend each instrument and playlist with modest head turns rather than claiming every panel fits simultaneously |
| P4 | Screen recorder set to capture the Preview panel at 30 fps+, mic or captions ready (`tools/preview-recording/` Swift source is an optional helper; do **not** publish its `build/` binary) | recording starts clean |

**Keep P2's console visible or excerpted** — it is honest evidence the lens
runs (receipts cite the same lines).

**Pacing fact:** chord pads ring for ≈5.2 s (measured 5.219887 s); pads are
not all short blips — let a chord finish before the next beat of the
script, and don't narrate over it.

## Shot list (target ≈2:30, hard limit 3:00)

| # | Time | Shot | What it proves | Status |
|---|---|---|---|---|
| S0 | 0:00–0:15 | Title card over a static Preview frame: "SoundCraft Orbit — mini-DAW in Spectacles. Lens Studio Preview." | framing | ready |
| S1 | 0:15–0:45 | Demo loop plays; slow look across the three floating instrument panels in arm's reach; orb breathing | room-fixed spatial instruments; bundled original demo audio (**backing loop is not captured performance — say so if asked**) | **verified** (5–6 Nov + 8 Nov receipts) |
| S2 | 0:45–1:15 | **Click/pinch pads** on Beat, then keys on Bass/Chord; orb pulses per hit; playlist take row grows automatically | play-first capture, immediate local sound+visuals; LEAF smoke proves the handler path records the correct pad identity | **verified** (receipts: take increments; `AudioComponent.isPlaying` observed) |
| S3 | 1:15–1:45 | Drag the Bass panel to a new spot (pan link ON → pan follows), flip its Pan toggle → placement no longer moves pan, drag again | movable panels + pan-link control; world-fixed parent preserved; LEAF `drag-panel-world-fixed-restore` + `pan-toggle-reverses-spatial` pass | **verified** (drag + runtime transform readback; pan flags reverse/restore) |
| S4 | 1:45–2:00 | Click the demo pad to stop/restart the loop; playlist demo transport responds | transport controls (optional editor keyboard `SPACE` exists but the Preview's `WASD`/`QE` navigation can overlap keys — click/pinch is primary) | **verified** (editor path; same DemoPad code path) |
| S5 | 2:00–2:20 | Show the LOCAL ONLY / SETUP REQUIRED panel, empty endpoint/code fields, PAIR and guarded OPEN LAST SAVE controls | honesty: unpaired playing is not represented as saved | local UI verified; real pairing remains pending |
| S6 | 2:20–2:35 | End card: repo path, `devpost/` folder, disclosure line — "SoundCraft/Forge are pre-existing separate projects; this Lens is new work. Preview-only demo; no hardware or backend round trip claimed." | disclosure | ready |

Narration/caption beats: name the three instruments → "every hit is captured
into a growing take" → "panels are room-fixed and movable; pan follows
placement until you unlink" → "saving to SoundCraft is designed and wired,
but not yet connected — the lens tells you exactly that".

## Receipts to capture during/after recording (for the submission record)

1. Fresh console log window (P2 lines) saved next to the video file.
2. A screenshot of the ConnectionPanel OFFLINE state (mirrors the 8 Nov
   receipt).
3. A short note in `devpost/implementation-status.md` with the recording
   date + which shots ran (add a new receipt JSON in `receipts/` following
   the existing format, `notEstablished` section included).

No recording or YouTube upload exists yet; upload authentication is still
unknown — treat "public YouTube link" as an open requirement, not a step
assumed to work.

## If something misbehaves while recording

- Pads silent → check the demo autostart log line; recompile; restart
  Preview (recompile after asset import is a known first-open hiccup).
- Panels outside frame → reset preview camera to origin (preview state
  only, no scene change; documented in the 6 Nov receipt).
- Keyboard mirror feels flaky in Preview → use click/pinch only. Do **not**
  invent or apply input/code fixes mid-session — scripts are owned by
  another writer; note the issue in the receipt instead.
- Never edit the scene during the take: the 6 Nov pass froze the layout on
  purpose; recorder should show the authored result, not a live tweak.

## Hard "do not" list for the video

- Do not narrate or imply a SoundCraft save, backend round trip, on-glasses
  run, hand-tracking quality, or per-pad audibility — none is established
  (one partial natural bass pinch is noted in the receipt; it is not an
  essential claim).
- Do not present the demo backing loop or UI blips as captured performance,
  and do not imply local pan is preserved as pan automation in any saved
  mix.
- Do not show private infrastructure: no machine hostnames, no pairing
  codes, no cluster/deploy UI, no private checkout folders (the
  `soundcraft-review/`, `soundcraft-stage-fix/`, QA canary material must
  not appear on screen).
- Do not present the older read-only Orbit web viewer as this Lens.
