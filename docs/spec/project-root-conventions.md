# Project-Root Resolution Conventions

> **Source of truth:** this document. Last updated for T9584 (E-PROJECT-ROOT-AUDIT
> close-out). ADR reference: ADR-067.

CLEO is a monorepo that gets invoked from many directories — the repository root,
a `packages/<pkg>/` subdirectory, a worktree under
`~/.local/share/cleo/worktrees/...`, a CI tmpdir, or a freshly-cloned consumer
project. Every read and write that lands in `.cleo/` MUST agree on the same
canonical project root, or two anti-patterns appear simultaneously:

1. A rogue `<subdir>/.cleo/` materialises beside `<projectRoot>/.cleo/`.
2. The CLI silently operates on the wrong database, corrupting state.

This document describes the canonical resolver, the helpers built on it, and
the linter that prevents regressions.

---

## 1. The Anti-Pattern (T9550 bug class)

```text
                            CWD = packages/core/src/foo
                                       │
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │  const root = opts.root ?? process.cwd();            │  ← anti-pattern
        │  fs.writeFileSync(join(root, '.cleo', 'foo.json'))   │
        └──────────────────────────────────────────────────────┘
                                       │
                                       ▼
              packages/core/src/foo/.cleo/foo.json   ← rogue dir
              (instead of)
              <projectRoot>/.cleo/foo.json
```

Even though `getProjectRoot()` exists and the spawn adapter exports
`CLEO_ROOT`, **any callsite that fell back to `process.cwd()` directly**
silently bypassed the canonical chain. The T9580 audit catalogued **160 such
files** across `packages/` (see `.cleo/rcasd/T9580/research/project-root-audit.md`).

The fix is to route every fallback through one of three canonical helpers.

---

## 2. The Canonical Resolver

### `getProjectRoot(cwd?: string): string`

Lives at `packages/core/src/paths.ts`. Implements a 5-tier priority chain:

1. **`worktreeScope.run(...)` AsyncLocalStorage** — set by the spawn adapter so
   subagents always honour the orchestrator's authoritative worktree root.
2. **`CLEO_ROOT` / `CLEO_PROJECT_ROOT` env var** — explicit override.
3. **`CLEO_DIR` (absolute path)** — derives root from `dirname(CLEO_DIR)`.
4. **Git-worktree gitlink walk-up** — reads `.git` (a file in worktrees) to
   reach the canonical main repo via `gitdir:` (T9092 fix).
5. **Ancestor `.cleo/` + `.git/` walk-up** — stops at the first directory
   whose `.cleo/project-info.json` parses or which has a real `.git/`
   directory sibling.

Hard guards: refuses to resolve to `$HOME` or `/`. Throws
`E_INVALID_PROJECT_ROOT` when one or more `.cleo/` dirs were skipped but no
valid root was found (the "parent .cleo trap" — T1463).

### `resolveOrCwd(maybeRoot?: string | null): string` (T9584)

Sugar for the common pattern. When the caller passes a non-empty string it
is returned verbatim (orchestrate spawn passes canonical roots already; we
trust callers); otherwise the call falls through to `getProjectRoot()`.

```typescript
// Before (T9580 anti-pattern):
const root = opts.root ?? process.cwd();

// After:
import { resolveOrCwd } from '@cleocode/core';
const root = resolveOrCwd(opts.root);
```

The helper exists so that the long-tail of CORE-layer functions never reach
for `process.cwd()` directly — but it never replaces `getProjectRoot()` when
the caller does not have an `opts.root` to pass through.

### `pathForCleo*()` family

Higher-level helpers in `packages/core/src/paths.ts` that compose
`getProjectRoot()` + a stable suffix:

- `getCleoDirAbsolute(cwd?)` — `<root>/.cleo`
- `getTaskPath(cwd?)` — `<root>/.cleo/tasks.db`
- `getConfigPath(cwd?)` — `<root>/.cleo/config.json`
- `getSessionsPath(cwd?)` — `<root>/.cleo/sessions.json`
- `getArchivePath(cwd?)` — `<root>/.cleo/tasks-archive.json`
- `getLogPath(cwd?)` — `<root>/.cleo/logs/cleo.log`
- `getBackupDir(cwd?)` — `<root>/.cleo/backups/operational`

Prefer these when the path is well-known. They make the call site self-documenting
and remove a class of `join(...)` typos.

---

## 3. Fix Patterns

| Anti-pattern (T9580)                                  | Fix (T9584)                                       |
|-------------------------------------------------------|---------------------------------------------------|
| `opts.root ?? process.cwd()`                          | `resolveOrCwd(opts.root)`                         |
| `cwd ?? process.cwd()`                                | `resolveOrCwd(cwd)`                               |
| `projectRoot ?? process.cwd()`                        | `resolveOrCwd(projectRoot)`                       |
| `join(process.cwd(), '.cleo', '<file>')`              | `join(getProjectRoot(), '.cleo', '<file>')` *or* a `pathForCleo*` helper |
| `process.env.CLEO_ROOT \|\| process.cwd()`            | `getProjectRoot()` (canonical chain runs)         |
| `homedir() + '.cleo'`                                 | `getCleoHome()` from `@cleocode/paths`            |
| `homedir() + '.local/share/cleo'`                     | `getCleoHome()` from `@cleocode/paths`            |

---

## 4. Legitimate `process.cwd()` Uses

A small number of callsites legitimately read `process.cwd()` for purposes
OTHER than resolving the CLEO project root. They must be flagged with a
`// CWD-OK: <reason>` comment so the linter does not nag and so future readers
understand the intent. Examples:

- **Package discovery for the running binary** (e.g. `getPackageInfo()` in
  `packages/core/src/system/runtime.ts`) — bound to the operator's invocation
  directory, not the CLEO project root.
- **Git subprocess `cwd` arguments** that have already been resolved through
  `getProjectRoot()` upstream and are simply being passed to `spawn` /
  `execFile`.

Pattern:

```typescript
// CWD-OK: package.json lookup is bound to the operator's CLI invocation
// directory, NOT the canonical CLEO project root.
candidates.push(join(process.cwd(), 'package.json'));
```

---

## 5. Testing Guidance

A "real project root" satisfies `validateProjectRoot()`. Test fixtures MUST
materialise both `.cleo/` and a sibling marker (`.git/` directory or
`.cleo/project-info.json`) — otherwise `getProjectRoot()` will walk past
the temp dir, hit `/var/tmp`, and throw `E_INVALID_PROJECT_ROOT`.

Canonical fixture (see `packages/core/src/__tests__/resolve-or-cwd.test.ts`):

```typescript
const tempBase = await mkdtemp(join(tmpdir(), 'cleo-fixture-'));
await mkdir(join(tempBase, '.cleo'), { recursive: true });
await mkdir(join(tempBase, '.git'), { recursive: true });
await writeFile(
  join(tempBase, '.cleo', 'project-info.json'),
  JSON.stringify({ projectId: 'fixture-' + crypto.randomUUID() }),
);

// Then either:
process.env.CLEO_ROOT = tempBase;
// — or invoke the function with an explicit projectRoot argument.
```

Subdir-isolation tests (the T9580 regression battery — see
`packages/core/src/validation/doctor/__tests__/subdir-isolation.test.ts`)
go further: they `chdir` into `<tempBase>/packages/core/src` and assert the
function still writes to `<tempBase>/.cleo/...`, NOT
`<tempBase>/packages/core/src/.cleo/...`. Add an isolation test for any new
function that writes inside `.cleo/`.

---

## 6. CI Guard

A CI lint job (`scripts/lint-project-root-anti-pattern.mjs`, modelled on the
T9407 path-drift lint) runs on every PR. It rejects:

- `process.cwd()` calls anywhere inside `packages/core/src/**/*.ts` that are
  not annotated with a `// CWD-OK: <reason>` comment.
- `join(<anything>, process.cwd(), <anything>, '.cleo', ...)` constructions
  anywhere in `packages/`.
- `homedir()` constructions of `.cleo` paths outside the canonical resolvers
  in `packages/core/src/paths.ts` and `packages/paths/`.

To suppress for a genuinely-justified exception, append
`// CWD-OK: <reason>` (or `// path-drift-allowed` for the homedir form). Long-lived
exceptions should be listed in the script's allowlist with a one-line rationale.

**Strict mode (T9685-B4).** As of T9685-B4 the linter is strict-by-default:
zero violations allowed. The original T9584 `.cleo/project-root-baseline.json`
file (which tolerated 57 → 12 → 1 long-tail violations during the migration)
was deleted once the T9685-B1/B2/B3 batches drove the count to zero. New
anti-pattern instances now fail CI immediately on the offending PR. The CI
workflow passes `--strict` explicitly for intent; the flag is accepted as a
no-op for workflow stability.

---

## 7. References

- **ADR-067** — project-root resolution mandate.
- **T9550** — original bug class that motivated the audit.
- **T9580** — codebase-wide audit (`.cleo/rcasd/T9580/research/project-root-audit.md`).
- **T9581** — Batch 2 fix: `doctor/checks.ts`, `lifecycle/engine-ops.ts`, `compliance/index.ts`.
- **T9582** — Batch 3 fix: `agent.ts`, `nexus.ts`, `dispatch/conduit.ts`, `dispatch/nexus.ts`.
- **T9583** — Batch 1 fix: `release/`, `orchestrate/`, `spawn/`.
- **T9584** — long-tail fix + `resolveOrCwd()` helper + this doc + CI guard.
- **T9685-B1/B2/B3** — drove baseline 57 → 0 (CORE `process.cwd()` migration,
  `homedir`-`.cleo` consolidation, raw `DatabaseSync` chokepoint).
- **T9685-B4** — flip CI guard to strict mode; delete baseline file.
- **T1463** — parent-`.cleo/` trap rejection.
- **T1864** — `project-info.json` contract.
- **T9092** — git-worktree gitlink handling.
- **T335** — worktree isolation.
