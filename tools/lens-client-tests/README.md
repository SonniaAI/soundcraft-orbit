# lens-client-tests

Offline, dependency-light reproducibility tests for the Soundcraft companion
Lens client (the TypeScript sources under
`../../lens-studio-specs/Assets/Scripts/`). The suite compiles the **actual
project source files in place** — no vendored copy of the client — and runs
87 validated test cases entirely in-process against a scripted fake HTTP
transport and a controllable fake clock.

```bash
npm ci     # installs the pinned TypeScript toolchain (5.5.4)
npm test   # compiles the project sources + runs all 87 cases
```

Optional development loop (recompiles on save):

```bash
npm run dev
```

Requires Node >= 18. `npm test` prints one line per case and a final
`87 passed, 0 failed` summary; any failure exits non-zero for CI use.

## What these tests actually are (and are not)

These are **lightweight offline unit/integration tests**:

- All HTTP traffic goes through a scripted fake transport — no network, no
  real backend, no companion process.
- All timing uses an injected fake clock — no real waiting, no render loop.
- Nothing here renders a Lens, touches Lens Studio, or executes
  SoundCraft. **No SoundCraft runtime is invoked, nothing is installed, and
  no Rust/cargo builds happen** — this folder never needs the `soundcraft-cli`
  binary or any backend service.

They are **not** a substitute for the two stronger validation layers:

1. **Native Lens Studio compile** — the authoritative type-check of the same
   sources against the real Lens API declarations, run inside Lens Studio
   (the project's editor toolchain). These tests use only
   `tests/lens-globals.d.ts`, a minimal hand-written stand-in for the few
   Lens globals the pure client sources reference; it is deliberately NOT
   generated from Lens Studio's `Support/` dumps, so it proves API-shape
   compatibility only where the stubs agree with the real declarations.
2. **Real acceptance on Spectacles hardware** — the PR17 backend + CLI
   end-to-end driver (byte-identical save verification, exact tick-level
   durations) executed on the Spark/k8s/CI environment. Passing here means
   the client logic is correct in isolation; it is not on-device proof.

## What the 87 cases cover

- Exact-fidelity capture windows (PR17 2 s stuck-window negotiation, sweep
  semantics, non-faithful substitutions refused).
- Pair-state honesty (never-paired vs `token_expired` distinction, queue
  retention, no privileged requests while unpaired).
- FIFO ordering, drain gates, commit-once semantics, save readback.
- The runtime commit-note cap gate, including the adversarial cases:
  - **A** — a burst crossing the server cap while a note is held: over-budget
    hits are stored in the bounded next-take buffer with full identity
    (instrument/pad/key/channel/velocity, absolute onset) and a *measured*
    duration from the later note-off, then transferred into the fresh take
    with fresh event ids; the probes assert the stored payload object-by-object
    AND the submitted wire events (triples, exact-ns rebased onsets,
    note-offs at onset + measured duration, contiguous fresh id space) — not
    just counts.
  - **B** — a missing/malformed/out-of-range server cap fails closed: no
    backend admission, no commit (even an explicit one), persistent visible
    status; on refresh of a valid cap the preserved buffer resumes with fresh
    ids and full payload. Includes the cap-of-1 edge (no negative ceilings).

## Hygiene

- Compiled output is isolated in `dist/` and gitignored, as is
  `node_modules/`.
- Every pairing code and token in the fixtures is synthetic and generated
  in-test (for example the code `A7K2-9MXP` and tokens shaped
  `test-token-<random>`); no real credential, endpoint, or path appears in
  this folder.
- A few source-contract probes read the project's TypeScript files to assert
  implementation properties; they resolve those paths relative to this folder
  (`../../../lens-studio-specs/...`) — no absolute machine paths.

## Receipt

Suite last validated green (`87 passed, 0 failed`) against the client source
with md5 `105f4e5d1dfb64eee697972779ded7cd`
(`lens-studio-specs/Assets/Scripts/SoundcraftCompanionClient.ts`). This
receipt is informational — the tests intentionally do not pin any hash.
