# ADR-041 — WorktreeHandle as SpawnOptions Contract

**Status**: Accepted
**Date**: 2026-04-08
**Author**: Wave W9 worker (T380 epic, T399 task)
**Related ADRs**: ADR-035 (Pi v2/v3 harness), ADR-037 (conduit/signaldock KDF separation)
**Related Tasks**: T335 (worktree leak root cause), T377 (epic), T380 (W9), T399–T406, T310, T362
**Keywords**: worktree, isolation, cwd, spawn, env-vars, db-paths, async-local-storage

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

### T335 Leak Root Cause

The T335 worktree-leak bug was observed in Wave 2a and Wave 2b of the April 8, 2026 session.
Workers spawned inside physical git worktrees (under
`$XDG_DATA_HOME/cleo/worktrees/<projectHash>/`) continued writing to main-repo files:

- DB paths (`tasks.db`, `brain.db`, `config.json`) resolved against main repo because
  `getProjectRoot()` in `packages/core/src/paths.ts` walked ancestors and found the main
  `.cleo/` directory, ignoring the worker's physical cwd.
- Credential KDF used the main project path, not the worktree path.
- `SpawnOptions.isolate: boolean` was a flag with no associated data — the harness received
  no path, no branch name, and no project hash from the worktree creation step.

### The Boolean Isolate Flaw

`packages/caamp/src/core/registry/spawn-adapter.ts:25` defined:

```typescript
isolate?: boolean;
```

This is a dead flag: it expresses intent without supplying the information needed to act on
that intent. A spawned process that receives `isolate: true` still has no cwd binding, no env
vars indicating the worktree root, and no way to redirect its DB path resolvers. The physical
isolation created by `createWorktree()` in `packages/cant/src/worktree.ts` (shipped Wave 8)
was not connected to logical agent scoping.

---

## Decision

### D1 — Replace isolate boolean with worktree handle

`SpawnOptions.worktree?: WorktreeHandle` (from `@cleocode/cant`) replaces `isolate?: boolean`.

The deprecated alias is retained for one release cycle (v2026.5.x removal target) with a
`@deprecated` TSDoc tag so callsites migrate without a hard break.

```typescript
// BEFORE (v2026.4.x)
export interface SpawnOptions {
  isolate?: boolean;   // boolean with no data
}

// AFTER (v2026.4.x — handle carries all required data)
export interface SpawnOptions {
  worktree?: WorktreeHandle;  // full handle: path, branch, projectHash
  /** @deprecated Use worktree instead. Removal target: v2026.5.x */
  isolate?: boolean;
}
```

### D2 — PiHarness.spawnSubagent must bind cwd and env from the handle

When `opts.worktree` is present, the harness MUST:

1. Pass `cwd: opts.worktree.path` to the Pi subprocess (overrides any `task.cwd`).
2. Merge the following env vars into the child environment BEFORE `opts.env` and `task.env`
   (so per-call overrides still win):

```
CLEO_WORKTREE_ROOT   = opts.worktree.path
CLEO_WORKTREE_BRANCH = opts.worktree.branch
CLEO_PROJECT_HASH    = opts.worktree.projectHash
```

### D3 — AsyncLocalStorage scoped DB path resolution

`packages/core/src/paths.ts` MUST export a new `AsyncLocalStorage<WorktreeScope>` instance
named `worktreeScope`. The `getProjectRoot()` function MUST consult this store BEFORE the
env-var walk:

```
Resolution order (updated):
  0. worktreeScope.getStore()?.worktreeRoot  — in-process async context (new)
  1. CLEO_ROOT env var                       — bypass walk (existing)
  2. CLEO_DIR env var (absolute)             — derive from dirname (existing)
  3. Walk ancestors for .cleo/ or .git/      — existing walk
```

DB path functions (`getTaskPath`, `getConfigPath`, and all derivatives that call
`getCleoDirAbsolute`) inherit the scoped root transparently once `getProjectRoot()` is
updated.

### D4 — WorktreeHandle gains projectHash field

`WorktreeHandle` in `packages/cant/src/worktree.ts` gains a `projectHash: string` field so
the spawn path has access to it without threading `WorktreeConfig` through every call site.
`buildHandle()` is updated to accept and store it; `createWorktree()` passes
`config.projectHash` when constructing the handle.

### D5 — Credential KDF coordination is DEFERRED

The existing `HMAC-SHA256(machine-key, projectPath)` KDF in
`packages/core/src/crypto/credentials.ts:138-141` is NOT changed in this ADR.

ADR-037 §5 already specifies the full KDF replacement (`machine-key + global-salt + agent-id`)
and assigns it to T310/T362 for implementation. A coordination comment block is added at the
KDF call site referencing ADR-037 §5 and these task IDs. Swapping the KDF prematurely, before
the global-signaldock migration lands, would silently invalidate all stored credentials.

### D6 — Worktree guardrail in cleo-subagent/AGENT.md

Every spawned worker MUST run the following Bash guard as the first action in Phase 1 of the
lifecycle protocol:

```bash
WORKTREE="$(pwd)"
[ "$WORKTREE" = "$(git rev-parse --show-toplevel)" ] || { echo "WORKTREE GUARD FAILED"; exit 1; }
case "$WORKTREE" in /mnt/projects/cleocode/.claude/worktrees/*) ;; *) echo "BAD PATH"; exit 1 ;; esac
```

This guard catches the most common failure mode: a worker whose cwd was not bound to its
worktree before spawn.

---

## Consequences

### Positive

- **Closes T335 root cause**: physical isolation (worktree path) is now coupled to logical
  scoping (cwd + env vars + DB path resolution).
- **Zero breaking change**: deprecated `isolate: boolean` alias is preserved for one release
  cycle so existing callers continue to compile.
- **AsyncLocalStorage is zero-overhead for non-worktree callers**: `worktreeScope.getStore()`
  returns `undefined` when not inside a worktree context, and `getProjectRoot()` falls through
  to existing logic unchanged.
- **projectHash on the handle eliminates threading**: callers don't need to carry
  `WorktreeConfig` alongside `WorktreeHandle` just to populate env vars.

### Negative / Trade-offs

- **WorktreeHandle interface is a minor breaking change** within `@cleocode/cant`: any
  consumer constructing a `WorktreeHandle` manually (e.g. in tests) must add `projectHash`.
  In practice only `buildHandle()` and test factories construct handles.
- **AsyncLocalStorage adds a `node:async_hooks` import** to `packages/core/src/paths.ts`.
  This is safe: Node.js >= 16 supports it, and the monorepo targets Node >= 24.
- **KDF is still project-path-bound** until T310/T362 land. Worktree workers use the same
  credential decryption as the main repo, which is correct short-term (they share the same
  project path) but becomes incorrect after the global-signaldock migration.

---

## Related

- **ULTRAPLAN §14** — multi-agent worktree isolation design authority
- **ADR-035 §D6** — PiHarness.spawnSubagent canonical spawn contract
- **ADR-037 §5** — KDF replacement plan (T310/T362 scope)
- **T335** — worktree leak root cause issue
- **T310** — GlobalAgentRegistryAccessor + KDF refactor
- **T362** — parallel KDF coordination task
