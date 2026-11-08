# SoundCraft Orbit — LEAF smoke scenarios (Assets/LeafTests)

TEST-OWNED, NEW-ONLY folder. Author: LEAF-test subagent. **Nothing in
`Assets/Scripts/`, the scene, packages, or credentials was read-modified —
production modules are only *imported* read-only.** Scenario authoring is
complete and source-verified, but the suite has **NOT been compiled,
attached, or run** (see "Status" below) — the parent session compiles and
runs once the scene owner and controller worker settle. No LEAF pass is
claimed.

## Files (all new)

| File | Purpose |
|---|---|
| `LeafIndex.ts` | `@scenariosIndex` registration module — the only component that must be attached to the scene. |
| `SoundcraftLeafInteractor.ts` | `DefaultLeafInteractor` subclass. Parent-disambiguated lookups (`Pad0`/`PanToggle` exist under all three panels) + collider guard. All interactions are **real SIK** (LEAF's `DefaultSikInteractor` drives hover→`onTriggerStart`→`onTriggerEnd` / `onDragStart`→`onDragEnd` on the production `Interactable` — the same handlers a hand pinch fires; no `hitPad()` bypass). |
| `SoundcraftPinchBeatPadScenario.ts` | id `soundcraft-pinch-beat-pad-records-take` |
| `SoundcraftDragPanelScenario.ts` | id `soundcraft-drag-panel-world-fixed-restore` |
| `SoundcraftPanToggleScenario.ts` | id `soundcraft-pan-toggle-reverses-spatial` |
| `ColliderLocalGeometryScenario.ts` | id `soundcraft-collider-local-geometry` — pure geometry contract for `ensureBoxCollider` on self-created scratch objects (no production state). |

## What each scenario proves (target: actual Preview, local mode)

### 1. `soundcraft-pinch-beat-pad-records-take`
Real SIK trigger on **`BeatPanel` → `Pad0`** (interactable runtime-ensured by
`PadInstrument`; AudioComponent editor-wired, confirmed in scene serialize):
- `SoundcraftBus.take` length **+1 delta** vs pre-trigger baseline.
- Identity of the new hit: `instrument === "beat"`, `pad === 0`, `label === "KICK"`;
  the `onHit` bus event fired with the same payload.
- **Pulsing objects**: `Pad0` local scale pulses > 1.1× base during the 0.28 s
  pulse and settles back; `PulseOrb/OrbCore` scale pulses > 1.2× baseline
  (hit pulse peaks 1.42× vs the demo's 1.07× breathe — thresholds separate them).
- **Audio playing — actual query only**: `AudioComponent.isPlaying()` observed
  `true` while polling ≤ 600 ms (method verified in `Support/StudioLib.d.ts`;
  `duration > 0` also asserted = wired one-shot). **No audibility claim.**
- Restore (test-owned): `take` truncated to baseline, the session-bar tick the
  hit relit is disabled again, `onHit` listener unsubscribed in `finally`.

### 2. `soundcraft-drag-panel-world-fixed-restore`
Real SIK drag on the **`BeatPanel`** root grab (`Interactable` +
`InteractableManipulation` runtime-ensured; collider presence asserted first):
- Structural proof of **world-fixed, not head-parented**: parent is exactly
  `"SoundcraftRoot"`, no `"Camera"`/`"Camera Object"` ancestor (camera confirmed
  on separate root `"Camera Object"`), and the parent's world position stays
  static while the panel's world position moves > 1 cm (drag delta 8, 5, 0 cm
  over 800 ms).
- **Restore is test-owned**: scenario writes `setWorldPosition`/`setWorldRotation`
  back to pre-drag values in a `finally` block and asserts the restore (position
  and quaternion, 0.1 precision). Still parented to `SoundcraftRoot` afterwards.
- No bus/audio state touched.

### 3. `soundcraft-pan-toggle-reverses-spatial`
Real SIK trigger on **`BeatPanel` → `PanToggle`** (twice):
- `panLinked` (read from `SoundcraftBus.instruments`, delta-based baseline)
  **reverses** after trigger 1 and **restores** after trigger 2.
- **Actual audio query**: the Pad0 `AudioComponent`'s
  `spatialAudio.enabled`, `spatialAudio.positionEffect.enabled`,
  `spatialAudio.distanceEffect.enabled` each equal the live `panLinked` value
  after both triggers — i.e. spatial is actually enabled when linked (what
  `applySpatial()` writes). **No audibility claim.**
- Side effects inherent to the real toggle path: the panel's UiAudio blip and
  the `[Soundcraft] … pan link …` log line. No take/state residue.

### 4. `soundcraft-collider-local-geometry`
Pure geometry contract for `ensureBoxCollider` (SoundcraftBus) on **self-created
scratch objects** (two chains, destroyed in `finally`; zero production state,
audio, UI, or interactions):
- `size` stored **verbatim local** on the BoxShape — unit `(1,1,1)` for
  scale-as-size visuals (pads/toggle/DemoPad), plate sizes `(11,38,1.2)` /
  `(34,14,1.2)` style for panel roots under scaled parents (NOT divided —
  dividing would put a world-size collider on a 0.66-scaled panel).
- `fitVisual` is `false` **after** the call — including after an external
  `fitVisual = true` (the SDK resets it to `true` on every shape assignment;
  the post-assignment set must win). Component is **reused**, not duplicated.
- **Contract split (v2 lesson)**: componentwise `getWorldScale()` equality —
  root `(2,3,4)` × pad `(8,8,2.5)` = `(16,24,10)` — is asserted **only in the
  unrotated chain**. Under the rotated non-uniform chain the test asserts the
  unit LOCAL shape unchanged + **world corners** via the verified
  `getWorldTransform().multiplyPoint()` against an independent per-level TRS
  composition (test-owned multiply-add + SDK `quat.multiplyVec3` per level) —
  never world-scale products (affine basis under rotated non-uniform parents
  is decomposition-dependent; `getWorldScale()` is documented lossy there).
- v1 post-mortem ("Expected 16 / Received 29.49251365661621"): v1 read
  `box.size` from a Shape **captured before a later re-ensure detached it** —
  a stale-wrapper read of freed native memory (garbage 1.8432821035385133 ×
  16). Exhaustive decomposition search (cols/rows/√diag(MᵀM)/SVD/|diag|/
  eigen-projection) over both rotation states proves no affine world-scale
  path yields 29.4925. v2 never holds a Shape reference across re-ensures.

## Safety guards (per-run contract)

- **Offline / preview-local**: nothing imports or calls
  `SoundcraftCaptureController`, `SoundcraftCompanionClient/Http`,
  `ConnectionPanel`, or any network/capture path. No backend calls, no fake
  replies, no SIM authoring.
- **No destructive pads**: `ClearPad` / `DemoPad` are never triggered; the take
  is only *extended by our one hit* and then **truncated back to baseline**
  (earlier hits preserved). If any required object is missing, the scenario
  **throws with the missing name** (a finding / SKIP-worthy environment issue)
  — it never fakes a pass.
- **Restores**: take baseline, relit tick, panel world transform, pan-link
  state + spatial flags. `PulseOrb`/pad pulse visuals self-restore via their
  own animations. Known cosmetic caveat: if a pre-existing user hit had already
  lit the *same* tick slot, our restore disables it too (preview-only visual;
  re-lights on any `clearTake` refresh).
- Scenarios run sequentially against the shared live lens (LEAF default);
  all assertions are delta-based, never absolute session state.

## Scene facts the scenarios rely on (verified via read-only scene serialize)

| object_name | parent | relevant components |
|---|---|---|
| `BeatPanel` / `BassPanel` / `ChordPanel` | `SoundcraftRoot` | ScriptComponent (`PadInstrument`); runtime-ensured collider+`Interactable`+`InteractableManipulation` on root |
| `Pad0..Pad3` | each panel root | RenderMeshVisual + **AudioComponent** (editor-wired one-shots); runtime-ensured collider+`Interactable` |
| `PanToggle` | each panel root | RenderMeshVisual; runtime-ensured collider+`Interactable` |
| `PlaylistPanel` | `SoundcraftRoot` | ScriptComponent (`PlaylistPanel`); children `DemoPad`, `ClearPad`, `Tick0..15`, `UiAudio` |
| `PulseOrb` → `OrbCore`, `OrbHalo` | `SoundcraftRoot` | ScriptComponent (`PulseOrb`) |
| `Camera Object` | scene root | Camera + AudioListenerComponent (NOT a parent of any panel) |
| `CaptureController`, `ConnectionPanel`, `DawManager` | `SoundcraftRoot` | deliberately untouched |

Interactables/colliders are added at runtime in `PadInstrument`/`PlaylistPanel`
`onAwake`, so scenarios sleep 1500 ms before touching anything.

## Exact wiring steps for the scene owner / parent session

The test author did **NOT** attach anything (scene owner active) and did
**NOT** compile. When the scene/layout writer and the controller worker
(runtime HTTPS setup, `explicitSafeOpenLastSaved`, `getStatusSnapshot`) are
settled:

1. **Force TypeScript recompile** via MCP (`RecompileTypeScriptTool`). LS
   auto-generates `.meta` files for the new `Assets/LeafTests/*.ts` on
   refresh/compile. Fix nothing in this folder by hand unless a real error
   is reported — do not "fix" by editing production files.
2. **Create a root SceneObject named `LeafIndex`** (under `SoundcraftRoot`
   or scene root — hierarchy position irrelevant to registration).
3. **Add a ScriptComponent** to it and set its **scriptAsset** to
   `Assets/LeafTests/LeafIndex.ts`.
4. Recompile once more; expect a clean build. On start, the LeafPlugin panel
   should list the three scenario ids above (registered via `@scenariosIndex`).
5. **Run from the LeafPlugin panel** (preview running, local mode). No
   `ScenarioClient` auto-runner is shipped on purpose — auto-run in the
   shared preview could collide with other writers' work. Run scenarios one
   at a time from the panel.
6. Expected per scenario: `[SUCCESS]`-style pass. Any failure names the
   missing object/precondition first — treat those as findings, not flaky.

## Status (honest)

- **Authored**: yes — all imports, type names, property/method signatures
  checked against actual sources (see confidence table).
- **Compiled**: **NOT RUN** — deliberately deferred (compile via MCP only once
  other writers settle; parent owns final compile).
- **Attached to scene**: NOT done (scene owner owns the scene).
- **Executed in preview / LeafPanel**: NOT run. **No LEAF pass is claimed.**
- IK (`createIKInteractor`) reachability coverage: intentionally **not
  authored** in this batch to keep the smoke set minimal and preview-local;
  recommended as a follow-up for arm's-reach validation of the three panels.

## Source API confidence

All verified against actual installed package source in
`Cache/TypeScript/Src/Packages/` (read-only) and `Support/StudioLib.d.ts`:

| API used | Source | Confidence |
|---|---|---|
| `Scenario` (abstract `run()`, `@component`) | `Leaf.lspkg/Scenarios/scenario/Scenario.ts` | high |
| `@scenariosIndex` decorator + `ScenarioMetadata {id, typename}` | `ScenarioIndexDecorator.ts`, `ScenarioMetadata.ts` | high |
| `DefaultLeafInteractor` (creates real `DefaultSikInteractor`), `trigger/drag` event pipeline | `DefaultLeafInteractor.ts`, `BaseLeafInteractor.ts` (read in full) | high |
| `findInteractablesByName(name, root?, enabledOnly?)`, `findInteractables(matcher, root?, enabledOnly?)`, `matchInteractableName(name, enabledOnly?)` | `Interactors/InteractableUtils.ts` (read in full) | high |
| `matchSceneObjectParentName`, `hasAncestorWithName`, `sleep`, `nextFrame`, `findSceneObjectByName` | `Utils/common/Utils.ts` (read in full) | high |
| `expect` matchers `toBe/not/toBeNull/toBeGreaterThan/toBeGreaterThanOrEqual*/toBeCloseTo/toBeTruthy` | `Utils/common/Expect.ts` (read in full) | high — note `toBeGreaterThanOrEqual` does **not** exist; scenarios use `toBeGreaterThan(-1)` / `toBe(...)` instead (authored accordingly) |
| `AudioComponent.isPlaying()` (method), `.duration`, `.spatialAudio.{enabled,positionEffect,distanceEffect}.enabled` | `Support/StudioLib.d.ts` lines ~25902+ (`SpatialAudio` ~25858) | high |
| `Transform.getWorldPosition/getWorldRotation/setWorldPosition/setWorldRotation`, `vec3.distance` | `Support/StudioLib.d.ts` ~13219–13259 | high |
| SIK `Event.add(cb) → unsubscribe` | `SpectaclesInteractionKit.lspkg/Utils/Event.ts` | high |
| `SoundcraftBus.{take, onHit, instruments}`, `audioOf`, `findChild`, `PadInstrumentLike`, `HitInfo` | `Assets/Scripts/SoundcraftBus.ts` (read-only) | high |
| Beat layout labels (`"KICK · SNARE · HAT · CLAP"` → Pad0 `"KICK"`), pulse magnitudes (pad 1.3×/0.28 s, orb 1.42×/0.4 s, breathe 1.07×), `panLinked=true` default | `Assets/Scripts/PadInstrument.ts`, `PulseOrb.ts` | high |
| Scene hierarchy names/parents | `.virtual-scene.json` read-only serialize (this session) | high |
| SIK version | `Cache/SpectaclesInteractionKit.v0.18.0.lspkg` versioned artifact (receipt said 0.18; matches) | medium-high (confirm in editor package list when convenient) |
