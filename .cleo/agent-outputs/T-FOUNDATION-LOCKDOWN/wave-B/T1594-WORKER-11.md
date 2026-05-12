# T1594 — Session-Drift Watchdog (Foundation-Worker-11, Wave B)

Parent: T1586 · Coordination siblings: T1588 (hooks), T1591 (git shim), T1595
(pre-push reconcile), T1598 (sync linter). No file collisions with siblings.

## Files / LOC

| Path | LOC | Purpose |
|------|-----|---------|
| `packages/core/src/sessions/drift-watchdog.ts` | 355 | Watchdog core (`detectSessionDrift`, types, audit-path resolver, env-var plumbing) |
| `packages/core/src/sessions/__tests__/drift-watchdog.test.ts` | 271 | 9 vitest cases |
| `packages/core/src/sessions/index.ts` | +14 | Re-export `detectSessionDrift`, `DriftReport`, `DriftAuditEntry`, constants |
| `packages/core/src/index.ts` | +2 | Top-level `detectSessionDrift` + `DriftReport` re-export |
| `packages/cleo/src/cli/commands/session.ts` | +22 (5 LOC handler body) | `cleo session drift` subcommand wired into `subCommands.drift` |

## Test pass count

`npx vitest run src/sessions/__tests__/drift-watchdog.test.ts` → **9 / 9 pass**, 1.79 s.

Cases:

1. No active task → empty report, audit NOT written.
2. All modified files match declared scope → no drift, no audit.
3. Drift > threshold → drift detected, audit appended, `suggestedPivot` populated with `cleo pivot <activeTaskId> <newTask> --reason "..."`.
4. Drift below threshold → drift recorded, audit still appended, no pivot.
5. **Project-agnostic**: real `git init` + working-tree change → default reader returns `README.md` via `git status --porcelain`.
6. `getDriftWatchdogIntervalSec` reads `CLEO_DRIFT_WATCHDOG_INTERVAL_SEC`, falls back to `300` on missing/zero/non-numeric.
7. Local audit path = `<projectRoot>/.cleo/audit/session-drift.jsonl`.
8. Global audit path matches `…/.local/share/cleo/audit/session-drift.jsonl`.
9. `DEFAULT_PIVOT_THRESHOLD === 0.5` (public contract).

Typecheck: `pnpm --filter @cleocode/core run typecheck` and
`pnpm --filter @cleocode/cleo run typecheck` both clean. Biome
`check --write` clean on all 5 touched files.

## CLI integration points

- **New**: `cleo session drift [--audit-scope global|local]`
  - Handler body 5 LOC, all logic in `@cleocode/core`.
  - Distinct from existing `cleo session context-drift` — file-scope vs. task-graph-scope drift.
- **Plumbing only** for `cleo current` / `cleo dash` integration: per spec
  ("just plumb the option; actual periodic firing is a future task"),
  `getDriftWatchdogIntervalSec()` is exported so a future task can hook
  the watchdog into those commands (or a daemon) without re-litigating
  the env-var contract. Direct injection into `current.ts`/`dash.ts`
  would have required engine + dispatch wiring; deferred to keep this
  task atomic and avoid touching files owned by parallel siblings.

## Audit log paths

| Scope | Path |
|-------|------|
| `global` (default) | `~/.local/share/cleo/audit/session-drift.jsonl` |
| `local` | `<projectRoot>/.cleo/audit/session-drift.jsonl` |

Append-only JSONL, one `DriftAuditEntry` per line:

```json
{"timestamp":"…","sessionId":"…","activeTaskId":"T###","declaredFiles":[…],"modifiedFiles":[…],"outsideScope":[…],"ratio":0.66,"pivotSuggested":true}
```

Separate stream from T1591's per-git-op shim audit log — both legitimate
by design.

## Project-agnostic verification

- Default modified-files reader is `git status --porcelain` invoked via
  `node:child_process.spawn`. No language- or framework-specific assumptions.
- Test 5 (`uses git status --porcelain by default`) initialises a fresh
  git repo in `tmpdir()`, makes a `README.md` change, and confirms the
  watchdog returns `README.md` via the default reader path.
- Path normalisation handles absolute paths, `./` prefixes, and Windows
  separators uniformly so `Task.files[]` declarations match git output
  regardless of how they were captured.

## Constraints honoured

- All business logic in `@cleocode/core` (`packages/core/src/sessions/drift-watchdog.ts`).
- CLI handler ≤ 5 LOC (excluding meta + arg declarations).
- TypeScript strict — no `any`, no `unknown` shortcuts, no inline type definitions.
- `@cleocode/contracts` imported only via `Session`/`Task` types (already standard cross-package contract surface; not a layering violation per T1565).
- `cleo` package does NOT import from `@cleocode/contracts` directly — the new CLI handler imports `detectSessionDrift` and `getProjectRoot` from `@cleocode/core` only.
