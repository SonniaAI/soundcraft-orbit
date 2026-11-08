# Submission checklist — Learn AR with SPECS (SoundCraft Orbit)

Updated 8 November 2026, evening. Status vocabulary: **VERIFIED** = receipt
or reproduced check on disk; **PENDING** = not yet true, with the exact
missing artifact named. This checklist does not claim a completed
submission; no recording, YouTube upload, or submission exists yet.

## A. Claims audit (current truth)

| Claim | Status | Evidence / gap |
|---|---|---|
| Lens project compiles and runs in Preview, no Lens startup exception | **VERIFIED** | native full compile 21:23 succeeded; fresh runtime window clean; 12 pads / 3 panels register — `receipts/lens-preview-smoke-20261108.json` (editor-side warnings recorded separately, not counted as Lens exceptions) |
| On-disk scene contains no private machine hostnames | **VERIFIED** | 16:57 EEC `project.save` succeeded; text search 0 hits |
| 4/4 LEAF Preview smoke scenarios pass (real MCP, serial) | **VERIFIED** | `receipts/lens-preview-smoke-20261108.json` — collider geometry, pinch pad identity + `AudioComponent.isPlaying`, world-fixed drag restore, pan-toggle spatial flag restore. **Limit:** overridden SIK target ⇒ no natural target discrimination / real hands / audibility / backend |
| Portable client-test suite passes | **VERIFIED** | `tools/lens-client-tests` `npm ci && npm test` 87/87 vs actual source |
| Unit tests pass per area (no aggregate) | **VERIFIED** | Node ≥ 22.18 `.mjs`: status 52 · workflow 22 · duration 12 · playlist 31 · open-confirm 23 |
| Take capture into the playlist (local, session-only) | **VERIFIED** | receipts: pinch increments the local take; local/unsaved status stays visible |
| Open-Last-Save two-tap control and code-clearing implemented in runtime UI | **VERIFIED (UI only)** | implemented, code stays memory-only, controller preserves data — **untested against a real service** |
| Sounds are original generated audio (14 WAVs: 12 pads + demo loop + UI) | **VERIFIED** | `receipts/mini-daw-lens-build-20261104.json` + `devpost/asset-provenance.md`; no proprietary/private audio |
| Publish path is open (push permission granted; no-LFS assets) | **VERIFIED** | existing public `SonniaAI/soundcraft-orbit` target writable (permission granted, verified true); `.gitattributes` custom rules ⇒ 0 LFS files; Assets+Packages 17,876,437 bytes, largest 5,447,652 — see `publication-allowlist.md` |
| Backend take commit → editable clip → versioned save from this Lens | **PENDING** | Spark backend qualification `42525348556` passed; PR #19 at `e9f52a7` is awaiting final checks. **No deployed service or Lens save/reopen is claimed** |
| Deployed SoundCraft environment | **PENDING — does not exist** | no live service receipt; "DAW really connected" is not claimed |
| Per-pad natural input + audible result | **PENDING (partial only)** | one natural world-position pinch on bass front registered one hit (take 4→5); not per-pad, not audibility, not hardware |
| Pad plays its assigned source | **PENDING** | to be proven by a later Spark read-only job; not claimed now |
| Spectacles hardware demo | **PENDING — no device** | Preview-only by constraint; disclosed |
| Approved plan-lens design brief | **PENDING** | `devpost/design-brief.md` frontmatter stays `draft`; learner approval outstanding |
| Public repo containing Lens project + devpost docs | **PENDING** | path open (allowlist rows R5–R7 remain: post-push verification) |
| Public YouTube video <3 min | **PENDING** | no recording exists; recorder source in `tools/preview-recording/` is optional; video-upload authentication still unknown |

## B. Acceptance rows awaiting actual receipts

Each row becomes done only when a dated receipt JSON in `receipts/` records
it (same format as existing receipts, `notEstablished` included). Historic
records stay marked historic and are never relabelled as current.

| # | Acceptance row | Needed receipt | Status |
|---|---|---|---|
| A1 | Pad pinch → audible local sound + visual + take growth in one capture | Preview capture receipt | **PENDING** (LEAF smoke proves handler path + `isPlaying`; audibility itself unproven) |
| A2 | Lens pairs with a **deployed** companion; played phrase becomes editable backend clip | pairing + commit receipt | **PENDING** (service undeployed) |
| A3 | Lens-initiated versioned save; `SAVED` badge only after confirmation | save receipt | **PENDING** |
| A4 | Fresh process reopens the saved project; notes verified editable | reopen receipt | **PENDING** |
| A5 | Failure states (expired pairing / lost network / unknown commit / unsynced) shown distinctly | failure-path receipt | **PENDING** (UI states + unit tests exist; no live-service run) |
| A6 | Broader LEAF coverage per brief done-criteria, including natural target discrimination | LEAF run receipts | **PENDING** (smoke 4/4 done with overridden target; discrimination not established) |
| A7 | Natural per-pad input with audibility | interaction receipt | **PENDING** (one partial bass pinch observed; not essential claim) |
| A8 | Pad plays its assigned source | Spark read-only job receipt | **PENDING** |
| A9 | Fresh-clone open + runtime check | clone-run receipt | **PENDING** (all receipts are from the authoring tree) |
| A10 | Public repo live with allowlisted content only | post-push `gh api` listing (allowlist R5–R7) | **PENDING** |
| A11 | Public YouTube link <3 min with disclosed limits | video URL + runbook receipts | **PENDING** |

## C. Submission requirements (from the hackathon rules page)

| Requirement | Status | Note |
|---|---|---|
| Lens built for SPECS via Lens Studio (Preview acceptable for demo) | **VERIFIED (Preview-only)** | no device = disclosed limitation |
| Make repo public with Lens Studio project + devpost folder | **PENDING** | push permission granted; execute allowlist R5–R7 |
| Public YouTube demo <3 min | **PENDING** | `demo-runbook.md` ready; upload auth unknown |
| Disclose pre-existing SoundCraft/Forge work | **VERIFIED (in docs)** | brief risks + status limits + §D here; keep in video end card |

## D. Required disclosure (keep verbatim in Devpost "About" + video end card)

> SoundCraft (the DAW host) and Forge (its asset engine) are the author's
> **pre-existing, separate projects**; this hackathon entry is the **new**
> SPECS Lens interface — SoundCraft Orbit. An earlier, different "Orbit"
> read-only AR track-progress viewer (web/lens/tools in this repo) is also
> pre-existing work and is not this Lens. Everything shown runs in **Lens
> Studio Preview on a laptop**: bundled original generated audio, local
> spatial monitoring, and an explicitly **simulated, session-only** take;
> the demo backing loop and UI blips are not captured performance and local
> pan is not preserved as pan automation. Four LEAF Preview smoke scenarios
> pass with an overridden target — they do not establish natural target
> discrimination, audibility, hardware behavior, or any backend effect. No
> Spectacles hardware, deployed SoundCraft service, or Lens↔backend round
> trip is claimed (backend PR open, not deployed); private-branch backend
> tests are not evidence of a working Lens save. The design brief is a
> draft pending the author's approval.

## E. Final gate order (do in this order)

1. Execute the allowlist (add listed paths; source-only rule for `tools/`
   folders), then verify rows R5–R7 post-push.
2. Record the video per `demo-runbook.md`; collect its receipts.
3. Update `implementation-status.md` with new receipt links; flip checklist
   rows only when their receipts exist. Live backend claims only after
   actual receipts.
4. Submit on Devpost with the disclosure block from §D.
