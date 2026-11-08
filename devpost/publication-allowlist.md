# Proposed public allowlist — what may enter the public commit

## Published milestone — 8 November, 22:02 UTC

PR #4 merged to public `main` as `36425c5`. Post-push verification matched
all 212 payload file blob IDs, 14 WAVs and seven SDK packages, with no
private checkout/credential paths, live private hostnames, embedded
repositories or LFS pointers in the payload. Receipt:
`receipts/lens-publication-20261108.json`. The checklist below is retained
as the publication procedure; its post-push gates have now been performed.

Updated 8 November 2026 (evening). Docs-prep session; read-only audit.
Nothing has been staged, committed, or pushed. The actual `git add`/push
belongs to the repository owner (permission now granted — see below).

## Current repository facts (verified 8 Nov)

- Target `SonniaAI/soundcraft-orbit` exists and is public, and the account
  now has **push permission (verified true)**. The earlier READ-only
  blocker is resolved.
- **LFS is resolved.** Custom binary/`.mjs` rules were appended at the END
  of `lens-studio-specs/.gitattributes` (the generated block above them is
  untouched). Verified: no project asset carries the LFS filter
  (`git check-attr filter` → unspecified on wav/lspkg/ts/mjs samples;
  0 LFS files). Publishable project content (Assets + Packages) totals
  **17,876,437 bytes**, largest single file **5,447,652 bytes** — all far
  under GitHub's 100 MB per-file limit. No LFS pointers, no data plan, no
  LFS CLI dependency; a plain GitHub ZIP gives the working assets.
- **Scene is clean:** `lens-studio-specs/Assets/Scene.scene` on disk (the
  16:57 official EEC `project.save`) contains **0 private machine
  hostnames** (verified by text search). The script-side `@hint` uses only
  a `<machine>` placeholder. R1 from earlier drafts is done.
- The owner's `.gitignore` now also ignores `soundcraft-review/` and the
  private checkout `soundcraft-stage-fix/` (verified via
  `git check-ignore`).

## ✅ Allowlist (add exactly these paths)

Root:

```
devpost/                                          # brief, status, and the docs in this folder
receipts/clad-runtime-verification-20261104.json
receipts/mini-daw-lens-build-20261104.json
receipts/specs-base-conversion-20261104.json
receipts/lens-native-preview-check-20261105.json
receipts/lens-play-first-framing-ux-20261106.json
receipts/lens-preview-smoke-20261108.json         # 4/4 LEAF Preview smoke — current evidence
skills-lock.json                                  # optional: locks plan-lens skill from official challengepost/learn-specs pack
tools/lens-client-tests/                          # SOURCE ONLY — tests/, package.json, package-lock.json, tsconfig.json, README.md, .gitignore
tools/preview-recording/                          # OPTIONAL, SOURCE ONLY — recorder Swift source/README/build.sh/.gitignore
```

Lens project (`lens-studio-specs/`):

```
SoundcraftOrbit.esproj
.gitignore                                        # project-local ignore rules (needed for a clean public clone)
.gitattributes                                    # includes the appended custom binary/mjs rules (the no-LFS publish path)
AGENTS.md                                         # optional but recommended: Lens-Studio-generated project reference
CLAUDE.md                                         # optional one-line stub (`@AGENTS.md`); keep with AGENTS.md or drop both
Assets/                                           # all current files (scene scrub verified above)
Packages/                                         # all 7 .lspkg + .meta (vendored SDK packages, ≈5.2 MB)
```

`tools/lens-client-tests/` and `tools/preview-recording/` must be added as
**source folders only** — never `node_modules/`, `dist/`, `build/`,
`videos/`, `debug/` outputs, or any recorded media. `dist/` and
`node_modules/` exist locally in `lens-client-tests` (22 MB) and
`build/preview-recorder` (a compiled binary) exists locally in
`preview-recording` — exclude all of these; both folders' own `.gitignore`
already covers most of it, but verify the staged file list before commit.

## ❌ Exclude from the public commit

| Path | Reason | Current git state |
|---|---|---|
| `soundcraft-review/` | Nested clone of private `SonniaAI/soundcraft`; private deployment records | **IGNORED** ✓ |
| `soundcraft-stage-fix/` | Private SoundCraft checkout | **IGNORED** ✓ |
| `layout-tooling/` | Private layout tooling checkout | not currently in-tree; keep out if it appears |
| QA screenshot canary folders | Private QA captures | keep out wherever they live |
| `tools/preview-recording/build/` | Compiled recorder binary | exclude (source-only rule above) |
| `tools/lens-client-tests/node_modules/`, `dist/` | Generated/bulk | exclude (source-only rule above) |
| `soundcraft-orbit-scene-baseline-20261106.json` | 863 KB machine scene dump (private hostname era) | **IGNORED** ✓ |
| `lens-studio-specs/.virtual-scene.json` | Machine scene dump | **IGNORED** ✓ |
| `lens-studio-specs/tempAssetGen/` | Provenance generator with machine-local paths; provenance lives publicly in `asset-provenance.md` | **IGNORED** ✓ |
| `lens-studio-specs/Plugins/` | Editor icon-atlas cache | exclude |

Also machine-ignored (verified, keep the rules): `Cache/`, `Support/`,
`Workspaces/`, `PluginsUserPreferences/`, `jsconfig.json`, `*.lock`,
`spk_debug_key.pem` (a signing key — never publish), `.mcp.json`,
`.vscode/**`, `.codex/config.toml`, `.claude/settings.local.json`,
`.cursor/mcp.json`, `.opencode/opencode.json`, and root-level agent
folders. Never disable or weaken these rules for the public push.

## Receipt notes — publication acceptance rows

| # | Acceptance row | Status 8 Nov |
|---|---|---|
| R1 | Scene scrubbed of private hostname default | **DONE** — 16:57 save; 0 hits verified |
| R2 | Private checkouts/clones untracked-and-ignored or absent (`soundcraft-review`, `soundcraft-stage-fix`, `layout-tooling`, QA canary) | **DONE** for in-tree items (ignored/absent); re-check `git status --porcelain` before staging |
| R3 | Push destination decided and writable | **DONE** — existing public `SonniaAI/soundcraft-orbit`, permission granted |
| R4 | LFS plan resolved | **DONE** — custom rules appended; 0 LFS files; 17,876,437 bytes total, largest 5,447,652 < 100 MB |
| R5 | Post-push check: public tree contains only allowlisted paths (incl. `tools/lens-client-tests` source-only, no `node_modules`/`dist`/`build`/`videos`/`debug`, no `tools/preview-recording/build/`) | **PENDING** |
| R6 | Post-push full-text search for `ts.net` returns zero | **PENDING** (pre-push scene search already 0) |
| R7 | `git log` of pushed history contains no private-clone commits | **PENDING** |
