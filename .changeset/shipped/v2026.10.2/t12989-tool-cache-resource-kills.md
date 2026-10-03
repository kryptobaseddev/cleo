---
id: t12989-tool-cache-resource-kills
tasks: [T12989]
kind: fix
summary: the evidence tool cache never reuses a run that was killed for resources (an OOM, a heap limit, exit 137/143, a signal), and its key now includes the heap and worker limits the run was spawned with, so a retry with more memory always runs
---

Field report (axiom): a `tool:test` run under a 3 GB heap ran out of memory.
Vitest caught the worker's OOM and exited 1, and the cache stored that as an
ordinary red. The retry under a 6 GB heap computed the same key, because the
key covered the tree, the installed dependencies and the command but never
`NODE_OPTIONS`. It was served the 3 GB OOM until the entry was deleted by
hand.

- **Resource kills are not cached.** A run counts as killed for resources
  when it was terminated by a signal, when it exited with 128 + a kill
  signal's number (137 `SIGKILL`, 143 `SIGTERM`, 134 `SIGABRT` from V8's
  abort, plus `SIGHUP`, `SIGINT`, `SIGXCPU` and `SIGXFSZ`), or when it exited
  non-zero and its output reports running out of memory:
  - `JavaScript heap out of memory`, `Reached heap limit`,
    `Ineffective mark-compacts near heap limit`;
  - `ERR_WORKER_OUT_OF_MEMORY`, `Worker terminated due to reaching memory
    limit`, vitest's `Worker exited unexpectedly`;
  - `ENOMEM`, `Cannot allocate memory`.

  Such a run is returned with `resourceKill` set to the reason and is never
  written to the cache. It is also not flake-retried and leaves the
  failed-first pointer unchanged. A focused failed-first run that is killed
  this way is inconclusive. An ordinary failure, such as an assertion's
  exit 1 or a segfault's 139, is still cached, so failed-first reruns keep
  working. A false match only costs a re-run, because the exit code is still
  reported.
- **`E_EVIDENCE_TOOL_KILLED` for every resource kill.** `cleo verify
  --evidence tool:<name>` now reports a resource kill with no signal, such as
  exit 137 or an OOM that exited 1, as `E_EVIDENCE_TOOL_KILLED` instead of
  `E_EVIDENCE_TOOL_FAILED`. The message says the result is not a verdict on
  the code, that nothing was cached, and that raising the heap or lowering
  the worker count changes the key.
- **Resource limits in the key.** Tool-cache entries gain a `resourceEnv`
  identity field. It holds readable `NAME=value` pairs taken from the
  environment the tool is spawned with, after `heavyToolEnv` is applied:
  - for every tool, only the V8 heap flags in `NODE_OPTIONS`
    (`--max-old-space-size`, `--max-old-space-size-percentage`,
    `--max-semi-space-size`). The last occurrence wins, and underscores read
    as dashes. Other flags such as `--enable-source-maps` or `--require` do
    not change the key;
  - for `test` and `build`, also every variable `heavyToolEnv` manages:
    `VITEST_MAX_WORKERS`, `JEST_MAX_WORKERS`, `RUST_TEST_THREADS`,
    `CARGO_BUILD_JOBS`, `GOMAXPROCS`, `PYTEST_XDIST_AUTO_NUM_WORKERS`,
    `npm_config_workspace_concurrency` and `MAKEFLAGS` (without its
    per-invocation `--jobserver-*` handle). The cgroup overrides
    `CLEO_TOOL_MEMORY_MAX_MB` and `CLEO_NO_TOOL_CGROUP` are included too. The
    list is derived from `heavyToolEnv`, so a lever added there is keyed
    automatically.

  The overlay is computed once per run and used both to spawn and to key, so
  the recorded limits are the ones the run actually got. `cleo done`'s plan
  computes the same key. Cache entries move to schema 4, and schema-3
  entries are deleted once per process.
