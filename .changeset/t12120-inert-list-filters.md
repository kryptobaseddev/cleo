---
id: t12120-inert-list-filters
tasks: [T12120]
kind: fix
summary: cleo list honours every filter it advertises — severity/kind now filter, an unknown value errors instead of returning the whole table, and the CLI can no longer drop a registry-declared param
---

Closes GH #1245, #1246, #1247, #1248.

`cleo list` accepted four filter flags and applied none of them. Each failed **open** — the constraint was dropped and every task returned, with no error, no warning, and an envelope indistinguishable from a successful narrow query. Measured on a 3173-task project: `--severity P0`, `--severity P3` and `--severity BOGUS` all returned 3173 rows, byte-identical. An agent asked to account for the P0 work reads that as "these 3173 tasks are all P0".

**Root cause.** The `tasks.list` filter set was hand-re-declared at **seven** independent layers, and a filter was honoured only if spelled correctly in all seven:

1. `contracts/src/dispatch/operations-registry.ts` — `params[]` (derives the `--help` surface)
2. `cleo/src/cli/commands/list.ts` — a hand-written `if (args['x'] !== undefined) params['x'] = args['x']` block
3. `cleo/src/dispatch/domains/tasks.ts` — the typed domain handler, re-enumerated
4. `core/src/tasks/ops.ts` `tasksListOp` — re-typed
5. `core/src/tasks/list.ts` `listTasksEngine` — re-typed again
6. `core/src/tasks/list.ts` `ListTasksOptions` → `queryFilters`
7. `contracts/src/data-accessor.ts` `TaskQueryFilters` → SQL `WHERE`

Four flags, three distinct mechanisms, one structural cause:

- **`--severity` (#1245) and `--kind` (#1246)** existed at *no* layer. They reached `args` only because citty silently accepts unknown flags, and neither appeared in `cleo list --help`. Both are ADR-066 first-class axes that `cleo add` persists correctly (`severity` column; `kind` → the `role` column) — only the read path was missing. Now wired through all seven layers with real `WHERE severity IN (...)` / `WHERE role IN (...)` clauses, single value or list.
- **`--children` (#1247)** was declared in the registry, advertised in `--help`, threaded through four layers into `listTasks()`'s options bag — and never read by the query builder. It also has no implementable meaning as documented: `--parent` already restricts to direct children on every path (the default query applies `eq(tasks.parentId, …)`, and the saga branch resolves members through the same containment since T10638), so there is no transitive mode to narrow from. Rather than invent a semantic, the flag is made **honest**: its registry description now states it is a no-op retained for compatibility, and a test pins the `--parent X` ≡ `--parent X --children` equivalence so a future transitive mode is forced to give the flag real meaning in the same change.
- **`--compact` (#1248)** was declared in the registry *and* correctly implemented in core — the CLI's hand-copy simply omitted it, so it never reached dispatch.

**An unrecognised filter value no longer widens a result set.** `--severity BOGUS` and `--kind chore` now fail with `E_VALIDATION` (exit 6) naming the offending value and every accepted value, via `assertTaskAxisFilters` in `core/src/tasks/axis-filters.ts`. Returning everything is the most dangerous possible response to "show me only the critical items", so a value that cannot be applied is an error, never a silent widening.

**The class fix — layer 2 is gone.** `registryParamsToDispatchPayload` (`cleo/src/cli/lib/registry-args.ts`) builds the dispatch payload from the same `ParamDef[]` that `paramsToCittyArgs` uses to build the flags, coercing each value to its declared type. A param can no longer be advertised without also being forwarded. Two tests enforce it: one fails if any registry-declared param is not forwarded, one fails if the advertised and forwardable surfaces differ. `--limit 0` (the "no limit" escape hatch) is explicitly covered, since a naive falsy check would have broken it.

Also documents `--limit 0` in the registry description — it has always meant "every match" in core and was documented nowhere, which is half of GH #1242.
