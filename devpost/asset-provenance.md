# Asset provenance — SoundCraft Orbit Lens project

Updated 8 November 2026. Scope: everything the public Lens project
(`lens-studio-specs/SoundcraftOrbit.esproj`) ships in `Assets/` and
`Packages/`. Every claim below points at an on-disk artifact or receipt.
**Correction to earlier notes:** the project ships **14 generated WAVs**
(12 playable instrument one-shots + 1 demo loop + 1 UI click), not 12. The
"12" figure that circulated refers to the **12 wired pad
AudioComponents** (3 panels × 4 pads) — see
`receipts/mini-daw-lens-build-20261104.json` (`audioAssets`, `wiring`).

## Audio — original synthesized WAVs (14 files, ≈9.9 MB total)

Location: `lens-studio-specs/Assets/GeneratedSFX/`.

| Group | Files | Role |
|---|---|---|
| Drum pads | `pad_kick.wav`, `pad_snare.wav`, `pad_hat.wav`, `pad_clap.wav` | Beat panel one-shots |
| Bass | `bass_a.wav` (A1), `bass_c.wav` (C2), `bass_d.wav` (D2), `bass_e.wav` (E2) | Bass panel one-shots |
| Chords | `chord_1.wav` (Cm), `chord_2.wav` (Bb), `chord_3.wav` (Ab), `chord_4.wav` (Eb) | Chord panel one-shots |
| Demo loop | `demo_vapor.wav` — "VAPOR SUNSET", 30.9 s vaporwave loop, C minor i–VII–VI–VII, 70 BPM, seeds pinned (chords `133985801`, drums `595341609`) | Demo transport loop |
| UI | `ui_toggle.wav` | Button/toggle click |

**How they were made:** local algorithmic synthesis via the ls-clad
`build-music` + `build-sfx` engines (scale-degree composition + synthesis;
sample-free, license-clean, fully offline). The generator script is kept at
`lens-studio-specs/tempAssetGen/gen_music_soundcraft_pack.js` (authoring
session 4 Nov 2026; see `receipts/mini-daw-lens-build-20261104.json`).

**Quality gate (from the same receipt):** `ffmpeg volumedetect` on all 14
WAVs — max_volume between −0.4 and −11.1 dB, silence floor −30 dB (all
pass). **Originality:** fresh synthesis in the build session; no audio or
code reused from the older read-only Orbit/web project.

> Publishing note: `tempAssetGen/gen_music_soundcraft_pack.js` contains
> machine-local absolute paths (local temp-folder + username). Do not
> publish it as-is — see
> [`publication-allowlist.md`](publication-allowlist.md). The provenance
> facts above are the public record; the script itself stays optional.

## Packages (7 `.lspkg`, ≈5.2 MB total)

Location: `lens-studio-specs/Packages/`. All installed from the official
Lens Studio Asset Library via the native MCP
(`receipts/specs-base-conversion-20261104.json`, 4 Nov 2026; runtime log
confirms **SIK 0.18.0** active — `receipts/lens-native-preview-check-20261105.json`).

| Package | Purpose in this project |
|---|---|
| `SpectaclesInteractionKit.lspkg` | Hand/pinch/drag interaction (core of the playable demo) |
| `SpectaclesUIKit.lspkg` | UI components used by panels |
| `Motion.lspkg` | Installed as a UIKit dependency |
| `Icons.lspkg` | Icon assets installed with SIK/UIKit |
| `Leaf.lspkg` | Test framework — four registered Preview smoke scenarios passed; see `receipts/lens-preview-smoke-20261108.json` for their scope and limits |
| `AiPreviewAgentInspect.lspkg` | Preview inspection agents (editor-side aid) |
| `AiPreviewAgentInteract.lspkg` | Preview gesture agents (editor-side aid) |

**License status:** each archive ships a `Package/Assets/README.md`;
**none contains a standalone LICENSE file** (checked all 7 archives on
8 Nov 2026). They are Snap-published Lens Studio packages distributed for
use inside Lens Studio projects; redistributing them inside a public Lens
Studio project directory is the normal, intended usage. If a reviewer asks,
the authoritative terms are Snap's Lens Studio/Asset Library terms, not this
repository. Do not strip the READMEs from the archives.

## Other bundled assets

| Asset | Origin |
|---|---|
| `Assets/Echopark.hdr` | Lens Studio environment HDRI that arrived with the project's base template (project converted to a SPECS base on 4 Nov 2026, `receipts/specs-base-conversion-20261104.json`; meta shows `PackageType: LegacyPackage`, `EnvmapTextureImporter`). Not authored by this project; no third-party license claimed beyond Lens Studio's own asset terms. |
| `Assets/Meshes/SC*.mesh`, `Assets/Materials/*.mat`, `Assets/Materials/unlit.graphShader`, `Assets/color_correction.graphShader` | Authored for this project during the 4 Nov build session (see `receipts/mini-daw-lens-build-20261104.json`, `scene` section). |
| `Assets/Scripts/**` | Authored TypeScript for this project; the companion client family (`Soundcraft*.ts`) is original work for this Lens. |

## What this project does NOT contain

- No SoundCraft or Forge engine code, binaries, or samples (those are
  pre-existing and separate (the private fork is actively developed) — disclosed in
  [`submission-checklist.md`](submission-checklist.md)).
- No audio sampled from commercial music.
- No credentials, tokens, or pairing codes (all pairing/token state is
  runtime in-memory by design — `Assets/Scripts/SoundcraftCompanionHttp.ts`,
  `SoundcraftCompanionTypes.ts`; the scene's only endpoint default is a
  private-machine URL that must be scrubbed before publishing — see
  [`publication-allowlist.md`](publication-allowlist.md)).
