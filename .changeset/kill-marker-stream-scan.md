---
id: kill-marker-stream-scan
tasks: [T13012, T13011]
kind: fix
summary: "an evidence run's resource kill is detected anywhere in its output, from jest's worker-crash messages, and on Linux from an OOM kill in its systemd scope that pnpm reports as exit 1"
---

- **Whole-stream scan (T13012).** Kill markers were matched only in the last
  64 KiB of each stream, so a V8 heap message followed by more output, as
  jest and `--no-bail` fan-outs produce, was missed and the run was cached as
  an ordinary red. Every chunk is now scanned as it arrives, with an overlap
  for a marker split across chunks.
- **Jest (T13012).** "was terminated by another process" and "child process
  exceptions, exceeding retry limit" count as resource kills.
- **Masked OOM (T13011).** `pnpm -r` 12+ reports a SIGKILLed child as exit 1.
  On Linux, where the run is confined in a transient systemd scope, a non-zero
  exit with no other evidence now checks the scope's journal for the OOM
  killer, and such a kill is never cached.
- **Limitation.** Where no scope confines the run (macOS, Windows, no user
  systemd), such an exit 1 with no marker in the output still cannot be told
  from a failing test. The tool-cache docs now say so.
