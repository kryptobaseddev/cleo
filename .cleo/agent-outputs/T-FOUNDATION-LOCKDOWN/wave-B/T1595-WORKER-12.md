# T1595 — Foundation-Worker-12 Deliverable (Wave B)

**Mission:** Pre-push reconcile gate that refuses pushes when
`cleo reconcile release --tag <pending> --dry-run` reports drift > 0.
Closes the recurrence pattern (T1408–T1413 shipped without reconcile).

## Files

- **Hook extension (POSIX shell):**
  `/mnt/projects/cleocode/packages/cleo/templates/hooks/pre-push.t1595-extension.sh`
  (executable, 0755)
- **Tests (Vitest, project-agnostic):**
  `/mnt/projects/cleocode/packages/cleo/src/cli/__tests__/pre-push-reconcile.test.ts`
- **Documentation:**
  `/mnt/projects/cleocode/docs/release/pre-push-reconcile-gate.md`

## T1588 integration status

T1588 had **NOT** landed at the time this work was completed. There is
no `packages/cleo/templates/hooks/pre-push` file and no
`# T1595:reconcile-extension-point` sentinel anywhere in the tree.

Therefore the reconcile gate is shipped as a **standalone extension
file** (`pre-push.t1595-extension.sh`). When T1588 lands, the body of
the `reconcile_gate()` function in that file MUST be inlined at the
sentinel block in T1588's unified pre-push hook.

The extension file is self-contained — it can be either sourced from
the unified hook (set `T1595_SOURCED=1` to suppress auto-invoke) or
called directly. Tests cover the direct-invoke path.

## Test results

8/8 passing (`pnpm exec vitest run packages/cleo/src/cli/__tests__/pre-push-reconcile.test.ts`):

1. hook file exists and is executable
2. refuses push when drift > 0 (exit 1, lists drifted task IDs)
3. allows push when drift == 0
4. bypass env var allows push + writes audit entry
5. soft-fails (warn + allow) when `cleo` CLI missing (default)
6. refuses push when `cleo` CLI missing + `CLEO_RECONCILE_STRICT=1`
7. allows push when no tags exist (fresh repo)
8. project-agnostic: works with SemVer tags (`v1.2.3`) too

## Override env var + audit log path

- Override: `CLEO_ALLOW_DRIFT_PUSH=1` bypasses the drift gate ONLY
  (T1588's T-ID validator and other pre-push hooks still run).
  This is intentional — `git push --no-verify` is a hammer; the env
  var is the scalpel.
- Audit log: `${XDG_DATA_HOME:-$HOME/.local/share}/cleo/audit/drift-push-bypass.jsonl`
  (one JSONL line per bypass: `{ts, user, repo, head, tag, reason}`).

## Project-agnostic verification

- **Tag detection:** `git tag --sort=-v:refname | head -n 1` works
  for CalVer (`v2026.4.145`), SemVer (`v1.2.3`), and any other
  `git tag`-sortable scheme. No hardcoded shape regex.
- **Branch:** no hardcoded `main`. The hook does not consult the
  branch name at all — drift is per-tag, not per-branch.
- **Reconcile CLI:** `cleo reconcile release` is itself project-agnostic
  (it dispatches to the registered invariants). The hook only depends
  on the top-level `"reconciled": <int>` JSON field, which is part of
  the `InvariantReport` contract in
  `packages/core/src/release/invariants/registry.ts`.
- **Shell:** `/bin/sh`, no bashisms. No `jq`, `node`, or other tool
  dependencies beyond `git`, `grep`, `head`, `mkdir`, `printf`, `tr`,
  `sort`. Tested on Linux 6.19 (Fedora 43); should work on any POSIX
  shell environment Git supports.
- **No --no-verify reliance:** the override is a dedicated env var so
  it does not bypass the T1588 T-ID validator.

## Coordination notes

- Did NOT touch T1588's primary file (none exists yet).
- Did NOT touch `packages/core/templates/git-hooks/pre-push` (that
  is the existing CalVer guard; merging the reconcile gate into that
  file is T1588's responsibility once it lands).
- Lint: ran `pnpm biome check --write` on the new test file (auto-fixed
  import grouping; tests still 8/8 green after format).

## Summary (4 bullets)

- Reconcile gate logic delivered in `pre-push.t1595-extension.sh`;
  parses `cleo reconcile release --json` aggregate `reconciled` count.
- T1588 not yet landed; extension is standalone; ready for sentinel
  inlining when T1588's unified hook arrives.
- 8/8 tests pass, all project-agnostic (SemVer + CalVer both covered);
  audit-log line verified on bypass path.
- Override = env `CLEO_ALLOW_DRIFT_PUSH=1`, audit at
  `${XDG_DATA_HOME:-~/.local/share}/cleo/audit/drift-push-bypass.jsonl`.
