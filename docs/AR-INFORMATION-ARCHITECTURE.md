# Orbit — AR-first information architecture for SoundCraft track progress

**Product target:** Snap Spectacles — see-through waveguide AR glasses, 51° horizontal field of view (founder-provided envelope; ~30° vertical assumed conservatively).
**Purpose:** a glance tells Arthur how the track is coming along — what exists, what is processed, how far the arrangement reaches, and the state of the latest mix bounce — without opening a laptop.
**Rule of the design:** this is *not* a website ported to glasses. There is no scrolling, no dense grid, no navigation. One spatial stage, three information depths, zero interaction required for the ambient answer.

Companions implementing this exact geometry:

- `web/` — desktop preview of the same IA (with a true-to-angle FOV overlay),
- `lens/` — Snap Spectacles Lens Studio project (scripts + scene manifest).

Both read the same data schema (`soundcraft-orbit/session@1`), produced from a real SoundCraft session by `tools/build_data.py` (read-only CLI inspect + `file.bounce_mix` receipts).

---

## 1. What "progress" means here

A SoundCraft session progresses on four axes. The IA gives each axis one dedicated visual channel — never two encodings for one fact:

| Axis | Question it answers | Visual channel |
| --- | --- | --- |
| **Material** | Which bars have sound on each track? | 8-segment bar strip on each track card; the session ring fills as *all* tracks cover a bar |
| **Processing** | Which tracks are shaped (inserts)? | Colour edge intensity + status-dot core on each card |
| **Balance** | Where does each track sit in the mix? | Volume tick on the card's right edge |
| **Output** | Has the mix been bounced, and how loud? | The bounce plaque (LUFS / peak / true peak / age) |

Session-level completion is the **ring**: segment *k* is fully lit only when every material-bearing track covers bar *k*. In the demo session (`first-light`), the Lead only enters at bar 5 — bars 1–4 render partially lit, which is exactly the glanceable "what's still missing" answer.

## 2. Spatial arrangement (one geometry, in millimetres)

All coordinates are millimetres at a 1.5 m reference depth from the user, x to the right, y up. The web companion projects these literally; the Lens places SceneObjects at these coordinates (Lens units are centimetres → divide by 10). This table is the single source of truth, mirrored in `web/app.js` and `lens/Scripts/OrbitSessionController.ts`.

| Element | Position (x, y, depth) | Size | Encodes |
| --- | --- | --- | --- |
| **Session ring** (8 bar segments + center readout) | −330, +40, 1500 | R 110, ring thickness 26 | bar coverage, playhead, BPM (center) |
| **Track cards** ×6 on a shallow arc | θ −2.5°→+17.5°, depth 1450→1650, y −60 (+20 mm bow) | 84 × 140 | per-track material / processing / balance |
| **Bounce plaque** | −330, −285, 1500 | 200 × 104 | output state (LUFS, peaks, age, size) |

Rationale:

- **The ring sits nearest the gaze axis** (−12.4° left of center). It is the one number that answers "how far along is the track" — the ambient answer requires no eye movement to the periphery.
- **Track cards read left→right in signal-flow order** (rhythm → harmony → melody: Kick, Snare, Hats, Bass, Keys, Lead), the mental model of a console bent into a shallow arc around the user. Depth staggers 1450→1650 mm so each card gets its own parallax plane — cards never visually stack.
- **The plaque hangs below the ring** — the "output tray" under the session core. Mix bounces are artifacts that materialize there, which keeps the metaphor physical: the track is a thing being built; the bounce is the thing that drops off the end of it.
- The full stage spans −16.4° … +19.8° horizontally — comfortably inside the ±25.5° half-FOV, leaving the outer ~5° on each side as peripheral reserve (head motion, not eye strain, brings edges in).

## 3. The 51° FOV budget

At 1.5 m the glasses show a window ≈ 1434 mm wide × ≈ 804 mm high. The design consumes:

- horizontally: −440 … +685 mm of the ±717 mm window (78% of width),
- vertically: −337 … +176 mm of the ±402 mm window (64% of height).

The unused margin is deliberate: see-through optics vignette at the edge and world content competes there. Nothing essential lives in the outer 20% of the frame. The web companion's **FOV overlay** dims everything outside this window — anything readable only outside the dashed frame is a design bug.

## 4. Legibility floor (small angular sizes on see-through optics)

At 1.5 m, 1° ≈ 26 mm. Two hard floors, chosen for waveguide luminance and contrast-on-world:

- **Text: ≥ 0.7°** (≥ 18 mm cap height). Card names, BPM, LUFS figures all clear this; the LUFS number is the largest element on the stage at 34 mm (1.3°) because decibel values are the thing users actually read aloud.
- **Glyphs (non-text symbols): ≥ 0.25°** (≥ 6.5 mm). Bar-strip cells are 7–8 mm; status dots 11 mm diameter. Glyphs carry state by *fill vs. outline*, which survives low contrast better than shape detail.

Sub-floor content (9 mm bar indices, 10 mm captions) is *supportive* — it repeats information available from a glyph or a larger figure and is never the only carrier.

## 5. State language (luminance-first, colour-second)

See-through displays lose hue on bright world backgrounds, so every state is readable from **luminance and fill alone**; hue is reinforcement, not carrier:

| State | Rendering |
| --- | --- |
| Empty (no material) | hollow outline only — the world shows through the card |
| Material recorded | filled elements at 45–60% — clearly "present" |
| Processed (inserts) | colour edge at 95% + status dot gets a dark core |
| Playing / active | card border brightens to 65%, bar cell at full brightness |
| Bounce fresh (< 2 min) | plaque border at 50% warm accent, fades to 25% with age |

Track hues (fixed, colour-vision-deficiency-aware by *luminance* separation, hue redundant): Kick `#FFB03B`, Snare `#FF6F61`, Hats `#4ECDC4`, Bass `#A78BFA`, Keys `#7BD88F`, Lead `#5EA9FF`.

## 6. Three information depths (no website-on-your-face)

1. **Ambient (0 interaction):** ring fill + plaque presence answer "how far along, and has it been bounced" from across the room.
2. **Glance (one fixation):** any card reads its material strip + status dot; the arc ordering means the eye already knows *where* the drums vs. the lead live.
3. **Inspect (deliberate):** gaze + pinch on a card pulls it forward (Lens) / clicking it opens the focus panel (web): full waveform, clip list, insert chain, volume. The inspect layer is the *only* place with prose-level detail, and it is modal — the ambient stage never degrades into a spreadsheet.

Interaction budget on-glasses: one gesture (pinch-pull), one dismissal (release / pinch-away). No scrolling, no pointer, no text entry.

## 7. Data contract (read-only integration with SoundCraft)

```text
soundcraft-cli 0.14.0
  run --in session/first-light.scraft --inspect   # read-only session JSON
  script tools/build_session.scmd --bounce ...    # build + bounce with engine receipt
        → receipt: bytes, lufs, peak_db, true_peak_db, seconds
```

`tools/build_data.py` merges the live inspect + the committed bounce receipt + per-stem waveform peaks into `web/data/session.json` (`soundcraft-orbit/session@1`). The bridge (`tools/serve.py`) re-inspects whenever the `.scraft` mtime changes, so the web companion genuinely renders *the* session as it is on disk — the Lens fetches the same JSON through `RemoteServiceModule`.

The SoundCraft repositories are PARKED by founder order (2026-10-26): this project integrates read-only and ships no engine code.
