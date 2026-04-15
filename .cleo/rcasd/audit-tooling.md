# CLI Audit — Tooling & Infrastructure Domain

**Date**: 2026-04-10
**CLI Version**: 2026.4.29
**Auditor**: Automated subagent
**Scope**: ADR, CANT, Skills, Web, Backup/Restore, Chain, Provider/Adapter, Telemetry

---

## Summary Table

| # | Command | Help Exit | Live Exit | Status | Notes |
|---|---------|-----------|-----------|--------|-------|
| 1 | `cleo adr validate` | 0 | 1 | FAIL | ADR-025 missing all frontmatter fields |
| 2 | `cleo adr list` | 0 | 0 | PASS | Returns 40 ADRs |
| 3 | `cleo adr show <id>` | 0 | 0 | PASS | Returns full frontmatter |
| 4 | `cleo adr sync` | 0 | 0 | PASS | 40 updated, warnings for orphaned task refs (expected) |
| 5 | `cleo adr find <query>` | 0 | 0 | PASS | Fuzzy search works |
| 6 | `cleo cant parse <file>` | 0 | 0 | PASS | Returns AST; invalid .cant files parsed gracefully |
| 7 | `cleo cant validate <file>` | 0 | 0 | PASS | Returns 42-rule diagnostics |
| 8 | `cleo cant list <file>` | 0 | 0 | PASS | Lists agents by kind |
| 9 | `cleo cant execute <file> --pipeline` | 0 | 0 | PASS | Returns pipeline result (parse errors surfaced inline) |
| 10 | `cleo cant migrate <file>` | 0 | 0 | PASS | Dry-run preview works |
| 11 | `cleo skills list` | 0 | 0 | PASS | 21 skills listed |
| 12 | `cleo skills search <query>` | 0 | 0 | PASS | Local fuzzy search |
| 13 | `cleo skills validate <name>` | 0 | 0 | PASS | Reports install + catalog presence |
| 14 | `cleo skills info <name>` | 0 | 0 | PASS | Returns full metadata |
| 15 | `cleo skills install <name>` | 0 | n/t | PASS-HELP | Mutates — not run |
| 16 | `cleo skills uninstall <name>` | 0 | n/t | PASS-HELP | Mutates — not run |
| 17 | `cleo skills enable <name>` | 0 | n/t | PASS-HELP | Explicit alias for install |
| 18 | `cleo skills disable <name>` | 0 | n/t | PASS-HELP | Explicit alias for uninstall |
| 19 | `cleo skills refresh` | 0 | 0 | PASS | Checked 1, no updates |
| 20 | `cleo skills dispatch <name>` | 0 | 0 | PASS | Returns dispatch routing (empty for ct-cleo) |
| 21 | `cleo skills catalog` | 0 | 0 | WARN | Returns `available: false` — no local library |
| 22 | `cleo skills precedence` | 0 | 0 | PASS | Returns 45-provider precedence map |
| 23 | `cleo skills deps <name>` | 0 | 0 | PASS | Returns tree |
| 24 | `cleo skills spawn-providers` | 0 | 0 | PASS | Lists 5 spawn-capable providers |
| 25 | `cleo web start` | 0 | n/t | PASS-HELP | Mutates — not run |
| 26 | `cleo web stop` | 0 | n/t | PASS-HELP | Mutates — not run |
| 27 | `cleo web status` | 0 | 0 | PASS | Reports not running |
| 28 | `cleo web open` | 0 | 1 | EXPECTED-FAIL | Returns error "Web server is not running" — correct behavior |
| 29 | `cleo backup add` | 0 | n/t | PASS-HELP | Mutates — not run |
| 30 | `cleo backup create` | 0 | n/t | PASS-HELP | Explicit alias for add (help text confirms) |
| 31 | `cleo backup list` | 0 | 0 | PASS | 3 snapshots found |
| 32 | `cleo backup export` | 0 | n/t | PASS-HELP | Mutates — not run |
| 33 | `cleo backup import` | 0 | n/t | PASS-HELP | Mutates — not run |
| 34 | `cleo backup inspect` | 0 | n/t | PASS-HELP | Non-mutating but requires bundle file |
| 35 | `cleo restore finalize` | 0 | 0 | PASS | Reports "Nothing to finalize" correctly |
| 36 | `cleo restore backup` | 0 | 1 | BUG | See BUG-001 — incomplete valid-file list |
| 37 | `cleo restore task <id>` | 0 | 4 | EXPECTED-FAIL | E_NOT_FOUND for unknown task — correct behavior |
| 38 | `cleo chain show <id>` | 0 | 0 | PASS | Returns full chain definition |
| 39 | `cleo chain list` | 0 | 0 | PASS | Returns 1 chain (tessera-rcasd) |
| 40 | `cleo chain add <file>` | 0 | n/t | PASS-HELP | Mutates — not run |
| 41 | `cleo chain instantiate <id> <epic>` | 0 | n/t | PASS-HELP | Mutates — not run |
| 42 | `cleo chain advance <id> <stage>` | 0 | n/t | PASS-HELP | Mutates — not run |
| 43 | `cleo provider list` | 0 | 0 | PASS | Large response — all registered providers |
| 44 | `cleo provider detect` | 0 | 0 | PASS | Detects installed providers |
| 45 | `cleo provider inject-status` | 0 | 0 | PASS | Shows AGENTS.md injection status per provider |
| 46 | `cleo provider supports <id> <cap>` | 0 | 0 | PASS | Returns boolean capability check |
| 47 | `cleo provider hooks <event>` | 0 | 0 | PASS | Returns providers supporting the event |
| 48 | `cleo provider inject` | 0 | n/t | PASS-HELP | Mutates — not run |
| 49 | `cleo adapter list` | 0 | 0 | PASS | Returns empty (no adapters loaded) |
| 50 | `cleo adapter show <id>` | 0 | 4 | EXPECTED-FAIL | E_NOT_FOUND — correct |
| 51 | `cleo adapter detect` | 0 | 0 | PASS | Returns empty detected list |
| 52 | `cleo adapter health` | 0 | 0 | PASS | Returns empty health list |
| 53 | `cleo adapter activate <id>` | 0 | 4 | EXPECTED-FAIL | E_NOT_FOUND — correct |
| 54 | `cleo adapter dispose` | 0 | n/t | PASS-HELP | Mutates — not run |
| 55 | `cleo token` | 0 | 0 | PASS | Top-level help lists 6 subcommands |
| 56 | `cleo token summary` | 0 | 0 | PASS | 4015 records, 12.5M tokens |
| 57 | `cleo token list` | 0 | 0 | PASS | Returns paginated records |
| 58 | `cleo token estimate` | 0 | n/t | PASS-HELP | Requires text input — not run |
| 59 | `cleo otel` | 0 | 0 | PASS | Top-level help lists 6 subcommands |
| 60 | `cleo otel status` | 0 | 0 | PASS | Reports 0 events in TOKEN_USAGE.jsonl |
| 61 | `cleo otel summary` | 0 | 0 | PASS | Reports "No token tracking data yet" |
| 62 | `cleo otel sessions` | 0 | 0 | PASS | Returns empty — no JSONL data |
| 63 | `cleo otel spawns` | 0 | 0 | PASS | Returns empty |
| 64 | `cleo otel real` | 0 | 0 | PASS | Reports OTel not configured |

**Legend**: `n/t` = not run (mutating); `PASS-HELP` = help verified, not executed live; `EXPECTED-FAIL` = failure is correct behavior for the input given.

---

## Bugs Found

### BUG-001: `restore backup` valid-file list is incomplete

**Severity**: HIGH
**Command**: `cleo restore backup --dryRun --file brain.db`
**Exit code**: 1

**Symptom**: The command reports `Valid files: tasks.db, config.json` and rejects `brain.db` and `project-info.json`. However `backup add` explicitly saves all four files (`tasks.db`, `brain.db`, `config.json`, `project-info.json`) as confirmed by `backup list`.

**Evidence**:
```
error: "Unknown file: /mnt/projects/cleocode/brain.db. Valid files: tasks.db, config.json"
```

**Impact**: `brain.db` and `project-info.json` cannot be restored from backup via CLI. The backup command saves them; the restore command cannot restore them. This is a silent data-recovery gap.

**Fix**: The `restore backup` handler must add `brain.db` and `project-info.json` to its accepted file list.

---

### BUG-002: `adr validate` exits 1 due to ADR-025 missing all frontmatter

**Severity**: LOW (content issue, not code issue)
**Command**: `cleo adr validate`
**Exit code**: 1

**Symptom**: 1 ADR validation error found. `adr show ADR-025` returns `"frontmatter": {}` — the file exists but has no required fields (Date, Status, Summary, Keywords, Topics).

**Impact**: `adr validate` cannot return success while ADR-025 exists in its current form. Any CI or agent that gates on `adr validate` exit 0 will always fail.

**Fix**: Either populate ADR-025 frontmatter per ADR-017 schema or mark it as a stub/draft with a `status: proposed` line.

---

### WARN-001: `cleo web open` returns exit 1 for no-server case

**Severity**: INFO (arguably correct behavior)
**Command**: `cleo web open`
**Exit code**: 1

The error message is helpful (`cleo web start`). Exit 1 is acceptable. No action required unless scripts need differentiated exit codes.

---

### WARN-002: `cleo skills catalog` reports no local library

**Severity**: INFO
**Command**: `cleo skills catalog`
**Exit code**: 0

Returns `{"available": false, ...}`. The CAAMP skill catalog library is not installed. This is a valid state if the catalog package has not been set up. No bug, but worth noting for users expecting catalog browsing.

---

## Duplicate / Overlap Analysis

### `backup add` vs `backup create`

**Verdict**: Confirmed explicit alias. Help text for both reads identically: "Add a new backup of all CLEO data files (backup create is an alias for backup add)". Both map to the same underlying handler. No issue.

### `skills enable` vs `skills install`

**Verdict**: Confirmed explicit alias. Help for `skills enable` reads "Enable a skill (alias for install)". Both exist deliberately for UX discoverability.

### `skills disable` vs `skills uninstall`

**Verdict**: Confirmed explicit alias. Help for `skills disable` reads "Disable a skill (alias for uninstall)". Both exist deliberately for UX discoverability.

### `provider list` vs `adapter list`

**Verdict**: Distinct concerns, no overlap.
- `provider list` queries the CAAMP provider registry — all 45+ registered providers, including those not installed. Returns full capability manifests.
- `adapter list` queries the adapter runtime engine — only adapters currently loaded/instantiated. Returns empty when none are active.

These are complementary, not redundant. `provider list` answers "what exists?"; `adapter list` answers "what is running?".

### `provider detect` vs `adapter detect`

**Verdict**: Distinct concerns, minor naming confusion risk.
- `provider detect` returns all providers detected as installed in the environment (by binary/directory heuristic). Returns large payload with full provider manifests.
- `adapter detect` queries the adapter layer for runtime-active adapters. Returns empty list when no adapters are loaded.

Both operate correctly. The naming difference (`provider` vs `adapter`) is meaningful but may not be obvious to users. A note in help text clarifying the distinction would help.

### `token` vs `otel`

**Verdict**: Distinct data sources, complementary — not overlapping.
- `cleo token` reads from `tasks.db` (historical, per-operation token records written by CLI dispatch). Has 4015 records and 12.5M tracked tokens.
- `cleo otel` reads from `.cleo/metrics/TOKEN_USAGE.jsonl` (session/spawn-level event stream written by OTEL instrumentation). Currently empty (TOKEN_USAGE.jsonl does not exist on this machine).

They are different tracking layers at different granularities. The conceptual overlap ("both track tokens") is real but the implementation targets are different. Recommendation: the help text for each should explicitly reference the other's data source to make the distinction clear to users who encounter both.

### `chain` vs `lifecycle`

**Verdict**: Distinct levels of abstraction, complementary.
- `cleo chain` manages WarpChain definitions (templates) and instances. It is the static definition layer: add chain templates, instantiate them for epics, advance stage pointers.
- `cleo lifecycle` manages per-epic RCASD-IVTR+C stage execution: start/complete/skip/gate stages, view history, get guidance. It is the dynamic execution layer.

`chain` defines the workflow shape; `lifecycle` executes it. No duplication. The relationship is that `chain instantiate` creates the instance that `lifecycle` then executes.

### `backup export` vs `cleo export` vs `cleo snapshot export`

**Verdict**: Three distinct operations — NOT overlap of the same feature.
- `cleo backup export` produces a portable `.cleobundle.tar.gz` containing all CLEO data files (SQLite snapshots + JSON). Supports encryption. Designed for cross-machine migration and archival.
- `cleo export` exports tasks to structured formats (JSON/CSV/TSV/Markdown) for human consumption or integration. It reads task data only, not database files.
- `cleo snapshot export` exports task state as a portable JSON snapshot for multi-contributor sharing (Nexus/collab workflow). Narrower than backup export.

All three have distinct purposes and output formats. No duplication. However, the naming `backup export` vs `snapshot export` is confusing at the top level — a user scanning the help might not understand that `snapshot` and `backup` refer to very different portability mechanisms.

---

## ADR-017 Compliance Notes

| Domain | Verb Pattern | Status |
|--------|-------------|--------|
| `adr` | list, show, find, sync, validate | Compliant |
| `cant` | parse, validate, list, execute, migrate | Compliant |
| `skills` | list, search, validate, info, install, uninstall, enable, disable, refresh, dispatch, catalog, precedence, deps, spawn-providers | Compliant |
| `web` | start, stop, status, open | Compliant |
| `backup` | add/create, list, export, import, inspect | Compliant |
| `restore` | backup, task, finalize | Compliant |
| `chain` | list, show, add, instantiate, advance | Compliant |
| `provider` | list, detect, inject-status, supports, hooks, inject | Compliant |
| `adapter` | list, show, detect, health, activate, dispose | Compliant |
| `token` | summary, list, show, delete, clear, estimate | Compliant |
| `otel` | status, summary, sessions, spawns, real, clear | Compliant |

---

## Exit Code Compliance

All commands use the standard CLEO exit code scheme:
- `0` = success
- `1` = general error (E_CLEO_GENERAL, validation failures)
- `2` = invalid input (E_INVALID_INPUT)
- `3` = file not found (E_FILE_READ)
- `4` = entity not found (E_NOT_FOUND)

`cant parse`, `cant validate`, and `cant execute` return exit 0 even when the parsed content has errors, reporting the diagnostic in the JSON envelope. This is consistent behavior — the CLI command succeeded; the CANT content itself failed.

---

## Stale Migration Journal Warning

Multiple commands emit a WARN-level log line before the JSON envelope:

```
{"level":"WARN","subsystem":"sqlite","orphaned":1,"msg":"Detected stale migration journal entries from a previous CLEO version. Reconciling."}
```

This is a recurring noise item. It appears on `backup list`, `provider detect`, `skills search`, and others. The reconcile appears to succeed silently (no follow-up error). This warning should be investigated: either the orphaned journal should be cleaned up once at startup, or the log level should be downgraded to DEBUG after the first occurrence per session.

---

## Recommendations

| Priority | Item | Action |
|----------|------|--------|
| P0 | BUG-001: `restore backup` missing brain.db + project-info.json | Fix valid-file list in restore backup handler |
| P1 | BUG-002: ADR-025 has empty frontmatter | Populate ADR-025 with Date, Status, Summary fields |
| P2 | Stale migration journal WARN fires on many commands | Deduplicate or downgrade to DEBUG after first reconcile |
| P3 | `token` vs `otel` distinction not documented in help | Add cross-reference in each command's description |
| P4 | `provider detect` vs `adapter detect` naming confusion | Add clarifying sentence to adapter detect help |
| P5 | `skills catalog` always returns `available: false` | Document catalog setup steps in help text |
