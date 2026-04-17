# Lead 3 Spawn Coherence — T889 Architecture

> **Owner**: Lead 3 (Spawn Pipeline)
> **Scope**: T890, T892, T893, T894, T895, T896
> **Date**: 2026-04-17
> **Status**: Research-only; permission granted to REPLACE/REFACTOR T882 if warranted.
> **Verdict**: **REFACTOR T882 into a two-layer SSoT** — keep the section builders, extract the top-level orchestration into `composeSpawnPayload` in `core/orchestration`. DELETE `cant/composer.ts` (orphan, different tier vocabulary, never called from `cleo orchestrate spawn`).

---

## 0. Executive summary

Today's `cleo orchestrate spawn T###` pipeline is **correct but duplicated and tier-blind**. When invoked inside Claude Code, the returned prompt contains a fully-embedded CLEO-INJECTION.md at tier 1 (default) — while the harness *already* auto-loaded AGENTS.md, which `@`-refs `CLEO-INJECTION.md`. Net effect: ~9 KB of identical protocol text is shipped twice per spawn, across every provider.

Simultaneously, a second, parallel spawn-composer exists in `packages/cant/src/composer.ts` (`composeSpawnPayload`). It speaks a different tier vocabulary (`low|mid|high`), a different token-budget model, and is wired to a BRAIN `ContextProvider`, but it has **zero callers from `cleo orchestrate spawn`**. The header comment of `orchestrate-engine.ts` still claims it was wired in T432 — it wasn't; `prepareSpawn` was used instead (T506 spawn-injection unification backed T882 out of that duplication).

T889 closes the loop: **one spawn codepath, tier-aware by role and environment, dedup by harness-hint, atomic by worker contract, with a public `cleo orchestrate plan <epicId>` command that fans out machine-readable spawn specs.**

The final-state architecture introduces a single, canonical `composeSpawnPayload(taskId, opts) → SpawnPayload` API in `packages/core/src/orchestration/`. T882's `buildSpawnPrompt` becomes its private section-rendering engine. `cant/composer.ts` is deleted (its mental-model / context-slice logic is already duplicated in `adapters/cant-context.ts`). The spawn pipeline reads `CLEO_HARNESS` env + `.cleo/harness-profile.json` + runtime auto-detection; at `claude-code` hint, the CLEO-INJECTION embed collapses to a one-line pointer and stage-specific guidance stays inline. Auto-tier (orchestrator=2, lead=1, worker=0) is computed from task type + size + labels with explicit override. Atomicity is enforced at spawn time when role=`worker`: if `AC.files` is absent or > 3 entries, spawn fails with `E_ATOMICITY_VIOLATION`. Hoisting the Task Identity block to the first 500 characters guarantees Claude reads the task before protocol boilerplate.

---

## 1. Final-state architecture

### 1.1 Single spawn API

**Location**: `packages/core/src/orchestration/spawn.ts` (new file — the T882 logic consolidates here under a cleaner top-level name; T882's internal `build*` section helpers keep their current `spawn-prompt.ts` home to preserve separation of concerns).

```ts
// packages/core/src/orchestration/spawn.ts (canonical public API)

export interface ComposeSpawnInput {
  taskId: string;
  /** Explicit role override. Inferred from task.type/labels when omitted. */
  role?: 'orchestrator' | 'lead' | 'worker';
  /** Explicit tier override. Auto-selected from role + size + labels when omitted. */
  tier?: SpawnTier; // 0 | 1 | 2
  /** Harness hint. Auto-detected from env when omitted. */
  hint?: HarnessContextHint; // 'claude-code' | 'generic' | 'bare'
  /** Orchestrator session id. Loaded from getActiveSession() when omitted. */
  sessionId?: string | null;
  /** Absolute project root. Defaults to resolveProjectRoot(). */
  projectRoot?: string;
  /** Protocol phase override. Defaults to autoDispatch(task). */
  protocol?: SpawnProtocolPhase | string;
}

export interface SpawnPayload {
  /** Fully-composed prompt, ready for `adapter.spawn()`. */
  prompt: string;
  /** Task identifier. */
  taskId: string;
  /** Agent registry ID (resolved via Lead 2 registry). */
  agentId: string;
  /** Persona kind (cleo-subagent, cleo-research-lead, …). */
  persona: string;
  /** Selected tier after auto-selection + escalation. */
  tier: SpawnTier;
  /** Model for this tier (via TIER_MODELS in @cleocode/cant — retained). */
  model: string;
  /** Fallback models in order. */
  fallbackModels: string[];
  /** Tools allow-list (Lead 2 registry output). */
  tools: string[];
  /** Skills bundle resolved by Lead 4 skill-composer. */
  skills: string[];
  /** Role/constraint contract (Lead 1 CANT v3 types). */
  contract: AgentContract;
  /** Detected harness — what the hint resolved to. */
  resolvedHint: HarnessContextHint;
  /** Playbook node id (T890 plan) if this spawn was planned. */
  playbookNode?: string;
  /** Resume token for idempotent handoff. */
  resumeToken?: string;
  /** Protocol phase (after autoDispatch). */
  protocol: string;
  /** Token resolution diagnostics. */
  tokenResolution: { fullyResolved: boolean; unresolvedTokens: string[] };
  /** Metrics for observability. */
  metrics: {
    charCount: number;
    estimatedTokens: number;
    sectionCounts: Record<string, number>;
    dedupSavedChars: number; // chars saved by harness dedup
  };
}

export async function composeSpawnPayload(
  input: ComposeSpawnInput,
  projectRoot?: string,
  accessor?: DataAccessor,
): Promise<SpawnPayload> { /* ... */ }
```

**Why this signature?**
- `SpawnPayload` is the **meta-return** the owner asked for: prompt + agentId + persona + model + tools + skills + contract + playbook + resume token. Any layer (CLI, orchestrate engine, future MCP) consumes it unchanged.
- `prompt` remains a string — all existing adapters (7 provider spawn.ts files) and `buildCantEnrichedPrompt` continue working with zero changes.
- `resolvedHint` + `metrics.dedupSavedChars` make the dedup observable and testable.
- `playbookNode`/`resumeToken` are optional — set when `cleo orchestrate plan` produced this spawn spec, null otherwise.

### 1.2 Fate of T882 spawn-prompt.ts

**Verdict: REFACTOR — keep, don't delete.**

The T882 section builders (`buildHeader`, `buildTaskIdentity`, `buildFilePathsBlock`, `buildSessionBlock`, `buildStageGuidance`, `buildEvidenceGateBlock`, `buildQualityGateBlock`, `buildReturnFormatBlock`, `buildTier0ProtocolPointer`, `buildTier1InjectionEmbed`, `buildTier2SkillExcerpts`, `buildAntiPatternBlock`) are **high-quality, isolated, and fully tested**. They cover the 8 required sections and the full RCASD-IVTR+C stage matrix. Deleting them would re-violate SSoT.

What changes:
- `buildSpawnPrompt` is renamed to `assemblePrompt` and becomes **internal** (not re-exported from `index.ts`).
- New public API `composeSpawnPayload` lives in `packages/core/src/orchestration/spawn.ts`; it calls `assemblePrompt` plus the new layers (auto-tier, hint resolution, dedup, hoisting, atomicity gate, registry resolve, skill compose).
- The tier 1 `buildTier1InjectionEmbed` gets a `hint` parameter: when `hint === 'claude-code'`, returns a one-line pointer ("CLEO-INJECTION.md already loaded by harness via AGENTS.md @-ref") instead of the 9 KB embed.
- Section ordering changes (T895): Task Identity + Return Format Contract MUST appear in the first 500 chars. See §1.6.
- The `export { buildSpawnPrompt }` re-export from `orchestration/index.ts` stays as a `@deprecated` alias pointing at `composeSpawnPayload({ tier, projectRoot, sessionId }).prompt` so the two downstream callers (`prepareSpawn`, tests) keep compiling during migration.

What gets deleted:
- `packages/cant/src/composer.ts` — the orphaned composer. Its tier vocabulary (`low|mid|high`) conflicts with T882's `0|1|2`; its ContextProvider abstraction duplicates `adapters/src/cant-context.ts` `fetchMentalModelInjection` + memory-bridge logic. Kill it, migrate `TIER_MODELS` + `estimateTokens` + the `MENTAL_MODEL_VALIDATION_PREFIX` to `core/orchestration/spawn.ts`. The re-export line `composeSpawnPayload, escalateTier, estimateTokens, TIER_CAPS` in `cant/src/index.ts` gets removed; nothing outside `cant/tests/composer*.test.ts` imports them. Those two test files get deleted.

### 1.3 Tier auto-selection algorithm (T892)

**Inputs**: `task.type`, `task.size`, `task.labels`, explicit `role`, explicit `tier` override.

**Rule order (first match wins)**:

| # | Condition | Resolved Role | Resolved Tier |
|---|-----------|---------------|---------------|
| 1 | `input.tier` supplied | (see §1.3.b) | `input.tier` |
| 2 | `input.role === 'orchestrator'` OR `task.type === 'epic'` AND labels contain `orchestrator` | orchestrator | 2 |
| 3 | `input.role === 'lead'` OR `task.labels` contains any of `lead`, `research-lead`, `consensus-lead`, `arch-lead`, `spec-lead`, `decomp-lead` | lead | 1 |
| 4 | `task.type === 'epic'` AND `children.length >= 5` | orchestrator | 2 |
| 5 | `task.labels` contains `complex` OR `size === 'large'` | worker | 1 |
| 6 | `task.labels` contains `research` | worker | 1 |
| 7 | Default | worker | 0 |

**b. Role inference when only tier is given**: If `input.tier === 2` and no role → orchestrator. If `input.tier === 1` and no role → lead for epics, worker for non-epics. If `input.tier === 0` and no role → worker.

**c. Overflow escalation** (borrowed from the old composer): after prompt assembly, if `estimateTokens(prompt) > TIER_CAPS[tier].systemPrompt`, escalate tier and re-assemble. Fail with `E_SPAWN_TOO_LARGE` if already at 2.

**Exposed via** a pure helper `resolveTierAndRole(input, task, childrenCount): { role, tier, escalated }` — trivially testable, no filesystem access.

### 1.4 Harness dedup (T893)

**Signal order (first present wins)**:
1. Explicit `input.hint`.
2. `$CLEO_HARNESS` env var (values: `claude-code` | `generic` | `bare`).
3. `.cleo/harness-profile.json` — `{ "harness": "claude-code", "autoLoadsAgentsMd": true }` (written once by `cleo init` when it detects Claude Code).
4. Runtime auto-detect: `process.env.CLAUDECODE === '1'` or `process.env.CLAUDE_CODE_ENTRYPOINT` present → `claude-code`.
5. Default → `generic`.

**Behavior matrix**:

| Hint | CLEO-INJECTION embed | Stage-specific guidance | AGENTS.md pointer | Skill excerpts (tier 2) |
|------|----------------------|-------------------------|-------------------|-------------------------|
| `claude-code` | **SKIPPED** (pointer only) | Inline (always) | Inline pointer: "Harness already loaded AGENTS.md → @ CLEO-INJECTION.md" | Inline at tier 2 (Claude Code does not auto-load skills) |
| `generic` | Full embed at tier 1+ | Inline | AGENTS.md NOT assumed | Inline at tier 2 |
| `bare` | Full embed at tier 1+ | Inline + extra quick-start | Full AGENTS.md block inlined before protocol | Inline at tier 2 |

**Measurable savings (snapshot-verified)**:
- Tier 0: `claude-code` hint saves 0 bytes (already pointer-only).
- Tier 1: `claude-code` hint saves ~9,000 chars (the CLEO-INJECTION embed).
- Tier 2: `claude-code` hint saves ~9,000 chars; skill excerpts remain since Claude Code skill auto-discovery only loads the skill name, not SKILL.md.

**This is what makes T893 testable**: `SpawnPayload.metrics.dedupSavedChars` must be zero for `generic`/`bare`, and positive for `claude-code` at tier >= 1.

### 1.5 Prompt layout (T895 hoisting)

**New ordering** (authoritative — tests assert this):

```
[0..~250 chars]   # CLEO Subagent Spawn — <TASK_ID> · Tier <N> · <Role>
                  (one-line task title + one-line directive: "Return only the Return-Format string; write work to files.")
                  ## Task
                  - ID / Title / Parent / Size / Priority / Labels
                  - Acceptance (first 3 criteria, compressed)

[~250..~500]      ## Return Format Contract (MANDATORY)
                  <3 exact strings>

[500..~1500]      ## File Paths (absolute)
                  ## Session Linkage
                  ## Stage-Specific Guidance

[1500..~3500]     ## Evidence-Based Gate Ritual
                  ## Quality Gates
                  ## Skills Bundle (Lead 4 refs)

[3500..end]       ## Protocol — pointer OR embed (per hint)
                  ## Anti-Patterns (tier 2 only)
```

Why the first 500 chars matter: Claude Code's UI truncates tool-generated content in its display, and agents frequently skim the first 500 chars when deciding what to read next. T882 today buries Task Identity around char ~400 but Return Format Contract sits around char ~2500. Hoisting the Return Format Contract is the single highest-leverage prompt-engineering change in this epic.

### 1.6 Plan command (T890) output schema

**Command**: `cleo orchestrate plan <epicId> [--variant research|consensus|implementation] [--tier 0|1|2]`

**LAFS envelope**:

```json
{
  "success": true,
  "data": {
    "epicId": "T889",
    "generatedAt": "2026-04-17T20:30:00Z",
    "totalTasks": 32,
    "totalWaves": 4,
    "waves": [
      {
        "wave": 1,
        "parallel": true,
        "lead": {
          "taskId": "T889-lead-1",
          "persona": "cleo-research-lead",
          "tier": 1,
          "role": "lead",
          "model": "claude-sonnet-4-6",
          "atomicScope": { "files": [], "mode": "planning" }
        },
        "workers": [
          {
            "taskId": "T890",
            "persona": "cleo-subagent",
            "tier": 0,
            "role": "worker",
            "model": "claude-haiku-4-5",
            "atomicScope": {
              "files": [
                "packages/cleo/src/dispatch/engines/orchestrate-engine.ts",
                "packages/cleo/src/cli/commands/orchestrate.ts",
                "packages/core/src/orchestration/spawn.ts"
              ],
              "mode": "edit",
              "maxFiles": 3
            },
            "skillBundle": ["ct-cleo", "ct-task-executor"],
            "contractRef": "worker@1"
          }
        ]
      }
    ],
    "atomicityReport": {
      "violations": [],
      "maxWorkerFileCount": 3,
      "tasksMissingFiles": []
    },
    "playbookId": "plan_T889_20260417_203000"
  },
  "_meta": { "version": "2026.5.x", "operation": "orchestrate.plan" }
}
```

**Key invariants**:
- `waves` is ordered — consumer executes wave N only after wave N-1 all-complete.
- Each worker MUST carry `atomicScope.files` (non-empty). If absent, the plan fails with `E_ATOMICITY_VIOLATION` pre-emit and lists the offending task IDs in `atomicityReport.tasksMissingFiles`. Owner can override with `--allow-unbounded-workers`.
- `playbookId` is a deterministic hash of `(epicId, generatedAt, epic.contentHash)`; `cleo orchestrate spawn <taskId> --playbook <playbookId>` consumes exactly this plan to produce the same SpawnPayload.
- `contractRef` points at a named `AgentContract` produced by Lead 1 CANT DSL v3 (`worker@1`, `lead@1`, `orchestrator@1` are the canonical contracts).

**Why machine-readable**: the owner asked for `{waves:[{lead, workers:[{taskId,persona,tier,atomicScope}]}]}`. The schema above is the strict superset — every field is either required or optional with defaults. It deserializes cleanly in the three consumer contexts: CLI pretty-print, orchestrator runtime, and T918 (Lead 5) test-spec harness.

### 1.7 Atomicity gate (T894)

**Signature**:

```ts
export interface AtomicityCheckInput {
  task: Task;
  role: 'orchestrator' | 'lead' | 'worker';
  maxFilesForWorker?: number; // default 3
}

export interface AtomicityCheckResult {
  ok: boolean;
  errors: Array<{
    code: 'E_ATOMICITY_NO_FILES' | 'E_ATOMICITY_TOO_MANY_FILES';
    message: string;
    details: { taskId: string; filesFound: number; filesMax: number };
  }>;
}

export function checkAtomicity(input: AtomicityCheckInput): AtomicityCheckResult;
```

**Rules**:
- `role === 'orchestrator' | 'lead'` → always ok (planning roles don't touch files).
- `role === 'worker'`:
  - Extract `AC.files` from `task.acceptance[*].files` (Lead 1 CANT v3 AC schema) OR `task.metadata.files[]` (legacy compat).
  - If zero files → fail with `E_ATOMICITY_NO_FILES` ("Worker tasks MUST declare AC.files — the set of files this task owns. Edit the task: `cleo update <id> --files a.ts,b.ts`").
  - If `files.length > maxFilesForWorker` (default 3) → fail with `E_ATOMICITY_TOO_MANY_FILES`. Owner override: `CLEO_WORKER_MAX_FILES=5` env var.

**Error path**: `composeSpawnPayload` calls `checkAtomicity` and throws a `CleoError(ExitCode.INVALID_INPUT, …)` when violations are non-empty. The CLI surfaces `E_ATOMICITY_VIOLATION` with a `fix` suggestion. Overridable via `cleo orchestrate spawn T### --allow-unbounded` (documented anti-pattern).

### 1.8 Env/control surface summary

| Variable / path | Purpose | Default |
|-----------------|---------|---------|
| `CLEO_HARNESS` | harness hint override | auto-detect |
| `CLEO_WORKER_MAX_FILES` | atomicity threshold | 3 |
| `.cleo/harness-profile.json` | persistent per-repo hint | absent |
| `--tier 0|1|2` CLI flag | explicit tier override | auto-select |
| `--hint claude-code|generic|bare` CLI flag | explicit hint override | auto-detect |
| `--role worker|lead|orchestrator` CLI flag | explicit role override | auto-infer |
| `--allow-unbounded` CLI flag | skip atomicity gate | false |
| `--playbook <id>` CLI flag | consume a previous plan | none |

---

## 2. Current-state findings

### 2.1 T882 spawn-prompt.ts section-by-section

| Section / function | Lines | Keep? | Action |
|--------------------|-------|-------|--------|
| `locateCleoInjectionTemplate()` | 67-95 | KEEP | Move to `core/orchestration/template-resolver.ts` (shared with plan command). |
| `SpawnTier` / `DEFAULT_SPAWN_TIER` / `ALL_SPAWN_PROTOCOL_PHASES` | 101-138 | KEEP | Unchanged. |
| `BuildSpawnPromptInput` / `BuildSpawnPromptResult` | 148-177 | KEEP | Becomes internal types. New public type `ComposeSpawnInput` / `SpawnPayload` wraps them. |
| `CACHE` / `resetSpawnPromptCache` / `loadCleoInjection` / `loadSkillExcerpt` / `loadSubagentProtocolBlock` | 183-277 | KEEP | Unchanged. |
| `buildHeader` (284) | 284-295 | MODIFY | Shorten — move Return Format contract up. |
| `buildTaskIdentity` (298) | 298-334 | MODIFY | Compress acceptance list to first 3 criteria + count; full list moves later. |
| `buildStageGuidance` (343) | 343-470 | KEEP | One of the strongest parts of T882. |
| `buildEvidenceGateBlock` (473) | 473-517 | KEEP | Unchanged. |
| `buildQualityGateBlock` (520) | 520-533 | KEEP | Unchanged. |
| `buildReturnFormatBlock` (536) | 536-574 | MOVE | Hoist output position — no content change. |
| `buildFilePathsBlock` (577) | 577-594 | KEEP | Unchanged. |
| `buildSessionBlock` (597) | 597-616 | KEEP | Unchanged. |
| `buildTier0ProtocolPointer` (619) | 619-627 | MODIFY | Take `hint` param; emit harness-aware pointer. |
| `buildTier1InjectionEmbed` (630) | 630-649 | MODIFY | Take `hint` param; collapse to pointer when `claude-code`. |
| `buildTier2SkillExcerpts` (652) | 652-682 | KEEP | Unchanged (skills are NOT auto-loaded by Claude Code). |
| `buildAntiPatternBlock` (685) | 685-697 | KEEP | Unchanged. |
| `buildSpawnPrompt` (713) | 713-792 | REFACTOR | Renamed `assemblePrompt`, made internal; called by new `composeSpawnPayload`. |
| `resolvePromptTokens` (803) | 803-832 | KEEP | Exported; tests preserved. |
| `slugify` (838) | 838-846 | KEEP | Exported under both names. |

**Net LOC impact**: T882 loses ~50 lines (section hoisting + hint params) and gains a new 150-line sibling `spawn.ts` with the public `composeSpawnPayload` API. Net +100 LOC in `core/orchestration/`, -365 LOC from `cant/composer.ts` deletion, -50 LOC from `cant/tests/composer*.test.ts` deletion — **net -315 LOC** across the epic.

### 2.2 Every current caller of T882

```
packages/core/src/orchestration/index.ts
   line 13: imports buildSpawnPrompt, DEFAULT_SPAWN_TIER, SpawnProtocolPhase, SpawnTier
   line 256: prepareSpawn() calls buildSpawnPrompt() — delegates, returns SpawnContext

packages/cleo/src/dispatch/engines/orchestrate-engine.ts
   line 42: imports prepareSpawn from @cleocode/core/internal (which transitively re-exports buildSpawnPrompt)
   line 538: orchestrateSpawnExecute → prepareSpawn(...) → buildSpawnPrompt
   line 738: orchestrateSpawn → prepareSpawn(...) → buildSpawnPrompt

packages/core/src/orchestration/__tests__/spawn-prompt.test.ts
   line 15: imports buildSpawnPrompt, DEFAULT_SPAWN_TIER, ALL_SPAWN_PROTOCOL_PHASES, resetSpawnPromptCache, resolvePromptTokens
   (14 describe blocks, ~100 assertions — all preserved under new internal API via a thin test-shim)
```

**Migration plan**: the `prepareSpawn` call sites (2 in `orchestrate-engine.ts`) migrate to `composeSpawnPayload`. The returned `SpawnPayload` is a superset of the old `SpawnContext` — `.prompt`, `.taskId`, `.protocol`, `.tokenResolution` are all present. Existing destructuring code keeps working. `prepareSpawn` itself becomes a deprecated wrapper that internally calls `composeSpawnPayload` and downcasts to `SpawnContext`.

### 2.3 Gap between `composer.ts` and T882

| Concept | T882 (`spawn-prompt.ts`) | `cant/composer.ts` | Resolution |
|---------|--------------------------|--------------------|------------|
| Tier vocabulary | `0 \| 1 \| 2` | `'low' \| 'mid' \| 'high'` | Delete composer. |
| Token budgets | Implicit (via section selection) | Explicit caps per tier | Migrate `TIER_CAPS` into `core/orchestration/spawn.ts`, KEEP. |
| Model selection | Not handled (delegated to adapter) | `TIER_MODELS` per tier | Migrate `TIER_MODELS` into `core/orchestration/spawn.ts`, KEEP. Map 0→'haiku', 1→'sonnet', 2→'opus' consistently. |
| Context injection | CLEO-INJECTION + skill excerpts embedded in prompt | `ContextProvider.queryContext()` pulls from BRAIN | Delete composer's provider path; CANT enrichment stays in `adapters/cant-context.ts` where it already lives (`buildCantEnrichedPrompt`). |
| Mental model | Not in T882; handled in `adapters/cant-context.ts` | `ContextProvider.loadMentalModel()` | Keep adapter-side implementation (already wired). Delete composer's. |
| Escalation | None | `while (overflow) escalateTier()` | Migrate to `core/orchestration/spawn.ts`. |
| Validation prefix | None | `MENTAL_MODEL_VALIDATION_PREFIX` const | Already duplicated as `VALIDATE_ON_LOAD_PREAMBLE` in `adapters/cant-context.ts`. Delete composer's. |

**Summary**: composer.ts has been effectively superseded by `buildSpawnPrompt` + `buildCantEnrichedPrompt`. It was never wired in despite the header comment claim. DELETE.

---

## 3. Atomic worker tasks (8 workers)

Decomposing T890 / T892 / T893 / T894 / T895 / T896 into ≤3-file workers. Each is sized to 1 ct-task-executor session (<4h wallclock). Dependencies form 2 waves.

### Wave A (parallel; no inter-dependencies)

**W3-1 — Canonical `composeSpawnPayload` API + types** (T890 core, T892 core)
- Files (exactly 3):
  - `packages/core/src/orchestration/spawn.ts` (NEW)
  - `packages/core/src/orchestration/index.ts` (add export)
  - `packages/contracts/src/orchestration/spawn-payload.ts` (NEW — `SpawnPayload`, `ComposeSpawnInput`, `HarnessContextHint`, `AgentContract`)
- Size: medium
- Depends on: Lead 1 AgentContract type (stub allowed; resolved later)
- AC: `composeSpawnPayload()` compiles, returns correct meta-shape; unit tests cover role+tier auto-select matrix (all 7 rules).

**W3-2 — Harness hint resolver + `.cleo/harness-profile.json`** (T893 core)
- Files (exactly 3):
  - `packages/core/src/orchestration/harness-hint.ts` (NEW)
  - `packages/core/src/orchestration/__tests__/harness-hint.test.ts` (NEW)
  - `packages/cleo/src/cli/commands/init.ts` (modify — write harness-profile.json on `cleo init` when `CLAUDECODE=1` detected)
- Size: small
- Depends on: none
- AC: 5-source resolver (arg → env → file → runtime → default); unit tests for all 5 paths; `cleo init` writes the file idempotently.

**W3-3 — Atomicity gate `checkAtomicity`** (T894)
- Files (exactly 3):
  - `packages/core/src/orchestration/atomicity.ts` (NEW)
  - `packages/core/src/orchestration/__tests__/atomicity.test.ts` (NEW)
  - `packages/contracts/src/orchestration/atomicity.ts` (NEW — error codes + types)
- Size: small
- Depends on: Lead 1 AC.files schema in CANT v3 (stub with `task.metadata.files` during Wave A)
- AC: Worker with 0 files fails; worker with >3 files fails; lead/orchestrator always pass; `CLEO_WORKER_MAX_FILES` env override works.

**W3-4 — Hoist Task + Return Format to first 500 chars** (T895)
- Files (exactly 2):
  - `packages/core/src/orchestration/spawn-prompt.ts` (modify — reorder section assembly in `buildSpawnPrompt`)
  - `packages/core/src/orchestration/__tests__/spawn-prompt.test.ts` (add new assertions on prompt.slice(0, 500))
- Size: small
- Depends on: none
- AC: `prompt.slice(0, 500)` contains Task ID, title, and all three Return Format strings; all existing snapshot tests updated.

**W3-5 — Delete `cant/composer.ts` + migrate TIER_MODELS** (cleanup)
- Files (exactly 3):
  - `packages/cant/src/composer.ts` (DELETE)
  - `packages/cant/src/index.ts` (remove composer re-exports)
  - `packages/cant/tests/composer.test.ts` + `composer-wiring.test.ts` (DELETE both via directive)
- Also creates: migrated constants live in W3-1's `spawn.ts` (TIER_MODELS, estimateTokens, escalateTier)
- Size: small
- Depends on: **W3-1 landed** (TIER_MODELS relocated before delete)
- AC: `pnpm --filter @cleocode/cant build` green; nothing imports composer; 3 tests deleted cleanly.

### Wave B (after Wave A)

**W3-6 — `cleo orchestrate plan <epicId>` command + engine** (T890)
- Files (exactly 3):
  - `packages/cleo/src/cli/commands/orchestrate.ts` (modify — add `planCommand` subcommand)
  - `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (add `orchestratePlan` function — loops `composeSpawnPayload` over children, emits SpawnPlan LAFS envelope)
  - `packages/cleo/src/dispatch/domains/orchestrate.ts` (register `orchestrate.plan` op)
- Size: medium
- Depends on: W3-1 (composeSpawnPayload), W3-3 (atomicity precheck)
- AC: `cleo orchestrate plan T889` returns a 4-wave plan; atomicity violations reported; `--tier` override honored; plan is idempotent (same hash).

**W3-7 — Integrate `composeSpawnPayload` into `orchestrate spawn` + dedup wiring** (T892 + T893 final)
- Files (exactly 3):
  - `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (modify — `orchestrateSpawn` and `orchestrateSpawnExecute` switch from `prepareSpawn` to `composeSpawnPayload`)
  - `packages/core/src/orchestration/index.ts` (deprecate `prepareSpawn` as alias; keep exports)
  - `packages/core/src/orchestration/__tests__/spawn.test.ts` (NEW — integration test: 3 personas × 3 hints × 3 tiers = 27 snapshot assertions)
- Size: medium
- Depends on: W3-1, W3-2, W3-4
- AC: `cleo orchestrate spawn T### --tier 1` under `CLEO_HARNESS=claude-code` produces ~9 KB smaller prompt than `--hint generic`; `metrics.dedupSavedChars > 8000`; all 7 adapter providers still receive a valid string prompt.

**W3-8 — Architecture doc + Mermaid diagram** (T896)
- Files (exactly 2):
  - `docs/architecture/orchestration-flow.md` (NEW — 8-layer model: CLI → engine → composer → tier-resolver → hint-resolver → atomicity-gate → assembler → adapter)
  - `docs/architecture/assets/orchestration-flow.mmd` (NEW — Mermaid source)
- Size: small
- Depends on: all of Wave A + B-6 + B-7 for accuracy
- AC: Mermaid renders in GitHub preview; doc lists every file touched across T889 epic; ADR-0xx reference included.

### Summary

| Wave | Workers | Parallel | Files touched (union) | Blocks |
|------|---------|----------|-----------------------|--------|
| A    | W3-1, W3-2, W3-3, W3-4, W3-5 | 5-way parallel | 13 files | Wave B |
| B    | W3-6, W3-7, W3-8 | 3-way parallel | 8 files | epic close |

Total workers: 8. Total files touched: 21 (13 new, 7 modified, 1 deleted). Meets owner's 8-12 target.

---

## 4. Migration plan (preserving backward compat)

### 4.1 Sequence

1. **W3-1, W3-2, W3-3, W3-4, W3-5 merge in parallel** (Wave A). None of them touch `orchestrateSpawn`'s call signature.
2. **W3-7 flips the `orchestrate-engine.ts` call sites** to `composeSpawnPayload`. At this point, `cleo orchestrate spawn T###` returns the **new SpawnPayload**, but the LAFS `data.prompt` field is preserved (same string content on `--hint generic`; smaller on `--hint claude-code`).
3. **W3-6 adds the new plan command**. Independent — no callsite changes required for existing commands.
4. **W3-8 doc** — final, no behavior change.

### 4.2 Existing subagents

- `packages/agents/cleo-subagent/AGENT.md` v2.0.0 says "spawn prompts are fully self-contained". This remains true at `hint=generic`. At `hint=claude-code`, the agent also has AGENTS.md auto-loaded by the harness — so the protocol is still accessible, just via a different path. AGENT.md gets a **v2.1.0 note** describing the dedup behavior (in scope for W3-8 doc work, not a separate worker).
- `cleo-subagent.cant` — no change needed; tier is already declared as 0 there, which matches the default worker tier from the new auto-selector.

### 4.3 Tests to preserve (DO NOT break)

`packages/core/src/orchestration/__tests__/spawn-prompt.test.ts` — 309 lines, ~100 assertions. **All preserved**. Each `describe` block keeps functioning because:
- `buildSpawnPrompt` export stays (now implemented via `assemblePrompt` under the hood).
- Section markers tested are all unchanged (`## Task Identity`, `## Evidence-Based Gate Ritual`, etc.).
- Tier assertions (tier 0 pointer, tier 1 embed, tier 2 skill excerpts) pass — new `hint` param defaults to `'generic'` which preserves today's behavior byte-for-byte.

**New tests added** (in W3-7):
- `spawn.test.ts` — integration matrix, 27 snapshot assertions (3 personas × 3 hints × 3 tiers).
- Each snapshot is committed to git; Lead 5 (T918) reviews them.

### 4.4 Rollback plan

If W3-7 introduces a regression post-merge:
- Revert `orchestrate-engine.ts` changes (one commit). `prepareSpawn` path resumes operation.
- W3-1/W3-2/W3-3/W3-4 stay landed — they're additive. W3-5 (composer delete) stays — it was always orphaned.
- Re-attempt W3-7 with additional tests covering the missed case.

### 4.5 Feature flag (optional, low cost)

Add `CLEO_LEGACY_SPAWN=1` env var (defaults off). When set, `orchestrate-engine.ts` keeps using `prepareSpawn` directly. Grants a one-release escape hatch. Removed in v2026.5.1.

---

## 5. Cross-lead dependencies

### 5.1 Lead 1 (CANT DSL v3)

- **Required**: `AgentContract` type (the "contract" field in `SpawnPayload`). Minimum surface: `{ role, constraints: string[], tools: string[], personas: string[] }`.
- **Required**: `AC.files` field on `AcceptanceGate`. Worker spawn uses this for atomicity (W3-3).
- **Provides to Lead 3**: typed personas (`cleo-subagent`, `cleo-research-lead`, …). Used by `resolveTierAndRole` to map role → default persona.
- **Owner of**: the canonical `.cant` schema. Lead 3 does **not** touch `.cant` parsing.
- **Coupling**: Low — we stub `AgentContract` during Wave A (`type AgentContract = unknown`) and type-narrow once Lead 1 lands.

### 5.2 Lead 2 (Registry)

- **Required**: `registry.resolveAgent(role, persona?) → { agentId, personaKind, tools, model?, fallbackModels? }`.
- **Timing**: W3-1 calls `registry.resolveAgent` inline. If Lead 2 isn't ready, we stub with a static map (`worker → 'cleo-subagent'`, `lead → 'cleo-research-lead'`, `orchestrator → 'cleo-prime'`) and swap at integration time.
- **Coupling**: Medium — `agentId` is surfaced in `SpawnPayload.agentId`. Contract is the return shape only.

### 5.3 Lead 4 (Skill bundle composer)

- **Required**: `skillComposer.composeBundle(role, persona, tier) → { skills: string[], embeddedRefs?: string[] }`.
- **Timing**: W3-1 surfaces `SpawnPayload.skills`. Tier 2 section builder (`buildTier2SkillExcerpts`) consumes `embeddedRefs` to inline SKILL.md content. Today this is hardcoded to `ct-cleo` + `ct-orchestrator`; with Lead 4 it becomes per-persona dynamic.
- **Location**: new `packages/core/src/orchestration/skill-composer.ts` per Lead 4 scope.
- **Coupling**: Medium — Lead 3 provides the integration point; Lead 4 provides the selection logic.

### 5.4 Lead 5 (Test strategy)

- **Dependency from Lead 5 → Lead 3**: the 27-snapshot matrix in `spawn.test.ts` (W3-7). Lead 5 reviews snapshots for protocol drift and approves per release.
- **Dependency from Lead 3 → Lead 5**: Lead 5's test harness helpers (`mockRegistry`, `mockSkillComposer`) to support W3-1/W3-7 integration tests without stubbing by hand.
- **Coupling**: Low — shared test fixtures in `packages/core/src/orchestration/__tests__/_fixtures/` directory (added in W3-1).

---

## 6. Top 3 risks + mitigations

### Risk 1: Snapshot churn explodes PR size

**Probability**: High. 27 snapshots × protocol phase variations means hundreds of lines per snapshot file. One typo in a section builder → every snapshot changes → reviewer fatigue.

**Mitigation**:
1. Split snapshots per tier × hint (9 files total, not one mega-snapshot).
2. Canonicalize whitespace + timestamps in pre-assertion normalizer so clock drift doesn't cause diffs.
3. Use **shape-based assertions** (like the existing `spawn-prompt.test.ts` does — `expect(p).toContain('## Task Identity')`) for the content; use snapshots only for the 500-char hoist-check and overall section-ordering.
4. Lead 5 reviews snapshot diffs in a dedicated commit separate from logic commits.

### Risk 2: Harness auto-detection false-positive outside Claude Code

**Probability**: Medium. `CLAUDECODE=1` env var *could* leak through parent shells (e.g., user exports it globally). A false `claude-code` hint on a non-Claude harness would omit the CLEO-INJECTION embed, leaving a subagent without protocol context.

**Mitigation**:
1. Auto-detection requires **both** `CLAUDECODE=1` **and** `CLAUDE_CODE_ENTRYPOINT` (two signals Claude Code CLI always sets together).
2. `.cleo/harness-profile.json` persists once per repo, eliminating re-detection races.
3. Even on false `claude-code`, the prompt still contains a protocol pointer ("See `~/.cleo/templates/CLEO-INJECTION.md`") so the subagent is directed to the file — not left blind.
4. `SpawnPayload.metrics.dedupSavedChars` is observable; regression tests assert it's 0 when `hint` is explicitly `generic`.
5. Document in CLAUDE.md: "If you ship via a non-Claude harness, set `CLEO_HARNESS=generic` explicitly."

### Risk 3: Deleting `cant/composer.ts` breaks a hidden consumer

**Probability**: Low-Medium. Grep shows only `cant/tests/*.test.ts` and `cant/src/index.ts` import it, but the `@cleocode/cant` package is published on npm — external consumers could import `composeSpawnPayload` from `@cleocode/cant`.

**Mitigation**:
1. Re-export a **deprecated shim** from `@cleocode/cant/composer`: a `composeSpawnPayload` stub that throws `Error("moved to @cleocode/core/orchestration — see CHANGELOG v2026.5.0")` with the migration URL. Keeps the import surface; makes misuse loud.
2. Ship the delete in a minor version bump (v2026.5.0, not a patch) with CHANGELOG entry "BREAKING: removed `@cleocode/cant` composer; use `composeSpawnPayload` from `@cleocode/core/orchestration`".
3. Before delete, grep the public npm registry (`npm search @cleocode/cant` consumers) for any known dependent — if zero, ship straight; if any, open an issue with ping.
4. Owner override: if a dependent is discovered post-ship, revert W3-5 (composer delete only) — `spawn.ts` migration stays since it's additive in core.

---

## Appendix A — 8-layer flow (for T896 Mermaid doc)

```
Layer 1: CLI          (cleo orchestrate spawn T123 --tier 1)
   ↓
Layer 2: dispatch     (packages/cleo/src/dispatch/adapters/cli.ts)
   ↓
Layer 3: engine       (orchestrateSpawn in orchestrate-engine.ts)
   ↓
Layer 4: composer     (composeSpawnPayload in core/orchestration/spawn.ts)
   ├─→ hint-resolver  (CLEO_HARNESS + env + harness-profile + runtime)
   ├─→ tier-resolver  (role × size × labels → tier)
   ├─→ atomicity-gate (role === worker → check AC.files)
   ├─→ registry       (Lead 2: resolveAgent)
   ├─→ skill-composer (Lead 4: composeBundle)
   ↓
Layer 5: assembler    (assemblePrompt in spawn-prompt.ts — section builders)
   ↓
Layer 6: SpawnPayload (meta-return with prompt + metadata)
   ↓
Layer 7: adapter      (packages/adapters/src/providers/<vendor>/spawn.ts)
   │    └─→ buildCantEnrichedPrompt (appends CANT bundle + memory bridge + mental model + NEXUS)
   ↓
Layer 8: subagent process (spawned by adapter)
```

## Appendix B — files touched by epic T889

**New (13)**:
1. `packages/core/src/orchestration/spawn.ts`
2. `packages/core/src/orchestration/harness-hint.ts`
3. `packages/core/src/orchestration/atomicity.ts`
4. `packages/core/src/orchestration/template-resolver.ts`
5. `packages/core/src/orchestration/__tests__/spawn.test.ts`
6. `packages/core/src/orchestration/__tests__/harness-hint.test.ts`
7. `packages/core/src/orchestration/__tests__/atomicity.test.ts`
8. `packages/core/src/orchestration/__tests__/_fixtures/` (dir)
9. `packages/contracts/src/orchestration/spawn-payload.ts`
10. `packages/contracts/src/orchestration/atomicity.ts`
11. `docs/architecture/orchestration-flow.md`
12. `docs/architecture/assets/orchestration-flow.mmd`
13. `.cleo/harness-profile.json` (per-repo, written by `cleo init`)

**Modified (7)**:
1. `packages/core/src/orchestration/spawn-prompt.ts` (hoist + hint-aware tier embeds)
2. `packages/core/src/orchestration/index.ts` (new exports)
3. `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (switch to composeSpawnPayload, add orchestratePlan)
4. `packages/cleo/src/cli/commands/orchestrate.ts` (add plan subcommand)
5. `packages/cleo/src/dispatch/domains/orchestrate.ts` (register `orchestrate.plan` op)
6. `packages/cleo/src/cli/commands/init.ts` (write harness-profile.json)
7. `packages/cant/src/index.ts` (remove composer re-exports)

**Deleted (3)**:
1. `packages/cant/src/composer.ts`
2. `packages/cant/tests/composer.test.ts`
3. `packages/cant/tests/composer-wiring.test.ts`
