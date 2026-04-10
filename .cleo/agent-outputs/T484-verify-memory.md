# T484 — Memory Domain CLI Runtime Verification

**Date**: 2026-04-10  
**Auditor**: CLI Runtime Verifier (subagent)  
**Scope**: All `cleo memory`, `cleo observe`, `cleo brain`, `cleo refresh-memory` commands

---

## Results Table

| Command | Exit | Status | Dispatch Op | Notes |
|---------|------|--------|-------------|-------|
| `cleo observe "text"` | 0 | PASS | `memory.observe` | Convenience alias — correctly routes to same op as `memory observe` |
| `cleo memory find "test"` | 0 | PASS | `memory.find` | Returns observations + learnings; 20 results for broad query |
| `cleo memory observe "text"` | 0 | PASS | `memory.observe` | Same dispatch op as `cleo observe` — confirmed DUPLICATE entry point |
| `cleo memory store --type pattern --content X --context Y` | 0 | PASS | `memory.pattern.store` | Creates `P-*` id; type field stored as `workflow` regardless of input |
| `cleo memory store --type learning --content X --source Y` | 0 | PASS | `memory.learning.store` | Creates `L-*` id; confidence defaults to 0.5 |
| `cleo memory stats` | 0 | PASS | (direct) | Response is 1.1MB+ — extremely large payload, all patterns/learnings returned |
| `cleo memory timeline --help` | 0 | PASS | — | Help renders correctly; requires `<ANCHOR>` positional |
| `cleo memory fetch --help` | 0 | PASS | — | Help renders correctly; requires `<IDS>` positional |
| `cleo memory decision find` | 1 | BUG | `memory.decision.store` | **ROUTING BUG**: `find` subword treated as positional arg; routes to `store`, fails on missing `--decision` |
| `cleo memory decision store --decision X --rationale Y` | 0 | PASS | `memory.decision.store` | Creates `D-*` id |
| `cleo memory graph show --help` | 0 | BUG | — | **ROUTING BUG**: shows `remove` help instead of `show` help |
| `cleo memory graph neighbors --help` | 0 | BUG | — | **ROUTING BUG**: shows `remove` help instead of `neighbors` help |
| `cleo memory graph add --help` | 0 | BUG | — | **ROUTING BUG**: shows `remove` help instead of `add` help |
| `cleo memory graph remove --help` | 0 | PASS | — | Help renders correctly (last registered wins) |
| `cleo memory graph show <nodeId>` | 0 | BUG | `memory.graph.remove` | **DISPATCH BUG**: dispatches to `remove`, not `show`; returns E_INVALID_INPUT |
| `cleo memory reason why --help` | 0 | BUG | — | **ROUTING BUG**: shows `similar` help instead of `why` help |
| `cleo memory reason similar --help` | 0 | PASS | — | Help renders correctly (last registered wins) |
| `cleo memory reason why <taskId>` | 0 | BUG | `memory.reason.similar` | **DISPATCH BUG**: dispatches to `similar`, not `why`; returns empty results |
| `cleo memory search hybrid "test"` | 0 | WARN | `memory.search.hybrid` | Works — "hybrid" is treated as positional arg passed to `search <query>`; effectively same as `cleo memory search "hybrid"` but query becomes "hybrid" not "test" |
| `cleo memory search "test"` | 0 | PASS | `memory.search.hybrid` | Correct entry point; `search` command is single-word so works properly |
| `cleo memory link --help` | 0 | PASS | — | Help renders correctly; requires `<TASKID> <ENTRYID>` |
| `cleo brain maintenance --help` | 0 | PASS | — | Separate top-level group; only 1 subcommand (`maintenance`) |
| `cleo brain --help` | 0 | PASS | — | Shows single `maintenance` subcommand |
| `cleo refresh-memory` | 0 | PASS | (direct) | Standalone top-level command; regenerates memory-bridge.md |

---

## Critical Bugs

### BUG-1: Multi-word subcommands collapse to last-registered (BLOCKER)

**Root cause**: `parseCommandName()` in `commander-shim.ts` takes only the first whitespace-delimited token as the command name. All subsequent tokens become positional args.

When `memory-brain.ts` registers:
```
memory.command('graph show <nodeId>')   → name: 'graph', args: ['show', 'nodeId']
memory.command('graph neighbors <nodeId>') → name: 'graph', args: ['neighbors', 'nodeId']
memory.command('graph add')             → name: 'graph', args: []
memory.command('graph remove')          → name: 'graph', args: []
```

All four register as `subCommands['graph']` in `shimToCitty`. Each overwrites the prior. The last one (`remove`) wins. Same pattern for `reason why` / `reason similar` — `similar` wins.

**Affected commands** (completely broken — wrong dispatch or wrong help):
- `cleo memory graph show` → dispatches as `graph.remove`
- `cleo memory graph neighbors` → dispatches as `graph.remove`
- `cleo memory graph add` → dispatches as `graph.remove`
- `cleo memory reason why` → dispatches as `reason.similar`
- `cleo memory decision find` → dispatches as `decision.store` (fails with exit 1)

**Fix location**: `packages/cleo/src/cli/commands/memory-brain.ts`  
These should be nested subcommand groups, not multi-word flat command names:
```ts
// Instead of:
memory.command('graph show <nodeId>')

// Register a 'graph' subcommand group with its own subcommands:
const graph = memory.command('graph');
graph.command('show <nodeId>').action(...)
graph.command('neighbors <nodeId>').action(...)
graph.command('add').action(...)
graph.command('remove').action(...)
```

### BUG-2: `cleo memory search hybrid "query"` mismatch

**Observed**: `cleo memory search hybrid "test"` succeeds with exit 0 but the query becomes `"hybrid"`, not `"test"`. The word `"test"` is silently dropped as an extra positional.

`memory.command('search hybrid <query>')` → name: `'search'`, args: `['hybrid', 'query']`. Only the first positional (`hybrid`) is used as `query`. The actual query string (`"test"`) is the second positional and is ignored.

**Fix**: Rename to `memory.command('search <query>')` (already exists and works) or register a proper nested `search` group with `hybrid` subcommand.

### BUG-3: `cleo memory decision find` does not exist

**Observed**: `cleo memory decision find` exits 1 with "Missing required argument: --decision". There is no `find` variant for decisions. The `memory decision` command is a single command (`store`), not a group.

**Fix**: Either add a `memory decision find` command that searches decisions, or remove the reference to it from documentation/protocols.

---

## Duplicate Analysis

| Pair | Same Operation? | Verdict |
|------|----------------|---------|
| `cleo observe "text"` vs `cleo memory observe "text"` | YES — both dispatch `mutate memory observe` | Intentional alias. `observe.ts` documents this explicitly as a "convenience alias". No bug — by design. |
| `cleo brain` vs `cleo memory` | NO — different domains | `cleo brain` = maintenance/optimization ops (`brain.maintenance`). `cleo memory` = CRUD for observations, patterns, learnings, decisions, graph, search. Distinct and complementary. |
| `cleo refresh-memory` vs `cleo memory ...` | NO — different scope | `refresh-memory` regenerates the memory-bridge.md file from brain.db. It is an admin/housekeeping op, not a memory query/store op. Standalone top-level is correct. |
| `cleo memory search "query"` vs `cleo memory search hybrid "query"` | SAME underlying op | `search` (single word) correctly dispatches to `memory.search.hybrid`. `search hybrid` is broken (swallows the actual query). Use `cleo memory search "query"` — it is the correct and working form. |
| `cleo memory store --type pattern` vs pattern-specific command | NO duplicate — only `store` exists | No standalone `cleo memory pattern store` shortcut exists. `store --type pattern/learning` is the only path. |

---

## Memory Domain Boundary Summary

```
cleo observe / cleo memory observe   → brain.db observations (same op, two entry points)
cleo memory find                     → search observations + learnings + patterns
cleo memory stats                    → all brain.db content (WARNING: huge payload)
cleo memory store --type pattern     → brain.db patterns
cleo memory store --type learning    → brain.db learnings
cleo memory timeline                 → chronological anchor context
cleo memory fetch                    → full details by ID
cleo memory decision                 → brain.db decisions (store only, no find)
cleo memory link                     → associate brain entry with task
cleo memory graph show/neighbors/add → BROKEN (dispatch to remove)
cleo memory graph remove             → works
cleo memory reason why               → BROKEN (dispatch to similar)
cleo memory reason similar           → works
cleo memory search "query"           → hybrid FTS5/vector/graph search (USE THIS)
cleo memory search hybrid "query"    → BROKEN (query arg dropped)
cleo brain maintenance               → decay, consolidation, embedding backfill
cleo refresh-memory                  → regenerate .cleo/memory-bridge.md
```

---

## Recommended Fixes (Priority Order)

1. **HIGH** — Fix multi-word subcommand registration in `memory-brain.ts` for `graph` group (4 commands broken) and `reason` group (1 command broken). Use nested `ShimCommand` groups.
2. **HIGH** — Fix `memory search hybrid <query>` — rename to `memory search <query>` or restructure as nested group.
3. **MEDIUM** — Add `memory decision find [query]` command, or document that `memory search` is the correct way to find decisions.
4. **LOW** — Add pagination or `--limit` to `memory stats` — current response is 1.1MB+ and will exceed agent context windows.

---

## Files Examined

- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/memory-brain.ts` — command registration source
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/observe.ts` — top-level observe alias
- `/mnt/projects/cleocode/packages/cleo/src/cli/commander-shim.ts` — root cause of multi-word bug
- `/mnt/projects/cleocode/packages/cleo/src/cli/index.ts` — shimToCitty translation layer
