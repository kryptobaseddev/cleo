# T1445 Tasks Dispatch OpsFromCore Plan

## Phase 1 Audit Summary

Task focus: `T1445 (T1435-W1-tasks)`.

Read-only audit commands run:

- CLI grep from master prompt returned no direct `tasks` hits because CLEO exposes split root commands instead of a `tasks` command group.
- Broadened audit with `rg` across `packages/cleo/src/cli/commands` and `packages/cleo/src/cli/index.ts`.
- Dispatch file: `packages/cleo/src/dispatch/domains/tasks.ts`, 985 LOC.
- Prompt grep found 26 simple `async` handler keys; manual audit found 32 supported operations because dotted operation keys are not matched by that grep.
- Core task functions exist under `packages/core/src/tasks/`; normalized `packages/core/src/tasks/ops.ts` currently covers CRUD subset only.

Supported dispatch ops to preserve:

- Query: `show`, `list`, `find`, `tree`, `blockers`, `depends`, `analyze`, `impact`, `next`, `plan`, `relates`, `complexity.estimate`, `history`, `current`, `label.list`, `sync.links`
- Mutate: `add`, `update`, `complete`, `cancel`, `delete`, `archive`, `restore`, `reparent`, `reorder`, `relates.add`, `start`, `stop`, `sync.reconcile`, `sync.links.remove`, `claim`, `unclaim`

Behavior contracts to preserve:

- Alias normalization stays in CLI only: `--parent-id -> parent`, `--note -> notes`, `--desc -> description`, `--kind -> role`, root aliases `done`, `rm`, `ls`, `tags`, and `promote -> tasks.reparent(newParentId: null)`.
- Output remains through existing `cliOutput`, `dispatchFromCli`, `dispatchRaw`, `lafsSuccess`, `lafsError`, and `wrapResult` paths.
- Exit codes stay unchanged: `list/find` no results exit `ExitCode.NO_DATA` (100), `exists` missing exits `ExitCode.NOT_FOUND` (4), CLI validation failures generally exit 1 or 2 as currently coded, `bug` owner-only exits 72, restore errors use `CleoError.code`.
- Exact task dispatch errors stay unchanged: `impact` missing `change` returns `E_INVALID_INPUT` with `change is required (free-text description of the proposed change)`; `depends` missing `taskId` returns `taskId is required (or use action: overview|cycles)`; `complete` still rejects removed `force` with `E_FLAG_REMOVED`; `relates.add` still accepts `relatedId` or legacy `targetId`.
- Existing edge behavior stays: `add` GitNexus file inference and session parent inference remain CLI-side; `add-batch` continues sequential per-task dispatch with partial failure output; `restore task` continues prechecking active/archive state before dispatch; `deps critical-path` and `exists` remain dispatch-bypass commands.

Dispatch-bypass and inline-logic paths:

- `cleo exists <task-id>` calls `getTask()` directly and only labels output as `tasks.exists`; no dispatch operation exists.
- `cleo deps critical-path <taskId>` calls `depsCriticalPath()` directly and labels output as `tasks.criticalPath`.
- `cleo add` contains CLI-only parent/file/acceptance alias normalization and active-session parent inference.
- `cleo add-batch` reads JSON/stdin and loops over `tasks.add`, with `tasks.add-batch` output and exit 1 on partial failure.
- `cleo bug` signs severity attestations before `tasks.add`.
- `cleo restore task` reads task/archive state directly before calling `tasks.restore`.
- `cleo req *` attempts `tasks.req.*`, but those operations are not currently supported by `TasksHandler`; behavior must not be changed in this task.

## Per-CLI-Command Migration Table

| CLI command | File:line, run lines | Flags / args | Current behavior | Target type source | CLI vs Core boundary |
|---|---:|---|---|---|---|
| `add` | `add.ts:40`, run at 176, ~129 lines | `title`, `--status/-s`, `--priority/-p`, `--type/-t`, `--parent`, `--parent-id`, `--size`, `--phase/-P`, `--description/-d`, `--desc`, `--labels/-l`, `--files`, `--files-infer`, `--acceptance`, `--depends/-D`, `--notes`, `--note`, `--position`, `--parent-search`, `--add-phase`, `--dry-run`, `--role`, `--kind`, `--scope`, `--severity` | Normalizes aliases, parses lists/acceptance, infers files/parent, dispatches `tasks.add`, prints warnings/duplicate/dry-run messages. | `tasksCoreOps.add` | Keep all CLI normalization and rendering in CLI; dispatch behavior unchanged. |
| `add-batch` | `add-batch.ts:41`, run at 57, 133 lines | `--file`, `--parent`, `--dry-run` | Reads JSON/stdin, loops over `tasks.add`, reports created/failed, exits 1 on partial failure, exits 2 for bad input. | `tasksCoreOps.add` | Keep batch orchestration in CLI; dispatch still receives single `tasks.add` calls. |
| `bug` | `bug.ts:152`, run at 185, 54 lines | `title`, `--severity/-s`, `--epic/-e`, `--description/-d`, `--dry-run` | Maps severity to priority/labels, signs audit line, dispatches `tasks.add`, exits 1 invalid severity or 72 owner-only. | `tasksCoreOps.add` | Keep attestation and severity mapping in CLI. |
| `list` / `ls` | `list.ts:38`, run at 41, 40 lines | Registry params plus `--parent-id` | Normalizes parent alias, calls `tasks.list`, wraps array payloads, exits 100 on empty, preserves page metadata. | `tasksCoreOps.list` | Keep no-data handling/rendering in CLI. |
| `find` | `find.ts:13`, run at 42, 39 lines | `query`, `--id`, `--exact`, `--status`, `--in`, `--include-archive`, `--limit`, `--offset`, `--fields`, `--verbose/-v`, `--role` | Dispatches `tasks.find`, page metadata, exits 100 on empty. | `tasksCoreOps.find` | Keep pagination/rendering in CLI. |
| `show` | `show.ts:25`, run at 32, 13 lines | Registry params: `taskId`, `--history`, `--ivtr-history` | Dispatches `tasks.show`; routes history flags in dispatch. | `tasksCoreOps.show` | No CLI changes. |
| `update` | `update.ts:28`, run at 161, 44 lines | `taskId`, task field flags, alias flags `--parent-id`, `--note`, `--kind` | Normalizes fields/lists/aliases, dispatches `tasks.update`. | `tasksCoreOps.update` | Keep CLI aliases; dispatch receives canonical params. |
| `complete` / `done` | `complete.ts:31`, run at 59, 28 lines | `taskId`, `--notes`, `--changeset`, `--verification-note`, `--acknowledge-risk` | Dispatches `tasks.complete`, reshapes task/autoCompleted/unblockedTasks output. | `tasksCoreOps.complete` | Preserve force-removal behavior in dispatch. |
| `cancel` | `cancel.ts:19`, run at 35, 12 lines | `taskId`, `--reason` | Dispatches `tasks.cancel`. | `tasksCoreOps.cancel` | No CLI changes. |
| `delete` / `rm` | `delete.ts:19`, run at 39, 20 lines | `taskId`, `--force`, `--cascade` | Dispatches `tasks.delete`, formats deleted/cascade output. | `tasksCoreOps.delete` | Preserve cascade pass-through even if dispatch ignores it. |
| `archive` | `archive.ts:26`, run at 48, 10 lines | `--before`, `--tasks`, `--cancelled`, `--dry-run` | Dispatches `tasks.archive`. | `tasksCoreOps.archive` | No CLI changes. |
| `restore task` | `restore.ts:413`, run at 445, 183 lines | `taskId`, `--status`, `--preserve-status`, `--reason`, `--dry-run` | Directly checks active/archive state, dispatches `tasks.restore` for terminal tasks, maps `CleoError` output/exit. | `tasksCoreOps.restore` | Keep inline restore preflight unchanged. |
| `reparent` | `reparent.ts:19`, run at 33, 10 lines | `taskId`, `--to` | Dispatches `tasks.reparent`, empty `--to` maps to null. | `tasksCoreOps.reparent` | No CLI changes. |
| `promote` | `promote.ts:16`, run at 25, 9 lines | `taskId` | Dispatches `tasks.reparent` with `newParentId: null`. | `tasksCoreOps.reparent` | No CLI changes. |
| `reorder` | `reorder.ts:19`, run at 40, 26 lines | `task-id`, `--position`, `--top`, `--bottom` | Validates a position selector, dispatches `tasks.reorder`, exits code 2 via `process.exitCode` when missing. | `tasksCoreOps.reorder` | Keep validation in CLI. |
| `start` | `start.ts:18`, run at 30, 9 lines | `taskId` | Dispatches `tasks.start`. | `tasksCoreOps.start` | No CLI changes. |
| `stop` | `stop.ts:18`, run at 24, 3 lines | none | Dispatches `tasks.stop`. | `tasksCoreOps.stop` | No CLI changes. |
| `current` | `current.ts:21`, run at 27, 3 lines | none | Dispatches `tasks.current`. | `tasksCoreOps.current` | No CLI changes. |
| `claim` / `unclaim` | `claim.ts:15/37`, run lines 9/9 | `claim <taskId> --agent`, `unclaim <taskId>` | Dispatches `tasks.claim` and `tasks.unclaim`. | `tasksCoreOps.claim/unclaim` | No CLI changes. |
| `analyze` | `analyze.ts:19`, run at 30, 3 lines | `--auto-start` ignored today | Dispatches `tasks.analyze` with `{}`. | `tasksCoreOps.analyze` | Preserve ignored flag. |
| `blockers` | `blockers.ts:18`, run at 29, 9 lines | `--analyze` | Dispatches `tasks.blockers`. | `tasksCoreOps.blockers` | No CLI changes. |
| `next` | `next.ts:19`, run at 36, 5 lines | `--explain`, `--count/-n` | Parses count, dispatches `tasks.next`. | `tasksCoreOps.next` | No CLI changes. |
| `plan` | `plan.ts:20`, run at 26, 9 lines | none | Dispatches `tasks.plan`. | `tasksCoreOps.plan` | No CLI changes. |
| `deps overview/show/impact/cycles` | `deps.ts:20/34/106/136` | `show <taskId> --tree`, `impact <taskId> --depth` | Dispatches `tasks.depends`; `overview/cycles` use action routing. | `tasksCoreOps.depends` | No CLI changes. |
| `tree` | `deps.ts:182`, run at 201, 11 lines | `rootId`, `--with-deps`, `--blockers` | Sets tree render context, dispatches `tasks.tree`. | `tasksCoreOps.tree` | Preserve render context side effect. |
| `deps critical-path` | `deps.ts:83`, run at 92, 11 lines | `taskId` | Direct Core bypass: `depsCriticalPath`, prints `critical-path: ...`, exits 4 on error. | none | Do not change. |
| `complexity estimate` | `complexity.ts:11`, run at 14, 9 lines | `taskId` | Dispatches `tasks.complexity.estimate`. | `tasksCoreOps["complexity.estimate"]` | No CLI changes. |
| `reason impact/timeline` | `reason.ts:17/81` | `impact [taskId] --change --limit --depth`, `timeline <taskId> --limit` | Dispatches `tasks.impact`, `tasks.depends`, or `tasks.history`; exits 1 if no impact input. | `tasksCoreOps.impact/depends/history` | No CLI changes. |
| `relates suggest/add/discover/list` | `relates.ts:19/45/85/105` | `taskId`, `threshold`, `from/to/type/reason` | Dispatches `tasks.relates` or `tasks.relates.add`; raw paths manually render. | `tasksCoreOps.relates/relates.add` | Preserve `relatedId` canonical wire field. |
| `labels` / `tags` | `labels.ts:19/27/38/53` | `list`, `show <label>`, `stats` | Dispatches `tasks.label.list` and `tasks.list({label})`; no-subcommand defaults to list. | `tasksCoreOps.label.list/list` | No CLI changes. |
| `history work` | `history.ts:50`, run at 52, 3 lines | none | Dispatches `tasks.history`; `history log` is admin-only. | `tasksCoreOps.history` | No CLI changes. |
| `sync links/remove/reconcile` | `sync.ts:25/46/79` | `--provider`, `--task`, `remove <providerId>`, `reconcile <file> --provider --conflict-policy` | Dispatches `tasks.sync.*`; `links` requires provider or task; JSON parse errors exit 2. | `tasksCoreOps.sync.*` | No CLI changes. |
| `exists` | `exists.ts:11`, run at 17, 21 lines | `task-id`, `--verbose` | Direct Core bypass via `getTask`; labels output `tasks.exists`; exits 4 when missing. | none | Do not change. |
| `req add/list/migrate` | `req.ts:21/56/72` | `add <task-id> --gate`, `list <task-id>`, `migrate <task-id> --apply` | Attempts `tasks.req.*`; currently not supported by `TasksHandler`. | none in current tasks handler | Do not change in T1445. |

## Implementation Plan

1. Add a Core-owned type signature registry for tasks operations.
   - Target: `packages/core/src/tasks/ops.ts`.
   - Shape: `export declare const tasksCoreOps: { readonly show: TaskCoreOperation<'show'>; ... }`.
   - Export type from `packages/core/src/tasks/index.ts` so `@cleocode/core` exposes `tasks.tasksCoreOps` for type inference.
   - No runtime behavior changes.

2. Refactor `packages/cleo/src/dispatch/domains/tasks.ts`.
   - Replace per-op `*Params`/`TasksOps` imports from `@cleocode/contracts` with `import type { tasks as coreTasks } from '@cleocode/core'`.
   - Use `type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>`.
   - Add `type OpsFromCore` to the typed adapter import.
   - Remove explicit per-op parameter annotations and let `defineTypedHandler<TasksOps>` contextually type each handler.
   - Keep every handler body, operation set, validation branch, error message, and output adapter unchanged.

3. Add regression test coverage.
   - Target: `packages/cleo/src/dispatch/domains/__tests__/tasks-opsfromcore.test.ts`.
   - Assert tasks dispatch uses `OpsFromCore<typeof coreTasks.tasksCoreOps>`.
   - Assert it no longer imports from `@cleocode/contracts`.
   - Assert known behavior-preservation strings remain present (`E_FLAG_REMOVED`, `relatedId (or targetId) is required`, `change is required`).

4. Contract cleanup.
   - No new contract types are expected.
   - Do not remove existing `packages/contracts/src/operations/tasks.ts` aliases unless a grep proves they are truly unreferenced after the refactor. The new Core type registry will intentionally keep `TasksOps` and its member aliases referenced as the public operation type source.

## New Contract Types Needed

None.

## New Core Functions / Signatures Needed

No new runtime Core functions are needed for behavior preservation. Add one Core type-source registry:

- `tasksCoreOps` in `packages/core/src/tasks/ops.ts`
- exported type from `packages/core/src/tasks/index.ts`
- purpose: make Core the SSoT for task operation params/results used by `OpsFromCore`

## Regression And Smoke Plan

Automated tests:

- `pnpm exec vitest run packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts packages/cleo/src/dispatch/domains/__tests__/tasks-opsfromcore.test.ts`
- `pnpm exec vitest run $(grep -rl 'tasks' packages/cleo/src/dispatch/domains/__tests__/ | tr '\n' ' ')`

Before/after smoke comparison:

- Build `@cleocode/cleo`.
- Run a fixed `/tmp/smoke-tasks` sequence before source edits and save normalized output.
- Rebuild after implementation and rerun the exact sequence in a fresh temp project.
- Compare normalized stdout/stderr/exit code for every task CLI command or task CLI wrapper listed above.

Required gates from the master prompt:

- `pnpm exec tsc -b`
- `pnpm biome ci .`
- `pnpm run build`
- `pnpm run test`
- `node scripts/lint-contracts-core-ssot.mjs --exit-on-fail`

