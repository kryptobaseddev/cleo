---
id: t13679-run-watchdog-signals
tasks: [T13679, T13680, T13681]
kind: fix
summary: cleo run no longer flags sequential short workers as hung, reports a signal while queued, and records a signal the runner forwarded
---

Three defects reported against `cleo run` on 2026.10.12:

- **False "hung" (T13679).** The watchdog sums the CPU of the processes alive
  in the child's tree, so a worker that exits drops out of the sum. It counted
  the tree busy only when the sum beat the last busy value by a second, so after
  one heavy worker every smaller worker that followed read as idle, and a
  typecheck of many short batches was flagged hung. A falling sum now counts as
  activity and resets the baseline; a tree that is truly flat for the idle
  window is still flagged once.
- **Silent queued runs (T13681).** A SIGINT, SIGTERM or SIGHUP while a run
  waits in the queue now leaves the queue and reports `E_RUN_INTERRUPTED`,
  exiting 128 + the signal number, instead of dying with no envelope. Under
  `--passthrough` a run that waited in the queue now prints its "admitted after
  Ns in the queue" line on stderr: a narrow change to the #1777 R7 contract,
  which is now "silent unless queued". A successful run that never queued still
  prints nothing of its own.
- **Unattributed SIGTERM (T13680).** When the runner itself receives a signal
  and forwards it, it says so ("runner received SIGTERM (its parent pid N);
  forwarding it to pid M") and the result carries `runnerSignal`. A signal with
  no `runnerSignal` was aimed at the child directly.
