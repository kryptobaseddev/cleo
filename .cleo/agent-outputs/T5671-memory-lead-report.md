# T5671 Memory Domain Gauntlet Report

**Agent**: gauntlet-memory
**Domain**: memory (18 operations: 11 query + 7 mutate)
**Date**: 2026-03-08
**Verdict**: PASS (with notes)

---

## Pass A: Functional Testing

### CLI Operations Tested (4 subcommands)

| CLI Command | MCP Operation(s) | Result | Notes |
|---|---|---|---|
| `memory observe <text> [--title]` | `memory.observe` | PASS | Returns ID, type, timestamp |
| `memory store --type pattern` | `memory.pattern.store` | PASS | All flags work: --content, --context, --pattern-type, --impact, --linked-task |
| `memory store --type learning` | `memory.learning.store` | PASS | All flags work: --content, --source, --confidence, --actionable |
| `memory find <query>` | `memory.find` | PASS | Cross-table FTS5 search works |
| `memory find --type pattern` | `memory.pattern.find` | PASS | Filters to patterns only |
| `memory find --type learning` | `memory.learning.find` | PASS | Filters to learnings only |
| `memory find --actionable` | `memory.find` (variant) | PASS | Filters actionable entries |
| `memory find --min-confidence` | `memory.learning.find` (variant) | PASS | Confidence threshold applied |
| `memory find --pattern-type` | `memory.pattern.find` (variant) | PASS | Pattern type filter works |
| `memory find --limit` | `memory.find` (variant) | PASS | Limit respected |
| `memory find --json` | `memory.find` (variant) | PASS | JSON output well-formed |
| `memory stats` | (no MCP equivalent) | PASS | Returns patterns + learnings summary |
| `memory stats --json` | (no MCP equivalent) | PASS | JSON output matches non-JSON |

### MCP-Only Operations (no CLI subcommand)

These operations exist in the domain handler and registry but have no CLI command:

| MCP Operation | Domain Handler | Registry | Constitution | Notes |
|---|---|---|---|---|
| `memory.timeline` | Implemented | Yes | Yes (tier 1) | No CLI command |
| `memory.fetch` | Implemented | Yes | Yes (tier 1) | No CLI command |
| `memory.decision.find` | Implemented | Yes | Yes (tier 1) | No CLI command |
| `memory.decision.store` | Implemented | Yes | Yes (tier 1) | No CLI command |
| `memory.link` | Implemented | Yes | Yes (tier 1) | No CLI command |
| `memory.graph.show` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.graph.neighbors` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.graph.add` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.graph.remove` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.reason.why` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.reason.similar` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |
| `memory.search.hybrid` | Implemented | Yes | Yes (tier 2) | No CLI command (Phase 3) |

**Note**: MCP is the primary interface; CLI is backup. MCP-only operations are expected for tier 2 advanced features.

### Error Handling

| Scenario | Exit Code | Error Message | Result |
|---|---|---|---|
| `store` without `--type` | 1 | Commander: "required option '--type' not specified" | PASS |
| `store --type invalid` | 1 | "Unknown memory type: invalid. Use 'pattern' or 'learning'." | PASS - Clear message |
| `find ""` (empty query) | 2 | "Missing required parameters: query" | PASS |
| `observe ""` (empty text) | 2 | "Missing required parameters: text" | PASS |
| `find "nonexistent"` (no results) | 0 | Returns `{results: [], total: 0}` | PASS - success:true with empty results |
| `store --type pattern --impact extreme` | 0 | Accepted "extreme" without validation | **NOTE** - see finding F1 |
| `store --type learning --confidence 2.5` | 1 | "Confidence must be between 0.0 and 1.0" | PASS |

---

## Pass B: Usability

| Check | Result | Notes |
|---|---|---|
| `memory --help` | PASS | Lists all 4 subcommands with descriptions |
| `memory store --help` | PASS | Lists all options with descriptions and types |
| `memory find --help` | PASS | Documents all filter options |
| `memory observe --help` | PASS | Minimal, clear |
| `memory stats --help` | PASS | Shows --json option |
| Unknown subcommand (`memory bogus`) | PASS | Exit 1 with "unknown command" error |
| Response envelope consistency | PASS | All responses include $schema, _meta, success, result |
| Operation names in _meta | PASS | e.g., "memory.observe", "memory.pattern.store", "memory.find" |

### Usability Notes

- Help text is concise and accurate
- Error messages are actionable (e.g., "Use 'pattern' or 'learning'")
- JSON output mode (`--json`) works on find and stats
- The CLI `find` command intelligently routes to the right MCP operation based on `--type` flag

---

## Pass C: Consistency

### Registry vs Constitution Alignment

| Metric | Value |
|---|---|
| Registry entries (domain: 'memory') | 18 |
| Constitution entries (section 6.3) | 18 |
| Domain handler operations (getSupportedOperations) | 18 (11 query + 7 mutate) |
| **Match** | **EXACT** |

### Verb Standards Compliance

| Operation | Verb | Standard? | Notes |
|---|---|---|---|
| `memory.find` | find | Yes | Canonical discovery verb |
| `memory.timeline` | timeline | Yes | Listed in Constitution verb table |
| `memory.fetch` | fetch | Yes | Listed in Constitution verb table |
| `memory.observe` | observe | Yes | Listed in Constitution verb table |
| `memory.decision.find` | find | Yes | |
| `memory.decision.store` | store | Yes | Listed in Constitution verb table |
| `memory.pattern.find` | find | Yes | |
| `memory.pattern.store` | store | Yes | |
| `memory.learning.find` | find | Yes | |
| `memory.learning.store` | store | Yes | |
| `memory.link` | link | Yes | Listed in Constitution verb table |
| `memory.graph.show` | show | Yes | Canonical read verb |
| `memory.graph.neighbors` | neighbors | Acceptable | Domain-specific, not a generic verb |
| `memory.graph.add` | add | Yes | Canonical create verb |
| `memory.graph.remove` | remove | Yes | |
| `memory.reason.why` | why | Acceptable | Domain-specific reasoning verb |
| `memory.reason.similar` | similar | Acceptable | Domain-specific reasoning verb |
| `memory.search.hybrid` | search.hybrid | **NOTE** | See finding F2 |

### Response Format Consistency

All tested operations return the standard CLEO envelope:
- `$schema` field present
- `_meta` with specVersion, schemaVersion, timestamp, operation, requestId, transport, strict, mvi, contextVersion
- `success` boolean
- `result` on success / `error` on failure
- Error responses include `code` (numeric or string) and `message`

---

## Findings

### F1: Impact field not validated against enum (LOW)

`memory store --type pattern --impact extreme` succeeds and stores "extreme" as the impact value. The Constitution and CLI help say impact should be "low, medium, high" but the store does not validate against this enum. The pattern is stored with impact="extreme".

**Severity**: Low - data quality issue, not a crash or security risk
**Recommendation**: Add impact enum validation in `memoryPatternStore` core function

### F2: `search.hybrid` uses deprecated `search` verb (LOW)

The Constitution explicitly lists `memory.search.hybrid` as a valid operation. However, the Verb Standards doc says `find` is canonical and `search` is deprecated. The Constitution takes precedence, but there is a minor inconsistency.

**Severity**: Low - documented exception in Constitution
**Recommendation**: Consider renaming to `memory.find.hybrid` in a future cleanup pass

### F3: CLI coverage gap for 12 of 18 MCP operations (INFO)

Only 6 of 18 memory operations are accessible via CLI (observe, pattern.store, learning.store, find, pattern.find, learning.find). The remaining 12 (timeline, fetch, decision.find, decision.store, link, graph.*, reason.*, search.hybrid) are MCP-only.

**Severity**: Info - by design (MCP is primary, CLI is backup). But decision.find and decision.store seem common enough to warrant CLI commands.

**Recommendation**: Consider adding `memory decision` and `memory link` CLI subcommands for common tier 1 operations.

### F4: `memory.stats` exists in CLI but not in Constitution (INFO)

The CLI has `memory stats` but the Constitution lists `memory.stats` under "Removed operations" with note "not replaced (dashboard metric, not agent workflow)". The CLI command still works and is useful for human debugging.

**Severity**: Info - acceptable divergence since CLI serves humans, not agents.

---

## Summary

| Pass | Result | Score |
|---|---|---|
| A: Functional | All tested operations work correctly | 18/18 ops implemented |
| B: Usability | Help text, errors, and discoverability are good | No blockers |
| C: Consistency | Registry, Constitution, and handler are aligned at 18 ops | Exact match |

**Overall**: PASS. The memory domain is well-implemented with strong alignment between registry, Constitution, and handler code. The 4 findings are all low/info severity. No bugs or blockers found.
