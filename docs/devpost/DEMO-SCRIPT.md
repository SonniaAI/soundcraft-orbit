# Demo video script — Orbit (Devpost Learn AR with SPECS)

Challenge rule: "Reviewers won't clone or run your project, so the video has to
show it working." One continuous cut, ~90 seconds, 1440×900, real screen
recording of the live companion — no slideware. Captions carry the narration
text below (burned in); optional voiceover reads the same lines.

Every beat is reproducible: the exact commands are in `CHECKLIST.md` and the
evidence receipts in `docs/evidence/README.md`.

## Shot list

| # | Time | On screen | Action (who/what) | Caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:08 | Ambient stage, FOV overlay on: ring left, 6 cards, plaque | nothing moves — let it breathe | "Orbit: how the track is coming along — from across the room, at a glance. Designed for Snap Spectacles first." |
| 2 | 0:08–0:16 | Same stage | click **PLAY** | "This is the real bounced mix. The playhead sweeps the ring; each card lights the bar being played." |
| 3 | 0:16–0:24 | Playhead mid-session (bars 3–4) | keep playing; mouse still | "Bars 1–4 sit at five of six tracks — the lead enters at bar 5. The ring shows progress honestly: half-lit means half-finished." |
| 4 | 0:24–0:34 | Page open, playing fades | in a terminal: `python3 tools/live_change.py` → prints the engine edit + bounce receipt | "Now a real change: the engine trims the lead out of bar 8, rebalances the mix, bounces — and measures." |
| 5 | 0:34–0:44 | The page updates itself | watch: badge flashes `LIVE · SYNCED`, ring bar 8 dims to 5/6, Lead card's last cell empties, plaque flips −16.3 → −14.8 LUFS, PK −0.9, "just now" | "The live bridge re-inspects the session; the stage re-renders itself in seconds, with the engine's own receipt on the plaque." |
| 6 | 0:44–0:54 | Inspect layer | click the Lead card → waveform, clip span, insert chain, volume; then close | "One fixation per track: waveform, clips, inserts. Gaze + pinch does this on the glasses." |
| 7 | 0:54–1:04 | FOV toggle + RULER | toggle **FOV** (everything outside the 51°×30° frame dims), then **RULER** | "Everything lives inside the Spectacles' 51-degree window at 1.5 metres. That budget is the design discipline." |
| 8 | 1:04–1:16 | `lens/` folder + scene manifest scroll-by, then the FOV-framed stage | screen capture of the Lens sources + assembly runbook headings | "The same geometry ships as a Spectacles Lens: TypeScript scripts + scene manifest, fetching this same live data on the glasses." |
| 9 | 1:16–1:25 | Live URL in a clean tab | close on https://sonniaai.github.io/soundcraft-orbit/web/ | "Orbit. Your track's progress, at a glance, in AR." |

## Production notes

- **Recording setup (headless-capable, used for the committed cut):**
  `xvfb-run` + Chromium on a virtual display, `ffmpeg -f x11grab` capture,
  clicks driven over the DevTools protocol. The audio under beats 2–4 is the
  real `first-light-mix.wav` (48 kHz), spliced at the PLAY moment.
- **Honesty rule:** nothing on screen may claim what is not running. The Lens
  beat (8) shows *sources and runbook*, never a faked preview frame; if
  `lens-preview-demo.mp4` exists by submission, cut it in after beat 8 as a
  picture-in-picture and update the caption to "running in Lens Studio
  preview".
- **Captions:** dark background, ≥ 24 px, max 2 lines, same wording as the
  table. No ticket IDs, no internal tool names.
- **Fallback cut (if the live-change beat misbehaves on the day):** beats
  4–5 can use the committed before/after evidence pair
  (`docs/evidence/live-bridge-*.png`) as full-frame stills with the same
  captions — the pixel-region receipts prove the change is real.
