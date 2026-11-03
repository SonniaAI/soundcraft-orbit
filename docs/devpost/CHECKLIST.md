# Submission checklist — Learn AR with SPECS

**Close: Tue 9 Nov 2026, 5:00pm EST (= 22:00 UTC). Demo-ready target: 8 Nov.**
Judging: 10–17 Nov · Winners: 19 Nov. Challenge page: https://learn-specs.devpost.com

Owners: **agents** = this lane (Paperclip product lane) · **Arthur** = founder-side
machine/account actions (Lens Studio runs on macOS only; Devpost account).
Card: SON-6176. Update the status column in place; link proof next to each item.

## Code & deployment (agents)

| ✅ | Item | Owner | Due | Status / proof |
| --- | --- | --- | --- | --- |
| ☑ | Live bridge end-to-end: serve.py watches session + receipts + mix; page re-renders | agents | 3 Nov | done — `docs/evidence/live-bridge-before/after.png`, region-diff receipts |
| ☑ | Scripted real change: `tools/live_change.py` (+ `--restore`) | agents | 3 Nov | done — engine edit + verbatim receipt, restores cleanly |
| ☑ | Lens Studio runbook with exact capture list + video instructions + web equivalents | agents | 3 Nov | done — `lens/SETUP-LENS-STUDIO.md` §5 |
| ☑ | Evidence index with reproduction receipts | agents | 3 Nov | done — `docs/evidence/README.md` |
| ☐ | PR independently reviewed at the exact head (no self-approval), merged to `main` | agents | 4 Nov | PR #___ · reviewer: ___ |
| ☐ | Pages redeploy verified: live URL shows v2 (FOV frame, live badge) | agents | 4 Nov | curl https://sonniaai.github.io/soundcraft-orbit/web/data/session.json → `generatedAt` after merge |

## Demo video (agents record the web companion; Arthur records Lens parts if available)

| ✅ | Item | Owner | Due | Status / proof |
| --- | --- | --- | --- | --- |
| ☑ | Record the 9-beat cut per `DEMO-SCRIPT.md` (web companion, live change on camera, real mix audio) | agents | 6 Nov | done 3 Nov — `docs/evidence/orbit-demo.mp4` (85 s, 1440×900, h264+aac, 1.6 MB), recorded by `tools/record_demo.py` |
| ☑ | Captions burned in; audio levels checked; ≤ ~100 MB | agents | 6 Nov | done — burned-in captions, real mix audio under the PLAY beat, 1.6 MB |
| ☐ | (Optional, strengthens entry) Lens Studio preview screen capture per runbook §5 | Arthur | 7 Nov | `lens-preview-demo.mp4` |

## Lens evidence (Arthur-side macOS run)

| ✅ | Item | Owner | Due | Status / proof |
| --- | --- | --- | --- | --- |
| ☐ | Lens Studio 5.10+ installed; repo cloned | Arthur | 6 Nov | — |
| ☐ | Assemble lens per runbook §§1–4 (~10 min): import scripts, scene from manifest, Remote Service module allow-listing `sonniaai.github.io`, `dataUrl` = `https://sonniaai.github.io/soundcraft-orbit/web/data/session.json` | Arthur | 6 Nov | — |
| ☐ | Five preview captures (stage, FOV-crop, inspect, live before, live after) into `docs/evidence/` | Arthur | 7 Nov | `lens-*.png` |
| ☐ | (Fallback if Lens Studio blocked) web equivalents stand in — already committed | agents | done | `docs/evidence/README.md` mapping table |

## Submission pack (agents prepare; Arthur submits)

| ✅ | Item | Owner | Due | Status / proof |
| --- | --- | --- | --- | --- |
| ☑ | Devpost text: what it does, AR-first rationale, how built, challenges, learned, next | agents | 3 Nov | done — `DEVPOST.md` (paste-ready per field) |
| ☑ | Demo script / shot list | agents | 3 Nov | done — `DEMO-SCRIPT.md` |
| ☐ | Cross-check DEVPOST.md against the live submission form fields (fill any extra fields; the form's exact field list is only visible to the submitting account) | Arthur + agents | 8 Nov | — |
| ☐ | Images attached to the form: stage w/ FOV overlay, playing, inspect, live before/after pair | agents | 8 Nov | same files as `docs/evidence/` |
| ☐ | Final read: every claim in DEVPOST.md true of the live deployment (no unbuilt features implied) | agents | 8 Nov | — |
| ☐ | **Submit on Devpost ≥ 3 h before close (by 18:30 UTC / 2:30pm ET), not at the deadline** | Arthur | 9 Nov | — |
| ☐ | Post-submission check: submitted page renders, video plays, links resolve | agents | 9 Nov | — |

## Risks & fallbacks

- **Lens Studio preview not captured in time** → entry stays honest: web
  companion fully working + live; Lens as complete sources + manifest + runbook
  with pre-captured web equivalents at the same AR geometry (committed). This is
  stated plainly in DEVPOST.md; update that section if captures land.
- **Live-change beat fails on recording day** → DEMO-SCRIPT.md fallback cut uses
  the committed before/after pair with identical captions.
- **Pages caching stale assets after merge** → hard-refresh; session.json is
  served with `no-store` by the bridge and Pages assets are content-hashed by
  path change if needed.
