# ADR-061: Project-Agnostic Evidence Tools + Cross-Process Result Cache

## Status

Accepted — 2026-04-28 (T1534)

## Context

`cleo verify <task> --evidence "tool:<name>"` is the programmatic-evidence
backbone of the ADR-051 gate model. Pre-T1534, the implementation in
`packages/core/src/tasks/evidence.ts` carried a hardcoded table:

```ts
const TOOL_COMMANDS = {
  biome:         { cmd: 'pnpm', args: ['biome', 'ci', '.'] },
  tsc:           { cmd: 'pnpm', args: ['tsc', '--noEmit'] },
  eslint:        { cmd: 'pnpm', args: ['eslint', '.'] },
  'pnpm-build':  { cmd: 'pnpm', args: ['run', 'build'] },
  'pnpm-test':   { cmd: 'pnpm', args: ['run', 'test'] },
  'security-scan': { cmd: 'pnpm', args: ['audit'] },
};
```

Two problems followed.

### Problem 1 — package-boundary violation

`@cleocode/core` is contracted to be **agnostic to any specific project type**
(see `AGENTS.md` Package-Boundary Check). Hardcoding `pnpm` + a TypeScript
toolchain leaks the cleocode repo's own conventions into the SDK. A Rust
project, a Python project, or a Node project that uses `bun` cannot use
`tool:test` evidence at all — verify silently spawns `pnpm run test`, fails,
and emits `E_EVIDENCE_TOOL_FAILED`.

### Problem 2 — resource thrash under parallel orchestration

When the orchestrator spawns N worker subagents in parallel (the common case
for multi-task waves), each worker may call `cleo verify --evidence
"tool:pnpm-test"` for its own task. With N parallel verifies:

- **N independent vitest runs** spawn across the entire monorepo.
- Each fork allocates ~1 GB RAM and saturates multiple CPU cores.
- 5–10 parallel verifies on a moderate workstation = OOM / fan-spin / freezes.

There is no caching, no result memoisation, no semaphore. Two adjacent verify
runs against the **same git HEAD** with no intervening edits run the entire
test suite twice.

## Decision

### 1. Replace `TOOL_COMMANDS` with a project-agnostic resolver

A new module — `packages/core/src/tasks/tool-resolver.ts` — exposes
`resolveToolCommand(toolName, projectRoot)` which returns a runnable command
through the following resolution chain:

1. **Alias lookup** — legacy names (`pnpm-test`, `tsc`, `biome`, `cargo-test`,
   `pytest`, …) map to one of six **canonical** tool names: `test`, `build`,
   `lint`, `typecheck`, `audit`, `security-scan`.
2. **`.cleo/project-context.json` overrides** — `test` reads `testing.command`,
   `build` reads `build.command`. The project's *own* declared command wins.
3. **Per-`primaryType` defaults** — keyed on the detected language
   (`node` → `npm test`, `rust` → `cargo test`, `python` → `pytest`,
   `go` → `go test ./...`, …). The defaults are project-agnostic at the SDK
   level: keyed on the detected type, not on cleocode-specific tooling.
4. **Marker-file fallback** — when `project-context.json` is absent, the
   resolver detects `primaryType` from `Cargo.toml` / `package.json` /
   `pyproject.toml` / `go.mod` / etc.

The returned command carries a `source` field (`project-context`,
`language-default`, `legacy-alias`) so cache keys and audit trails can
distinguish project-supplied commands from SDK fallbacks.

### 2. Content-addressed cache + cross-process semaphore

A new module — `packages/core/src/tasks/tool-cache.ts` — wraps tool execution
in `runToolCached(command, projectRoot)`. The cache key is a sha256 hash of:

```
canonical || cmd || args || git_HEAD || sha256(git status --porcelain)
```

Cache entries live under `<projectRoot>/.cleo/cache/evidence/<key>.json` as
small JSON files (≤ 4 KB each). Each entry stores `exitCode`, `stdoutTail`,
`stderrTail`, `durationMs`, `head`, `dirtyFingerprint`, `capturedAt`.

Concurrency is handled by `proper-lockfile` via the existing `withLock`
primitive in `packages/core/src/store/lock.ts`. When N processes simultaneously
miss the cache for the same key:

1. Process #1 acquires the lock and spawns the tool.
2. Processes #2..N block on the lock.
3. When #1 completes and writes the cache entry, #2..N re-check the cache,
   observe the fresh entry, and return without spawning.

Effect: parallel verify runs of the same toolchain against the same repo
state coalesce to a single execution.

### 3. Bounded stdout/stderr capture (memory-leak fix)

The original `runCommand` in `evidence.ts` accumulated the entire child
stdout/stderr stream into JS strings via `s += d.toString()` on every
`'data'` event. For a vitest run emitting 50–200 MB of progress output
that translated to 50–200 MB of resident heap **per spawn**. With 10
parallel verify processes this manifested as a memory leak that grew
during long orchestrator runs and was never reclaimed until the verify
process exited.

The cache-aware `spawnCmd` uses a 64 KB ring-buffered tail accumulator
(`TailBuffer` in `tool-cache.ts`). Bytes beyond the cap are discarded at
the data-event boundary so the resident set stays bounded regardless of
how much the tool emits. The cached evidence atom still records only the
trailing 512 bytes — the 64 KB working buffer just gives us enough
headroom that a final 512-byte slice is meaningful even when a long
event arrives in one chunk.

### 4. Cross-process global concurrency semaphore (Scenario B)

Per-key cache coalescing is insufficient when the orchestrator spawns
worker subagents into per-task git worktrees (ADR-055): each worktree
has its own HEAD, so each `cleo verify` produces a different cache key,
and the per-key lock does not serialise them. Without a second bound,
N worktree workers calling `tool:test` simultaneously would each spawn
the full toolchain, multiplying CPU and resident memory by N.

`tool-semaphore.ts` adds a cross-process counting semaphore keyed on
canonical tool name. The slot directory lives at
`~/.local/share/cleo/locks/tool-<canonical>/` with `slot-0.lock` …
`slot-(N-1).lock` files; each slot is held by `proper-lockfile`. A
process exiting without releasing is reaped via the standard 10-minute
stale-lock recovery.

Defaults (computed from `os.availableParallelism()` at runtime):

| Canonical tool             | Default slots         | Rationale                                   |
|----------------------------|-----------------------|---------------------------------------------|
| `test`, `build`            | `max(1, floor(cpus/4))` | Already runs an internal worker pool         |
| `lint`, `typecheck`        | `max(2, floor(cpus/2))` | Single-threaded, low memory                  |
| `audit`, `security-scan`   | `max(2, floor(cpus/2))` | Network-bound, low memory                    |

Override via env: `CLEO_TOOL_CONCURRENCY_<CANONICAL>=<n>`. Use
`<n>=0` (or any non-positive value) to disable the bound for that tool.

`runToolCached` acquires the global semaphore **before** the per-key
file lock so blocked workers wait on the lighter semaphore turnover
rather than holding per-key locks. The order is:

```
fast cache check
  → acquire global semaphore (machine-wide bound)
    → acquire per-key file lock (cache-key-scoped)
      → re-check cache (another holder may have written it)
      → spawn the tool, write entry
    ← release per-key lock
  ← release semaphore
```

### 5. Automatic invalidation

Cache entries become stale when **either**:

- `git rev-parse HEAD` changes (a new commit landed).
- `sha256(git status --porcelain)` changes (an uncommitted edit, new file,
  or removed file).

Stale entries are discarded on access — no GC daemon, no TTL, no manual
maintenance. `cleo admin cache clear-evidence` (via `clearToolCache`) wipes
the cache directory in one call for forced re-runs.

### 6. Backwards compatibility

All legacy tool names (`pnpm-test`, `biome`, `tsc`, `eslint`, `pnpm-build`,
`security-scan`) continue to resolve. Existing audit trails referencing those
names remain re-validatable. The `EvidenceTool` TypeScript type widens to
`CanonicalTool | string` — a strict subtype of the previous union, so existing
callers compile unchanged.

The `TOOL_COMMANDS` export remains as an empty `Object.freeze({})` table
purely so any downstream code that destructured the legacy symbol does not
hard-fail at import time. Direct use is deprecated; new code MUST call
`resolveToolCommand`.

## Consequences

### Positive

- `@cleocode/core` is now project-type-agnostic. A Rust project verifies via
  `cargo test`, a Python project via `pytest`, a Bun project via `bun test`
  — all without touching SDK code.
- Parallel `cleo verify` calls against the same repo state now spawn at most
  one toolchain invocation per `(canonical, cmd, args, head, dirty)` tuple.
  10 parallel verifies → 1 vitest run → 9 cache hits.
- Parallel `cleo verify` calls across different worktrees / branches are now
  bounded by the per-tool semaphore — 10 worktree workers calling `tool:test`
  on a 16-core box run at most 4 concurrent test suites; the rest queue.
- Resident memory per spawn is bounded at ~64 KB regardless of stdout volume,
  fixing the apparent "memory leak" observed during long orchestrator
  sessions where verifies were producing megabytes of stdout each.
- Editing a tracked file invalidates the cache automatically — no risk of
  stale "tests pass" evidence after a code change.
- The cache is plain JSON under `.cleo/cache/evidence/`, easy to inspect,
  reset, or version-control-ignore.

### Negative / Tradeoffs

- The resolver consults `.cleo/project-context.json` on every tool atom. This
  is a single small file read; the cost is negligible compared to spawning a
  test runner. Studio / CLI hot paths that load `project-context.json` already
  pay this cost.
- The cache adds a new directory under `.cleo/cache/evidence/`. The default
  `.gitignore` template ignores `.cleo/cache/`, so version-controlled trees
  do not pollute. Existing repos may want to add `.cleo/cache/` to their
  ignore list.
- The cross-process lock uses `proper-lockfile` with a default 10-minute
  stale window. A test suite that genuinely takes longer than 10 minutes
  will see a stale-lock recovery (the slow process re-acquires after the
  stale window). Callers can pass `lockStaleMs` to widen the window.
- `coreTestRun` (the `validate.tests.run` op) is also routed through the
  resolver. Pre-T1534 it shelled out to `npx vitest run --reporter=json`;
  post-T1534 it uses `testing.command` from project-context.json. Output
  parsing remains vitest-specific — non-vitest runners get the raw stdout
  truncated to 2 KB. A follow-up may add a `testing.outputFormat` field
  (`vitest-json`, `tap`, `junit`, …) for richer cross-runner parsing.

## Compliance

- **Package-Boundary Check** — `tool-resolver.ts` lives in
  `packages/core/src/tasks/`, the SDK package, and is keyed on detected
  project facts rather than hardcoded tool choices.
- **No `any` / `unknown`** — every export carries proper types.
- **TSDoc** — all exports documented.
- **Tests** — `tool-resolver.test.ts` and `tool-cache.test.ts` cover the
  resolver matrix (node / rust / python / go / unknown), aliases, error
  paths, cache hit/miss, HEAD-based invalidation, dirty-tree invalidation,
  parallel-coalescing, and `clearToolCache`.

## References

- Tasks: T1534
- Predecessor ADRs: ADR-051 (Evidence-Based Gates), ADR-059 (Override Pumps)
- Related code:
  - `packages/core/src/tasks/tool-resolver.ts`
  - `packages/core/src/tasks/tool-cache.ts` (cache + per-key lock + bounded tail buffer)
  - `packages/core/src/tasks/tool-semaphore.ts` (cross-process global per-tool slot semaphore)
  - `packages/core/src/tasks/evidence.ts` (`validateTool` integration)
  - `packages/core/src/validation/validate-ops.ts` (`coreTestRun` integration)
- Configuration:
  - `CLEO_TOOL_CONCURRENCY_TEST=<n>` (and `_BUILD`, `_LINT`, `_TYPECHECK`,
    `_AUDIT`, `_SECURITY_SCAN`) — override per-tool concurrency cap.
