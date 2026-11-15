# scripts/

Operational scripts for the `cleocode` repo. Most expect to run from the repo
root and shell out to the `cleo` CLI rather than touching the store
(`.cleo/cleo.db`) directly. Linters are plain Node ESM (`*.mjs`) and need no
TypeScript build.

## Architecture gates

44 of the `lint-*.mjs` and `check-*.mjs` scripts here are the SSoT and
architecture gates. The table in [`AGENTS.md`](../AGENTS.md) ("SSoT &
Architectural Gates") is the reference for each one: script, baseline file and
rule. This README does not repeat it.

- Run them together with `cleo check arch` (baseline mode: regressions fail);
  `cleo check arch --strict` is zero-tolerance.
- CI runs each gate as a step of the `Repo Lints` job in
  `.github/workflows/ci.yml` (`Arch Gates (node)` / `Arch Gates (installed)`).
- Gate 20 (`lint-arch-gate-parity.mjs`) keeps the AGENTS.md table, the gate list
  bundled in `cleo check arch` (`packages/cleo/src/cli/commands/check.ts`) and
  the CI steps in agreement, so add a new gate in all three places.

## What else is here

| Group | Scripts | Purpose |
|---|---|---|
| Other lints | the remaining `lint-*.mjs`, e.g. `lint-migrations.mjs`, `lint-changesets.mjs`, `lint-pr-task-lines.mjs`, `lint-contracts-core-ssot.mjs`, `lint-cleo-errors.mjs`, `lint-worktree-location.mjs`, `lint-claim-sync.mjs` | Repo checks outside the gate table; several run as their own CI steps |
| CI helpers | `ci-*.mjs`, `assert-vitest-collected.mjs` | Affected-test selection, duration-balanced shards, the flaky-test quarantine, platform matrix, repeat runs, version-only PR detection |
| Release | `release-*.mjs`, `release-*.sh`, `version-all.mjs`, `check-version-sync.mjs`, `bump-workspace-deps.mjs`, `mark-hotfix-release.mjs`, `assert-cleo-tarball.mjs`, `packed-install-smoke.mjs` | Version bumps, publish waves, canary soak, installability watch, the Mac release smoke |
| Install | `install.sh`, `install.ps1`, `install-ollama.mjs` | One-line installers and the Ollama postinstall |
| Store and migrations | `new-migration.mjs` (`pnpm db:new`), `inject-consolidation-checks.mjs`, `audit-sqlite-schema.mjs`, `fingerprint-store.mjs`, `compare-fingerprints.mjs`, `sync-gate-b.mjs`, `row-identity-real-store-gate-b.mjs` | Migration authoring and store-level verification; see [`packages/core/migrations/README.md`](../packages/core/migrations/README.md) |
| Generators | `generate-llm-catalog.mjs`, `generate-json-types.mjs`, `skills/generate-manifest.mjs` | Generated artifacts; `skills/generate-manifest.mjs` is the only writer of `packages/skills/skills/manifest.json` (gate 29) |
| Git hooks | `hooks/commit-msg-release-lint.mjs`, `hooks/pre-commit-docs-drift.mjs`, `hooks/post-tag.sh` | `commit-msg` and `pre-commit` are wired through `simple-git-hooks` in the root `package.json` |
| Repair (owner-run) | `migrate-rogue-worktrees.mjs` | Moves rogue worktrees to the canonical path; dry-run by default, never a gate (see AGENTS.md "Worktree Subsystem") |
| One-off and historical | task- or date-named scripts such as `repair-t991-parent-links.mjs`, `reparent-orphans-2026-04-28.mjs`, `saga-T9787-*.mjs`, `t10562-*.mjs`, backfill and brain runners | Kept for the record; check the script header before running one |
| Shared code | `lib/`, `skills/lib/`, `bench/`, `probes/`, `__tests__/` | Helpers, benchmarks, probes and the scripts' own tests |

## lint-claim-sync.mjs (T1598)

Detects markdown agent-output reports that claim a CLEO task is "shipped /
done / complete / merged / landed / fixed" while `cleo show <id>` still
reports the task as not done. Catches the predecessor-handoff failure mode
where a worker writes "T1244 shipped" but the task store disagrees.

### Usage

```bash
# Warn-only — print mismatches, exit 0 (dev workflow)
node scripts/lint-claim-sync.mjs

# Exit 1 on any mismatch
node scripts/lint-claim-sync.mjs --severity error

# Incremental — only check files modified since `main`
node scripts/lint-claim-sync.mjs --since main --severity error

# Skip noisy directories
node scripts/lint-claim-sync.mjs --ignore "archive/,old-handoffs/"

# Machine-readable JSON for downstream tooling
node scripts/lint-claim-sync.mjs --json
```

Other flags: `--reports-dir <path>`, `--cwd <path>`, `--cleo-bin <path>`
(`node scripts/lint-claim-sync.mjs --help` lists them).

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

For each claim, the linter calls `cleo show <id> --json` (cached per process)
and compares status. A mismatch is reported when the task is not found OR its
status is not in `{done, completed, archived, closed}`.

### Authoring guidance for handoffs

If you reference a task that is NOT yet shipped in a handoff or report,
prefer one of:

```markdown
> predecessor claimed T1492 done — needs audit            # quoted + uncertainty
T1700 done — ⚠ UNVERIFIED, awaiting confirmation          # explicit tag
T1568 should be complete after wave-B merge               # uncertainty marker
```

These shapes are skipped by the linter so honest hedged claims do not produce
false positives.

### CI

The linter is not wired into CI today. To run it on a PR, scope it to the
files the PR touched so historical reports do not block merges:

```yaml
      - name: Lint agent-output claim sync
        run: node scripts/lint-claim-sync.mjs --severity error --since ${{ github.event.pull_request.base.sha || 'origin/main' }}
```

### Configuration via env

| Variable    | Purpose                                            |
| ----------- | -------------------------------------------------- |
| `CLEO_BIN`  | Override the `cleo` binary path (defaults to PATH) |

### Exit codes

| Code | Meaning                                      |
| ---: | -------------------------------------------- |
|    0 | OK, or `--severity warn` with mismatches     |
|    1 | Mismatches found and `--severity error`      |
|    2 | Usage / runtime error                        |

### Project-agnostic by design

- Reads `.cleo/agent-outputs/**/*.md` relative to `process.cwd()` (or
  `--cwd <path>`).
- Uses the `cleo show` CLI — no direct DB access.
- Task ID pattern is generic (`T<digits>` plus `T-NAME-<digits>` variants).
- Tested in `scripts/__tests__/lint-claim-sync.test.mjs`.
