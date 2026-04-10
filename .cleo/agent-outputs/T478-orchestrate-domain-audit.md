# T478 — orchestrate Domain Lead Audit

**Date**: 2026-04-10
**Agent**: Domain Lead — orchestrate (24 ops + 5 conduit.* from ADR-042)
**Status**: complete

---

## 1. Registry Inventory

All ops drawn from `OrchestrateHandler.getSupportedOperations()` in
`packages/cleo/src/dispatch/domains/orchestrate.ts`.

| Gateway | Operation | Registry | CLI (before) | CLI (after) | Classification |
|---------|-----------|----------|-------------|-------------|----------------|
| query | `status` | yes | missing | added | needs-cli |
| query | `next` | yes | present | present | needs-cli |
| query | `ready` | yes | present | present | needs-cli |
| query | `analyze` | yes | present | present (extended) | needs-cli |
| query | `context` | yes | present | present | needs-cli |
| query | `waves` | yes | missing | added | needs-cli |
| query | `bootstrap` | yes | missing | — | agent-only |
| query | `unblock.opportunities` | yes | missing | added (as `unblock`) | needs-cli |
| query | `tessera.list` | yes | missing | added | needs-cli |
| query | `classify` | yes | missing | — | agent-only |
| query | `fanout.status` | yes | missing | — | agent-only |
| query | `conduit.status` | yes | missing | — | agent-only |
| query | `conduit.peek` | yes | missing | — | agent-only |
| mutate | `start` | yes | present | present | needs-cli |
| mutate | `spawn` | yes | present | present (extended opts) | needs-cli |
| mutate | `handoff` | yes | missing | — | agent-only |
| mutate | `spawn.execute` | yes | missing | — | agent-only |
| mutate | `validate` | yes | present | present | needs-cli |
| mutate | `parallel` | yes | missing | added | needs-cli |
| mutate | `tessera.instantiate` | yes | missing | added | needs-cli |
| mutate | `fanout` | yes | missing | — | agent-only |
| mutate | `conduit.start` | yes | missing | — | agent-only |
| mutate | `conduit.stop` | yes | missing | — | agent-only |
| mutate | `conduit.send` | yes | missing | — | agent-only |

**Total registry ops**: 24 (13 query, 11 mutate) — all verified against `getSupportedOperations()`.

---

## 2. Classification Rationale

### needs-cli (added in this task)

- **`orchestrate.status`**: General-purpose status check for an epic or whole project. Useful for
  human operators diagnosing orchestration state. Accepts optional `--epic` flag.

- **`orchestrate.waves`**: Wave computation is a planning-time view. Humans and CI scripts benefit
  from seeing the wave breakdown. Required arg: `<epicId>`.

- **`orchestrate.parallel`**: Tracks parallel execution start/end per wave. Orchestrators can call
  this programmatically, but operators also need CLI access for manual wave bookkeeping.
  Args: `<action> <epicId> --wave <n>`.

- **`orchestrate.tessera list`**: Template discovery is a human-facing browsing operation. The
  optional `--id` flag returns details for a specific template.

- **`orchestrate.tessera instantiate`**: Creating orchestration task graphs from templates is an
  explicit action that benefits from a CLI entry point (CI pipelines, manual bootstrapping).

- **`orchestrate.unblock`** (maps to `unblock.opportunities`): Diagnostic query. Engineers and
  orchestrators use it to identify what tasks are blocking progress.

### agent-only (no CLI surface)

- **`orchestrate.bootstrap`**: Loads `BrainState` for subagent context injection. This operation
  is called by orchestrator agents at spawn time, never by a human at a terminal. Its output is
  a large structured object consumed programmatically.

- **`orchestrate.classify`**: Prompt-based CANT team routing. The operation takes a free-text
  request string and returns a routing decision. It is designed to be called by the orchestrator
  loop, not invoked directly. Real LLM routing will replace the stub in a later wave.

- **`orchestrate.fanout`**: `Promise.allSettled` wrapper that spawns N tasks concurrently via the
  adapter registry. This is a programmatic coordination primitive — it has no meaningful CLI UX
  because it requires items already prepared by an orchestrator agent.

- **`orchestrate.fanout.status`**: Reads from the in-process `fanoutManifestStore` (an in-memory
  Map). A CLI invocation would always return `found: false` because the in-process state only
  exists within the same running process. No durable persistence.

- **`orchestrate.handoff`**: Composite op (session.context.inject → session.end → orchestrate.spawn).
  Designed to be the terminal action of an orchestrator agent handing off to a successor. The
  operation requires an active session, which a CLI invocation from a fresh shell does not have.

- **`orchestrate.spawn.execute`**: Adapter-registry spawn. Requires a registered `CLEOSpawnAdapter`
  and a live provider. This is infrastructure-level automation; the human-facing entry point is
  `orchestrate spawn` (which prepares context) followed by the provider's own UI.

- **`orchestrate.conduit.*`** (5 ops from ADR-042): All conduit sub-operations route to the
  `ConduitHandler` instance inside the orchestrate domain. They operate on `conduit.db`
  (agent-to-agent messaging). These are designed for inter-agent communication and should be
  surfaced through the top-level `agent` or `conduit` CLI domain, not `orchestrate`. ADR-042
  classifies them as experimental. No CLI surface added.

---

## 3. Changes Made

**File**: `packages/cleo/src/cli/commands/orchestrate.ts`

### New subcommands added

```
orchestrate status [--epic <epicId>]
orchestrate waves <epicId>
orchestrate parallel <action> <epicId> [--wave <n>]
orchestrate tessera list [--id <id>] [--limit <n>] [--offset <n>]
orchestrate tessera instantiate <templateId> <epicId> [--var key=val ...]
orchestrate unblock
```

### Existing subcommands extended

- `orchestrate spawn` gained `--protocol <type>` and `--tier <0|1|2>` options to expose
  the `protocolType` and `tier` parameters already present in the registry op.
- `orchestrate analyze` gained `--mode <mode>` and `--tasks <ids>` options to expose
  parallel-safety mode (T410).

---

## 4. Build Verification

- `pnpm biome check --write packages/cleo/src/cli/commands/orchestrate.ts` — passed, no fixes needed.
- `pnpm run build` — pre-existing failures in `@cleocode/caamp` (DTS build error for missing
  `@types/node` in that package) and `@cleocode/lafs` export mismatches. These failures exist on
  `main` before this task and are not caused by changes to `orchestrate.ts`.
- `pnpm --filter @cleocode/cleo run build` — same pre-existing `@cleocode/caamp` and
  `@cleocode/lafs` failures cascade into `cleo` but no errors originate from `orchestrate.ts`.

---

## 5. Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| All 24 ops verified against registry | PASS — table in §1 covers all ops |
| Missing CLI built or classified | PASS — 6 ops added, 8 classified agent-only |
| Build passes | PARTIAL — pre-existing failures unrelated to this task; orchestrate.ts is clean |
