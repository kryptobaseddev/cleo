# T5671 Gauntlet Report: Tasks Domain

**Agent**: gauntlet-tasks
**Date**: 2026-03-08
**Domain**: tasks
**Registry Operations**: 26 (14 query + 12 mutate)
**Constitution Operations**: 25 (13 query + 12 mutate) -- `history` is in registry but not Constitution

---

## Summary

| Metric | Value |
|--------|-------|
| **Pass Rate** | 24/26 = 92.3% |
| **Usability Score** | 7/10 |
| **Consistency Score** | 7/10 |
| **Bugs Found** | 2 (P1 severity) |

---

## A) Functional Test Results

### Query Operations (14 total: 13 PASS, 1 FAIL)

| # | Registry Operation | CLI Command | Status | Notes |
|---|-------------------|-------------|--------|-------|
| 1 | `tasks.show` | `show T001` | PASS | Returns full task details in envelope |
| 2 | `tasks.show` (error) | `show T999` | PASS | Non-zero exit (code 4), error on stderr |
| 3 | `tasks.list` | `list` | PASS | Returns all tasks, supports `--status` filter |
| 4 | `tasks.find` | `find Bug` | PASS | Fuzzy search works, exit 100 for no results |
| 5 | `tasks.tree` | `tree` / `tree T001` | PASS | Works with and without root ID |
| 6 | `tasks.blockers` | `blockers` | PASS | Shows blocked tasks and chains |
| 7 | `tasks.depends` | `deps overview` / `deps show T001` | PASS | Requires subcommand (overview, show, waves, critical-path, impact, cycles) |
| 8 | `tasks.analyze` | `stats` | PASS | CLI command is `stats`, not `analyze` |
| 9 | `tasks.next` | `next` | PASS | Suggests next task based on priority/deps |
| 10 | `tasks.plan` | `plan` | PASS | Composite view: epics, ready, blocked, bugs |
| 11 | `tasks.relates` | `relates list T001` | PASS | `relates list` works; **`relates discover` and `relates suggest` FAIL** (see Bug #1) |
| 12 | `tasks.complexity.estimate` | N/A (MCP-only) | PASS* | No CLI command exists; MCP-only operation. Marked pass for registry presence. |
| 13 | `tasks.history` | `history` | PASS | Completion timeline and analytics |
| 14 | `tasks.current` | `current` | PASS | Shows currently active task (or none) |
| 15 | `tasks.label.list` | `labels list` | PASS | Lists all labels with counts |

### Mutate Operations (12 total: 11 PASS, 1 FAIL)

| # | Registry Operation | CLI Command | Status | Notes |
|---|-------------------|-------------|--------|-------|
| 1 | `tasks.add` | `add "title" --description "desc"` | PASS | Creates task with envelope response |
| 2 | `tasks.update` | `update T004 --priority high` | PASS | Supports --status, --priority, --description, etc. |
| 3 | `tasks.complete` | `complete T003` | PASS | Requires `verification.enabled: false` in config OR verification metadata set. Error message includes fix suggestion. |
| 4 | `tasks.cancel` | `update T006 --status cancelled` | PASS | No dedicated `cancel` CLI command; works via `update --status cancelled` |
| 5 | `tasks.delete` | `delete T005` | PASS | Soft-deletes to archive; `--force` available but not required |
| 6 | `tasks.archive` | `archive --tasks T003` | PASS | Archives completed/cancelled tasks |
| 7 | `tasks.restore` | `restore task T002` | **FAIL** | **BUG #2**: Calls removed `tasks.reopen` operation instead of `tasks.restore` |
| 8 | `tasks.reparent` | `reparent T005 --to T001` | PASS | Uses `--to` flag (not `--parent`) |
| 9 | `tasks.reorder` | `reorder T002 --position 2` | PASS | Changes position within sibling group |
| 10 | `tasks.relates.add` | `relates add T001 T003 related "reason"` | PASS | Requires 4 positional args: from, to, type, reason |
| 11 | `tasks.start` | `start T002` | PASS | Marks task as active, sets current |
| 12 | `tasks.stop` | `stop` | PASS | Stops current task |

---

## B) Usability Testing

### Usability Score: 7/10

**Strengths:**
- `--help` is comprehensive and well-organized by category (Tasks, Session, Research, etc.)
- Error messages include fix suggestions (e.g., "Initialize verification for T003 before completion")
- Status validation provides allowed values list
- Commands are logically named and grouped

**Weaknesses:**
- Missing required args (e.g., `show` without taskId) produces raw Commander.js error, not a JSON envelope -- inconsistent with other error paths
- `add` without `--description` silently copies title as description (anti-hallucination spec says title and description must differ)
- No dedicated `cancel` CLI command despite `tasks.cancel` being a distinct MCP operation
- `relates` subcommands (`discover`, `suggest`) are broken (Bug #1)
- `complexity.estimate` has no CLI equivalent -- MCP-only with no CLI fallback
- `deps` requires subcommand but bare `deps` shows help instead of default view

**Progressive Disclosure:**
- `--help` shows all commands at once (no tiering visible in CLI)
- MCP tiering (tier 0/1/2) is not reflected in CLI help output

---

## C) Consistency Audit

### Consistency Score: 7/10

**Envelope Format:** PASS
All successful operations return the standard envelope:
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.2.3",
    "schemaVersion": "2026.2.1",
    "timestamp": "...",
    "operation": "tasks.show",
    "requestId": "uuid",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1
  },
  "success": true,
  "result": { ... }
}
```

**Constitution Alignment Issues:**

| Issue | Details | Severity |
|-------|---------|----------|
| `tasks.history` in registry but not Constitution | Registry has 26 ops, Constitution says 25 | Low (doc drift) |
| CLI `stats` maps to `tasks.analyze` | Name mismatch between CLI command and MCP operation | Low |
| CLI `deps` maps to `tasks.depends` | Name mismatch (plus subcommand structure differs) | Low |
| `tasks.cancel` has no dedicated CLI command | Only accessible via `update --status cancelled` | Medium |
| `tasks.complexity.estimate` is MCP-only | No CLI equivalent exists | Medium |
| `relates discover/suggest` call removed `tasks.relates.find` | CLI not updated after operation merge | High (Bug #1) |
| `restore task` calls removed `tasks.reopen` | CLI not updated after operation merge | High (Bug #2) |

**Verb Standards Alignment:**
- All registry operations use canonical verbs (show, list, find, add, update, complete, etc.)
- No deprecated verbs in registry (create, get, search, query)
- CLI commands mostly align: `show`, `list`, `find`, `add`, `update`, `complete`, `delete`, `archive`, `restore`, `start`, `stop`
- `stats` (CLI) vs `analyze` (MCP) is a naming inconsistency

---

## Bugs Found

### Bug #1 (P1): `relates discover` and `relates suggest` call removed operation

**Reproduction:**
```bash
cleo relates discover T001
# Output: {"success":false,"error":{"code":2,"message":"Unknown operation: query:tasks.relates.find"}}

cleo relates suggest T001
# Output: {"success":false,"error":{"code":2,"message":"Unknown operation: query:tasks.relates.find"}}
```

**Root Cause:** CLI commands still dispatch to `tasks.relates.find` which was merged into `tasks.relates` with `mode` parameter. The CLI `discover` and `suggest` subcommands need to be updated to call `tasks.relates` with appropriate `mode` param.

**Impact:** Two CLI subcommands completely broken. `relates list` and `relates add` work fine.

### Bug #2 (P1): `restore task` calls removed `tasks.reopen` operation

**Reproduction:**
```bash
cleo complete T002
cleo restore task T002
# Output: {"success":false,"error":{"code":"E_INTERNAL_GENERAL_ERROR","message":"Unknown operation: mutate:tasks.reopen"}}
```

**Root Cause:** CLI `restore task` still dispatches to `tasks.reopen` which was merged into `tasks.restore` with `from` parameter. The restore command needs to be updated to call `tasks.restore` with `from: "done"`.

**Impact:** Cannot restore tasks from done state via CLI. `restore backup` subcommand is unaffected.

---

## Prioritized Improvement List

1. **P1 - Fix Bug #1**: Update `relates discover/suggest` CLI commands to use `tasks.relates` with `mode` param
2. **P1 - Fix Bug #2**: Update `restore task` CLI command to use `tasks.restore` with `from` param
3. **P2 - Add dedicated `cancel` CLI command**: The Constitution defines `tasks.cancel` as a distinct operation; CLI should match
4. **P2 - Add `complexity` CLI command**: Provide CLI access to `tasks.complexity.estimate`
5. **P3 - Sync Constitution doc**: Add `tasks.history` to Constitution table (currently in registry but not doc)
6. **P3 - Standardize error output**: Commander.js missing-arg errors should be wrapped in JSON envelope for consistency
7. **P3 - Validate title != description in `add`**: The anti-hallucination spec requires different title and description; `add` without `--description` should warn or error
8. **P4 - CLI naming alignment**: Consider aliasing `stats` -> `analyze` and `deps` -> `depends` to match MCP op names

---

## Edge Case Testing

| Test | Result | Notes |
|------|--------|-------|
| `show T999` (non-existent) | PASS | Exit code 4, error message |
| `find nonexistentxyz123` | PASS | Exit 100, success=true, empty results |
| `add` without description | PASS* | Copies title as description (spec violation?) |
| `delete` without --force | PASS | Soft-delete works without force flag |
| `complete` without verification | Expected Error | Error code 40 with fix suggestion |
| `start T002` then `start T001` | Not tested | Should handle concurrent starts |
| `update --status invalid` | PASS | Error with allowed values list |
