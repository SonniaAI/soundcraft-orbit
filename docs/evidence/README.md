# Evidence index

Every artifact here is produced by the committed commands in this repo — no
manual photo editing, no mock data. Re-run any receipt to reproduce.

## Web companion (AR geometry preview of record)

| File | What it proves | How it was produced |
| --- | --- | --- |
| `web-stage-fov-overlay.png` | The whole stage fits the Spectacles 51°×30° window at 1.5 m; the dashed frame is the true-to-angle FOV overlay, everything outside it is what the glasses would NOT render | `cd web && python3 -m http.server 8000` → open `http://localhost:8000` (FOV toggle on) → screenshot at 1440×900 |
| `web-playing-bar3.png` | PLAY plays the real bounced mix; the ring playhead needle and the active bar cell track it | same, after clicking **PLAY** during bar 3 |
| `web-inspect-lead.png` | The inspect layer: the Lead card's waveform, clip span (bars 5–8), insert chain (plate reverb → chorus), volume | same, after clicking the Lead card |

## Live bridge (Orbit v2 — real session change, end to end)

| File | What it proves | How it was produced |
| --- | --- | --- |
| `live-bridge-before.png` | Canonical `first-light` session over the live bridge: ring bar 8 fully lit (6/6 tracks), plaque at −16.3 LUFS, badge `LIVE · BRIDGE` | `python3 tools/serve.py --port 8760` → `http://localhost:8760` → headless Chromium 1440×900 screenshot |
| `live-bridge-after.png` | After a REAL engine change the page re-rendered itself: ring bar 8 dimmed to 5/6 (Lead dropped out), Lead card mini-grid lost its last cell, both volume ticks moved, plaque shows the fresh receipt (−14.8 LUFS, PK −0.9, TP −0.7, "just now") | `python3 tools/live_change.py` (engine edit + bounce + receipt), wait ~5 s, same screenshot |

Measured diff between the two screenshots (1440×900): ring region 2 117 px
changed, plaque region 818 px changed — exactly the two surfaces the IA says
must react (bar coverage + output state).

The engine change behind the pair, produced by `tools/live_change.py` and
stored verbatim in `receipts/first-light-live.json` during the capture run:

```json
{
  "tool": "soundcraft-cli 0.14.0 (linux aarch64)",
  "capturedAt": "2026-11-03T11:58:45Z",
  "bytes": 4608104,
  "lufs": -14.771750450134277,
  "peak_db": -0.8641636967658997,
  "seconds": 16.0,
  "true_peak_db": -0.6992049217224121
}
```

(engine edit: `edit.trim_clip` Lead clip end 768000 → 672000 samples, so the
Lead drops out of bar 8; `mix.volume` Lead −9 → −6 dB, Bass −4 → −2 dB)

Reproduce the pair:

```bash
python3 tools/serve.py --port 8760          # terminal 1 — the bridge
chromium --headless --window-size=1440,900 \
  --screenshot=docs/evidence/live-bridge-before.png http://localhost:8760/
python3 tools/live_change.py                # terminal 2 — the real change
chromium --headless --window-size=1440,900 \
  --screenshot=docs/evidence/live-bridge-after.png  http://localhost:8760/
python3 tools/live_change.py --restore      # back to committed first-light
```

(Any browser works; the page polls `/api/session` every 4 s and flashes
`LIVE · SYNCED hh:mm:ss` on its badge when a change lands.)

## Lens Studio (Arthur-side, macOS)

`lens-preview-*.png` / `lens-live-*.png` / `lens-preview-demo.mp4` are captured
on a machine that can run Lens Studio (company Linux/arm64 nodes cannot). The
exact runbook — including what each capture must show and the web equivalents
that stand in until then — is `lens/SETUP-LENS-STUDIO.md` §5.
