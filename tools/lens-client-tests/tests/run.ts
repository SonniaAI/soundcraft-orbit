// run.ts — the offline test entry point.

import { runAll } from "./harness";
import { tests as pairAndCapture } from "./test_pair_and_capture";
import { tests as uncertaintyCommitSave } from "./test_uncertainty_commit_save";
import { tests as reviewProbes } from "./probe_review";
import { tests as debugProbesB } from "./debug_probe_b";
import { tests as round2Probes } from "./probe_round2";
import { tests as p1Probes } from "./probe_p1";
import { tests as stuckProbes } from "./probe_stuck";
import { tests as fifoProbes } from "./probe_fifo";
import { tests as windowProbes } from "./probe_window";
import { tests as pairStateProbes } from "./probe_pair_state";
import { tests as capGateProbes } from "./probe_cap_gate";

runAll([...pairAndCapture, ...uncertaintyCommitSave, ...reviewProbes, ...debugProbesB, ...round2Probes, ...p1Probes, ...stuckProbes, ...fifoProbes, ...windowProbes, ...pairStateProbes, ...capGateProbes])
  .then(() => {
    console.log("ALL OFFLINE TESTS PASSED (baseline + review probes)");
  })
  .catch(() => process.exit(1));
