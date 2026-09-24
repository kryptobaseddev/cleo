---
id: nexus-worker-lifecycle
tasks: [T12313, T12312]
kind: fix
summary: `cleo nexus analyze` survives its own parser workers — five defects behind one mask, verified on a CLEO root that sits above its git root
---

A nexus rebuild could never complete on larger repositories. Five defects
compounded, and the first hid the other four:

1. **The worker's stderr was discarded** (`child.stderr.on('data', () => undefined)`),
   so every worker death reported no cause. It is now retained (bounded tail) and
   quoted in the failure.
2. **Transient-scope names collided across processes** — the systemd scope name
   was a per-process counter, so two concurrent analyzes asked systemd for the
   same unit. Scopes are now unique per process and run with `--collect`.
3. **The worker heap default (128 MB) and memory ceiling ignored native memory.**
   tree-sitter arenas live outside the V8 heap; the cgroup ceiling now carries
   native headroom and the heap default is 512 MB (`CLEO_NEXUS_WORKER_HEAP_MB`).
4. **One dead worker discarded every other worker's results.** Chunks from a
   worker that died are retried once on a fresh worker; cancellation is never
   retried and still reports `E_PARSE_CANCELLED`.
5. **A few unparseable files refused the whole generation.** Gaps are published
   and reported; refusal is retained above 10% unparsed.

Also: git ignore checks get a size-scaled budget with one retry
(`CLEO_NEXUS_GIT_TIMEOUT_MS`), which fixes `spawnSync git ETIMEDOUT`, and the
per-batch parse deadline is 30 s (`CLEO_NEXUS_PARSE_TIMEOUT_MS`).

Measured on /mnt/projects/axiom-analytics/axiom-app: before, 5,762 of 5,762
files stale and analyze always failed; after, 66,957 nodes, 135,046 relations,
0 stale.
