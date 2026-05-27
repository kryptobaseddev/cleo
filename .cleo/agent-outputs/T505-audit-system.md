# CLI Audit — System & Admin Core Domain

**Date**: 2026-04-11
**Version tested**: 2026.4.30
**Auditor**: cleo-prime (subagent)
**Scope**: Core system commands + config subcommands + admin subcommands

---

## Summary Table

| # | Command | Help Exit | Exec Exit | Status | Notes |
|---|---------|-----------|-----------|--------|-------|
| 1 | `cleo version` | 0 | 0 | PASS | Identical output to `cleo admin version` |
| 2 | `cleo init` | 0 | — | SKIP (write) | Options well-defined; --detect overlaps with `cleo detect` |
| 3 | `cleo doctor` | 0 | 0 | PASS | Alias for `admin health`; --comprehensive runs deep check |
| 4 | `cleo upgrade` | 0 | 0 | PASS | --status and --dryRun are functionally identical (BUG) |
| 5 | `cleo self-update` | 0 | 0 | PASS | --status did a live update during audit (see notes) |
| 6 | `cleo ops` | 0 | 0 | PASS | Tiered disclosure works correctly (-t 0/1/2) |
| 7 | `cleo schema` | 0 | 0 | PASS | --list mentioned in error output but flag does not exist (BUG) |
| 8 | `cleo log` | 0 | 0 | PASS | Pagination, filter by operation, filter by task all work |
| 9 | `cleo sequence show` | 0 | 0 | PASS | Returns counter, lastId, nextId correctly |
| 10 | `cleo sequence check` | 0 | 0 | PASS | Returns valid:true when counter >= max |
| 11 | `cleo sequence repair` | 0 | — | SKIP (write) | Destructive — not run |
| 12 | `cleo detect` | 0 | 0 | PASS | Runs on every invocation, reports "repaired" even when current |
| 13 | `cleo generate-changelog` | 0 | 8/0 | WARN | Fails E_CLEO_CONFIG without --platform; works with --platform plain |
| 14 | `cleo issue diagnostics` | 0 | 0 | BUG | Reports cleoVersion as hardcoded "2026.2.1" — stale in source |
| 15 | `cleo issue bug --dryRun` | 0 | 0 | PASS | Dry run output is correct |
| 16 | `cleo migrate storage --dryRun` | 0 | 0 | PASS | No migrations needed; from/to = "unknown" (minor UX) |
| 17 | `cleo migrate claude-mem` | 0 | — | SKIP (write) | No claude-mem.db present |
| 18 | `cleo config get` | 0 | 0/1 | BUG | Fails on keys present only in defaults (not in config.json file) |
| 19 | `cleo config set` | 0 | — | SKIP (write) | --global flag present |
| 20 | `cleo config set-preset` | 0 | — | SKIP (write) | Three presets: strict/standard/minimal |
| 21 | `cleo config presets` | 0 | 0 | PASS | Returns all 3 presets with values |
| 22 | `cleo config list` | 0 | 0 | PASS | Returns full merged config (file + defaults) |
| 23 | `cleo admin version` | 0 | 0 | PASS | Identical to `cleo version` |
| 24 | `cleo admin health` | 0 | 0 | PASS | Basic = 5 checks; --detailed adds log_file + backups_dir checks |
| 25 | `cleo admin stats` | 0 | 0 | PASS | Rich stats; also exposed as `cleo stats` (alias) |
| 26 | `cleo admin runtime` | 0 | 0 | PASS | --detailed adds binaries + package info |
| 27 | `cleo admin smoke` | 0 | 0 | PASS | 13 probes (10 domain + 3 DB); all pass |
| 28 | `cleo admin paths` | 0 | 0 | PASS | All hub dirs reported as scaffolded |
| 29 | `cleo admin scaffold-hub` | 0 | — | SKIP (write) | Already scaffolded; would be idempotent |
| 30 | `cleo admin cleanup --dryRun` | 0 | 0/2 | BUG | `--target archive` documented but returns E_INVALID_INPUT |
| 31 | `cleo admin job list` | 0 | 1 | EXPECTED FAIL | Requires daemon; clear error with fix hint |
| 32 | `cleo admin install-global` | 0 | — | SKIP (write) | Refreshes provider files and ~/.agents/AGENTS.md |
| 33 | `cleo admin context-inject` | 0 | 4 | BUG | Can never resolve protocols in this project (path mismatch) |

---

## Executed Command Results

### cleo version
```json
{"success":true,"data":{"version":"2026.4.30"}}
```
Exit: 0. Works correctly. Output is machine-readable JSON envelope.

### cleo doctor (basic)
Routes directly to `admin.health` operation. Returns 5 checks: cleo_dir, tasks_db, audit_log, signaldock_db (WARN — expected, signaldock.db not init'd), config_json. Overall: warning. Exit: 0.

### cleo doctor --detailed
Adds log_file (WARN — log not found) and backups_dir checks. Identical to `admin health --detailed`. Exit: 0.

### cleo doctor --comprehensive
Full 27-check deep inspection including git, SQLite integrity, gitignore, git hooks, injection health, node version, platform info. Identified real issues:
- `core_files_not_ignored` ERROR: config.json and project-info.json are in .cleo/.gitignore (contradicts AGENTS.md guidance)
- `cleo_gitignore` WARN: drifted from template (fix: `cleo upgrade`)
- `git_hooks` WARN: commit-msg, pre-commit, pre-push missing (fix: `cleo init --force`)
- `vital_files_tracked` WARN: config.json and project-info.json not tracked
Exit: 0 (success:true even with errors — correct behavior as it's reporting, not failing).

### cleo doctor --full
Runs the same 13-probe smoke test as `cleo admin smoke`. Identical output. Exit: 0.

### cleo doctor --hooks
Returns CAAMP hook taxonomy matrix (16 events). Providers array is empty (no hooks installed). Exit: 0.

### cleo doctor --coherence
Delegates to `check.coherence`. Returns coherent:true, no issues. Exit: 0.

### cleo upgrade --status / --dryRun
Both flags produce functionally identical output (same 9 actions, all skipped/preview, dryRun:true in both). Only requestId and timestamp differ. `--status` flag is redundant.

### cleo self-update --status
WARNING: Running this during audit triggered an actual update from 2026.4.28 to 2026.4.30. The `--status` flag is described as "Show current vs latest version" but it performed an install. The `--check` flag correctly returned version comparison without installing. Confirmed distinction: `--check` = read-only; `--status` = not read-only (misnaming).

### cleo ops (tiers 0/1/2)
- Tier 0: 27 operations across 5 domains. Quick start guide included. Works correctly.
- Tier 1: 175 operations across 9 domains. All expected domains present.
- Tier 2: 232 operations across 10 domains (adds nexus fully). Works correctly.

### cleo schema tasks.find
Basic schema returns no params or gates (operation accepts free-form query). Correct for find.

### cleo schema tasks.add --includeExamples --format human
Full parameter table with types, enums, CLI flags, gates, and examples. Human format is clean and readable. Works well.

### cleo schema nonexistent.op
Returns E_NOT_FOUND with message: "Run `cleo schema --list` to see all operations." But `--list` flag does not exist (help shows no such flag). Exit: 4.

### cleo schema --list
Prints help text and "Missing required positional argument: OPERATION". Exit: 1. The flag is referenced in an error message but was never implemented.

### cleo log
- Basic (limit 5): returns 5 most recent entries with full detail. Pagination metadata present.
- `--operation add --limit 3`: filter works correctly.
- `--since 2026-04-11 --limit 3`: filter works correctly.
- Total log rows: 3,806 at time of audit.

### cleo sequence show
Returns: counter=501, lastId=T501, nextId=T502. Exit: 0.

### cleo sequence check
Returns: counter=501, maxIdInData=501, valid=true. Exit: 0.

### cleo detect
Runs on every invocation (no guard for freshness). Reports "repaired" on project-context.json even when nothing changed. This is misleading — should say "already current" when no change was made. Exit: 0.

### cleo generate-changelog --dryRun
Returns E_CLEO_CONFIG (exit 8): "No changelog output platforms configured." Without `--platform`, the command always fails if `release.changelog.outputs` not in config.json. With `--platform plain --dryRun`, works correctly and shows source CHANGELOG.md → output path. The error without `--platform` is user-hostile for first-time use.

### cleo issue diagnostics
Returns cleoVersion as hardcoded "2026.2.1" — this is a hardcoded constant in `@cleocode/core/src/issue/diagnostics.ts` that was not updated with releases. Actual version is 2026.4.30. Source:
```
/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo/node_modules/@cleocode/core/src/issue/diagnostics.ts:
    cleoVersion: '2026.2.1',
```

### cleo issue bug --dryRun
Correctly builds formatted GitHub issue body with environment table. gh CLI present (v2.87.3). Would file to kryptobaseddev/cleo. Exit: 0.

### cleo migrate storage --dryRun
Returns from="unknown", to="unknown", migrations=[]. No migrations needed. The "unknown" version values are minor UX issue — should say current schema version. Exit: 0.

### cleo config get
- `cleo config get output.defaultFormat` → "json" (PASS)
- `cleo config get session.autoStart` → false (PASS)
- `cleo config get session.multiSession` → false (PASS)
- `cleo config get session.requireNotes` → E_CONFIG_KEY_NOT_FOUND (BUG)
- Root cause: `config get` reads only the raw config.json file. `config list` returns the merged config (defaults + file). `session.requireNotes` is not stored in config.json (only `autoStart` and `multiSession` are), but `config list` returns it via default merging. The two commands use different resolution strategies — `config get` does not fall back to defaults.

### cleo config list
Returns full merged config (file + defaults). Correct behavior.

### cleo config presets
Returns 3 presets (strict/standard/minimal) with descriptions and value sets. Exit: 0.

### cleo admin version
```json
{"success":true,"data":{"version":"2026.4.30"}}
```
Exit: 0. Identical to `cleo version`.

### cleo admin health
Basic (5 checks): same as `cleo doctor` basic.
Detailed (7 checks): adds log_file and backups_dir.

### cleo admin stats
Returns comprehensive stats: 80 active tasks (69 pending, 12 done), 421 archived, completion rate 63.68%, cycle time avg 0.08 days. Exit: 0. Also accessible as `cleo stats` (top-level alias discovered during testing).

### cleo admin runtime
Basic: channel, mode, source, version, dataRoot, node, platform, arch.
Detailed: adds binaries map (cleo found, ct found, cleo-dev not found, cleo-beta not found) and package name. mode="unknown", source="unknown" are noted (install mode detection not working for npm-global installs).

### cleo admin smoke
13 probes: 10 domain probes (admin, tasks, session, memory, pipeline, check, tools, sticky, nexus, orchestrate) + 3 DB checks (tasks.db, brain.db, migrations). All pass. Total: 163ms. Exit: 0.

### cleo admin paths
All paths reported correctly. Hub dirs (global-recipes, pi-extensions, cant-workflows, agents) all scaffolded:true. Exit: 0.

### cleo admin cleanup
- `--target backups --dryRun`: 0 deleted. Exit: 0. (PASS)
- `--target logs --dryRun`: 0 deleted. Exit: 0. (PASS)
- `--target sessions --dryRun`: 0 deleted. Exit: 0. (PASS)
- `--target archive --dryRun`: E_INVALID_INPUT "Invalid cleanup target: archive". Exit: 2. (BUG)

Help text states valid targets as "backups | logs | archive | sessions". The `archive` target is documented but not implemented.

### cleo admin job list
Returns E_NOT_AVAILABLE: "Job manager not available. Background jobs require a running CLEO daemon or long-lived process." Clear error with actionable fix hint (`cleo daemon start`). Note: `cleo daemon` appears to be an undocumented command. Exit: 1.

### cleo admin context-inject
Searched paths (relative to cwd /mnt/projects/cleocode):
1. `src/protocols/{name}.md`
2. `skills/_shared/{name}.md`
3. `agents/cleo-subagent/protocols/{name}.md`

None of these directories exist in this project. The actual protocol files are at `packages/core/src/validation/protocols/protocols-markdown/`. The search paths do not match project structure. Every protocol name tried (`cleo-base`, `ct-orchestrator`) returns E_NOT_FOUND with exit 4. This command is non-functional in this project.

The help text example says `cleo-base`, `ct-orchestrator`, `ct-cleo` as valid protocol types, but no documentation explains what protocols are available or how to install them.

---

## Duplicate / Overlap Analysis

### CONFIRMED DUPLICATES (exact same output)

| Command A | Command B | Finding |
|-----------|-----------|---------|
| `cleo version` | `cleo admin version` | Identical JSON output, different `operation` field in meta. One is a convenience alias. `cleo admin version` is the canonical; `cleo version` is the user-facing shortcut. Acceptable duplication — but both could share the same handler. |
| `cleo doctor` (basic) | `cleo admin health` (basic) | Byte-for-byte identical response data. `cleo doctor` is a full alias for `admin health`. Users should know this so they use the most specific flag. |
| `cleo upgrade --status` | `cleo upgrade --dryRun` | Functionally identical. `--status` should be read-only (no writes); `--dryRun` is the conventional dry-run name. Having two flags that do the same thing creates confusion. **Recommend removing `--status` or making it truly lighter (no write simulation).** |

### SIGNIFICANT OVERLAPS (different depth/scope)

| Command A | Command B | Relationship |
|-----------|-----------|-------------|
| `cleo doctor` | `cleo admin health` | Same operation. `doctor` adds `--comprehensive`, `--full`, `--coherence`, `--hooks`, `--fix` flags not on `admin health`. `admin health` has `--detailed`. Neither has the full flag set. Split personality. |
| `cleo doctor --full` | `cleo admin smoke` | Byte-for-byte identical output. `doctor --full` calls the smoke runner directly. `admin smoke` is the canonical path; `doctor --full` is a convenience. Acceptable but worth noting. |
| `cleo doctor --comprehensive` | `cleo admin health --detailed` | Vastly different depth (27 checks vs 7 checks). The naming is inverted from what users would expect: `--detailed` sounds more thorough than it is, `--comprehensive` on `doctor` is the real deep check. |
| `cleo ops` | `cleo schema` | `ops` shows what operations exist (discovery); `schema` shows details on a specific operation. Complementary, not duplicate. Relationship is clear and correct. |
| `cleo self-update` | `cleo upgrade` | **Clear distinction**: `self-update` = install a new CLI version from npm; `upgrade` = fix internal project structure/data (schema repair, gitignore, hooks, etc.). Different scopes. The naming is slightly confusing (`upgrade` sounds like what `self-update` does) but the description text clarifies. |
| `cleo detect` | `cleo init --detect` | `cleo detect` = standalone re-detection; `cleo init --detect` = detection as part of full initialization. `cleo detect` is a post-init utility for re-detection without re-running full init. Acceptable, but `cleo detect` always reports "repaired" even when nothing changed. |
| `cleo stats` | `cleo admin stats` | `cleo stats` is a top-level alias that routes to `admin.stats`. Same output. Works as documented alias. Acceptable — follows same pattern as `cleo version` / `cleo admin version`. |

### UNCLEAR / MISSING RELATIONSHIP

| Command | Issue |
|---------|-------|
| `cleo admin runtime` | The `mode` and `source` fields return "unknown" for npm-global installs. This reduces diagnostic value for most users. |
| `cleo admin context-inject` | The help text promises `ct-orchestrator`, `ct-cleo` as valid types, but they are NOT built into the CLI — they require the user to have protocol markdown files in specific project paths that don't exist by default. Zero out-of-box protocols. The command always fails unless `cleo init --installSeedAgents` was run and created the paths. |
| `cleo migrate storage` | from/to both "unknown" — schema versioning not tracking correctly. |

---

## Bugs Found

### BUG-SYS-001: `cleo schema` suggests non-existent `--list` flag
**Severity**: Minor (UX friction)
**Command**: `cleo schema nonexistent.op`
**Error message**: "Run `cleo schema --list` to see all operations."
**Reality**: `--list` flag does not exist. Running `cleo schema --list` shows help + "Missing required positional argument: OPERATION". Users following the error message get another error.
**Fix**: Either implement `cleo schema --list` (returns all known operations) or change error message to `cleo ops -t 2` or `cleo ops` as the discovery command.

### BUG-SYS-002: `cleo config get` fails on default-only keys
**Severity**: Medium (correctness)
**Command**: `cleo config get session.requireNotes`
**Error**: E_CONFIG_KEY_NOT_FOUND (exit 1)
**Root cause**: `config get` reads raw config.json (file-only). `config list` returns merged config (defaults + file). Keys present only in defaults (not written to config.json) return NOT_FOUND from `config get`. Users who see a key in `config list` cannot retrieve it with `config get`.
**Affected keys**: Any key that has a default value but was never explicitly set (e.g., `session.requireNotes`).
**Fix**: `config get` should use the same merged resolution as `config list`.

### BUG-SYS-003: `cleo issue diagnostics` reports stale hardcoded version
**Severity**: Minor (stale data)
**Command**: `cleo issue diagnostics`
**Reported**: `cleoVersion: "2026.2.1"` (hardcoded)
**Actual**: 2026.4.30
**Source file**: `packages/core/src/issue/diagnostics.ts` — `cleoVersion` is a hardcoded string constant, not dynamically read from package.json.
**Fix**: Read version from package.json at runtime, not from a hardcoded string.

### BUG-SYS-004: `cleo admin cleanup --target archive` fails despite being documented
**Severity**: Minor (broken feature)
**Command**: `cleo admin cleanup --target archive --dryRun`
**Error**: E_INVALID_INPUT "Invalid cleanup target: archive" (exit 2)
**Help text says**: `--target: What to clean: backups | logs | archive | sessions`
**Reality**: `archive` target is not implemented in the handler.
**Fix**: Implement the `archive` cleanup target or remove it from help text.

### BUG-SYS-005: `cleo upgrade --status` is not read-only (misleading flag name)
**Severity**: Medium (semantic confusion)
**Command**: `cleo upgrade --status`
**Expected**: Read-only status check (no writes)
**Actual**: Produces identical output to `--dryRun`, which simulates all changes. The name "status" implies a lighter inspection than "dryRun". If both flags do exactly the same thing, one is redundant.
**Fix**: Either (a) make `--status` genuinely read-only (just check what's out of date, skip the write simulation), or (b) remove `--status` and document `--dryRun` as the preview mode.

### BUG-SYS-006: `cleo self-update --status` performs a live install (misnaming)
**Severity**: Medium (dangerous semantic)
**Command**: `cleo self-update --status`
**Expected per help**: "Show current vs latest version"
**Actual**: Performed a live update from 2026.4.28 to 2026.4.30 during the read-only audit.
**Note**: `--check` flag correctly only checks without installing.
**Fix**: `--status` should be read-only (equivalent to `--check`). The install action should only be triggered by running `cleo self-update` without flags, or with `--force`.

### BUG-SYS-007: `cleo admin context-inject` always fails in this project (path mismatch)
**Severity**: Medium (non-functional feature)
**Command**: `cleo admin context-inject <any-protocol>`
**Error**: E_NOT_FOUND "Protocol not found in src/protocols/, skills/_shared/, or agents/cleo-subagent/protocols/" (exit 4)
**Root cause**: The search paths are hardcoded relative paths that do not match the actual project structure. Protocols exist at `packages/core/src/validation/protocols/protocols-markdown/` but the command searches `{cwd}/agents/cleo-subagent/protocols/`, which does not exist.
**Fix**: Either (a) add the correct path to the search list, or (b) document that `cleo init --installSeedAgents` must be run first to scaffold the expected paths, or (c) bundle a set of base protocols into the CLI package itself.

### BUG-SYS-008: `cleo detect` always reports "repaired" regardless of changes
**Severity**: Minor (misleading output)
**Command**: `cleo detect`
**Output**: `{"action":"repaired","path":".../project-context.json"}` — every time
**Reality**: When no changes are made, "repaired" is misleading. Should say "ok" or "unchanged" when context is already current.
**Fix**: Distinguish between "actually repaired" (wrote new content) and "verified current" (no write needed).

---

## Structural Issues

### `cleo doctor` flag fragmentation
`cleo doctor` has 6 flags (--detailed, --comprehensive, --full, --fix, --coherence, --hooks). These map to completely different operations:
- basic = `admin.health` (5 checks)
- --detailed = `admin.health` + 2 checks (7 total)
- --comprehensive = `admin.health` (27-check deep scan)
- --full = `admin.smoke` (13 probes)
- --coherence = `check.coherence`
- --hooks = `admin.hooks.matrix`
- --fix = auto-fix mode (not tested)

This is a "god command" problem. Each flag invokes a fundamentally different operation. Users and agents cannot predict what `cleo doctor` does without reading all the flags. The `admin` subcommand has separate commands for health/smoke but `doctor` bundles them all.

**Recommendation**: Keep `cleo doctor` as a user-friendly entry point, but document the equivalences explicitly in help text so agents know the canonical path.

### `cleo generate-changelog` requires pre-configuration
The command fails with E_CLEO_CONFIG unless `release.changelog.outputs` is configured. However, passing `--platform` on the command line overrides this requirement. The error message doesn't mention that `--platform` is an alternative. First-time users are stuck.

**Recommendation**: If `--platform` is passed on CLI, skip the config requirement check. Update error message to include "or pass --platform <name> directly".

### `cleo migrate storage` from/to = "unknown"
The schema versioning system is not tracking the current schema version string. `from` and `to` both return "unknown". While the migration check itself is correct (no migrations needed), the "unknown" values reduce diagnostic confidence.

---

## Observations

1. **Exit code discipline**: All commands use exit codes consistently. E_NOT_FOUND = 4, E_VALIDATION = 1 or 2, E_CONFIG = 8. The envelope `success` field matches exit code (success:false = non-zero exit), except the initial confusion with `context-inject` which was actually exit 4 (correct).

2. **`--dryRun` coverage**: Excellent. `admin cleanup`, `upgrade`, `migrate storage`, `generate-changelog`, `issue bug/feature/help` all support `--dryRun`. This is consistent and well-executed.

3. **Stale migration journal warning**: Appears on commands that open the session-scoped brain.db or tasks.db under certain conditions (specifically when a session is active). Not an error — just informational. The reconciliation is automatic. Low noise in practice.

4. **`admin job` is documentation-correct**: The error message explicitly says "Background jobs require a running CLEO daemon" and suggests `cleo daemon start`. The command fails gracefully with a clear recovery path.

5. **`cleo ops` tiering**: The 3-tier (0/1/2) disclosure model works correctly and is well-calibrated. Tier 0 covers the 80% case (27 ops), Tier 1 expands to 175 ops for memory/check work, Tier 2 gives full 232 ops. The quick-start guide in Tier 0 output is a nice agent-ergonomics touch.

6. **`cleo schema` human format**: Excellent output quality. Parameter table with types, enums, CLI flag mappings, gate conditions, and examples is genuinely useful for agent introspection. The `--includeExamples` flag reveals concrete usage examples.
