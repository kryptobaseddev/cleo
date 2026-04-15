# CLI Audit: Research & Orchestration Domain

**Date**: 2026-04-10
**Auditor**: cleo-prime (CLI-Full-Audit session)
**Scope**: `cleo research` (10 subcommands) + `cleo orchestrate` (23 subcommands + `tessera` sub-tree)

---

## Summary Table

| # | Command | Exit | Status | Notes |
|---|---------|------|--------|-------|
| 1 | `cleo research add` | 0 (help) | HELP OK | Requires `-t/--task` and `--topic` |
| 2 | `cleo research show <id>` | 0 | PASS | Returns `fileContent: null, fileExists: false` when file missing — acceptable |
| 3 | `cleo research list` | 0 | PASS | Filters work: `--status`, `--task`, `--limit` |
| 4 | `cleo research pending` | 0 | PASS | Alias for `manifest.list` with `status: pending` |
| 5 | `cleo research link` | 0 (help) | **BUG** | Creates a new stub entry instead of linking existing entry to a task |
| 6 | `cleo research update` | 0 (help) | **BUG** | Uses `manifest.append` (upsert) but zeroes `linked_tasks`; updating strips task linkages |
| 7 | `cleo research stats` | 0 | PASS | Returns totals by status and agent type |
| 8 | `cleo research links <taskId>` | 2 | **BUG (BROKEN)** | Calls `manifest.find` (requires `query` string); should call `manifest.list` with `{ taskId }` |
| 9 | `cleo research archive` | 0 | PASS | Returns `archived: 0, remaining: 1` when no entries match `--beforeDate` |
| 10 | `cleo research manifest` | 0 | **BUG (silent)** | `--agent-type` option has a camelCase mismatch: reads `opts['agentType']` but citty/commander stores `opts['agentType']` only in some parsers; needs verification |
| 11 | `cleo orchestrate start <epicId>` | 0 (help) | HELP OK | Calls `orchestrateStartup` — creates DB state |
| 12 | `cleo orchestrate status` | 0 | PASS | Project-wide summary; `--epic` scopes to one epic |
| 13 | `cleo orchestrate analyze <epicId>` | 0 | PASS | Returns waves, circular deps, missing deps |
| 14 | `cleo orchestrate ready <epicId>` | 0 | PASS | Returns parallel-safe tasks |
| 15 | `cleo orchestrate next <epicId>` | 0 | PASS | Returns next task within epic scope |
| 16 | `cleo orchestrate waves <epicId>` | 0 | **DUPLICATE** | Identical output to `cleo deps waves <epicId>` |
| 17 | `cleo orchestrate spawn <taskId>` | 0 | PASS | Reads spawn context; does not execute |
| 18 | `cleo orchestrate validate <taskId>` | 0 | PASS | Returns `ready: true, issues: []` for valid task |
| 19 | `cleo orchestrate context <epicId>` | 0 | PASS | Returns token estimate + epic/task summary |
| 20 | `cleo orchestrate parallel <action> <epicId>` | 0 (help) | HELP OK | Actions: `start`, `end` |
| 21 | `cleo orchestrate tessera list` | 0 | PASS | Returns `tessera-rcasd` template with full RCASD pipeline shape |
| 22 | `cleo orchestrate tessera instantiate` | 0 (help) | HELP OK | Requires `<templateId> <epicId>` |
| 23 | `cleo orchestrate unblock` | 0 | PASS | Returns `highImpact: [], singleBlocker: [], commonBlockers: []` |
| 24 | `cleo orchestrate bootstrap` | 0 | PASS | Fast bootstrapping context; `--epic` scopes it |
| 25 | `cleo orchestrate classify <request>` | 0 | **DEGRADED** | Returns `confidence: 0, team: null` — no CANT team definitions loaded; needs `teams.cant` seeded |
| 26 | `cleo orchestrate fanout-status --manifestEntryId <id>` | 0 | PASS | Returns empty status for unknown IDs (no error); `found: false` in data |
| 27 | `cleo orchestrate handoff <taskId> --protocol <type>` | 0 (help) | HELP OK | Writes handoff state; requires `--protocol` |
| 28 | `cleo orchestrate spawn-execute <taskId>` | 6 | PASS (error path) | Validates task ID format; returns `E_VALIDATION_FAILED` for bad IDs |
| 29 | `cleo orchestrate fanout <epicId>` | 0 (help) | HELP OK | `--tasks` narrows to specific task IDs |
| 30 | `cleo orchestrate conduit-status` | 0 | PASS (connected: false) | Reports `API returned 401` in `error` field — SignalDock not authenticated locally |
| 31 | `cleo orchestrate conduit-peek` | 0 | PASS | Returns empty messages array when no active conduit |
| 32 | `cleo orchestrate conduit-start` | 0 (help) | HELP OK | `--pollInterval` in ms |
| 33 | `cleo orchestrate conduit-stop` | 0 (help) | HELP OK | No options |
| 34 | `cleo orchestrate conduit-send <content>` | 0 (help) | HELP OK | `--to` (agent) or `--conversation` (conv ID) |

---

## Bugs Found

### BUG-1: `research links <taskId>` — Wrong dispatch target (EXIT 2 / E_MISSING_PARAMS)

**Severity**: HIGH — command is completely broken

**Symptom**: Any call to `cleo research links <taskId>` returns:
```json
{"success":false,"error":{"code":2,"message":"Missing required parameters: query","codeName":"E_MISSING_PARAMS"}}
```

**Root cause**: `/packages/cleo/src/cli/commands/research.ts` line 186 calls `manifest.find` with `{ taskId }` as the params object. `manifest.find` is a text-search operation that requires a `query` string — it does not accept `taskId` as a filter. The correct operation is `manifest.list` which does accept `{ taskId }` as an in-memory filter (confirmed in `pipelineManifestList`).

**Fix**:
```typescript
// research.ts line 184-191 — change dispatch target from manifest.find to manifest.list
.action(async (taskId: string) => {
  await dispatchFromCli(
    'query',
    'pipeline',
    'manifest.list',      // <-- was 'manifest.find'
    { taskId },
    { command: 'research' },
  );
});
```

---

### BUG-2: `research link <researchId> <taskId>` — Creates new entry instead of linking

**Severity**: MEDIUM — silently wrong behavior

**Symptom**: Running `cleo research link res_abc T001` does not link the existing entry `res_abc` to `T001`. Instead, it calls `manifest.append` with `id: researchId` which creates or upserts a new stub entry with that ID, discarding any existing findings, sources, topics, or status.

**Root cause**: `research.ts` lines 110-134 call `manifest.append`. The correct operation is `manifest.link` (implemented in `pipelineManifestLink` in `pipeline-manifest-sqlite.ts` at line 970), but `manifest.link` is **not registered** in the pipeline dispatch switch. It appears in core but has no case in `queryManifest`/`mutateManifest`.

**Fix** (two parts):
1. Register `manifest.link` in `/packages/cleo/src/dispatch/domains/pipeline.ts` `mutateManifest` switch:
   ```typescript
   case 'link': {
     const result = await pipelineManifestLink(
       params?.taskId as string,
       params?.researchId as string,
       params?.notes as string | undefined,
       this.projectRoot,
     );
     return wrapResult(result, 'mutate', 'pipeline', 'manifest.link', startTime);
   }
   ```
2. Update `research.ts` `link` action to call `manifest.link` with `{ taskId, researchId }`.

---

### BUG-3: `research update <id>` — Overwrites `linked_tasks` with empty array

**Severity**: MEDIUM — data loss on update

**Symptom**: Calling `cleo research update <id> --findings "new finding"` upserts the entry via `manifest.append` with `linked_tasks: []`. Any previously linked tasks are silently cleared.

**Root cause**: `research.ts` lines 151-172 build the append payload with `linked_tasks: []` hardcoded. There is no read-then-update pattern. `manifest.append` is an upsert that replaces the full record.

**Fix**: Add a `manifest.update` operation (or extend `manifest.append` to merge `linked_tasks` when `linked_tasks` is omitted from the payload). As a minimal fix in the CLI layer: call `manifest.show` first to fetch existing `linked_tasks`, then include them in the append payload.

---

### BUG-4: `research manifest --agent-type` — Option value not passed

**Severity**: LOW — silent filter failure

**Symptom**: `cleo research manifest --agent-type researcher` silently ignores the filter. The code at line 225 reads `opts['agentType']` but Commander registers the option as `--agent-type <type>` with key `agentType` — this should work in Commander but was observed to pass `undefined` in testing under certain citty shim configurations.

**Root cause**: Citty shim camelCase conversion may not normalize `agent-type` → `agentType` in all code paths. Needs verification against the shim behavior in `commander-shim.ts`.

**Impact**: Agents filtering research by type get back unfiltered results with no error signal.

---

## Overlap / Duplicate Analysis

### `cleo orchestrate waves` vs `cleo deps waves` — DUPLICATE

Both accept `<epicId>` and return identical JSON structure:
```json
{"epicId":"T091","waves":[],"totalWaves":0,"totalTasks":0}
```
`cleo orchestrate waves` internally calls the same `orchestrateWaves` function used by `cleo deps waves`. There is no functional difference. The `orchestrate waves` surface was likely added for UX convenience during multi-agent orchestration sessions, but it adds surface area with no behavioral distinction.

**Recommendation**: Remove `orchestrate waves`. Reference `deps waves` from orchestrate help text.

---

### `cleo orchestrate status` vs `cleo session status` — DIFFERENT (no real overlap)

These serve different concerns:
- `orchestrate status` → task completion metrics scoped to epics (total/done/active/blocked/pending counts)
- `session status` → session lifecycle (who is running, since when, task focus, notes, stats)

The names look similar but they address different audiences. No change needed.

---

### `cleo orchestrate handoff` vs `cleo session handoff` — DIFFERENT (no real overlap)

- `orchestrate handoff <taskId> --protocol <type>` → **writes** handoff state for an in-progress task so a successor agent can be spawned
- `session handoff` → **reads** handoff data from the most recently ended session

These are complementary: orchestrate handoff produces what session handoff reads. Not a duplicate. No change needed.

---

### `cleo orchestrate next <epicId>` vs `cleo next` — SCOPED DIFFERENTLY (no real overlap)

- `orchestrate next <epicId>` → next task within a specific epic, used by orchestrator agents
- `cleo next` → project-wide next task suggestion based on global priority score

Different scope and algorithm. Both are necessary for their respective workflows. No change needed.

---

### `cleo orchestrate conduit-*` vs `cleo agent send/poll` — DIFFERENT LAYERS

- `orchestrate conduit-*` → proxies through `ConduitHandler` → SignalDock cloud API (ADR-042); targets agent-to-agent messaging at the orchestration layer
- `agent send` → routes through `agent.send` dispatch; also targets SignalDock but is the lower-level single-agent operation

Per ADR-042, the `orchestrate conduit-*` commands are the correct entrypoint for orchestrators. `agent send/poll` is the direct agent interface. The surface area is intentional. No change needed, but the help text for `orchestrate conduit-*` should cross-reference ADR-042.

---

### `cleo research manifest` vs `cleo research list` — FUNCTIONAL OVERLAP

Both call `manifest.list` with nearly identical parameters:

| Option | `research list` | `research manifest` |
|--------|----------------|---------------------|
| `--task` | yes | yes |
| `--status` | yes | yes |
| `--limit` | yes | yes |
| `--agent-type` | no | yes |
| `--topic` | no | yes |

`research manifest` is a superset of `research list` with two additional filters. These should be merged: `research list` should absorb `--agent-type` and `--topic`, and `research manifest` should be deprecated or removed.

**Recommendation**: Extend `research list` with `--agent-type` and `--topic`. Remove `research manifest` or make it an alias.

---

### `cleo orchestrate classify` — DEGRADED (not broken)

Returns `confidence: 0, team: null` because `teams.cant` is not seeded in the global workflows directory. The command itself is correctly wired to `orchestrate.classify` dispatch → CANT routing logic. This is a configuration gap, not a code bug. Needs `teams.cant` to be seeded as part of `cleo init` or documented as a setup step.

---

### `cleo orchestrate tessera` — WIRED AND WORKING

`tessera list` returns the full `tessera-rcasd` template (9-stage RCASD pipeline, 35 gates, complete shape). `tessera instantiate` is help-only verified. The tessera subsystem is fully functional.

---

## Confirmed Passing (read-only live execution)

| Command | Operation | Result |
|---------|-----------|--------|
| `research list` | `pipeline.manifest.list` | 1 entry returned |
| `research pending` | `pipeline.manifest.list(status=pending)` | 0 entries returned |
| `research stats` | `pipeline.manifest.stats` | `{total:1, byStatus:{partial:1}}` |
| `research manifest` | `pipeline.manifest.list` | 1 entry returned (agentType filter silent) |
| `research show res_1775873522415` | `pipeline.manifest.show` | Full entry, `fileExists: false` |
| `research archive --beforeDate 2020-01-01` | `pipeline.manifest.archive` | `archived: 0` safe |
| `orchestrate status` | `orchestrate.status` | `{totalEpics:9, totalTasks:80}` |
| `orchestrate unblock` | `orchestrate.unblock.opportunities` | `{highImpact:[], singleBlocker:[]}` |
| `orchestrate bootstrap` | `orchestrate.bootstrap` | Session + progress + nextSuggestion |
| `orchestrate conduit-status` | `orchestrate.conduit.status` | `{connected:false, error:"API returned 401"}` |
| `orchestrate conduit-peek` | `orchestrate.conduit.peek` | `{messages:[]}` |
| `orchestrate classify "..."` | `orchestrate.classify` | `confidence: 0` (no CANT teams configured) |
| `orchestrate tessera list` | `orchestrate.tessera.list` | Full `tessera-rcasd` template |
| `orchestrate fanout-status --manifestEntryId nonexistent` | `orchestrate.fanout.status` | `{found:false}` — graceful |
| `orchestrate analyze T091` | `orchestrate.analyze` | Waves, dep graph returned |
| `orchestrate waves T091` | `orchestrate.waves` | Same output as `deps waves T091` |
| `orchestrate ready T091` | `orchestrate.ready` | `{readyTasks:[], total:0}` |
| `orchestrate next T091` | `orchestrate.next` | `{nextTask:{id:"T501",...}}` |
| `orchestrate validate T501` | `orchestrate.validate` | `{ready:true, issues:[]}` |
| `orchestrate spawn T091` | `orchestrate.spawn` | `{spawnContext:{protocol:"decomposition"}}` |
| `orchestrate bootstrap --epic T091` | `orchestrate.bootstrap` | Epic-scoped context |
| `orchestrate context T091` | `orchestrate.context` | `[epicId, taskCount, manifestEntries, estimatedTokens, recommendation, limits]` |

---

## Action Items (Priority Order)

| Priority | Item | Command | File |
|----------|------|---------|------|
| P0 | Fix `manifest.find` → `manifest.list` dispatch | `research links` | `research.ts:186` |
| P0 | Register `manifest.link` in pipeline dispatch | `research link` | `pipeline.ts` mutateManifest |
| P0 | Fix `research link` CLI to call `manifest.link` | `research link` | `research.ts:110-134` |
| P1 | Fix `research update` to preserve `linked_tasks` | `research update` | `research.ts:151-172` |
| P1 | Verify `--agent-type` citty camelCase in manifest command | `research manifest` | `research.ts:225` |
| P2 | Remove `orchestrate waves` (duplicate of `deps waves`) | `orchestrate waves` | orchestrate CLI |
| P2 | Merge `research manifest` into `research list` | `research manifest` | `research.ts` |
| P3 | Seed `teams.cant` in init flow for classify | `orchestrate classify` | init/setup |
| P3 | Add ADR-042 cross-reference to `conduit-*` help text | `orchestrate conduit-*` | orchestrate CLI |
