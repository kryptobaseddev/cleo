# ADR-068 Amendment §3.1 — Worktree-Aware CLI Routing for SSoT Writes

**Status**: Accepted
**Task**: T10389
**Closes**: T10365 (P1 bug — `cleo docs add` + `cleo changeset add` unreachable from worktrees)
**Saga**: T10288 SG-DOCS-INTEGRITY
**Epic**: T10289 E1-DOCS-SLUG-NAMESPACE
**Amends**: ADR-068 (CLEO Database Charter), §3 (worktree-isolation guard)
**Date**: 2026-05-23

## Context

ADR-068 §3 established the worktree-isolation guard
(`assertDbPathIsNotWorktreeResident`, T9806). That guard refuses to open
any CLEO DB whose `.cleo/` parent has `.git` as a FILE (gitlink). The
guard correctly closes the orphan-DB vector from worktrees.

However, three CLI verbs that write to the SSoT *across the boundary*
were never updated to handle the gitlink case explicitly. When an agent
runs `cleo docs add T1234 file.md --slug foo` from inside an
orchestrator-spawned worktree (under
`~/.local/share/cleo/worktrees/<hash>/<task>/`), three independent guards
collide and produce one of three confusing errors:

1. **`E_PATH_TRAVERSAL`** — the dispatch sanitizer
   (`packages/core/src/security/input-sanitization.ts`,
   `sanitizePath`) resolves the file argument against the canonical
   project root (main repo). When the supplied path is absolute and
   under the worktree dir (outside the main repo), `relative(mainRoot,
   absPath)` starts with `..` → "outside project root".

2. **`E_FILE_ERROR: Cannot read file`** — when the path is relative,
   the docs.add handler calls `resolve(filePath)` which is anchored to
   `process.cwd()` (the worktree). The file exists at the worktree
   path BUT the sanitizer already rewrote it relative to the canonical
   root, leaving the dispatch op looking in the wrong directory.

3. **`E_WT_DB_ISOLATION_VIOLATION`** — if the worktree carries a stray
   `.cleo/tasks.db` (pre-T9803 leak), `getCleoDirAbsolute` resolves to
   the worktree's local `.cleo/`, and the isolation guard throws.

This collision class blocked agents working on T10353, T10354, and
T10294 from writing canonical docs or changesets from their worktrees.
The same agents must then ssh into the main repo OR `cd` outside
their worktree just to invoke `cleo docs add` — a UX regression that
defeats the worktree-mandatory protocol (ADR-055).

## Decision

CLI verbs that write to the SSoT MUST explicitly route through the
canonical project root when invoked from a worktree. Implementation
lives in two CLI commands and three core helpers — NOT in
`getProjectRoot` itself, NOT in the dispatch sanitizer's path check,
and NOT in `@cleocode/paths` (which is a zero-dep leaf).

### Strategy (b) — explicit canonical-root routing in CLI verbs

Two CLI verbs are amended:

- `cleo docs add` (`packages/cleo/src/cli/commands/docs.ts`)
- `cleo changeset add` (`packages/cleo/src/cli/commands/changeset.ts`)

Both now:

1. Call `resolveWorktreeRouting()` (new helper in
   `packages/core/src/paths.ts`) BEFORE dispatch.
2. When `isWorktree === true`:
   - Resolve user-supplied file paths against the worktree cwd via
     `resolveWorktreeFilePath(filePath, routing)` (new helper).
   - Emit one info line to stderr:
     `[T10389] routing SSoT write from worktree cwd <cwd> → canonical project root <root>`
     (suppressible via `CLEO_QUIET=1`).
3. Detect stray `.cleo/tasks.db` inside the worktree via
   `detectStrayCleoDb(routing)` (new helper) and emit a clear
   `E_STRAY_WORKTREE_DB` error with `rm -rf <worktree>/.cleo`
   remediation BEFORE invoking the DB chokepoint.

The dispatch sanitizer
(`packages/core/src/security/input-sanitization.ts`,
`sanitizeParams`) is amended to extend the existing
`allowExternalPath` exemption to `(domain: 'docs', operation: 'add')`
— so the absolute path computed by the CLI verb passes through
unchanged. The exemption is narrow and additive (the existing nexus
exemption stays unchanged).

### Strategy (a) REJECTED — making `getProjectRoot` worktree-aware at all callsites

We considered making `getProjectRoot` resolve its own routing for
every call. Rejected because:

- It would expand the `@cleocode/paths` zero-dep contract by adding
  git invocation in a path-resolver leaf.
- 95% of callers (DB opens, config reads, schema loads) WANT the
  canonical project root, not the worktree cwd. Inverting the default
  would regress every callsite.
- The dispatch sanitizer would still reject worktree-resident paths
  even if `getProjectRoot` returned the worktree — the sanitizer
  enforces canonical-root anchoring.

The fix-pack therefore touches the two CLI verbs that legitimately
accept "user-supplied bytes from anywhere", NOT the resolver itself.

## Consequences

### Positive

- `cleo docs add` and `cleo changeset add` work seamlessly from agent
  worktrees — no `cd` workarounds required.
- Stray `.cleo/tasks.db` inside worktrees surfaces with an actionable
  error before the DB chokepoint fires.
- The fix is minimally invasive: 4 files changed across cleo + core,
  zero new dependencies, zero ADR-068 §3 violations.
- Regression-locked by `worktree-docs-add.test.ts`
  (`packages/cleo/src/cli/commands/__tests__/`).

### Negative / Watch

- Two CLI verbs now share the worktree-routing pattern. Future SSoT-
  writing verbs (research add, handoff add, etc. — currently routed
  through `cleo docs add --type X`) inherit the fix for free, but any
  *new* top-level verb that accepts a file argument MUST adopt the
  same routing. The CLI package boundary check
  (`scripts/lint-cli-package-boundary.mjs`) does not currently flag
  missing routing; expansion is tracked under T10289's W2.

- The sanitizer exemption is now keyed on `(domain, operation)` pairs.
  We accept one extra entry per worktree-writing verb. The
  alternative (a generic "allow external paths" flag) would weaken
  the sanitizer's contract more broadly.

### Open

- The `getProjectRoot` ancestor-walk gitlink branch only fires when
  `start` itself carries the gitlink. Subdirectories of a worktree
  (e.g. `<worktree>/docs/`) miss the branch and trigger
  `E_NO_PROJECT`. The fix-pack's `resolveWorktreeRouting` walks
  ancestors first and delegates to `getProjectRoot` with the worktree
  root as the cwd argument — closing the subdirectory case for the
  two affected verbs. A separate cleanup task should generalise this
  ancestor walk into `getProjectRoot` itself for *all* callers.

## Related

- ADR-055 (worktree-mandatory protocol)
- ADR-068 (CLEO Database Charter — particularly §3 worktree-isolation guard)
- T9806 (worktree-isolation guard original implementation)
- T9803 (THROWS-on-orphan path resolution)
- T10353 / T10354 / T10294 (agents that hit the 3-guard collision)
- T10365 (the umbrella P1 bug closed by this fix-pack)
