# scripts/

Operational scripts for the `cleocode` repo. Most are project-agnostic — they
expect to run from the repo root (or any `cleo init` project) and shell out to
the `cleo` CLI rather than touching `tasks.db` directly.

## lint-claim-sync.mjs (T1598)

Detects markdown agent-output reports that claim a CLEO task is "shipped /
done / complete / merged / landed / fixed" while `cleo show <id>` still
reports the task as `pending`. Catches the predecessor-handoff failure mode
where a worker writes "T1244 shipped" but tasks.db disagrees.

### Usage

```bash
# Warn-only — print mismatches, exit 0 (dev workflow)
node scripts/lint-claim-sync.mjs

# CI gate — exit 1 on any mismatch
node scripts/lint-claim-sync.mjs --severity error

# Incremental — only check files modified since `main`
node scripts/lint-claim-sync.mjs --since main --severity error

# Skip noisy directories
node scripts/lint-claim-sync.mjs --ignore "archive/,old-handoffs/"

# Machine-readable JSON for downstream tooling
node scripts/lint-claim-sync.mjs --json
```

### How a "claim" is detected

A line is considered a completion claim when ALL of:

- It contains a task ID matching `T<digits>` or `T-NAME-<digits>`.
- It contains one of the completion keywords (`shipped`, `done`, `complete`,
  `completed`, `merged`, `landed`, `fixed`, `closed`, `finished`, `delivered`,
  `resolved`), a glyph (`✅`, `✓`, `☑`), or a phrase (`100%`,
  `feature complete`).
- It is NOT a quote (`> ...`) or markdown table row (`| ... |`).
- It does NOT contain an uncertainty marker:
  `would be`, `should be`, `claimed`, `predecessor said/claimed/reported/asserted`,
  `allegedly`, `supposedly`, `if true`, `unverified`, `⚠ UNVERIFIED`,
  `[unverified]`, `(unverified)`.

For each claim, the linter calls `cleo show <id> --json` (cached per process
to avoid duplicate spawns) and compares status. A mismatch is reported when
the task is not found OR its status is not in `{done, completed, archived,
closed}`.

### Authoring guidance for handoffs

If you reference a task that is NOT yet shipped in a handoff or report,
prefer one of:

```markdown
> predecessor claimed T1492 done — needs audit            # quoted + uncertainty
T1700 done — ⚠ UNVERIFIED, awaiting confirmation          # explicit tag
T1568 should be complete after wave-B merge               # uncertainty marker
```

These shapes are explicitly skipped by the linter so honest hedged claims do
not produce false positives.

### CI integration

Add to `.github/workflows/ci.yml` after the existing lint jobs:

```yaml
      - name: Lint agent-output claim sync
        run: node scripts/lint-claim-sync.mjs --severity error --since ${{ github.event.pull_request.base.sha || 'origin/main' }}
```

The `--since` flag scopes the check to files the PR touched, so existing
historical reports do not block merges.

### Configuration via env

| Variable    | Purpose                                            |
| ----------- | -------------------------------------------------- |
| `CLEO_BIN`  | Override the `cleo` binary path (defaults to PATH) |

### Exit codes

| Code | Meaning                                      |
| ---: | -------------------------------------------- |
|    0 | OK, or `--severity warn` with mismatches     |
|    1 | Mismatches found and `--severity error`     |
|    2 | Usage / runtime error                        |

### Project-agnostic by design

- Reads `.cleo/agent-outputs/**/*.md` relative to `process.cwd()` (or
  `--cwd <path>`).
- Uses the `cleo show` CLI — no direct DB access.
- Task ID pattern is generic (`T<digits>` plus `T-NAME-<digits>` variants).
- Tested against ephemeral fixtures under `tmpdir()` (no cleocode-specific
  paths in tests).

## Other scripts (existing)

| Script                            | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `lint-cleo-errors.mjs`            | Reject 2-arg `new CleoError(...)` (T335)             |
| `lint-contracts-core-ssot.mjs`    | Enforce contracts-core layering invariants           |
| `lint-migrations.mjs`             | Validate Drizzle migration metadata                  |
| `check-version-sync.mjs`          | Cross-check workspace version pins                   |
| `version-all.mjs`                 | Bump every package version in lockstep              |
| `new-migration.mjs`               | Scaffold a new Drizzle migration                     |
| `hooks/commit-msg-release-lint.mjs` | Mandate task IDs in `feat(release):` commits      |

All linters are pure Node ESM, no TypeScript build required.
