# CLEO Core SDK Tools Surface

**ADR-064** | Epic **T1768** | Checked against the code: 2026-11-14 (T14108)

## Overview

The Core SDK Tools surface is the set of harness-agnostic primitives that spawn
pathways, provider adapters and orchestration code use instead of copying isolation,
tool resolution and manifest writes inline. It has two homes in `@cleocode/core`:

- **SDK tools** (category B): `packages/core/src/sdk/`, barrel `packages/core/src/sdk/index.ts`.
- **Atomic tool primitives**: `packages/core/src/tools/` (`fs`, `shell`, `pty`, `guard`,
  `env-scrub`), the home gate 11 (tools-vs-skills boundary) protects. ADR-098 keeps
  them: they are not part of any harness.

CLEO itself ships no agent harness (ADR-098). The consumers are the provider spawn
adapters in `@cleocode/adapters` and core's orchestration (`orchestrate/spawn-ops.ts`,
`orchestration/spawn-prompt.ts`, `validation/validate-ops.ts`).

## Categories

| Category | What | Where |
|---|---|---|
| **A — Agent tool** | LLM-callable tools in an agent-facing registry | `packages/core/src/tools/agent-registry.ts`, `builtin-agent-tools.ts` and the `*-agent-tool(s).ts` modules. ADR-098 retires the agent-tool registry with the in-core Pi runner, its only consumer. |
| **B — SDK tool** | Harness-agnostic infrastructure primitives (this doc) | `packages/core/src/sdk/` |
| **C — Domain utility** | CAAMP provider/skill/adapter management ops | `packages/core/src/tools/index.ts` (`issue.*`, `skill.*`, `provider.*`, `adapter.*`) |
| **Atomic primitives** | Raw fs/shell/pty side effects, exposed only through the deny-first `createToolGuard()` chokepoint | `packages/core/src/tools/{fs,shell,pty,guard,env-scrub}.ts` |

The raw side-effecting primitives (`writeFileAtomic`, `executeShell`, `runGit`, …) are not
re-exported from the tools barrel: a consumer calls `createToolGuard()` and uses the
returned `ToolGuard`, so every fs/shell call passes one policy point.

## SDK tools reference

Import from `packages/core/src/sdk/index.ts`, not from the implementation files.

| SDK tool | File | Exports | Purpose |
|---|---|---|---|
| WorktreeIsolation | `sdk/isolation.ts` (re-exports `worktree/isolation.ts` → `@cleocode/contracts`) | `provisionIsolatedShell`, `validateAbsolutePath`, `BoundaryContract`, `IsolationEnvKey` | Provision a worker's isolated shell (worktree cwd, environment, preamble) and keep file edits inside the worktree |
| ToolResolver | `sdk/tool-resolver.ts` (source `tasks/tool-resolver.ts`) | `resolveToolCommand`, `CANONICAL_TOOLS` | Resolve canonical tools (`test`, `lint`, `typecheck`, `build`, …) to the project's commands from `.cleo/project-context.json` |
| ToolCache | `sdk/tool-cache.ts` (source `tasks/tool-cache.ts`) | `runToolCached`, `acquireGlobalSlot` | Content-addressed, cross-process cached tool runs with per-tool concurrency limits (ADR-061); used by evidence verification (`cleo verify --evidence "tool:test"`) |
| Manifest | `sdk/manifest.ts` (source `memory/pipeline-manifest-sqlite.ts`) | `pipelineManifestAppend`, `ManifestEntry` | Append a pipeline manifest entry (ADR-027); the CLI form is `cleo manifest append` |
| SpawnPrimitives | `sdk/spawn-primitives.ts` | `buildAgentEnv`, `buildWorktreeSpawnResult` | Build a spawned agent's environment map and the canonical spawn result |
| Spawn validator | `sdk/spawn-validator.ts` | `spawnValidator` | Spawn a Validator subagent; only an orchestrator at tier 1 or above may call it |
| Validator verbs | `sdk/validator-ac-pull.ts`, `validator-attest.ts`, `validator-reject.ts` | `validatorAcPull`, `validatorAttest`, `validatorReject` | A Validator's steps: pull a task's acceptance criteria with their binding status; attest (one passing finding per criterion, written as `evidence_ac_bindings` coverage rows); reject (at least one failing or inconclusive finding) |

**Rules of use**

- A spawn pathway that provisions a worktree calls `provisionIsolatedShell`; a write
  outside the working directory is checked with `validateAbsolutePath` first.
- Evidence verification resolves tool commands with `resolveToolCommand` and runs them
  through `runToolCached` instead of hardcoding `pnpm run test`.
- A worker records its findings with `pipelineManifestAppend` (or `cleo manifest append`).
  The specification protocol validator reports a missing manifest entry as exit 62
  (`MANIFEST_ENTRY_MISSING`).

## Related

- [ADR-064](../adr/adr-064-caamp-adapters-boundary.md) — SDK tools taxonomy (CAAMP adapters boundary)
- ADR-098 (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`) — what stays (atomic tools, adapters) and what goes (agent-tool registry, in-core Pi runner)
- [Orchestration flow](orchestration-flow.md) — how spawn execution uses these tools
