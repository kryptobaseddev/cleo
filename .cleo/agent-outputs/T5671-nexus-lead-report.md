# T5671 Gauntlet Report: Nexus Domain

**Agent**: gauntlet-nexus-sticky
**Date**: 2026-03-08
**Test environment**: `/tmp/cleo-gauntlet-nexus`

## Registry vs Constitution Alignment

Constitution defines **20 operations** (12 query + 8 mutate). Registry matches exactly.

| Gateway | Operation | Constitution | Registry | CLI Command | Status |
|---------|-----------|:---:|:---:|-------------|--------|
| query | status | Y | Y | `nexus status` | PASS |
| query | list | Y | Y | `nexus list` | PASS |
| query | show | Y | Y | `nexus show` | PASS |
| query | resolve | Y | Y | `nexus show\|query` | PASS |
| query | deps | Y | Y | `nexus deps` | PASS |
| query | graph | Y | Y | MCP-only | N/T |
| query | path.show | Y | Y | `nexus critical-path` | PASS |
| query | blockers.show | Y | Y | `nexus blocking` | PASS |
| query | orphans.list | Y | Y | `nexus orphans` | PASS |
| query | discover | Y | Y | `nexus discover` | PASS |
| query | search | Y | Y | `nexus search` | PASS |
| query | share.status | Y | Y | MCP-only | N/T |
| mutate | init | Y | Y | `nexus init` | PASS |
| mutate | register | Y | Y | `nexus register` | PASS |
| mutate | unregister | Y | Y | `nexus unregister` | PASS |
| mutate | sync | Y | Y | `nexus sync` | PASS |
| mutate | permission.set | Y | Y | MCP-only | N/T |
| mutate | reconcile | Y | Y | `nexus reconcile` | PASS |
| mutate | share.snapshot.export | Y | Y | MCP-only | N/T |
| mutate | share.snapshot.import | Y | Y | MCP-only | N/T |

**N/T** = Not Tested (MCP-only, no CLI equivalent)

## A) Functional Testing

### Query Operations (12)

| Operation | Input | Output | Verdict |
|-----------|-------|--------|---------|
| `status` | (none) | `{initialized: true, projectCount: 672, lastUpdated: ...}` | PASS |
| `list` | (none) | Returns all 672 registered projects with full metadata | PASS |
| `show` (resolve) | `T001` | Resolves task with `_project` field | PASS |
| `show` (invalid) | `nonexistent:T999` | `{success: false, code: 1, "Project not found"}` | PASS |
| `discover` | `T001` | Returns 10 related tasks across projects with scores | PASS |
| `search` | `"test"` | Returns 20 matching tasks across projects | PASS |
| `deps` | `T001` | `{depends: [], blocking: []}` (no deps on test task) | PASS |
| `deps` (invalid) | `nonexistent:T999` | `{success: false, code: 1}` | PASS |
| `path.show` (critical-path) | (none) | Returns critical path with 1 entry | PASS |
| `blockers.show` (blocking) | `T001` | `{blocking: [], impactScore: 0}` | PASS |
| `orphans.list` (orphans) | (none) | `{orphans: [], count: 0}` | PASS |

### Mutate Operations (8)

| Operation | Input | Output | Verdict |
|-----------|-------|--------|---------|
| `init` | (none) | `{message: "NEXUS initialized successfully"}` | PASS |
| `register` | `/tmp/cleo-gauntlet-nexus` | Returns hash; duplicate returns error | PASS |
| `unregister` | `cleo-gauntlet-nexus` | Success message; re-register works | PASS |
| `unregister` (invalid) | `nonexistent-project` | `{success: false, code: 1, "not found"}` | PASS |
| `sync` | (none) | `{synced: 672, failed: 0}` | PASS |
| `reconcile` | (none) | `{status: "ok"}` | PASS |

## B) Usability

### Help Discoverability
- `nexus --help` lists all CLI subcommands clearly
- Each subcommand has descriptive text
- Arguments shown for commands that need them (`<path>`, `<nameOrHash>`, etc.)

### Error Messages
- **Not found errors**: Clear message with project/task identifier (`"Project not found in registry: nonexistent"`)
- **Duplicate register**: Clear error (`"Project already registered with hash: ..."`)
- **Exit codes**: Consistent (1 for general errors)
- **JSON structure**: All errors follow `{success: false, error: {code, message}}` pattern

### Naming Observations
- CLI uses `critical-path` but MCP operation is `path.show` -- Constitution documents this as a removed alias
- CLI uses `blocking` but MCP operation is `blockers.show` -- same, documented alias
- CLI uses `show|query` for the `resolve` operation -- `show` is the primary, `query` is aliased

## C) Consistency

- All 20 ops in registry match Constitution exactly (count, names, gateways, tiers)
- LAFS envelope present on all responses (`$schema`, `_meta`, `success`, `result`)
- `_meta.operation` correctly reflects MCP operation names (e.g., `nexus.resolve` not `nexus.query`)
- Tier assignments match: status + list at tier 1, everything else tier 2
- 5 MCP-only operations (graph, share.status, share.snapshot.export/import, permission.set) have no CLI equivalent -- acceptable for tier 2

## Issues Found

| Severity | Issue | Details |
|----------|-------|---------|
| INFO | MCP-only ops untestable via CLI | graph, share.status, share.snapshot.export/import, permission.set lack CLI commands. Standard for tier 2 advanced ops. |
| INFO | list output very large | `nexus list` returns 248KB+ for 672 projects. May benefit from pagination flag. |

## Verdict: PASS

All 15 CLI-testable operations work correctly. Error handling is consistent. Registry and Constitution are perfectly aligned at 20 operations.
