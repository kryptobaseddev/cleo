# T1598 — Foundation-Worker-13 (Wave B)

**Status**: Implementation complete, tests green, biome clean.
**Parent**: T1586 · **Mission**: claim-sync linter

## Deliverables

| Artifact | Path | Size |
| --- | --- | --- |
| Linter script | `/mnt/projects/cleocode/scripts/lint-claim-sync.mjs` | 666 LOC |
| Vitest suite | `/mnt/projects/cleocode/scripts/__tests__/lint-claim-sync.test.mjs` | 276 LOC, 12 tests |
| Documentation | `/mnt/projects/cleocode/scripts/README.md` | 114 LOC |

## Test results

```
Test Files  1 passed (1)
     Tests  12 passed (12)
  Duration  ~570ms
```

Coverage:

1. claim agrees with `done` state → no mismatch
2. `pending` state with completion claim → mismatch + `exit 1` under `--severity error`
3. `--severity warn` → exit 0 even with mismatches
4. uncertainty marker (`predecessor claimed`) skipped
5. `⚠ UNVERIFIED` tag skipped
6. quoted (`> ...`) and table (`| ... |`) lines skipped
7. `--json` output shape (summary + mismatches[])
8. unknown task IDs → `actualStatus: not-found` mismatch
9. `--ignore` path substring filter
10. project-agnostic execution under tmpdir (NOT inside cleocode root)
11. missing `.cleo/agent-outputs/` handled gracefully
12. `--help` exits 0 with usage text

## Detection rules

- **Completion keywords**: `shipped, done, complete, completed, merged, landed, fixed, closed, finished, delivered, resolved`
- **Glyphs**: `✅ ✓ ☑`
- **Phrases**: `100%`, `feature complete`, `feature-complete`
- **Skip filters** (11 uncertainty patterns): `would be`, `should be`, `claimed`, `predecessor said/claimed/reported/asserted`, `allegedly`, `supposedly`, `if true`, `unverified`, `⚠ UNVERIFIED`, `[unverified]`, `(unverified)`
- **Quote/table filter**: lines starting with `>` or `|` skipped
- **Task-ID pattern**: `\bT-?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b` (catches `T123` and `T-FOUNDATION-1`)

## CI integration command

```yaml
- name: Lint agent-output claim sync
  run: node scripts/lint-claim-sync.mjs --severity error --since ${{ github.event.pull_request.base.sha || 'origin/main' }}
```

For local pre-commit: `node scripts/lint-claim-sync.mjs --severity warn`.

## Project-agnostic verification

End-to-end run against an isolated tmpdir (`/tmp/cs-sample/`) outside the
cleocode repo with one copied report — linter spawned the real `cleo` binary,
parsed JSON envelopes, and returned `files=1, claims=3, mismatches=3` with
correct `actualStatus: not-found` for stale IDs. Test #10 explicitly asserts
`cwd.startsWith(REPO_ROOT) === false` to lock in tmpdir-portability.

No cleocode-specific paths, filenames, or task-ID conventions are baked in.
Reads `.cleo/agent-outputs/` relative to `process.cwd()` (overridable via
`--cwd` / `--reports-dir`); shells out to `cleo show <id> --json` (overridable
via `CLEO_BIN` env or `--cleo-bin`).

## Quality gates

- `pnpm vitest run scripts/__tests__/lint-claim-sync.test.mjs` → 12/12 pass
- `pnpm biome check scripts/lint-claim-sync.mjs scripts/__tests__/lint-claim-sync.test.mjs` → clean
- No new dependencies (Node built-ins only)
- No DB writes (read-only `cleo show`)
- TSDoc on every exported function

## Coordination

Touched only `scripts/lint-claim-sync.mjs`, `scripts/__tests__/lint-claim-sync.test.mjs`,
and `scripts/README.md`. No collisions with T1588 / T1591 / T1594 / T1595.
