# T948 Studio Refactor — Visual Regression Checklist

After deploying the T948 refactor, verify the following in a browser against a
project with real data. The refactor preserves response SHAPES and UI
contracts, but the DATA SOURCE changed from raw SQL to the canonical
`TaskRollupPayload` projection, so any drift between `/tasks` and
`/tasks/pipeline` should now be gone.

## Files changed

- `packages/studio/src/routes/api/tasks/+server.ts` — raw SQL eliminated, now uses `listTasks` + `computeTaskRollups`.
- `packages/studio/src/routes/api/tasks/pipeline/+server.ts` — raw SQL eliminated, groups by canonical rollup `pipelineStage`.
- `packages/studio/src/routes/tasks/+page.server.ts` — epic-progress panel now rollup-backed. `_computeEpicProgress(db, options)` retained as deprecated alias so T874/T878 tests keep passing.
- `packages/core/src/cleo.ts` — `Cleo.lifecycle` now exposes `computeRollup` + `computeRollupsBatch`; `Cleo.tasks.list` accepts `excludeArchived` and `sortByPriority`.
- `packages/contracts/src/facade.ts` — `TasksAPI.list` + `LifecycleAPI` contract expanded; `TaskRollupPayload` exported.
- `packages/core/src/tasks/list.ts` — wires `excludeArchived` → `excludeStatus: 'archived'` and `sortByPriority` → `orderBy: 'priority'`.
- `packages/core/src/validation/engine.ts` — backfilled `proposed` status transition map (unblocks tsc — pre-T948 compile error).

## Pages / routes to verify

### 1. Tasks Dashboard (`/tasks`)

- [ ] Status cards (pending/active/done/cancelled/archived) populate from `load()`.
- [ ] Priority cards (critical/high/medium/low) populate.
- [ ] Type cards (epic/task/subtask) populate.
- [ ] **Epic Progress panel** renders one row per non-cancelled epic (owner's T900 default).
- [ ] Each epic row shows `done / total` with the correct numerator and denominator.
- [ ] Toggling `?deferred=1` surfaces cancelled epics WITH the Deferred badge.
- [ ] Toggling `?archived=1` surfaces archived tasks in Recent Activity.
- [ ] **Regression guard**: the same epic's numerator here must equal the
  "Done" column count for that epic's direct children on `/tasks/pipeline`.
  Before T948 they could disagree; after T948 they should match.

### 2. Pipeline Kanban (`/tasks/pipeline`)

- [ ] All 10 RCASD-IVTR+C columns render (research → contribution).
- [ ] Column counts match the task cards inside.
- [ ] Tasks with `status='done'` appear in the DONE column, regardless of
  their `pipeline_stage` (T873 fix preserved).
- [ ] Verification gate badges (I / T / Q) render on each card — this
  means `verification_json` round-trips correctly from
  `Task.verification` → JSON string.
- [ ] Priority-first ordering within each column preserved (critical → low).

### 3. Dashboard (`/`)

- [ ] `tasksStats` card on the landing page still shows correct totals
  (the dashboard +page.server.ts is unaffected by T948).

## API endpoints to spot-check

```bash
# Shape check — {tasks, rollups, total}
curl -s http://localhost:3456/api/tasks | jq 'keys'
# Expect: ["rollups","tasks","total"]

# Rollup parity — every task must have a matching rollup by id
curl -s http://localhost:3456/api/tasks | jq '.tasks[].id' | sort > /tmp/t-ids
curl -s http://localhost:3456/api/tasks | jq '.rollups[].id' | sort > /tmp/r-ids
diff /tmp/t-ids /tmp/r-ids
# Expect: no diff

# Priority filter
curl -s 'http://localhost:3456/api/tasks?priority=critical' | jq '.tasks[].priority' | sort -u
# Expect: "critical"

# Pipeline grouping
curl -s http://localhost:3456/api/tasks/pipeline | jq '.stages[] | {id, count}'
```

## Known non-regressions

- `/api/tasks` dropped support for comma-separated status values
  (`?status=active,pending`). The facade takes a single value. Clients
  that relied on multi-value filtering must issue multiple requests.
  No known Studio UI uses this pattern.
- `verification_json` and `acceptance_json` are now re-serialised from
  parsed `Task.verification` / `Task.acceptance` rather than pulled
  verbatim from the DB column. The decoded shape is identical but
  key ordering may differ — any UI comparing JSON strings byte-for-byte
  must switch to structural comparison.
