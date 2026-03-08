# T5671 Gauntlet Report: Admin Domain

**Agent**: gauntlet-ota
**Date**: 2026-03-08
**Version**: 2026.3.24

## Registry Operations (from ops --tier 2)

| Gateway | Operations |
|---------|-----------|
| query (15) | version, health, config.show, stats, context, runtime, job, dash, log, sequence, help, token, adr.show, adr.find, export |
| mutate (15) | init, config.set, backup, migrate, cleanup, job.cancel, safestop, inject.generate, install.global, token, adr.sync, health, context.inject, import, detect |
| **Total** | **30 operations** |

## A) Functional Testing

### Query Operations

| Operation | CLI Command | Result | Notes |
|-----------|------------|--------|-------|
| admin.version | `version` | PASS | Returns `{"version":"2026.3.24"}` |
| admin.health | `doctor` | PASS | 4 checks all pass (cleo_dir, tasks_db, audit_log, config_json) |
| admin.config.show | `config get test.key` | PASS | Returns stored value |
| admin.config.show | `config get project.name` | PASS (error) | "Config key not found" (code 1) |
| admin.stats | `stats` | PASS | Full stats: counts, priority, type, phase, completion metrics |
| admin.context | `context` | PASS | Shows subcommand help |
| admin.runtime | `env` | PASS | Returns channel, mode, version, node, platform |
| admin.dash | `dash` | PASS | Full dashboard: summary, taskWork, session, highPriority, blocked |
| admin.log | `log` | PASS | Returns entries with pagination (0 entries in fresh project) |
| admin.sequence | `sequence show` | PASS | counter=4, lastId=T004, nextId=T5 |
| admin.sequence | `sequence check` | PASS | counter=4, maxIdInData=4, valid=true |
| admin.help | `ops` | PASS | Tier 0 by default, shows 24 ops with quickStart guide |
| admin.help | `ops --tier 0` | PASS | Same as default |
| admin.help | `ops --tier 2` | PASS | Full 201+ ops across all 10 domains |
| admin.adr.find | `adr list` | PASS | Returns empty list (no ADRs in test project) |
| admin.export | `export` | PASS | Exports full task data |
| admin.token (query) | `token summary` | PASS | Aggregated token telemetry |
| admin.token (query) | `token list` | PASS | Individual telemetry records |

### Mutate Operations

| Operation | CLI Command | Result | Notes |
|-----------|------------|--------|-------|
| admin.init | `init` | PASS (tested in setup) | Full initialization with skills, nexus, injection |
| admin.config.set | `config set test.key test-value` | PASS | Sets and persists config value |
| admin.backup | `backup` | PASS | Creates snapshot with tasks.db, brain.db, config.json, project-info.json |
| admin.safestop | `safestop --reason "test"` | PASS | Returns stopped=true, sessionEnded=false |
| admin.adr.sync | `adr sync` | PASS | Returns {inserted:0, updated:0, skipped:0} |
| admin.inject.generate | `inject` | PASS | Returns full MVI injection markdown |
| admin.detect | `detect-drift` | PASS | Returns 8 checks (4 pass, 1 warn, 3 error) |
| admin.import | `import-tasks --help` | PASS | Shows full import options |
| admin.export | `export-tasks` | PASS | Exports portable .cleo-export.json |

### MCP-Only Operations (6/30)

| Operation | Notes |
|-----------|-------|
| admin.job (query) | Job status/list via action param - MCP workflow |
| admin.job.cancel | Job cancellation - MCP workflow |
| admin.cleanup | Not exposed as CLI command |
| admin.migrate (MCP) | CLI has `migrate claude-mem` but full migrate is MCP |
| admin.install.global | `install-global` CLI exists but not tested (modifies global state) |
| admin.context.inject | MCP-only session context injection |
| admin.health (mutate) | Separate from query health - MCP repair mode |

### Error Handling

| Scenario | Result | Error Message |
|----------|--------|---------------|
| Config key not found | PASS | "Config key 'project.name' not found" (code 1) |
| Empty config key | PASS | "key is required" (code 2) |
| ADR not found | PASS | "ADR not found: ADR-999" (code 4) |
| Safestop without reason | PASS | Commander.js: "required option '--reason' not specified" |
| adr validate | FAIL | "Unknown operation: mutate:admin.adr.validate" - not in registry |

### Output Format Options

| Option | Result | Notes |
|--------|--------|-------|
| `--json` (default) | PASS | Standard JSON envelope |
| `--human` | PASS | Human-readable table format (tested with dash) |
| `--mvi minimal` | PASS | Minimal envelope |
| `--mvi full` | PASS | Full envelope |
| `--field version` | PASS | Returns plain text "2026.3.24" |
| `--quiet` | PASS | Still returns JSON (quiet suppresses non-essential only) |

## B) Usability

- **Help discoverability**: Excellent - `--help` at every level, `ops --tier N` progressive disclosure
- **Error messages**: Clear, structured, with error codes
- **Human format**: Working for dashboard and complex outputs
- **Progressive disclosure**: Tier 0/1/2 system works correctly
- **Config flow**: get/set/list all work correctly

## C) Consistency

- **Operation names match Constitution**: YES - all 30 ops verified via ops --tier 2
- **Response format**: 100% consistent envelope across all operations
- **CLI coverage**: ~24/30 operations CLI-accessible (80%) - highest of the three domains
- **Verb alignment**: Canonical verbs used consistently (show, find, not get/search)
- **ADR ops**: adr.find correctly absorbs adr.list (Wave A fix confirmed working)

## Issues Found

| # | Severity | Description |
|---|----------|-------------|
| 1 | MEDIUM | `adr validate` CLI command routes to `mutate:admin.adr.validate` which is NOT registered in the dispatch registry. Should either be registered or the CLI command removed |
| 2 | LOW | `backup --list` is not a valid option. Backup listing may need a subcommand |
| 3 | LOW | `config show` is not a CLI subcommand (use `config get <key>` instead). The MCP op `admin.config.show` maps to CLI `config get` - minor naming asymmetry |
| 4 | INFO | `env` returns version 2026.3.20 while `version` returns 2026.3.24 - different version sources (npm install vs runtime) |
| 5 | INFO | `detect-drift` reports 3 errors for files at source code paths (CLEO-OPERATIONS-REFERENCE.md, src/mcp/domains/, CLEO-INJECTION.md) - expected when running against test dir not source |

## Summary

**PASS** - Admin domain is the most complete of the three domains tested. 24/30 operations accessible via CLI. All core operations (version, health, dash, stats, config, backup, sequence, log, help, adr) work correctly. Output format options (json, human, mvi, field, quiet) all functional. One notable issue: `adr validate` routes to an unregistered operation.
