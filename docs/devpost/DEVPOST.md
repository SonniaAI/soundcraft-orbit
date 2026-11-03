# Devpost submission text — Learn AR with SPECS

Challenge: https://learn-specs.devpost.com — submissions close **9 Nov 2026,
5:00pm EST**. This file is the paste-ready text for each submission field.
Reviewers do not clone or run the project, so the video has to show it
working (see `DEMO-SCRIPT.md`; the finished cut goes with the submission).

---

## Project title

**Orbit — see your track taking shape, at a glance, in AR**

## Tagline (short pitch)

A track-progress stage for SoundCraft, designed for Snap Spectacles first:
one glance from across the room tells you what exists, what's processed, how
far the arrangement reaches, and how the latest mix bounce measures.

## What it does

Making music is a long process with no ambient answer. Anyone walking past the
studio — or the producer glancing up from the piano — has no idea how the
track is coming along without opening a laptop and staring at a timeline.

Orbit is a spatial stage that answers four questions in one glance:

- **How far along is the arrangement?** A session ring — one segment per bar —
  fills only where *every* material-bearing track has recorded content. In the
  demo session the lead enters at bar 5, so bars 1–4 render honestly
  half-lit: "in progress", not "done".
- **What's on each track?** Six cards in signal-flow order (drums → harmony →
  melody), each with an 8-cell bar strip (what was played where), a status dot
  (empty / material / processed), and a volume tick (where it sits in the mix).
- **How does the latest bounce measure?** A plaque drops off the end of the
  stage the way a bounce drops off the end of a session: LUFS, peak, true
  peak, size, and how fresh it is.
- **Is it moving right now?** Press play and a playhead needle sweeps the ring
  while the active bar lights up on every card — the stage tracks the actual
  bounced mix, not an animation.

Everything is real: the stage renders a genuine SoundCraft session
(`first-light`, 8 bars at 120 BPM, 48 kHz, six tracks) built headlessly by the
engine's CLI, and every plaque figure comes from a verbatim engine bounce
receipt. A live bridge re-inspects the session on every change, so when the
music changes — a clip is trimmed, a new bounce lands — the ring, the cards
and the plaque update themselves within seconds. The submission evidence
includes a captured before/after pair of exactly that happening, driven by an
engine edit and measured by an engine receipt.

## Why AR-first (design rationale)

Most AR first attempts are a website floating in front of your face. Orbit
started from how the glasses differ from a screen:

- **Zero interaction for the ambient answer.** No scrolling, no navigation, no
  clicking required to learn "how far along is this track". The ring and the
  plaque answer it from across the room; everything else is one fixation away
  (cards) or deliberate (inspect).
- **One geometry, a 51° budget.** The whole stage is laid out in millimetres at
  a 1.5 m reference depth and consumes 78% of the Spectacles' 51° horizontal
  window, leaving the outer edges as peripheral reserve. The desktop companion
  renders a true-to-angle FOV overlay that dims anything the glasses would not
  show — if something is readable only outside the frame, that is a design bug
  we can see immediately.
- **Luminance first, colour second.** See-through optics lose hue against a
  bright world, so every state is readable from brightness and fill alone:
  empty is hollow, material is filled, processed gets a colour edge and a
  status-dot core, playing brightens, fresh bounces glow warm and fade with age.
- **Legibility floors.** Text never drops below 0.7° of visual angle (18 mm at
  1.5 m); glyphs never below 0.25°. The LUFS figure is the largest element on
  the stage because the loudness number is the thing people actually read aloud.
- **Three information depths, one stage.** Ambient (no interaction) → glance
  (one fixation on any card) → inspect (gaze + pinch pulls the card forward
  with its full waveform, clip list and insert chain). The stage never
  degrades into a spreadsheet in your face.

## How we built it

An AI coding agent planned and built this end to end:

1. **Information architecture first.** The agent wrote the spatial IA as a
   specification before any code: what "progress" means (material, processing,
   balance, output — each with exactly one visual channel), the mm-precise
   stage layout, the 51° FOV budget, legibility floors and the state language
   (`docs/AR-INFORMATION-ARCHITECTURE.md`).
2. **A real session, not a mock.** The engine (SoundCraft, a pure-Rust DAW)
   built `first-light` headlessly: six stems synthesised deterministically,
   imported, mixed and bounced through `soundcraft-cli 0.14.0` — producing the
   session bundle and the engine's own bounce receipt (LUFS/peak/true peak)
   that the plaque displays verbatim. Orbit integrates read-only: it ships no
   engine code and never writes back to the session.
3. **The web companion.** A dependency-free canvas app rendering the exact
   millimetre geometry, with the FOV overlay, the angular ruler, playback
   tracking of the real bounced mix, and the inspect layer.
4. **The live bridge.** A small server re-inspects the session bundle, the
   bounce receipts and the mix with the engine CLI whenever any of them
   changes; the companion polls every 4 seconds and re-renders. This is what
   makes the stage *live* — the captured before/after evidence shows a real
   engine edit (lead drops out of bar 8, rebalance, new bounce) reflected in
   the ring, the cards and the plaque within seconds, with the fresh engine
   receipt on the plaque.
5. **The Lens.** The same information architecture as a Snap Spectacles Lens:
   TypeScript scripts (`lens/Scripts/`) implementing the identical geometry
   table, a declarative scene manifest, and a data contract that fetches the
   same generated JSON through Lens Studio's RemoteServiceModule — so the
   glasses and the desktop preview can never drift apart. The lens/ directory
   plus the IA document is a complete build package for Lens Studio (the
   company's Linux/arm64 build nodes cannot run Lens Studio, so assembly and
   preview captures happen on a Mac; the step-by-step runbook, including
   exactly what to capture, is `lens/SETUP-LENS-STUDIO.md`).

**Status, stated plainly:** the web companion and the live bridge are fully
working and deployed (live URL below — open it, press play, make a change, watch
it update). The Lens ships as complete project sources + scene manifest +
assembly runbook; Lens Studio preview captures on Spectacles device simulation
are the remaining step and are pre-captured on the web companion at the same AR
geometry until then (evidence index: `docs/evidence/README.md`).

## Challenges

- Designing for 51°: cutting a full DAW session down to four questions that
  survive a small see-through window, without falling into the
  website-on-your-face trap.
- Making "progress" honest: partial ring segments instead of a progress bar,
  so half-finished bars read as half-finished.
- Live truth on glasses: the Lens and the desktop preview share one generated
  JSON schema (`soundcraft-orbit/session@1`), so neither can show stale state
  the other contradicts.
- Building on Linux/arm64 where Lens Studio does not run: the entire Lens is
  authored as sources + manifest + runbook, so the final assembly is mechanical.

## What we learned

- The discipline that matters in AR is subtraction: four questions, one visual
  channel each, and the angular budget enforces it.
- Bounding every element in millimetres at a reference depth makes the desktop
  preview a truthful proxy for the glasses — the same numbers place every
  element in Lens Studio (centimetres, divide by ten).
- An engine that can be driven headlessly (CLI in, receipts out) turns "demo
  data" into evidence: every figure on the stage is measured, not invented.

## What's next

- Lens Studio assembly + Spectacles preview captures on a Mac (runbook ready,
  ~30 minutes: `lens/SETUP-LENS-STUDIO.md`).
- Live position from the engine's transport on the glasses (the bridge already
  carries playback state).
- Multi-session rings: one stage per track, a shelf of plaques for bounce
  history.
- A glanceable "what's missing" prompt: the ring already shows *which* bars
  are thin; next, whisper the instrument that would complete them.

## Built With

typescript, javascript, canvas, python, lens-studio, snap-spectacles,
soundcraft, github-pages

## Links

- Live companion: https://sonniaai.github.io/soundcraft-orbit/web/
- Repository: https://github.com/SonniaAI/soundcraft-orbit
- Evidence index (reproduction receipts for every image):
  https://github.com/SonniaAI/soundcraft-orbit/blob/main/docs/evidence/README.md
- Video: `orbit-demo.mp4` (see `DEMO-SCRIPT.md` for the shot list it follows)
