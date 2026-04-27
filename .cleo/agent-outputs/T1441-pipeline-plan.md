# T1441 Pipeline Dispatch OpsFromCore Plan

## Phase 1 Audit

### CLI Surface

All CLI routes that ultimately dispatch into the `pipeline` domain:

| CLI command | File:line | Pipeline op | Flags / args | Action body lines | Behavior to preserve |
|---|---:|---|---|---:|---|
| `cleo phase show [slug]` | `packages/cleo/src/cli/commands/phase.ts:34` | query `phase.show` | optional positional `slug` | 2 | Dispatch with `{ phaseId }` only when slug is present; default shows current phase. |
| `cleo phase list` | `packages/cleo/src/cli/commands/phase.ts:43` | query `phase.list` | none | 1 | Empty params. |
| `cleo phase set <slug>` | `packages/cleo/src/cli/commands/phase.ts:70` | mutate `phase.set` | `slug`, `--rollback`, `--force`, `--dry-run` | 12 | Preserve flag names and `dryRun` camel-case payload. |
| `cleo phase start <slug>` | `packages/cleo/src/cli/commands/phase.ts:96` | mutate `phase.set` | `slug` | 8 | Preserve merged op with `action: "start"`. |
| `cleo phase complete <slug>` | `packages/cleo/src/cli/commands/phase.ts:117` | mutate `phase.set` | `slug` | 8 | Preserve merged op with `action: "complete"`. |
| `cleo phase advance` | `packages/cleo/src/cli/commands/phase.ts:138` | mutate `phase.advance` | `--force`, alias `-f` | 8 | Preserve force alias and output. |
| `cleo phase rename <oldName> <newName>` | `packages/cleo/src/cli/commands/phase.ts:164` | mutate `phase.rename` | `oldName`, `newName` | 8 | Preserve positional names and output. |
| `cleo phase delete <slug>` | `packages/cleo/src/cli/commands/phase.ts:193` | mutate `phase.delete` | `slug`, `--reassign-to`, `--force` | 12 | Preserve `--reassign-to` payload as `reassignTo`. |
| `cleo pipeline ...` | `packages/cleo/src/cli/index.ts:316` | same as phase | phase alias | n/a | `pipeline` remains alias for `phaseCommand`. |
| `cleo lifecycle show <epicId>` | `packages/cleo/src/cli/commands/lifecycle.ts:32` | query `stage.status` | `epicId` | 8 | Preserve payload key `epicId`. |
| `cleo lifecycle start <epicId> <stage>` | `packages/cleo/src/cli/commands/lifecycle.ts:53` | mutate `stage.record` | `epicId`, `stage` | 8 | Preserve `taskId: epicId`, `status: "in_progress"`. |
| `cleo lifecycle complete <epicId> <stage>` | `packages/cleo/src/cli/commands/lifecycle.ts:76` | mutate `stage.record` | `epicId`, `stage`, `--artifacts`, `--notes` | 13 | Preserve ignored `--artifacts` and `notes` payload. |
| `cleo lifecycle skip <epicId> <stage>` | `packages/cleo/src/cli/commands/lifecycle.ts:103` | mutate `stage.skip` | `epicId`, `stage`, required `--reason` | 8 | Preserve required CLI flag and error path. |
| `cleo lifecycle gate <epicId> <stage>` | `packages/cleo/src/cli/commands/lifecycle.ts:121` | query `stage.validate` via `dispatchRaw` | `epicId`, `stage` | 15 | Preserve custom rendering and `process.exit(80)` when `canProgress` is false. |
| `cleo lifecycle guidance [stage]` | `packages/cleo/src/cli/commands/lifecycle.ts:154` | query `stage.guidance` | optional `stage`, `--epicId`, `--format` default `markdown` | 12 | Preserve stage resolution and markdown/json payload. |
| `cleo lifecycle history <taskId>` | `packages/cleo/src/cli/commands/lifecycle.ts:175` | query `stage.history` | `taskId` | 8 | Preserve payload key `taskId`. |
| `cleo lifecycle reset <epicId> <stage>` | `packages/cleo/src/cli/commands/lifecycle.ts:197` | mutate `stage.reset` | `epicId`, `stage`, required `--reason` | 8 | Preserve required CLI flag and payload. |
| `cleo lifecycle gate-record pass <epicId> <gateName>` | `packages/cleo/src/cli/commands/lifecycle.ts:217` | mutate `stage.gate.pass` | `epicId`, `gateName`, `--agent`, `--notes` | 12 | Preserve defaulting in engine (`agent ?? system`). |
| `cleo lifecycle gate-record fail <epicId> <gateName>` | `packages/cleo/src/cli/commands/lifecycle.ts:241` | mutate `stage.gate.fail` | `epicId`, `gateName`, `--reason` | 12 | Preserve optional reason behavior. |
| `cleo release ship <version>` | `packages/cleo/src/cli/commands/release.ts:70` | mutate `release.ship` | `version`, required `--epic`, `--dry-run`, `--push`, `--bump`, `--remote`, `--force` | 16 | Preserve `push` flag currently parsed but ignored by dispatch handler. |
| `cleo release list` | `packages/cleo/src/cli/commands/release.ts:92` | query `release.list` | none | 1 | Empty params. |
| `cleo release show <version>` | `packages/cleo/src/cli/commands/release.ts:107` | query `release.show` | `version` | 8 | Preserve version-required error. |
| `cleo release cancel <version>` | `packages/cleo/src/cli/commands/release.ts:131` | mutate `release.cancel` | `version` | 8 | Preserve cancel semantics. |
| `cleo release changelog --since <tag>` | `packages/cleo/src/cli/commands/release.ts:162` | query `release.changelog.since` | required `--since` | 8 | Preserve `sinceTag` error. |
| `cleo release rollback <version>` | `packages/cleo/src/cli/commands/release.ts:190` | mutate `release.rollback` | `version`, `--reason` | 10 | Preserve optional reason. |
| `cleo release rollback-full <version>` | `packages/cleo/src/cli/commands/release.ts:232` | mutate `release.rollback.full` | `version`, `--reason`, `--force` | 11 | Preserve full rollback params. |
| `cleo release channel` | `packages/cleo/src/cli/commands/release.ts:253` | query `release.channel.show` | none | 1 | Preserve git branch resolution and fallback `unknown`. |
| `cleo manifest show <id>` | `packages/cleo/src/cli/commands/manifest.ts:37` | query `manifest.show` | `id` | 8 | Preserve `entryId` payload. |
| `cleo manifest list` | `packages/cleo/src/cli/commands/manifest.ts:85` | query `manifest.list` | `--filter`, `--task`, `--epic`, `--type`, `--limit`, `--offset`, `--json` | 19 | Preserve integer parsing defaults `limit=50`, `offset=0`. |
| `cleo manifest find <query>` | `packages/cleo/src/cli/commands/manifest.ts:129` | query `manifest.find` | `query`, `--limit`, `--json` | 14 | Preserve integer parsing default `limit=20`. |
| `cleo manifest stats` | `packages/cleo/src/cli/commands/manifest.ts:159` | query `manifest.stats` | `--json` | 10 | Preserve `json` payload even though dispatch ignores it. |
| `cleo manifest append` | `packages/cleo/src/cli/commands/manifest.ts:213` | mutate `manifest.append` | `--entry`, `--task`, `--type`, `--content`, `--title`, `--status`, `--file`, stdin | 84 | Preserve exact CLI parse errors and `process.exit(1)` paths. |
| `cleo manifest archive [id]` | `packages/cleo/src/cli/commands/manifest.ts:316` | mutate `manifest.archive` | optional `id`, `--before-date` | 19 | Preserve mutual-exclusion errors. Existing dispatch only honors `beforeDate`; `id` path remains current behavior. |
| `cleo research add` | `packages/cleo/src/cli/commands/research.ts:70` | mutate `manifest.append` | required `--task/-t`, required `--topic`, `--findings`, `--sources`, `--agent-type` | 27 | Preserve generated `res_${Date.now()}` IDs and ignored `--sources`. |
| `cleo research show <id>` | `packages/cleo/src/cli/commands/research.ts:110` | query `manifest.show` | `id` | 8 | Preserve research command output context. |
| `cleo research list` | `packages/cleo/src/cli/commands/research.ts:141` | query `manifest.list` | `--task/-t`, `--status/-s`, `--limit/-l` | 12 | Preserve parsed `limit` or undefined. |
| `cleo research pending` | `packages/cleo/src/cli/commands/research.ts:159` | query `manifest.list` | none | 8 | Preserve payload `{ status: "pending" }`. |
| `cleo research link <researchId> <taskId>` | `packages/cleo/src/cli/commands/research.ts:185` | mutate `manifest.append` | `researchId`, `taskId` | 25 | Preserve append-based link behavior. |
| `cleo research update <id>` | `packages/cleo/src/cli/commands/research.ts:240` | mutate `manifest.append` | `id`, `--findings`, `--sources`, `--status/-s`, `--topic` | 28 | Preserve append-based update behavior and ignored `--sources`. |
| `cleo research stats` | `packages/cleo/src/cli/commands/research.ts:273` | query `manifest.stats` | none | 1 | Empty params. |
| `cleo research links <taskId>` | `packages/cleo/src/cli/commands/research.ts:288` | query `manifest.find` | `taskId` | 8 | Preserve current risky payload `{ taskId }`, which triggers dispatch `query is required`. |
| `cleo research archive` | `packages/cleo/src/cli/commands/research.ts:308` | mutate `manifest.archive` | `--before-date` | 10 | Preserve missing-date dispatch error. |
| `cleo research manifest` | `packages/cleo/src/cli/commands/research.ts:350` | query `manifest.list` | `--status/-s`, `--agent-type/-a`, `--topic`, `--task/-t`, `--limit/-l` | 20 | Preserve deprecation warning to stderr. |
| `cleo chain show <chainId>` | `packages/cleo/src/cli/commands/chain.ts:33` | query `chain.show` | `chainId` | 8 | Preserve not-found translation. |
| `cleo chain list` | `packages/cleo/src/cli/commands/chain.ts:47` | query `chain.list` | none | 1 | Empty params. |
| `cleo chain add <file>` | `packages/cleo/src/cli/commands/chain.ts:62` | mutate `chain.add` | `file` | 9 | Preserve inline JSON file read/parse behavior. |
| `cleo chain instantiate <chainId> <epicId>` | `packages/cleo/src/cli/commands/chain.ts:89` | mutate `chain.instantiate` | `chainId`, `epicId` | 8 | Preserve FK error translation to `E_NOT_FOUND`. |
| `cleo chain advance <instanceId> <nextStage>` | `packages/cleo/src/cli/commands/chain.ts:115` | mutate `chain.advance` | `instanceId`, `nextStage` | 8 | Preserve default empty gate results. |

### Dispatch Surface

`packages/cleo/src/dispatch/domains/pipeline.ts` is 1155 lines. It supports:

- Query: `stage.validate`, `stage.status`, `stage.history`, `stage.guidance`, `manifest.show`, `manifest.list`, `manifest.find`, `manifest.stats`, `release.list`, `release.show`, `release.channel.show`, `release.changelog.since`, `phase.show`, `phase.list`, `chain.show`, `chain.list`.
- Mutate: `stage.record`, `stage.skip`, `stage.reset`, `stage.gate.pass`, `stage.gate.fail`, `release.ship`, `release.cancel`, `release.rollback`, `release.rollback.full`, `manifest.append`, `manifest.archive`, `phase.set`, `phase.advance`, `phase.rename`, `phase.delete`, `chain.add`, `chain.instantiate`, `chain.advance`.

Error contracts to preserve include:

- Unknown root query/mutate: `Unknown pipeline query: <op>` / `Unknown pipeline mutation: <op>`.
- Unknown subdomains: `Unknown stage query`, `Unknown stage mutation`, `Unknown release query`, `Unknown release mutation`, `Unknown manifest query`, `Unknown manifest mutation`, `Unknown phase query`, `Unknown phase mutation`, `Unknown chain query`, `Unknown chain mutation`.
- Required input messages: `epicId and targetStage are required`, `epicId is required`, `taskId is required`, `taskId, stage, and status are required`, `taskId, stage, and reason are required`, `taskId and gateName are required`, `version is required`, `version and epicId are required`, `entryId is required`, `query is required`, `entry is required`, `beforeDate is required (ISO-8601: YYYY-MM-DD)`, `phaseId is required`, `oldName and newName are required`, `chainId is required`, `chain is required`, `chainId and epicId are required`, `instanceId and nextStage are required`.
- Special edge cases: lifecycle guidance resolves `stage` from `epicId`; invalid stage returns `Unknown stage: <stage>`; `chain.show` maps missing chain to `E_NOT_FOUND`; `chain.instantiate` maps FK failures to `Chain "<id>" not found`; `phase.list` preserves pagination fields; `release.channel.show` falls back to branch `unknown`.

### Core Surface

Canonical `packages/core/src/pipeline/` currently contains:

- `listPhases(projectRoot, accessor?)`
- `showPhase(projectRoot, phaseId?, accessor?)`

The pipeline dispatch domain also delegates to existing Core-owned functionality through `@cleocode/core/internal` and dispatch engines:

- Lifecycle/stage: `lifecycleCheck`, `lifecycleStatus`, `lifecycleHistory`, `lifecycleProgress`, `lifecycleSkip`, `lifecycleReset`, `lifecycleGatePass`, `lifecycleGateFail`, plus stage guidance helpers.
- Manifest: `pipelineManifestShow`, `pipelineManifestList`, `pipelineManifestFind`, `pipelineManifestStats`, `pipelineManifestAppend`, `pipelineManifestArchive`.
- Release: `releaseList`, `releaseShow`, `releaseChangelogSince`, `releaseCancel`, `releaseRollback`, `releaseShip`, `releaseRollbackFull`, channel helpers.
- Chain: `showChain`, `listChains`, `addChain`, `createInstance`, `advanceInstance`.
- Phase: `phaseShow`, `phaseList`, `phaseSet`, `phaseStart`, `phaseComplete`, `phaseAdvance`, `phaseRename`, `phaseDelete`.

### Dispatch-Bypass / Inline Logic

- `lifecycle gate` uses `dispatchRaw` to inspect `canProgress` and exit with code 80. Keep unchanged.
- `manifest append` performs JSON/file/stdin parsing and shorthand assembly before dispatch. Keep unchanged.
- `manifest archive` validates `id` vs `--before-date` in CLI before dispatch. Keep unchanged, including current `id` behavior.
- `research add/link/update` synthesize full manifest entries inline before dispatch. Keep unchanged.
- `research manifest` prints a deprecation warning to stderr before dispatch. Keep unchanged.
- `chain add` reads/parses JSON inline before dispatch. Keep unchanged.

## Phase 2 Plan

### Migration Table

| Operation group | Current behavior | Target Core type source | CLI stays responsible for | Dispatch/Core behavior |
|---|---|---|---|---|
| `stage.*` | PipelineHandler extracts raw params and delegates to lifecycle engine/core helpers. | `packages/core/src/pipeline/ops.ts` `pipelineCoreOps` signatures. | Existing lifecycle command aliases, custom gate exit 80, command output context. | Typed handler validates required params and preserves current lifecycle calls/errors. |
| `manifest.*` | Handler delegates to Core pipeline-manifest SQLite functions. | `pipelineCoreOps` signatures using `PipelineOps` params. | JSON/file/stdin/shorthand parsing and current CLI validation messages. | Typed handler preserves append/list/find/show/stats/archive calls and pagination. |
| `release.*` | Handler delegates to release engine and channel helpers. | `pipelineCoreOps` signatures. | Release command flag normalization. | Typed handler preserves current `push` ignore behavior, channel fallback, and release errors. |
| `phase.*` | Handler delegates to phase engine wrappers and paginates list. | `pipelineCoreOps` signatures. | Phase/pipeline alias and flag aliases. | Typed handler preserves merged `phase.set` actions and pagination shape. |
| `chain.*` | Handler delegates to Core chain store helpers. | `pipelineCoreOps` signatures using `WarpChain` / `GateResult`. | JSON file loading for `chain add`. | Typed handler preserves not-found/FK translations and pagination shape. |

### New Contract Types

Target file: `packages/contracts/src/operations/pipeline.ts`.

- `PipelineManifestEntry`: manifest append entry shape compatible with pipeline_manifest rows and legacy research entries.
- `PipelineReleaseStatus`: release list status union.
- `PipelineOps`: discriminated union of the 34 pipeline operation names and param shapes.
- `PipelineOperationName`: `PipelineOps["op"]`.
- `PipelineOperationParams<Op>`: extracts the param shape for Core signatures.

Barrels to update:

- `packages/contracts/src/operations/index.ts`
- `packages/contracts/src/index.ts`

### New Core Signatures

Target file: `packages/core/src/pipeline/ops.ts`.

- `pipelineCoreOps`: declared Core-owned operation signature registry.
- Signature pattern: `(params: PipelineOperationParams<"pipeline.<op>">) => Promise<EngineResult>`.
- Export type from `packages/core/src/pipeline/index.ts`.

Code placed in `packages/core/src/pipeline/` per Package-Boundary Check — verified against AGENTS.md. The file is a Core SDK type registry, not CLI logic.

### Dispatch Refactor

Target file: `packages/cleo/src/dispatch/domains/pipeline.ts`.

- Import `type { pipeline as corePipeline } from "@cleocode/core"`.
- Use `type PipelineOps = OpsFromCore<typeof corePipeline.pipelineCoreOps>`.
- Replace raw per-field casts in operation handling with a typed inner handler.
- Keep the outer `DomainHandler` class for registry compatibility.
- Convert typed envelopes back through `wrapResult` so metadata, page info, exit details, fixes, alternatives, and current output remain preserved.

### Regression-Test Plan

New/updated tests:

- Add `packages/cleo/src/dispatch/domains/__tests__/pipeline-opsfromcore.test.ts` to lock that `pipeline.ts` derives `PipelineOps` from Core signatures and does not import per-op params/results from contracts.
- Keep existing `pipeline.test.ts`, `pipeline-manifest.test.ts`, and registry parity tests passing.

Manual smoke plan:

- Baseline before source edits and after implementation for every command group: `phase`, `pipeline` alias, `lifecycle`, `release`, `manifest`, `research`, `chain`.
- Use a fresh `/tmp/smoke-pipeline` project where possible.
- For destructive/high-risk commands, smoke deterministic validation/error paths to preserve output and exit codes without mutating the real repo.

## Commit Plan

1. `feat(T1441): add pipeline core operation signatures`
   - Contracts pipeline operation params.
   - Core `pipelineCoreOps` type registry.
2. `feat(T1441): infer pipeline dispatch ops from core`
   - Refactor pipeline dispatch handler to typed inner handler.
3. `test(T1441): regression for pipeline OpsFromCore inference`
   - Add source-shape regression test.
