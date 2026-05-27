# CLI Full Audit — Memory & Notes Domain

**Audited**: 2026-04-11  
**Auditor**: Claude Sonnet 4.6 (subagent)  
**Scope**: All `cleo memory`, `cleo brain`, `cleo sticky`, `cleo reason`, `cleo observe`, and `cleo refresh-memory` commands

---

## 1. Summary Table

| # | Command | Help Text | Execution | Exit Code | Envelope | Notes |
|---|---------|-----------|-----------|-----------|----------|-------|
| 1 | `cleo memory store` (pattern) | PASS | PASS | 0 | `{success,data,meta}` | |
| 2 | `cleo memory store` (learning) | PASS | PASS | 0 | `{success,data,meta}` | |
| 3 | `cleo memory find` | PASS | PASS | 0 | `{success,data,meta}` | `--type observation` silently falls through to all-types search (undocumented) |
| 4 | `cleo memory stats` | FAIL (partial) | PASS | 0 | `{success,data,meta}` | Help shows no options, but `--json` is accepted at runtime via global flag |
| 5 | `cleo memory observe` | PASS | PASS | 0 | `{success,data,meta}` | |
| 6 | `cleo memory timeline` | FAIL (partial) | PASS | 0 | `{success,data,meta}` | `--json` missing from help but works (global flag). Also no `--json` in help. |
| 7 | `cleo memory fetch` | FAIL (partial) | PASS | 0 | `{success,data,meta}` | `--json` missing from help entirely but accepted via global flag |
| 8 | `cleo memory decision-find` | PASS | FAIL (bug) | 0 | `{success,data,meta}` | Multi-word phrase search returns 0 results; single words work. FTS5 phrase quoting issue. |
| 9 | `cleo memory decision-store` | PASS | PASS | 0 | `{success,data,meta}` | |
| 10 | `cleo memory link` | PASS | PASS | 0 | `{success,data,meta}` | |
| 11 | `cleo memory graph-show` | PASS | PASS | 0 | `{success,data,meta}` | Returns E_NOT_FOUND (exit 4) for non-PageIndex IDs (e.g. observation IDs) — correct |
| 12 | `cleo memory graph-neighbors` | PASS | PASS | 0 | `{success,data,meta}` | |
| 13 | `cleo memory graph-add` | PASS | PASS | 0 | `{success,data,meta}` | |
| 14 | `cleo memory graph-remove` | PASS | PASS | 0 | `{success,data,meta}` | Emits WARN about stale migration journal (cosmetic) |
| 15 | `cleo memory reason-why` | PASS | PASS | 0 | `{success,data,meta}` | Returns empty `blockers/rootCauses` for tasks with no recorded deps — correct |
| 16 | `cleo memory reason-similar` | PASS | PASS (degraded) | 0 | `{success,data,meta}` | Always returns 0 results — no vector embeddings generated. Silent degradation, no warning emitted. |
| 17 | `cleo memory search-hybrid` | PASS | PASS | 0 | `{success,data,meta}` | Falls back to FTS5 only (no vectors). Score is 0 for FTS-only hits — correct. |
| 18 | `cleo brain maintenance` | PASS | PASS | 0 | JSON direct (not envelope) | Outputs bare JSON without `{success,data,meta}` wrapper in `--json` mode — envelope violation |
| 19 | `cleo refresh-memory` | PASS | PASS | 0 | plaintext stdout | No `--json` option. Output is human-readable plaintext — acceptable for a maintenance command |
| 20 | `cleo sticky add` / `jot` | PASS | PASS | 0 | `{success,data,meta}` | `jot` is an alias for `add` — both show identical help |
| 21 | `cleo sticky list` / `ls` | PASS | PASS | 0 | `{success,data,meta}` | `ls` is an alias for `list` — identical help |
| 22 | `cleo sticky show` | PASS | PASS | 0 | `{success,data,meta}` | |
| 23 | `cleo sticky convert` | PASS | PASS | 0 | `{success,data,meta}` | `--toTask` / `--toMemory` flags use camelCase in help, but kebab-case is also accepted |
| 24 | `cleo sticky archive` | PASS | PASS | 0 | `{success,data,meta}` | Works on converted stickies too (double-archiving allowed) |
| 25 | `cleo sticky purge` | PASS | PASS | 0 | `{success,data,meta}` | |
| 26 | `cleo reason impact` (--change) | PASS | PASS | 0 | `{success,data,meta}` | |
| 27 | `cleo reason impact` (taskId) | PASS | FAIL | 3 | `{success:false,error,meta}` | Returns `E_NOT_INITIALIZED` "Task not found" for non-existent task — correct error but wrong code (3 vs 4) |
| 28 | `cleo reason timeline` | PASS | PASS | 0 | `{success,data,meta}` | Returns full audit log across all operations touching the task |
| 29 | `cleo observe` (top-level) | n/a | n/a | n/a | n/a | NOT wired as top-level. Running `cleo observe` shows the global help. The file `observe.ts` is a dead registration — see Issue #1 below. |

**Overall: 23 PASS / 4 FAIL / 1 DEAD**

---

## 2. Duplicate Analysis

### 2.1 `cleo brain` vs `cleo memory` — Why Separate?

**Finding**: These are NOT duplicates — they operate on the same DB but with orthogonal concerns.

- `cleo memory` = **data operations**: store, find, observe, fetch, link, graph, search. All read/write brain.db content.
- `cleo brain maintenance` = **housekeeping operations**: temporal decay, consolidation, embedding backfill, orphan reconciliation. These are optimization passes, not data access.

The separation is intentional and correct. The naming creates a hierarchy mismatch however: `brain maintenance` lives under a top-level `brain` command (1 subcommand) instead of logically fitting under `cleo memory`. The `brain` command exists as a distinct top-level because the implementation bypasses the dispatch layer and calls `runBrainMaintenance()` directly from core. This is noted in the source (`brain.ts` L13 uses `getProjectRoot, runBrainMaintenance` directly).

**Recommendation**: Keep the separation but document it clearly. Consider moving `cleo brain maintenance` to `cleo memory maintenance` to unify the surface. The sole reason it is separate is that it bypasses dispatch — that could be refactored if desired, but it is not urgent.

---

### 2.2 `cleo memory observe` vs `cleo observe` (top-level)

**Finding**: `cleo observe` is registered in `observe.ts` but that registration function is NEVER called. Running `cleo observe` shows the global help, not the observe command. The file exists as a dead stub.

Evidence:
- `observe.ts` line 17: `program.command('observe <text>')` — registers the command.
- Running `cleo observe --help` shows the root `cleo` help, not the observe subcommand.
- The file comment says "Thin alias for `cleo memory observe <text>`" — so the intent was a top-level alias.

**Recommendation**: Either wire `registerObserveCommand` into the CLI entrypoint or delete `observe.ts`. The alias is useful for agents (the CLEO protocol doc references `cleo observe` as the primary save command). If the alias is desired, it should be registered. If `cleo memory observe` is the canonical form, remove the dead file.

---

### 2.3 `cleo memory decision-store` vs `cleo session record-decision`

**Finding**: These overlap in name but serve different scopes:

| Command | Storage | Scope | Requires session? | Search later? |
|---------|---------|-------|-------------------|---------------|
| `cleo memory decision-store` | `brain.db` decisions table | Permanent, cross-session memory | No | Yes, via `memory decision-find` |
| `cleo session record-decision` | `tasks.db` session audit log | Session-scoped, requires `--taskId` | Yes (active session) | Via `session decision-log` |

These are NOT the same thing. Session decisions are ephemeral audit trail entries tied to a specific session and task. Brain decisions are permanent memory intended for agent recall. The naming collision is confusing but the semantics are distinct.

**Recommendation**: The help text for both should call out the distinction explicitly. Suggest adding a line to `memory decision-store` help: "For in-session tracking, use `cleo session record-decision`." And vice versa.

---

### 2.4 `cleo memory reason-why` vs `cleo reason impact` vs `cleo deps impact` — Triple Overlap?

**Finding**: These address similar questions ("what will break?") but from three different angles:

| Command | Input | What it does | Data source |
|---------|-------|-------------|-------------|
| `cleo memory reason-why <taskId>` | task ID | Causal trace: finds blocker chain and root causes for why a task is blocked | `brain.db` — recorded dependency graph |
| `cleo reason impact <taskId>` | task ID | Downstream dependency impact: what tasks depend on this one | `tasks.db` — task dependency edges |
| `cleo reason impact --change <text>` | free text | Semantic match: find tasks related to a described change | `tasks.db` — FTS5 title/description |
| `cleo deps impact <taskId>` | task ID | Same as `reason impact <taskId>` — both dispatch to `tasks.depends` action=impact | `tasks.db` |

`reason impact <taskId>` and `deps impact <taskId>` ARE true duplicates — both call the same dispatch operation `tasks.depends` with `action: 'impact'`. The source code comment in `reason.ts` lines 7-8 explicitly acknowledges the prior duplication between `reason why`/`reason similar` and their `memory` counterparts, stating those were removed. The `deps impact` vs `reason impact` overlap was not cleaned up at the same time.

`memory reason-why` is conceptually different: it queries causal chains in the brain's reasoning layer (why is this blocked?), not downstream impact.

**Recommendation**:
- `cleo memory reason-why` — keep, distinct purpose (causal/blocker trace in brain)
- `cleo reason impact` — keep, provides two modes (free-text semantic + taskId graph)
- `cleo deps impact` — DUPLICATE of `reason impact <taskId>`. Recommend deprecation or removal. At minimum, help text should say "See also: `cleo reason impact <taskId>`".

---

### 2.5 `cleo memory reason-similar` vs `cleo memory find`

**Finding**: These overlap conceptually but use different lookup strategies:

| Command | Mechanism | Input type |
|---------|-----------|------------|
| `cleo memory find <query>` | FTS5 full-text search across patterns, learnings, observations | Text query |
| `cleo memory search-hybrid <query>` | FTS5 + vector similarity + graph traversal | Text query |
| `cleo memory reason-similar <entryId>` | Vector similarity (embeddings) | Entry ID (finds entries similar to an existing entry) |

`reason-similar` is input-by-ID (find things similar to entry X), while `find` is input-by-text (find things matching a query). These are NOT duplicates — they answer different questions.

**However**: `reason-similar` currently always returns 0 results because no vector embeddings have been generated (`brain maintenance` shows `processed: 0`). It silently degrades with an empty result set and no warning. This is a usability bug.

**Recommendation**: `reason-similar` should emit a warning (or a `_warnings` field in JSON output) when the embeddings store is empty. Something like: `"No embeddings found. Run \`cleo brain maintenance\` to generate vector embeddings."`. The command is not broken — it is just unusable without embeddings.

---

### 2.6 `cleo memory timeline` vs `cleo reason timeline`

**Finding**: These are DISTINCT commands targeting completely different timelines:

| Command | Input | What it returns |
|---------|-------|----------------|
| `cleo memory timeline <observationId>` | observation ID | Chronological context window around one brain.db observation (what was recorded before/after it) |
| `cleo reason timeline <taskId>` | task ID | Full audit log of all operations that touched a task (task history from tasks.db) |

No overlap. Different databases, different concepts. The shared "timeline" noun is slightly misleading but not harmful.

**Recommendation**: No change needed. The help text for each is already distinguishing. Consider mentioning the other in a "See also" note for discoverability.

---

### 2.7 `cleo sticky` vs `cleo memory` — Where Should Notes Go?

**Finding**: These serve different temporal scopes, not different types of content:

| Feature | `cleo sticky` | `cleo memory` |
|---------|---------------|---------------|
| Lifetime | Ephemeral (active/converted/archived) | Permanent (cross-session, decay-adjusted) |
| Purpose | Quick capture, reminders, work-in-progress notes | Knowledge retention, patterns, decisions |
| Conversion | Can be promoted to task or memory | Cannot be demoted to sticky |
| Searchable | By tag/color/status | By FTS5, vector, graph |

The `sticky convert --toMemory` bridge makes the direction explicit: sticky is the scratchpad, memory is the archive. This is a clean design.

**Recommendation**: No change needed. The distinction is correct and `sticky convert` provides the upgrade path. The CLEO protocol doc could benefit from a one-liner explaining this: "Use `cleo sticky` for ephemeral notes; use `cleo memory observe` for permanent knowledge."

---

### 2.8 `cleo brain maintenance` — Only One Subcommand, Wrong Parent?

**Finding**: `cleo brain` has exactly one subcommand (`maintenance`) and its parent command description is "Brain memory optimization operations". The command is a separate top-level specifically because it bypasses the dispatch layer and calls `runBrainMaintenance()` directly from the core package (see `brain.ts` lines 13-14).

This creates a surface-area oddity: the entire `brain` top-level exists solely to house one subcommand. Running `cleo brain` alone shows "Brain memory optimization operations" with only `maintenance` listed.

**Recommendation**: Move `cleo brain maintenance` to `cleo memory maintenance`. The separation is an implementation detail (direct core call vs dispatch) that should not be exposed in the CLI surface. This is a medium-priority cleanup, not a blocker.

---

### 2.9 `cleo refresh-memory` — Why Top-Level?

**Finding**: `cleo refresh-memory` regenerates `.cleo/memory-bridge.md` from brain.db. It is a maintenance operation with no `--json` flag and no options. It is registered as a top-level command because `refresh-memory.ts` is a standalone file added in T5240.

It does not fit naturally as a top-level command — it is a memory maintenance operation. The protocol doc references it as a session-management tool (memory bridge is used by agents at session start).

**Recommendation**: Move to `cleo memory refresh-bridge` or `cleo memory refresh`. The top-level position creates category confusion (it appears in the MEMORY & NOTES section of `cleo --help` but is its own root-level entry alongside the `memory` subcommand group). Alternatively, make it an alias under `cleo memory`: `cleo memory refresh`.

---

## 3. Issues by Severity

### P0 — Bug

**Issue #1: `cleo observe` is a dead stub**  
File: `packages/cleo/src/cli/commands/observe.ts`  
`registerObserveCommand` is never called from the CLI entrypoint. Running `cleo observe "text"` outputs the global help instead of saving an observation. The CLEO protocol doc instructs agents to use `cleo observe` — this is broken.  
Fix: Register `registerObserveCommand` in the entrypoint, OR delete `observe.ts` and update docs.

**Issue #2: `cleo memory decision-find` fails for multi-word phrases**  
`cleo memory decision-find "CLI dispatch"` returns `total: 0` despite a matching entry existing. `cleo memory decision-find "CLI"` and `cleo memory decision-find "dispatch"` each return the entry separately. This is an FTS5 phrase query bug — multi-word input is likely being treated as a phrase match instead of AND-joined tokens, or the FTS5 query is not quoting/tokenizing correctly.  
Fix: Investigate the FTS5 query construction in the decision.find dispatch operation. Likely needs `"CLI" AND "dispatch"` or the string needs to be tokenized before query construction.

**Issue #3: `cleo brain maintenance --json` does not use the standard envelope**  
Output is bare JSON (`{"decay":...,"embeddings":...}`) without the `{success,data,meta}` envelope required by ADR-039. All other `--json` outputs in this domain wrap with the standard envelope. `brain.ts` writes the result directly with `console.log(JSON.stringify(result, null, 2))` (line 93).  
Fix: Wrap the result in the standard `cliOutput()` call.

**Issue #4: `cleo reason impact <taskId>` returns exit code 3 (`E_NOT_INITIALIZED`) for missing tasks**  
Expected exit code for a not-found resource is 4 (`E_NOT_FOUND`). Code 3 is `E_NOT_INITIALIZED` which is semantically wrong. The underlying dispatch operation `tasks.depends` appears to be returning the wrong error code when the task doesn't exist.  
Fix: Verify the `tasks.depends` operation returns `E_NOT_FOUND` (code 4) when the taskId is absent.

### P1 — Usability

**Issue #5: `cleo memory reason-similar` silently returns empty when no embeddings exist**  
No warning is emitted. Agents will assume the command works and receive no signal that embeddings need to be generated first. This is especially confusing because `memory search-hybrid` partially works (FTS5 path) while `reason-similar` returns nothing.  
Fix: Detect empty embeddings store during `reason.similar` and return a `_warnings` field or a non-zero exit code.

**Issue #6: `cleo memory stats` help shows no options**  
The command accepts `--json` via the global format flag but the help text shows zero options. This makes it look like a broken or incomplete command.  
Fix: Add `--json` to the help text, or document that it respects the global `--json` flag.

**Issue #7: `cleo memory fetch` and `cleo memory timeline` are missing `--json` from help**  
Both commands accept `--json` at runtime (tested and confirmed working) via the global format-context flag, but neither lists it in help. All peer commands in the domain (`find`, `decision-find`, `link`, etc.) show `--json` explicitly.  
Fix: Add explicit `--json` option to both commands, OR document that the global `--json` flag works for all `memory` subcommands.

### P2 — Surface Cleanup

**Issue #8: `cleo deps impact` duplicates `cleo reason impact <taskId>`**  
Both dispatch `tasks.depends` with `action: impact`. The `reason.ts` source comment already cleaned up `reason why`/`reason similar` duplicates — `deps impact` was missed.  
Fix: Deprecate `cleo deps impact` or add a "See also" redirect in its help text.

**Issue #9: `cleo brain maintenance` is a lone subcommand under a separate top-level**  
Should logically live under `cleo memory maintenance`. The isolation is an implementation detail.  
Fix: Register under `memory` command group, keep `brain maintenance` as a deprecated alias.

**Issue #10: `cleo refresh-memory` is top-level, should be under `cleo memory`**  
As a memory maintenance operation it does not warrant its own top-level slot.  
Fix: `cleo memory refresh` or `cleo memory refresh-bridge`.

---

## 4. Help Text Quality Assessment

| Command | Quality | Notes |
|---------|---------|-------|
| `cleo memory store` | Good | All options documented with types and enum values |
| `cleo memory find` | Good | Agent filter `--agent` well-documented |
| `cleo memory stats` | Poor | Shows no options; `--json` silently accepted |
| `cleo memory observe` | Good | Type enum values listed in help |
| `cleo memory timeline` | Fair | Missing `--json` |
| `cleo memory fetch` | Fair | Missing `--json`, no mention of comma-separated ID support |
| `cleo memory decision-find` | Good | Query is optional (correctly shown as `[QUERY]`) |
| `cleo memory decision-store` | Good | Required options marked clearly |
| `cleo memory link` | Good | Positional args named clearly |
| `cleo memory graph-show` | Good | Brief but complete |
| `cleo memory graph-neighbors` | Good | |
| `cleo memory graph-add` | Good | Node/edge mode separation clear |
| `cleo memory graph-remove` | Good | |
| `cleo memory reason-why` | Fair | No mention that empty results may mean no recorded deps vs. no data |
| `cleo memory reason-similar` | Poor | No mention of embedding requirement; always returns empty without warning |
| `cleo memory search-hybrid` | Good | Clearly states FTS5 + vector + graph |
| `cleo brain maintenance` | Good | All skip flags documented |
| `cleo refresh-memory` | Fair | No options shown; no mention of what memory-bridge.md is |
| `cleo sticky add/jot` | Good | Defaults shown in help (`--color="yellow"`, `--priority="medium"`) |
| `cleo sticky list/ls` | Good | Default shown for `--status` and `--limit` |
| `cleo sticky show` | Good | Minimal but complete |
| `cleo sticky convert` | Good | Both `--toTask` and `--toMemory` modes explained |
| `cleo sticky archive` | Good | |
| `cleo sticky purge` | Good | Destruction warning in description |
| `cleo reason impact` | Good | Two-mode behavior documented inline |
| `cleo reason timeline` | Good | |

---

## 5. Wiring Verification

All commands verified as wired in the CLI entrypoint except:

- `cleo observe` — `registerObserveCommand` IS NOT called (dead code, P0 issue)

All other commands responded to `--help` with exit 0, confirming they are registered.

---

## 6. Envelope Conformance Summary

| Standard | Conforming | Non-conforming |
|----------|------------|----------------|
| `{success,data,meta}` | 27 of 29 commands | `brain maintenance --json` (bare JSON), `refresh-memory` (plaintext, no JSON option) |

`refresh-memory` is acceptable as a maintenance utility with plaintext output. `brain maintenance --json` is a bug.
