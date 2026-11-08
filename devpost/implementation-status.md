# SoundCraft Lens: implementation and acceptance

Updated 8 November 2026, evening (current-status section below is
authoritative; the 5 November record is kept as a marked historic baseline,
and the earlier 8 Nov audit snapshot is kept with supersession notes).
This is a status record, not user approval of the draft brief or proof of a
completed hackathon submission.

## Current status — 8 November 2026 evening: Preview smoke green, publication path clear, backend still pending

**Preview (verified, receipt-backed):**

- Official EEC `project.save` at 16:57 succeeded; the scene on disk now
  contains **zero private machine hostnames** (re-verified by text search:
  0 hits). The capture controller and the LEAF test index persist in the
  saved inputs.
- Latest native full compile (21:23) succeeded. A fresh runtime window
  shows **no Lens startup exception**; 12 pads on 3 instrument panels
  register. Two editor-side warnings (editor resource-stream
  authentication; LeafPlugin skipping a destroyed panel instance during
  refresh) are recorded but not counted as Lens runtime exceptions.
- **All 4 LEAF smoke scenarios passed (21:24)** through the real LEAF MCP
  path, serially, with the Lens-side `DefaultLeafScenarioManager` PASSED
  lines as the authoritative source:
  `receipts/lens-preview-smoke-20261108.json`.
  1. `soundcraft-collider-local-geometry` — collider-local box geometry
     (an earlier failure was fixed **in the test** by refreshing native
     shape references; production collider code was not relaxed),
  2. `soundcraft-pinch-beat-pad-records-take` — correct beat/pad hit
     identity, pad and orb pulse, and `AudioComponent.isPlaying` observed,
  3. `soundcraft-drag-panel-world-fixed-restore` — drag moves the panel,
     its world-fixed parent unchanged, original transform restored,
  4. `soundcraft-pan-toggle-reverses-spatial` — the toggle reverses and
     restores the actual local spatial/position/distance-effect flags.
- **LEAF limits (kept honest):** LEAF overrides the SIK target, so these
  passes do **not** establish natural sibling-collider target
  discrimination or real-hand tracking, audibility, or any backend effect.
- Partial, optional observation: one natural world-position pinch (no
  object UID) on the bass panel's front registered one hit (take 4→5).
  This is a partial natural-input data point — **not** a per-pad or
  audible-on-hardware proof and not an essential claim.

**Tests (verified):**

- Portable suite `tools/lens-client-tests`: `npm ci && npm test` —
  **87/87 pass** against actual source.
- Standalone unit `.mjs` tests (optional; need Node ≥ 22.18), reported
  per area without aggregation: connection-status 52, capture-controller
  workflow 22, duration policy 12, playlist presentation 31, open-confirm
  23.

**Implemented in the runtime UI, still untested end-to-end:** the
connection panel exposes the companion endpoint and one-time-code pair
fields; a cleared code stays memory-only; **Open-Last-Save** requires two
distinct taps within 300 ms–8 s and the controller preserves data across
it. Real pairing, capture and save/open remain **UNTESTED because no
companion service is deployed** — no receipt can exist for them yet.

**Backend (private SoundCraft branch — code-level only, nothing deployed):**

- Spark qualification **42525348556 succeeded** at source `e72b704`:
  the complete Rust gate, isolated current/base CLI builds, real integration
  suites on Python 3.10 and 3.12, and portable ARM64 CLI all passed. The
  no-skip gate covered banked recovery and saved-sample identity. These are
  backend tests, not evidence of Lens connectivity or the 12 original pad
  files being rendered from a Lens-created save.
- PR #19 is **OPEN** at `e9f52a7`, adding a narrow test-observation race
  fix after that qualification. Its final checks are running; its hosted
  Python 3.10 and 3.12 jobs have passed. **No deployed image or
  Lens-initiated backend save/reopen exists yet.**

**Publication path (resolved):**

- Push permission to the existing public target
  `SonniaAI/soundcraft-orbit` is **granted** (verified true).
- LFS is resolved: custom binary/`.mjs` rules were appended at the end of
  the project `.gitattributes`; no project asset uses the LFS filter
  (verified 0). Assets + Packages total **17,876,437 bytes**, largest
  single file 5,447,652 bytes — far under GitHub's 100 MB per-file limit,
  so a plain GitHub ZIP works with no LFS pointers, data plan, or CLI
  dependency. See
  [`publication-allowlist.md`](publication-allowlist.md).

**Still pending (unchanged):** design-brief approval (frontmatter stays
`draft`), deployed companion/backend, any Lens↔backend round trip
(including save/reopen), per-pad natural-input and audibility proof (the
actual source-pad matching is to be proven by a later Spark read-only
job), fresh-clone runtime verification, and any recording/video/submission
(none exists yet). Live backend claims will be made **only after actual
receipts**.

## Experience to deliver

Play two or three room-fixed, movable instruments within reach. Sounds and
pulsing visuals respond immediately. The mini-DAW handles capture and placing
takes on a simple timing view automatically, without a recording-console
workflow. SoundCraft owns the editable song; the Lens is its spatial interface.

## Verified so far

- SoundCraft PRs #10–#17 are merged. Main at the latest verified merge is
  `b1679b5d5d5eb8a35eff7fee2d861a7039d20ae0`. The deployment bundle is source,
  not a live service receipt; an image containing the longer-note fix and rollout
  qualification are pending. PR #16 repairs an image-build stage selector.
- Tests exercise captured notes becoming an editable MIDI clip, authenticated
  companion calls, protected versioned saves, and reopening saved projects in
  a real headless SoundCraft process. These are backend tests, not Lens or
  hardware tests. The current take-commit limit is 999 notes per commit;
  oversize or unresolved takes are refused, not truncated or silently repaired.
- The Lens project has newly authored instruments, visual feedback scripts and
  original synthesized sounds. Historical build receipts describe their
  on-disk authoring and isolated compilation, not a successful running Preview.
- Lens Studio's native MCP is available from the project directory. A direct
  read-only check confirmed the intended project is open and the user is signed
  in. Neither fact proves compilation or playback.
- The compatible-package repair now passes a full project compile and a fresh
  runtime window with no errors. Native Preview hand-pinch interaction registered
  a pad hit; a panel drag changed its runtime position. Fresh captures show the
  prototype. See `receipts/lens-native-preview-check-20261105.json` for evidence
  and limits: the take bar is still labelled simulated, and no Lens/backend round
  trip has been verified.
- The reviewed capture controller and pairing/status UI have been added to the
  scene. A Preview pinch while the service is absent reported a missed hit and
  did not display a saved badge. Actual pairing and saving are not yet verified.
- On 6 November the Preview layout was adjusted and saved. A fresh native-MCP
  compile and log window were clean; a simulated hand pinch registered a pad hit.
  See `receipts/lens-play-first-framing-ux-20261106.json`. This is local Preview
  interaction evidence, not backend capture, device audio or saved-project proof.

## In progress, not yet accepted

- Improve default Preview framing and text readability, and extend the verified
  pad/drag checks into complete, reproducible interaction scenarios.
- Deploy the reviewed companion and a compatible, provenance-checked SoundCraft
  binary on a Spark with dedicated persistent project storage. The optional
  cluster admission policy is not authorized by application rollout and stays
  unapplied unless separately approved by the cluster owner.
- Verify a private HTTPS/Tailscale endpoint from the laptop, then from the Lens
  runtime itself. A shell HTTP check alone is insufficient.
- Pair the Lens without embedding cluster, Forge, or MCP credentials. Short-lived
  companion credentials remain local and must not enter this public repository.
- Replace the prototype's labelled simulated take bar with verified real event
  capture, backend readback, editable clip identity and a confirmed save receipt.
  The wired controller is not proof of connectivity while the service is absent.

## Required acceptance checks

1. **Playing:** actual pad interaction makes an audible local-monitor sound and
   matching visual response. Capture timestamps and note-offs follow that same
   path. A delayed backend echo must not be mixed with the local attack.
2. **Automatic capture:** a phrase grows in the timing view from played events,
   becomes an editable SoundCraft clip, and reaches a confirmed versioned save
   without a record-button workflow. No saved badge before confirmation.
3. **Persistence:** reopen the saved backend project in a fresh process and
   verify note pitches, velocities, timing and source/instrument references.
   A screenshot of a growing bar is not persistence evidence.
4. **Failures:** expired pairing, lost network and uncertain commit/save outcomes
   stay visible. Unsent local performances remain marked unsynced; do not blindly
   replay note-ons or duplicate takes.
5. **Spatial controls:** panels stay in the room and can be moved intentionally.
   Check the panning link and unlink control. Local spatial monitoring is not
   evidence of saved-song pan automation; those claims need separate readback.

## Explicit limits

- The headless backend has no real-time audio-thread note monitoring. Its
  transport hook is a labelled simulation, not a running desktop DAW clock.
- The previous one-second stuck-note window cannot faithfully capture the
  prototype's longer bass and chord sounds in overlapping phrases. The merged
  backend can negotiate a longer bounded window, but the Lens-to-deployed-service
  negotiation and actual saved long-note round trip still need verification.
- Notes still open when a live session disconnects have unknown duration. The
  backend refuses to commit unresolved musical data rather than inventing it.
- Laptop Preview can use a tailnet connection. Hardware glasses and public
  judges are not assumed to have Tailscale access. Never solve this by publishing
  private service credentials or exposing an unauthenticated control server.
- Full plugin panels, detailed playlist editing, the routing switchboard,
  custom hand-speed/pose input and verified voice control are not implemented
  acceptance claims for this first playable slice.
- Original SoundCraft/Forge and the older read-only Orbit viewer are
  pre-existing work. Disclose them; do not present the viewer as a new playable
  Lens or the backend tests as a successful Lens demonstration.

## 8 November addendum — earlier same-day audit snapshot (kept historic; superseded in part by the current-status section above)

> Supersession notes: (1) the READ-only push limit has since been **resolved**
> (permission granted); (2) the `Scene.scene` hostname default has since been
> **scrubbed** (16:57 save, 0 private hosts on disk); (3) `soundcraft-review/`
> has since been **ignored**. The rest of this snapshot still applies.

- The repo's own logic test
  (`lens-studio-specs/Assets/Scripts/tests/soundcraft-connection-status.test.mjs`)
  was re-run and passes (node v26.7.0, exit 0), including its
  credential-hygiene checks. Still a logic test, not a Lens runtime test.
- SoundCraft side, read from the private working clone: PR #18 (companion
  image ALSA package fix) merged after the PRs listed above. Still
  **source-level**: no deployed image or live service receipt exists, so
  the "not deployed" claim stands.
- Publishing path audited; three concrete blockers recorded with fixes in
  [`publication-allowlist.md`](publication-allowlist.md): (1) the account
  has only READ on the already-public origin repo, (2) `Scene.scene` still
  carries a private machine hostname as the companion-URL default and must
  be scrubbed before any push, (3) the private `soundcraft-review/` nested
  clone is currently untracked and un-ignored — never `git add .` from the
  root.
- Asset provenance is documented (14 generated WAVs — 12 playable
  one-shots + demo loop + UI click — original synthesis; 7 vendored
  packages): [`asset-provenance.md`](asset-provenance.md). Judge-facing
  run/reproduce instructions and limits:
  [`reproducibility.md`](reproducibility.md). Demo + <3-min video plan:
  [`demo-runbook.md`](demo-runbook.md). Full acceptance-vs-receipt table:
  [`submission-checklist.md`](submission-checklist.md).

## 8 November integration follow-up

- Public repository write access is now verified. The private checkout and
  local infrastructure/screenshot records are explicitly ignored. The Lens
  project has not yet been published; its authored private endpoint must be
  removed before staging the scene.
- Independent client review verified real buffering of over-budget hits,
  generation-specific finishes, and no backend admission or guessed commit
  while the advertised take limit is unknown. The lightweight suite passed
  87 checks. These are client tests, not a deployed-service receipt.
- The original WAV headers show bass samples at 1.864263 seconds and chord
  samples at 5.219887 seconds. The controller now requests a bounded 7-second
  stuck-note window. Twelve local header/policy checks passed; actual deployed
  long-note negotiation remains pending.
- A fresh native Lens Studio compile succeeded and a refresh produced no Lens
  runtime errors. Device-view inspection still found cropped controls, so
  default framing is being corrected rather than declared accepted.
- Spark qualification run `42495322059` at source `cd0ee061e73e99b82dfe86a4da498732feeb3624`
  passed the complete Rust gate and both native binary builds. Its full Python
  run failed three test-harness cases with 1,651 tests passing. The run is
  **not green**; fixture corrections and a new Spark run are required before
  merge/deployment. No SoundCraft build or execution ran on the laptop for
  this qualification.
- No deployed SoundCraft service or Lens-to-backend save/reopen receipt has
  been established yet. The design brief remains a draft.
