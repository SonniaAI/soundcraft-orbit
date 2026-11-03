# Orbit — AR-first track-progress view for SoundCraft

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
