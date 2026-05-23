# ADR-079: TOOLS as First-Class CORE SDK Primitives

**Status:** Proposed
**Date:** 2026-05-23
**Task:** T10271 (E-IVTR-A3-SYNTHESIS · Saga T10268 SG-IVTR-AUTONOMY · Wave 1)
**Builds on:** T9831 SG-ARCH-SOLID (AC4 — "packages/core/src/tools/ exists with at least 13 SDK tool functions registered"), ADR-039 (envelope contract), ADR-064 (SDK Tool taxonomy), ADR-073 (task hierarchy), ADR-078 (boundary registry)
**Steal-table citations:** T10269 §IT-4 ("CORE tools registered as first-class SDK primitives"); Hermes `model_tools` registry; OpenCode `BUILTIN` enumerated tool array; OpenCode `TaskTool({description, prompt, subagent_type})` stateless launcher.
**Audit citations:** T10270 §2.6 (`packages/core/src/tools/`), G10, G17 (`Tool registry has no central list()`; `defineSdkTool` lacks runtime validator).

---

## 1. Context

### 1.1 What T9831 AC4 delivered (verified)

`packages/core/src/tools/` exists today with the following SDK exports (per `packages/core/src/tools/index.ts:1-66`):

- **BrainTools (Category B)** — `searchBrain`, `observeBrain`, `fetchBrainEntries`, `timelineBrain`, `buildRetrievalBundle` (`brain-tools/index.ts:18-22`).
- **ProjectTools (Category B)** — `doctorProject`, `scaffoldGlobal`, `scaffoldProject` (`tools/doctor-project.ts`, `tools/scaffold-global.ts`, `tools/scaffold-project.ts`).
- **TaskTools (Category B)** — `buildTaskTree`, `computeCriticalPath`, `describeSchema`, `scoreTask`, `renderTaskTreeText`, `renderTaskTreeMermaid`, `defineSdkTool` (`task-tools/index.ts:19-25`).
- **SDK infra (Category B)** — `provisionIsolatedShell`, `validateAbsolutePath`, `runToolCached`, `acquireGlobalSlot`, `pipelineManifestAppend`, `buildAgentEnv`, `buildWorktreeSpawnResult`, `CANONICAL_TOOLS`, `resolveToolCommand` (`tools/sdk/index.ts:26-61`).
- **Domain Utilities (Category C)** — 22 `toolsAdapter*`, `toolsProvider*`, `toolsSkill*`, `toolsIssueDiagnostics` ops (`tools/engine-ops.ts` re-exported via `tools/index.ts:22-53`).

Counted strictly, AC4 is **met as raw count** (≥ 13 functions) but **incomplete as architecture**:

- **No Category A subdirectory** (`packages/core/src/tools/agents/` does not exist — confirmed by `find` — yet the SDK index file documents the taxonomy at `sdk/index.ts:15-19`). LLM-callable agent tools (terminal, file, web, search, send-message, validate, spawn, request-hitl) are not consolidated; today they live across `packages/core/src/agents/`, `packages/core/src/orchestration/`, `packages/cleo/src/dispatch/domains/*.ts`.
- **No central registry** — there is a `defineSdkTool` factory (`task-tools/sdk-tool.ts:69-78`) but no `ToolRegistry` with `list()` / `get(name)` / `invoke(name, params)`. Every consumer must import a named export — there is no programmatic discovery.
- **No runtime validation** — `defineSdkTool` emits `inputSchema` / `outputSchema` as JSON-Schema-draft-07 hints but `invoke()` runs the raw function with no input check (G17).
- **No envelope contract** — SDK tools return their function's raw return type; the LAFS `{success,data,error,meta}` envelope (ADR-039) is applied separately by each CLI handler.

### 1.2 What CLI/Studio do today (the duplication)

- **CLI dispatch** — `packages/cleo/src/dispatch/domains/memory.ts` (2,220 LOC), `orchestrate.ts` (1,803), `admin.ts` (1,471), `nexus.ts` (1,461), `docs.ts` (1,316), `pipeline.ts` (1,029), `tasks.ts` (1,021). Each domain file is a fat handler that (a) parses CLI args, (b) calls into `@cleocode/core` (or `@cleocode/core/internal`), (c) hand-rolls a LAFS envelope. The master plan synthesis (T9831 attachment `sg-arch-solid-master-plan`) counted **616 hand-rolled envelopes** + **65 raw `defineCommand` blocks** + **5,861 string-literal op names** as repo-wide CLI duplication.
- **Studio API routes** use **two patterns inconsistently**: (a) **direct core imports** (`packages/studio/src/routes/api/brain/+server.ts:32` imports `@cleocode/brain` and `$lib/server/brain/index.js` directly — bypasses CLI/dispatch entirely); (b) **subprocess spawning** via `executeCliAction(['cleo', 'nexus', ...])` (`packages/studio/src/lib/server/cli-action.ts:49-60`) — wraps the CLI subprocess as the SDK. Result: same operation, two paths, different envelopes.
- **MCP adapter** (`@cleocode/mcp-adapter`) is **subprocess-only by canon** (`packages/mcp-adapter/README.md:5`). It calls `cleo` as a child process — explicitly does NOT import internal packages. This is the right boundary for *external* consumers, but means new tools must be CLI verbs first.
- **CLI lint scripts already exist** (per T10156 inventory verified 2026-05-23):
  - `scripts/lint-cli-package-boundary.mjs` (536 LOC, present and runnable)
  - `scripts/lint-no-raw-define-command.mjs` (294 LOC)
  - `scripts/lint-contracts-fan-out.mjs` (497 LOC)
  - `scripts/lint-no-ssot-exempt.mjs` (448 LOC)
  - `scripts/lint-no-direct-db-open.mjs` (388 LOC)

  T10156 (status=pending, P2 bug) claims these are missing; the filesystem disagrees. T10156 SHOULD be re-verified — likely already resolved by a prior PR that wasn't reconciled to the task graph. **Prerequisite:** Reconcile T10156 before this ADR is accepted, so the strict-mode lint flips required by Decision 6 below are not blocked.

### 1.3 The gap this ADR closes

The IVTR autonomy saga (T10268) needs **`validateAcceptance`, `pullAcceptanceCriteria`, `retryWorker`, `spawnValidator`, `request-hitl`** as first-class tools that the orchestrator, lead, validator, and worker all consume identically. If those tools live in CLI handlers, Studio and the validator-spawn adapter must each re-implement them. The current `defineSdkTool` factory is the right shape but is **inert** — no registry, no validation, no envelope, no scoping, no per-tier visibility.

---

## 2. Decision

### Decision 1 — Registration surface: `defineTool` factory + `CoreToolRegistry`

**MUST** extend `packages/core/src/tools/task-tools/sdk-tool.ts` into a domain-aware contract exposed from `@cleocode/core/tools` and `@cleocode/contracts`:

- `defineTool<I, O>(spec)` factory accepts: `name` (kebab-case, scoped: `<domain>.<verb>`, e.g. `memory.observe`), `version` (semver), `description`, `inputSchema` / `outputSchema` (JSON-Schema-draft-07; **MUST** be `zod`-derived via `@cleocode/contracts` for runtime validation — closes G17), `handler(input): Promise<Result<O, ToolError>>`, `requires?: { capabilities, db, network, fs }`, `scope: { tiers: Tier[], domains: CanonicalDomain[], roles: ('orchestrator'|'lead'|'worker'|'validator')[], visibility: 'llm-callable'|'sdk-internal' }`, `idempotent: boolean`, `boundary: BoundaryEntry` (FK into ADR-078 `BOUNDARY_REGISTRY`).
- `CoreToolRegistry` (new — `packages/core/src/tools/registry.ts`) exposes:
  - `register(tool: RegisteredTool): void`
  - `list(filter?: ScopeFilter): RegisteredTool[]`
  - `get(name: string): RegisteredTool | undefined`
  - `invoke<I,O>(name: string, input: I, ctx: InvocationContext): Promise<Envelope<O>>` — wraps handler with input validation, output validation, envelope wrapping, telemetry.
- `RegisteredTool` and `ScopeFilter` types live in `@cleocode/contracts/tools.ts` (new file).
- Today's `defineSdkTool` (`task-tools/sdk-tool.ts:69-78`) is **renamed** `defineTool` and retained as a back-compat alias for one release cycle.

**Comparison to external systems** (per T10269 steal table):

- **Hermes' `model_tools.get_toolset_for_tool(name)`** — same name→toolset lookup pattern; we adopt the registry index but extend with scope filtering Hermes lacks.
- **Claude Code tool definitions** — `{name, description, input_schema, output_schema?, ...}` — same shape; our `scope` field is additive and supersets Hermes' `DELEGATE_BLOCKED_TOOLS` frozenset (steal-table row 4.1).
- **MCP tool schema** — also `{name, description, inputSchema, outputSchema}`; our registry MAY emit MCP-compatible manifests via `registry.exportMcpManifest()` (used by `@cleocode/mcp-adapter` to keep subprocess boundary intact).

### Decision 2 — Discovery and scoping

**Per-tier scoping IS THE PRIMARY AXIS.** Per-domain and per-role scoping are derived:

- **Tier 0 (worker)** — only `llm-callable` tools whose `scope.roles` includes `'worker'`. **MUST NOT** see `spawn.*`, `validator.*`, `release.*`, `lifecycle.*`. Today's `enforceThinAgent()` / `THIN_AGENT_SPAWN_TOOLS` (per T10269 §3.3) is the proto for this — formalized as `CoreToolRegistry.list({ role: 'worker', visibility: 'llm-callable' })`.
- **Tier 1 (lead/validator)** — workers' set + `spawn.worker`, `validator.spawn`, `worker.retry`, `lead.rollup`, `worker.complete.observe`. Validator subset further restricted (per Wave 2 sibling ADR — `adr-independent-validator`).
- **Tier 2 (orchestrator)** — full registry minus internals (`sdk-internal` visibility hidden).
- **Per-skill scoping** — skills declared in a skill's front-matter `tools:` block (existing skill schema) MUST resolve against `CoreToolRegistry`; unknown tool names fail the skill loader. This makes the existing skill front-matter `tools:` declaration become a **typed reference** instead of a free-text hint.
- **Discovery API** — `cleo tools list --tier=worker --domain=memory --json` (new CLI verb under existing `tools` domain — `packages/cleo/src/dispatch/domains/tools.ts:1-759` already exists and is a thin adapter; this verb adds one route).

### Decision 3 — Dispatch contract

**Every CLI command handler, every Studio API route, every spawn adapter MUST be a thin envelope around `CoreToolRegistry.invoke(name, params, ctx)`.** Specifically:

- **CLI dispatch domain** files (`packages/cleo/src/dispatch/domains/*.ts`) **MUST**:
  1. Parse CLI args with citty (existing `defineCommand`).
  2. Resolve the tool name from the dispatch path (e.g. `memory observe` → `memory.observe`).
  3. Call `await registry.invoke('memory.observe', params, { tier, role, sessionId, agentId })`.
  4. Forward the returned `Envelope<T>` to stdout as JSON.
  5. **MUST NOT** contain business logic, validation, DB opens, or file I/O outside the tool registry.
- **Studio API routes** (`packages/studio/src/routes/api/**/+server.ts`) **MUST**:
  1. Authenticate the caller (existing `csrf.ts` / `cleo-home.ts`).
  2. Call `await registry.invoke(toolName, params, { tier: 2, role: 'orchestrator', sessionId: studioSession })` directly via `@cleocode/core/tools` import.
  3. Return the envelope via `json(envelope)`.
  4. **MUST NOT** use `executeCliAction()` (subprocess spawn) for tools that are in the registry. The subprocess path remains valid ONLY for tools NOT yet in the registry (transitional).
- **`@cleocode/mcp-adapter`** continues to call `cleo` as a subprocess (preserving the external-only canon from `packages/mcp-adapter/README.md:5`). Internally, that subprocess hits `registry.invoke()` — so MCP gets identical semantics without crossing the canon boundary.
- **Spawn adapters** (`packages/adapters/src/providers/*`) **MUST** consume the registry for `validate`, `complete`, `request-hitl` tools — not re-implement.

### Decision 4 — Tool envelope: `Envelope<T>` via `Result<T, ToolError>`

**Every tool handler MUST return `Result<T, ToolError>`**, and `registry.invoke()` MUST wrap the result into the LAFS `Envelope<T>` per ADR-039:

```text
// type-level only (no implementation here)
Envelope<T> = { success: true,  data: T, meta: Meta }
            | { success: false, error: ErrorEnvelope, meta: Meta }
Result<T,E> = { ok: true, value: T } | { ok: false, error: E }
ToolError   = { code: ErrorCode, codeName: string, message: string,
                fix?: string, alternatives?: string[] }
```

- The registry runtime applies (a) `inputSchema` validation pre-handler, (b) `outputSchema` validation post-handler, (c) timing/telemetry metadata. Failure at any step yields `{ success: false }` with the correct exit code (per `@cleocode/contracts/exit-codes.ts`).
- This **MAKES THE ENVELOPE PRODUCED AT THE TOOL BOUNDARY**, not at the CLI boundary. Eliminates the 616 hand-rolled envelopes counted in the SG-ARCH-SOLID synthesis plan.
- Pre-existing tools (`searchBrain`, `observeBrain`, `buildTaskTree`, etc.) **MUST** be re-wrapped via `defineTool` so they return `Envelope<T>` rather than raw return values. Existing pure-function exports remain for unit-test ergonomics but the registry-routed path becomes the canonical surface.

### Decision 5 — Target catalog (the complete tool list)

Beyond the ≥ 13 from T9831 AC4, the **target catalog (~50 tools)** is:

| Category | Tool name | Visibility | Roles | Source package |
|---|---|---|---|---|
| **Agent-facing (Category A — LLM-callable)** | `terminal.run`, `terminal.run-cached` | llm | worker, lead | core/tools/agents/terminal |
| | `file.read`, `file.write`, `file.edit`, `file.glob` | llm | worker, lead | core/tools/agents/file |
| | `web.fetch`, `web.search` | llm | worker, lead, validator | core/tools/agents/web |
| | `search.code`, `search.grep` | llm | worker, lead, validator | core/tools/agents/search |
| | `memory.observe`, `memory.find`, `memory.fetch`, `memory.timeline` | llm | all | core/tools/brain-tools (existing) |
| | `nexus.query`, `nexus.context`, `nexus.impact` | llm | worker, lead | core/tools/agents/nexus (new — wraps existing nexus ops) |
| | `docs.fetch`, `docs.add` | llm | lead, validator, orchestrator | core/tools/agents/docs (new — wraps `cleo docs`) |
| | `spawn.worker`, `spawn.validator`, `spawn.lead` | llm | lead, orchestrator | core/tools/agents/spawn (new — wraps `core/orchestrate/spawn-ops.ts`) |
| | `worker.send-message`, `worker.terminate`, `worker.status` | llm | lead, orchestrator | core/tools/agents/worker-control (new — extends `CLEOSpawnAdapter`) |
| | `validator.ac-pull`, `validator.attest`, `validator.reject` | llm | validator | core/tools/agents/validator (new — Wave 2 sibling ADR) |
| | `agent.request-hitl` | llm | worker, lead, validator | core/tools/agents/hitl (new — model-welfare; per T10269 §3.7) |
| **Control-plane (Category B — SDK-internal)** | `verify.gate`, `verify.all` | sdk-internal | orchestrator | core/tools (wraps `core/validation/engine-ops.ts`) |
| | `task.complete`, `task.create`, `task.show`, `task.find` | sdk-internal | orchestrator, lead | core/tools/task-tools (new wrappers over existing ops) |
| | `conduit.publish`, `conduit.subscribe`, `conduit.drain` | sdk-internal | lead, orchestrator | core/tools (new — wraps `core/conduit/conduit-client.ts`) |
| | `pipeline.manifest-append`, `pipeline.manifest-read` | sdk-internal | lead | core/tools/sdk (existing) |
| | `worktree.provision`, `worktree.dispose` | sdk-internal | orchestrator | core/tools/sdk (existing — `provisionIsolatedShell`) |
| | `release.plan`, `release.open`, `release.reconcile` | sdk-internal | orchestrator | core/tools (new — wraps `core/release/*`) |
| | `lifecycle.advance`, `lifecycle.show` | sdk-internal | orchestrator | core/tools (new — wraps `core/lifecycle/engine-ops.ts`) |
| **Infrastructure (Category B — existing)** | `task-tree.build`, `task-tree.render-text`, `task-tree.render-mermaid`, `task.score`, `task.critical-path` | sdk-internal | orchestrator | core/tools/task-tools (existing) |
| | `brain.retrieval-bundle` | sdk-internal | lead, orchestrator | core/tools/brain-tools (existing) |
| | `project.scaffold`, `project.scaffold-global`, `project.doctor` | sdk-internal | orchestrator | core/tools (existing) |
| | `tool.resolve`, `tool.run-cached`, `tool.acquire-slot` | sdk-internal | sdk | core/tools/sdk (existing) |
| | `agent.env-build`, `worktree.spawn-result-build` | sdk-internal | sdk | core/tools/sdk (existing) |
| **Domain (Category C — adapter/skill mgmt)** | `tools.skill.list`, `tools.skill.find`, `tools.skill.dispatch`, `tools.adapter.list`, `tools.adapter.activate`, `tools.provider.list`, `tools.provider.inject` etc. (22 existing in `engine-ops.ts`) | sdk-internal | orchestrator | core/tools/engine-ops (existing) |

Total: ~50 tools across ~12 new sub-modules. New work (~25 net new tools) is sized as one Wave-2 epic under SG-IVTR-AUTONOMY.

### Decision 6 — CLI/Studio adapter rules and lint enforcement

**The CLI handler boundary rule (binding):** *"A `packages/cleo/src/dispatch/domains/*.ts` handler MAY only (a) parse CLI args, (b) resolve a tool name from the dispatch path, (c) call `CoreToolRegistry.invoke()`, (d) forward the returned envelope. ANY business logic, validation, DB opens, file I/O, or external command spawning inside the handler is a CI failure."*

**Lint rule scope** (extends T9837 / T10156 enforcement):

1. **Promote `scripts/lint-cli-package-boundary.mjs` from `--baseline` to `--strict`** on `packages/cleo/src/dispatch/domains/**` after Migration Phase B completes. Current 30-LOC ceiling for standalone functions is retained but the carve-out for `make*Command` helpers SHOULD be tightened to require a `tool:<name>` annotation.
2. **New `scripts/lint-no-direct-core-deep-import.mjs`** — block `import ... from '@cleocode/core/internal'` and `await import('@cleocode/core/internal')` outside the `tools/` and a small set of bootstrap files. Today `memory.ts:380, 403, 426, 558, 584, 606, 1666, 1678, 2087` use lazy `@cleocode/core/internal` imports — every site MUST migrate to `registry.invoke()`.
3. **New `scripts/lint-studio-tools-only.mjs`** — block `executeCliAction()` calls in `packages/studio/src/routes/api/**/+server.ts` for tool names that ARE registered in `CoreToolRegistry`. Studio still calls subprocess for unregistered tools (gradual migration).
4. **New `scripts/lint-tool-name-string-literals.mjs`** — block raw string literals matching `/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/` in dispatch domain files unless they appear inside `registry.invoke()` calls. (The synthesis plan flagged **5,861 string-literal op names** repo-wide.)
5. **Boundary registry FK** — every new `defineTool` call MUST reference a `BoundaryEntry` from `@cleocode/contracts/boundary.BOUNDARY_REGISTRY` (ADR-078). Adding a tool without a boundary entry fails the existing `lint-boundary-registry.mjs`.

---

## 3. Consequences

### 3.1 Refactor scope (NOT a code change in this ADR — proposal only)

- **CLI dispatch domains** — ~17,860 LOC across 14 files (largest: `memory.ts` 2,220; `orchestrate.ts` 1,803). Each file becomes a thin router. Expected net reduction: ~40–60% LOC after tool extraction (consistent with SG-ARCH-SOLID synthesis estimates of "14,000–17,000 LOC moved or eliminated").
- **Studio API** — ~10 server routes. Each migrates from `executeCliAction` or direct deep imports to `registry.invoke()`. New shared helper `$lib/server/tools.ts` wraps the import + envelope forwarding. No UX/UI change.
- **MCP adapter** — zero source change (subprocess boundary preserved). MCP manifest exported via `registry.exportMcpManifest()` ensures parity.
- **Spawn adapters** (`packages/adapters/src/providers/*`) — each provider gains an `extendedAdapter.invokeTool(name, ...)` shim that forwards to the registry. Today's `CLEOSpawnAdapter` (`packages/contracts/src/spawn-types.ts:90-123`) gains optional `toolRegistry` capability flag.

### 3.2 Lint rule additions

5 new/promoted lint scripts (Decision 6). All MUST land with `--baseline` mode first and graduate to `--strict` once the relevant migration phase completes. Existing `scripts/lint-cli-package-boundary.mjs` graduates without code change — only the runtime flag flips.

### 3.3 Breaking changes for plugin/adapter authors

- `@cleocode/contracts.SdkToolIdentity` adds optional `scope: ScopeDescriptor` field (SemVer minor — additive).
- `CLEOSpawnAdapter` gains optional `toolRegistry?: CoreToolRegistry` constructor param (SemVer minor).
- Third-party adapter authors in the 9 `packages/adapters/src/providers/*` dirs MUST update if they want to participate in tool dispatch, but existing call sites continue to work (the optional fields default to undefined).
- Skills with `tools:` front-matter that reference unknown names will fail loading at registry registration time (NEW). MAY require updating skill front-matter for ~6 community skills that reference non-canonical names.

### 3.4 Risk surface

- **Performance** — `registry.invoke()` adds per-call overhead (schema validation + envelope wrapping). MUST keep validation under 1ms per call via Zod-compiled validators. Cached `ToolResolver` pattern (existing `runToolCached`) is the reference.
- **Migration breakage** — the 9 lazy `await import('@cleocode/core/internal')` sites in `memory.ts` are evidence that refactors went lazy to avoid circular deps. The migration MUST verify no new cycles introduced; `lint-contracts-dep` already catches the worst class but does not check tool-registry self-imports.
- **Test churn** — every CLI integration test that asserts exit-code shape MUST be re-run; the envelope shape MUST remain backward-compatible per ADR-039.
- **Studio direct-import path** — `api/brain/+server.ts` imports `@cleocode/brain` and `$lib/server/brain/index.js`. These imports SHOULD eventually flow through `registry.invoke('brain.tier-graph')` — but the LRU-cache layer in `$lib/server/brain/cache.ts` is Studio-specific and SHOULD remain. The boundary: shared business logic moves to a tool; Studio-specific caching/UI logic stays in `$lib/server/`.

---

## 4. Alternatives Considered

### Alt 1 — Keep CLI handlers as the primary tool surface (status quo)

The CLI is already the canonical entry point per MCP-removal canon (2026-04-04). Studio could continue to spawn `cleo` subprocesses; MCP adapter already does this. The 5,861 string-literal op names are the cost.

**Rejected because:** (a) Studio's per-request subprocess spawn is 50–500ms overhead vs in-process invoke; (b) the IVTR autonomy saga needs the orchestrator/lead/validator to invoke tools in-process without subprocess fork — Hermes' `delegate_task` is in-process for the same reason; (c) two paths for the same operation guarantees envelope drift.

### Alt 2 — Tools live in a standalone `@cleocode/tools` package

Carve a new top-level package between core and adapters. Plugin authors import from it directly.

**Rejected because:** (a) The 22 existing engine-ops (`tools/engine-ops.ts`) already live inside core because they need access to BRAIN, conduit, and store — extracting them would re-create the circular-dep problem T9831's E-CORE-DECOMP explicitly solved; (b) `defineTool` lives in `@cleocode/contracts` (type) + `@cleocode/core/tools` (implementation) — splitting further is YAGNI; (c) ADR-064 already established `packages/core/src/tools/` as canonical location.

### Alt 3 — MCP as the canonical tool surface (everyone speaks MCP internally)

The current MCP adapter has 3 tools today; extending it to be the internal protocol would standardize across external/internal boundaries.

**Rejected because:** (a) MCP is JSON-RPC over stdio — fine for external consumers, slow for in-process orchestration (every tool call serializes/deserializes); (b) the 2026-04-04 MCP-removal canon explicitly states "Do NOT add MCP to internal CLEO dispatch" — `packages/mcp-adapter/README.md:5`; (c) `registry.exportMcpManifest()` gives us MCP compat for free without making it the internal lingua franca.

### Alt 4 — Tools as Zod schemas only (no separate factory)

The registry is just `Map<string, ZodSchema>` + handlers. No `defineTool` factory.

**Rejected because:** (a) scope, requires, boundary, telemetry metadata are not expressible in Zod alone; (b) `RegisteredTool` is reused by skills' front-matter validator and MCP manifest exporter — needs a stable object shape beyond schema-only.

### Alt 5 — Per-domain mini-registries (memoryRegistry, taskRegistry, …)

Each domain owns its own registry; a thin federator combines them.

**Rejected because:** (a) the orchestrator-tier scope filter needs a *unified* view to enforce blocklists like Hermes' `DELEGATE_BLOCKED_TOOLS`; (b) cross-domain tools like `spawn.validator` (validator role spans validation + spawn domains) become awkward; (c) test ergonomics for the registry are best with one chokepoint.

---

## 5. Migration

**Phased plan.** Each phase is one or more child tasks under the Wave-2 epic of SG-IVTR-AUTONOMY. ALL phases MUST land with the lint scripts in `--baseline` mode first; promotion to `--strict` happens at the phase boundary.

### Phase A — Prerequisite reconciliation (1 wave)

- A1. Reconcile T10156 (lint-script inventory mismatch). The 5 scripts named in T10156's acceptance criteria already exist in `scripts/`; verify they pass `cleo check arch` and mark T10156 done.
- A2. Audit current `defineSdkTool` callers. Inventory every place the existing factory is used to ensure the rename to `defineTool` is mechanical.

### Phase B — Registry foundation (1 wave)

- B1. Add `CoreToolRegistry` to `packages/core/src/tools/registry.ts` with `register/list/get/invoke`.
- B2. Add `RegisteredTool` / `ScopeFilter` / `InvocationContext` to `@cleocode/contracts/tools.ts`.
- B3. Rename `defineSdkTool` → `defineTool`; retain alias.
- B4. Migrate existing ≥ 13 SDK tools (T9831 AC4 set) through `defineTool` so they register on import side-effect. Existing pure-function exports remain.
- B5. Add `registry.exportMcpManifest()` and verify `@cleocode/mcp-adapter` consumes it without source change to the adapter.

### Phase C — CLI dispatch routing (1 wave per top-3 domains)

- C1. Migrate `memory.ts` domain handlers to `registry.invoke()`. Move business logic from the 9 lazy `await import('@cleocode/core/internal')` sites into named tools.
- C2. Migrate `orchestrate.ts` and `tasks.ts` similarly.
- C3. After C1+C2 land, promote `lint-cli-package-boundary.mjs` from `--baseline` to `--strict` on those two domains. The remaining 11 domains continue in `--baseline` mode.
- C4. Continue migration domain-by-domain across releases. Add `lint-no-direct-core-deep-import.mjs` in `--baseline` mode.

### Phase D — Studio adapter alignment (1 wave)

- D1. Add `$lib/server/tools.ts` helper in Studio that calls `registry.invoke()` directly via `@cleocode/core/tools`.
- D2. Migrate each `+server.ts` route that uses `executeCliAction` for a now-registered tool.
- D3. Add `lint-studio-tools-only.mjs` in `--baseline` mode.

### Phase E — Validator + autonomy tools (depends on Wave-2 sibling ADRs)

- E1. Register `validator.ac-pull`, `validator.attest`, `validator.reject`, `agent.request-hitl`, `worker.send-message` (per sibling ADRs `adr-independent-validator`, `adr-ac-stable-ids`).
- E2. `CLEOSpawnAdapter` extension: optional `toolRegistry` reference; spawn adapters opt in via `extendedAdapter.invokeTool()`.
- E3. Skill front-matter `tools:` becomes typed — skill loader validates against `registry.list()` and fails on unknowns.

### Phase F — Strict mode + retirement (1 wave per release)

- F1. Promote all 5 lint scripts from Decision 6 to `--strict`.
- F2. Retire the `defineSdkTool` back-compat alias.
- F3. Document the catalog from §2.5 in `AGENTS.md` and the published `llms-full.txt` so external agents discover it.

---

## 6. References

- **Slugs (cleo docs fetch):**
  - `ivtr-external-systems-steal-table` (T10269 / Wave 0) — §IT-4 motivation; §3.3 tool dispatch comparison; §4.1 Hermes patterns.
  - `ivtr-current-state-audit` (T10270 / Wave 0) — §2.6 current tools state; G10, G17 gap entries.
  - `t9154-consensus` (older — superseded for tools framing; cited for spawn-adapter context).
  - `sg-arch-solid-master-plan` (T9831 attachment) — 616 envelopes / 65 raw defineCommand / 5,861 string-literal op-names counts.
- **ADRs:**
  - **ADR-039** — LAFS envelope contract (every tool envelope MUST conform).
  - **ADR-051** — evidence-based gate ritual (tools MUST emit evidence-compatible atoms).
  - **ADR-064** — SDK Tools taxonomy (Category A/B/C — this ADR formalizes Category A).
  - **ADR-070** — three-tier orchestration (tier scoping in Decision 2 derives from this).
  - **ADR-073** — task hierarchy (no impact, cited for completeness).
  - **ADR-078** — boundary registry (every tool MUST FK into `BOUNDARY_REGISTRY`).
- **Tasks:**
  - T9831 AC4 — original ≥ 13 SDK tools delivery.
  - T9837 — SSoT enforcement lint scripts (5 scripts already exist; T10156 reconciliation required).
  - T10156 — lint-script inventory mismatch (prerequisite — see §1.2 and Phase A).
  - T10068, T10069, T10070 — TaskTools/ProjectTools/BrainTools delivered under T9835.
  - T1737, T1739, T1741 — pending agent-tool epics (Category A) that this ADR's catalog absorbs.
  - T10271 — this ADR's parent epic.
- **Files:**
  - `packages/core/src/tools/index.ts:1-66` (barrel).
  - `packages/core/src/tools/task-tools/sdk-tool.ts:69-78` (`defineSdkTool` — to be renamed).
  - `packages/contracts/src/sdk-tool.ts:31-58` (identity types).
  - `packages/contracts/src/dispatch/operation-def.ts:55-79` (OperationDef — current dispatch contract).
  - `packages/cleo/src/dispatch/domains/_routing.ts:8-25` (param routing utility).
  - `packages/cleo/src/dispatch/domains/memory.ts:380, 403, 426, 558, 584, 606, 1666, 1678, 2087` (9 lazy `core/internal` imports — migration targets).
  - `packages/studio/src/routes/api/brain/+server.ts:32-40` (direct-core-import pattern).
  - `packages/studio/src/lib/server/cli-action.ts:49-60` (subprocess-spawn pattern).
  - `packages/mcp-adapter/README.md:5-7` (external-only canon).
  - `scripts/lint-cli-package-boundary.mjs`, `scripts/lint-no-raw-define-command.mjs`, `scripts/lint-contracts-fan-out.mjs`, `scripts/lint-no-ssot-exempt.mjs`, `scripts/lint-no-direct-db-open.mjs` (existing, per filesystem verify 2026-05-23).
