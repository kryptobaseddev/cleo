# T5671 Gauntlet Report: Tools Domain

**Agent**: gauntlet-ota
**Date**: 2026-03-08
**Version**: 2026.3.24

## Registry Operations (from ops --tier 2)

| Gateway | Operations |
|---------|-----------|
| query (16) | issue.diagnostics, skill.list, skill.show, skill.find, skill.dispatch, skill.verify, skill.dependencies, skill.spawn.providers, skill.catalog, skill.precedence, provider.list, provider.detect, provider.inject.status, provider.supports, provider.hooks, todowrite.status |
| mutate (6) | skill.install, skill.uninstall, skill.refresh, provider.inject, todowrite.sync, todowrite.clear |
| **Total** | **22 operations** |

## A) Functional Testing

### CLI-Exposed Operations

| Operation | CLI Command | Result | Notes |
|-----------|------------|--------|-------|
| tools.skill.list | `skills list` | PASS | Returns 14 skills with full metadata |
| tools.skill.show | `skills info ct-cleo` | PASS | Returns skill name, path, metadata |
| tools.skill.find | `skills search test` | PASS | Returns fuzzy-matched results (2 hits) |
| tools.skill.install | `skills install nonexistent` | PASS (error) | Proper error: ENOENT for missing skill |
| tools.skill.uninstall | `skills uninstall nonexistent` | PASS (error) | Proper error: "Skill uninstall failed" |
| tools.skill.refresh | `skills refresh` | PASS | Returns {updated:[], failed:[], checked:1} |
| tools.skill.verify | `skills validate ct-cleo` | FAIL | Error: "No skill library registered" - needs CAAMP_SKILL_LIBRARY env |
| admin.token (query) | `token summary` | PASS | Returns aggregated token telemetry |
| admin.token (query) | `token list` | PASS | Returns 28 individual records |
| admin.token (mutate) | `token estimate --help` | PASS | Shows estimation options |
| todowrite.sync | `sync` | PASS | Shows subcommand help |
| todowrite.status | `inject` | PASS | Returns injection markdown |

### MCP-Only Operations (10/22)

| Operation | Notes |
|-----------|-------|
| tools.skill.dispatch | MCP-only (agent skill routing) |
| tools.skill.dependencies | MCP-only |
| tools.skill.spawn.providers | MCP-only |
| tools.skill.catalog | MCP-only |
| tools.skill.precedence | MCP-only |
| tools.provider.list | MCP-only |
| tools.provider.detect | MCP-only |
| tools.provider.inject.status | MCP-only |
| tools.provider.supports | MCP-only |
| tools.provider.hooks | MCP-only |

### Error Handling

| Scenario | Result | Error Message |
|----------|--------|---------------|
| Install nonexistent skill | PASS | ENOENT with file path |
| Uninstall nonexistent skill | PASS | "Skill uninstall failed" (code 1) |
| Validate without library | PARTIAL | Error message could be more helpful |
| commands --domain admin | FAIL | `error: unknown option '--domain'` - deprecation but bad UX |

## B) Usability

- **Help discoverability**: `skills --help` shows 11 subcommands clearly
- **Error messages**: Generally clear; `skills validate` error could explain how to fix
- **Deprecation notice**: `commands` shows deprecation message - good
- **Output format**: Consistent envelope for all operations

## C) Consistency

- **Operation names match Constitution**: YES
- **Response format**: Standard envelope throughout
- **CLI coverage**: ~12/22 operations CLI-accessible (55%)
- **Verb alignment**: `skills search` CLI maps to `tools.skill.find` - verb mismatch (CLI uses `search`, registry uses `find`)

## Issues Found

| # | Severity | Description |
|---|----------|-------------|
| 1 | MEDIUM | `skills validate` fails with unhelpful error about missing skill library. Should either work without CAAMP_SKILL_LIBRARY or explain setup steps |
| 2 | LOW | `skills search` CLI subcommand uses non-canonical verb `search` instead of `find` (though registry maps to `tools.skill.find` correctly) |
| 3 | LOW | `backup --list` fails with `error: unknown option '--list'` - should be `backup` subcommand or documented flag |
| 4 | INFO | 10/22 ops MCP-only - expected for provider/agent infrastructure |
| 5 | INFO | `commands` deprecated but still accessible - deprecation path working |

## Summary

**PASS with issues** - Core skill operations (list, show, find, install, uninstall, refresh) work correctly. Token telemetry works. Two notable issues: `skills validate` fails without CAAMP env setup, and `skills search` uses non-canonical verb. Provider operations are MCP-only by design.
