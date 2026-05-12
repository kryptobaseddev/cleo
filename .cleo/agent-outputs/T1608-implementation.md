# T1608: commit-T-ID-matches-diff validation (deepens T1588)

**Status**: completed
**Date**: 2026-04-30
**Commit**: 54945d2a0c667bdb3cc9c07ebb0902e0ea0c5528 (branch: task/T1608)

## Summary

Extended the T1588 POSIX `commit-msg` hook template at
`packages/cleo/templates/hooks/commit-msg` with diff-scope validation.
The hook now reads `cleo show <T-ID>` to retrieve `task.files[]` and
compares the staged diff (`git diff --cached --name-only`) against the
declared scope, emitting a WARNING to stderr when drift exceeds 50%.

## Files Changed

- `packages/cleo/templates/hooks/commit-msg` — extended hook
- `packages/core/src/git/__tests__/hooks-install.test.ts` — 8 new T1608 tests

## Implementation Details

### Hook Extension

After the existing T-ID presence check (T1588), the hook:

1. Extracts the first `T<digits>` from the commit subject
2. Looks up `CLEO_BIN` (env override) or `cleo` from PATH
3. Calls `cleo show <T-ID>` to get task JSON
4. Parses `data.task.files[]` via `python3 -c` (avoids stdin/heredoc conflict)
5. Gets staged files via `git diff --cached --name-only`
6. Delegates overlap math to `python3 -c` with argv passing (not stdin)
7. Emits WARNING to stderr if `drift_pct > 50` (integer math: out-of-scope * 100 / total)

### Design Decisions

- **Warning-only, exit 0**: Hard-blocking would reject valid refactors that touch adjacent files. The warning feeds audit tooling without blocking commits.
- **50% threshold**: Files in scope / total staged. `drift_pct > 50` (not `>= 50`) so a 50/50 split is not a warning.
- **Directory-prefix matching**: A task file path is in-scope if it's an exact match, a prefix of the staged file, or a staged file is a prefix of the task file path. This handles both file-level and directory-level scope declarations.
- **Graceful degradation**: Hook exits 0 silently if cleo is absent, python3 is absent, cleo show fails, task has no files[], or no files are staged.
- **Project-agnostic**: POSIX `/bin/sh` only. The only runtime dependency is `cleo` + `python3` (both already required for the project).
- **stdin conflict fix**: Python script is passed via `argv` to `python3 -c` rather than via heredoc + pipe (heredoc replaces stdin, conflicting with piped input).

### Tests (8 new, all passing)

1. All staged files in-scope → exit 0, no warning
2. Drift exactly at 50% threshold → exit 0, no warning (threshold is strict >)
3. Drift > 50% → exit 0 with WARNING on stderr (warning-only confirmed)
4. cleo absent → exit 0, no warning (graceful degradation)
5. task.files[] empty → exit 0, no warning (no scope declared)
6. No staged files → exit 0, no warning (message-only amend)
7. Directory-prefix scope, all in-scope → exit 0, no warning
8. Directory-prefix scope, drift > 50% → exit 0 with WARNING

Total: 37 tests pass (35 pre-existing + 8 new T1608), 0 failures.

## Gates

- implemented: commit 54945d2a, files packages/cleo/templates/hooks/commit-msg + test
- testsPassed: vitest run — 37/37 pass
- qaPassed: biome ci — no errors (schema version info only)
