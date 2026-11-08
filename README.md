# SoundCraft Orbit

## New: playable SPECS Lens — current status (8 November 2026)

**What works today (receipt-backed, local Lens Studio Preview only):**
`lens-studio-specs/SoundcraftOrbit.esproj` compiles and runs clean (12 pads
on 3 floating instrument panels, demo loop "VAPOR SUNSET" autostarts);
**all 4 LEAF Preview smoke scenarios pass** via the real LEAF MCP path
(`receipts/lens-preview-smoke-20261108.json`) — collider-local geometry,
pinch pad-identity + `AudioComponent.isPlaying`, world-fixed drag restore,
pan-toggle spatial flag restore. LEAF uses an overridden target, so these
prove the handler paths, not natural target discrimination, audibility,
hand-tracking, or any backend effect. The portable test suite
(`tools/lens-client-tests`, `npm ci && npm test`) passes **87/87**, plus
per-area unit checks (status 52 · workflow 22 · duration 12 · playlist 31 ·
open-confirm 23). The saved scene contains **no private endpoints**, and
a GitHub ZIP includes the actual assets rather than Git LFS pointers.

**Honest limits:** playing creates a **local, session-only** take with
local/unsaved status. The setup panel shows pairing,
one-time-code (memory-only) and a two-tap Open-Last-Save control, but no
companion service is deployed, so real pairing/capture/save/open are
**untested against a deployed service**. Backend qualification run
`42525348556` passed on the Spark, including real CLI save/reopen tests on
Python 3.10 and 3.12. PR #19 remains open at `e9f52a7` while its final checks
run — **no deployed image or Lens↔backend round trip is claimed**.
The design brief is still a draft without author approval. No video,
YouTube upload, or Devpost submission exists yet; a fresh clone has not
been runtime-tested.

**Published:** the Lens project and planning documents are on public `main`
(PR #4, merge `36425c5`). All 212 payload files were checked against the
remote Git blob IDs; see `receipts/lens-publication-20261108.json`. See
[`devpost/publication-allowlist.md`](devpost/publication-allowlist.md) for
the exact paths, [`devpost/reproducibility.md`](devpost/reproducibility.md)
for judge-facing run steps,
[`devpost/demo-runbook.md`](devpost/demo-runbook.md) for the <3-min video
plan, and [`devpost/submission-checklist.md`](devpost/submission-checklist.md)
for the acceptance-vs-receipt table with the required pre-existing-work
disclosure (SoundCraft/Forge and the older Orbit viewer below are
pre-existing work, not this Lens).

---

## Historical implementation note — 5 November 2026

The new experience is a fun mini-DAW in glasses: room-fixed instruments within
reach, immediate local sound and visual feedback, and automatic capture into
an editable SoundCraft project. The draft design is in
[`devpost/design-brief.md`](devpost/design-brief.md); evidence and unfinished
acceptance checks are in
[`devpost/implementation-status.md`](devpost/implementation-status.md).

- **Lens project:** `lens-studio-specs/SoundcraftOrbit.esproj`, configured for
  Specs on Lens Studio 5.23.2 with compatible interaction packages. Full project
  compilation, local runtime rendering, a Preview hand-pinch pad hit and panel
  dragging have been checked. This does not establish hardware behaviour.
- **Backend:** SoundCraft main `b1679b5` includes authenticated companion calls,
  editable MIDI take commits and protected versioned saves. Backend subprocess
  tests verify save/reopen; private Spark deployment and the Lens-to-backend
  connection are still being completed.
- **Not saved yet in the Lens:** the current take view remains explicitly
  simulated/session-only. The companion-client scripts are wired into the scene,
  but have not been qualified against a deployed service. Never interpret
  local audio or a growing bar as a successful SoundCraft save.
- **Monitoring:** the prototype uses original bundled one-shots as a local
  monitor. SoundCraft headless does not yet supply live audio monitoring.
- **Access:** planned private Tailscale HTTPS is for laptop Preview; glasses and
  public judges do not automatically have that access. Cluster and MCP
  credentials must never be included in this public project.

The older read-only web viewer below is preserved as pre-existing work. It is
not the new playable Lens. Its historical parked-repository statements describe
that older milestone, not the current SoundCraft development state.

## Earlier Orbit — AR-first track-progress view

**See how the track is coming along — from across the room, at a glance, in AR.**

Orbit is the AR-first answer to "a lightweight webapp to see the progress of
the track being made": one information architecture, designed for Snap
Spectacles (51° FOV see-through glasses) first, delivered as

- **(a)** `docs/AR-INFORMATION-ARCHITECTURE.md` — the spatial IA: session ring,
  track arc, bounce plaque; angular-size floors; state language; the 51° FOV budget
- **(b)** `web/` — the desktop companion rendering the same geometry, with a
  true-to-angle FOV overlay (dims anything the glasses would not show)
- **(c)** `lens/` — the Snap Spectacles Lens Studio project (scripts + scene
  manifest + assembly/preview plan; Lens Studio does not run on Linux/arm64
  build nodes)
- **(d)** `tools/` — the read-only SoundCraft data path: deterministic 8-bar
  120 BPM session build, `file.bounce_mix` receipts, live re-inspection

Built for Arthur's Devpost Learn **AR with SPECS** entry (submissions close
9 Nov 2026 17:00 ET). SoundCraft repos are PARKED (founder order, 26 Oct
2026) — this project integrates **read-only** and contains no engine code.

## The demo session (real, not mocked)

`session/first-light.scraft` + `session/Audio Files/` — **first-light**, exactly
8 bars at 120 BPM (16.0 s), 48 kHz, six tracks (Kick, Snare, Hats, Bass, Keys,
Lead) built headlessly by `tools/make_stems.py` + `tools/build_session.scmd`
through soundcraft-cli 0.14.0. The Lead enters at bar 5 on purpose: the stage
renders genuine mid-progress state (ring segments 1–4 partially lit).

Latest bounce receipt (`receipts/first-light-bounce.json`, engine-produced):

```json
{"bytes":4608104,"lufs":-16.29,"path":"first-light-mix.wav",
 "peak_db":-1.44,"seconds":16.0,"true_peak_db":-1.27}
```

## Run it

Static (what the reviewer opens):

```bash
# after deploy: https://<host>/soundcraft-orbit/   (GitHub Pages)
# or locally:
cd web && python3 -m http.server 8000   # → http://localhost:8000
```

Live bridge (re-inspects the session on change; page polls every 4 s):

```bash
python3 tools/serve.py --port 8760      # → http://localhost:8760  (LIVE · BRIDGE badge)
```

Controls: **FOV** toggles the Spectacles 51°×30° frame at 1.5 m (everything
outside is dimmed — that is what the glasses would not render), **RULER** shows
the angular scale, **PLAY** plays the actual bounced mix while the ring
playhead and active bar cells track it. Click any card for the inspect layer
(waveform, clips, inserts).

Rebuild the data from the session bundle:

```bash
python3 tools/build_data.py             # read-only inspect + peaks + receipts → web/data/session.json
```

Rebuild the session from scratch (deterministic stems → engine):

```bash
python3 tools/make_stems.py             # writes build/stems/*.wav
soundcraft-cli script tools/build_session.scmd \
  --save session/first-light.scraft --bounce first-light-mix.wav --inspect
python3 tools/build_data.py
```

## Repository layout

```text
docs/AR-INFORMATION-ARCHITECTURE.md   deliverable (a) — the IA
web/                                  deliverable (b) — companion (vanilla JS, no build step)
lens/                                 deliverable (c) — Lens Studio scripts + manifest + setup
tools/                                deliverable (d) — stems, session build, data bridge
session/                              the real SoundCraft session bundle (.scraft + Audio Files)
receipts/                             engine bounce receipts (verbatim)
web/data/session.json                 generated artifact — soundcraft-orbit/session@1
```

## Provenance

- Engine: SoundCraft (read-only) via `soundcraft-cli 0.14.0 (linux aarch64)`
- Receipts: engine-produced `file.bounce_mix` output, stored verbatim
- Peaks: computed from the session's own `Audio Files/` by `tools/build_data.py`
- The SoundCraft repositories remain PARKED — no pushes, merges, or CI triggers there.
