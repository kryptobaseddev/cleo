# Lead 1 — Foundation Architecture
## T889 Orchestration Coherence v3 | Research Phase
**Date**: 2026-04-17 | **Scope**: T903 (CANT DSL v3 types), T905 (seed-agent SSoT), T891 (persona wiring)

---

## 1. CURRENT-STATE FINDINGS

### 1.1 Type Gap
- `packages/cant/src/types.ts` TODAY exports ONLY `ParsedCANTMessage` + `DirectiveType` (chat message DSL)
- Agent DSL fields (`kind: agent`, `skills[]`, `permissions`, `transport`, `lifecycle`, `on Event`, `enforcement`, `context_sources`, `mental_model`, `tier`) are PARSED by Rust `cantParseDocumentNative` but NEVER TYPED
- `packages/cant/src/composer.ts` has hand-authored `AgentDefinition` (line 174-223) and `PathPermissions` (line 150-171) — but these were never derived from real .cant AST
- `packages/cant/src/bundle.ts:extractAgents()` (line 234-265) walks AST via `Record<string, unknown>` with `simplifyValue()`. `AgentEntry.properties` fully untyped
- `composeSpawnPayload()` is never called from `cleo orchestrate spawn` — the entire composer stack is dead code relative to spawn

**Data flow gap:**
```
.cant file → cantParseDocumentNative [opaque Rust AST]
          → extractAgents() → AgentEntry.properties [Record<string, unknown>]
          → (NOTHING) → composeSpawnPayload [hand-typed, unreachable]
```

### 1.2 .cant File Inventory (28 files)
Canonical source **packages/agents/seed-agents/** (6 files) already referenced by `packages/cant/tests/agent-fixtures.test.ts:31` as SSoT.

| File | Source | TODO stubs | Decision |
|------|--------|-----------|----------|
| cleo-prime.cant | packages/agents/seed-agents/ | 3 | CANONICAL (fix stubs in W1-5) |
| cleo-dev, cleo-historian, cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator | packages/agents/seed-agents/ | 0 | CANONICAL |
| (same 6 + cleo-subagent) | packages/cleo-os/seed-agents/ | 0-3 | DELETE 6 duplicates; MIGRATE cleo-subagent to canonical |
| cleo-orchestrator, dev-lead, code-worker, docs-worker | packages/cleo-os/starter-bundle/agents/ | 0 | KEEP as separate installable bundle — DIFFERENT hierarchy, v3 exemplars with `context_sources` + `mental_model` |
| (6 legacy + 4 starter variants) | .cleo/agents/ + .cleo/cant/agents/ | stale | RUNTIME SCAFFOLD COPIES — never sources |

### 1.3 Starter-bundle Files Are v3 Exemplars
`code-worker.cant`, `dev-lead.cant`, `cleo-orchestrator.cant`, `docs-worker.cant` already use `context_sources:`, `mental_model:`, `consult-when:`, `tier:`, `workers:`, `stages:` — all fields that need formal types. These are the v3 reference implementation.

---

## 2. FINAL-STATE ARCHITECTURE

### 2.1 Proposed Types (packages/cant/src/types.ts additions)

```typescript
export interface CantContractClause {
  text: string;
  enforcement?: 'hard' | 'soft';  // defaults to 'soft'
}
export interface CantContractBlock {
  requires: CantContractClause[];  // default []
  ensures: CantContractClause[];   // default []
}
export interface CantMentalModelRef {
  scope: 'project' | 'global';
  maxTokens: number;
  validateOnLoad: boolean;
}
export interface CantContextSourceDef {
  source: string;
  query: string;
  maxEntries: number;
}
export type CantOverflowStrategy = 'escalate_tier' | 'fail';

export interface CantAgentV3 {
  name: string;
  sourcePath: string;
  version: string;
  // Core (v1/v2/v3)
  role: string;
  description: string;
  prompt: string;  // TODO-stubs rejected at CI gate
  skills: string[];
  permissions: Record<string, string>;
  model?: string;
  persist?: boolean | string;
  parent?: string;
  filePermissions?: PathPermissions;
  // v3-only (defaults for v1/v2)
  tier: 'low' | 'mid' | 'high';  // default 'mid'
  contextSources: CantContextSourceDef[];  // default []
  onOverflow: CantOverflowStrategy;  // default 'escalate_tier'
  mentalModelRef: CantMentalModelRef | null;  // default null
  contracts: CantContractBlock;  // default { requires:[], ensures:[] }
  consultWhen?: string;
  workers?: string[];
  stages?: string[];
  tools?: Record<string, string[]>;
}

export function isCantAgentV3(x: unknown): x is CantAgentV3;
```

### 2.2 requires/ensures Parse Strategy
**Decision: parse from AST properties as arrays of OpenProse strings, NO inline Zod/JSON Schema.**
Rationale: Rust `cant-core` parser handles YAML-like blocks as `ProseBlock { lines: string[] }`. Adding `contracts: { requires: [], ensures: [] }` is purely additive. Validation = non-empty string, no TODO placeholder. Enforcement defaults to 'soft'.

### 2.3 mental_model Resolution
Maps to `AgentDefinition.mentalModel` in composer.ts via `toCantAgentV3ToAgentDefinition()` adapter. Does NOT call BRAIN directly — produces config block that `composeSpawnPayload` receives.

### 2.4 Canonical Seed-Agent Decision
**SSoT = packages/agents/seed-agents/** — confirmed by existing test guard.
- DELETE: `packages/cleo-os/seed-agents/` (all 7 files; migrate cleo-subagent.cant to canonical)
- KEEP: `packages/cleo-os/starter-bundle/agents/` (separate installable, v3 reference)
- EPHEMERAL: `.cleo/agents/` and `.cleo/cant/agents/` (scaffold outputs, never sources)
- DEPRECATE: cleoos-opus-orchestrator (add `deprecated: true`, `supersededBy: cleo-prime`, alias in resolveAgent)

### 2.5 resolveAgent() API
```typescript
// packages/cant/src/agent-resolver.ts (NEW ~200 lines)
export async function resolveAgent(
  agentId: string,
  options?: { projectRoot?: string; tierPref?: Tier; skipAliasCheck?: boolean }
): Promise<ResolvedAgent>;

export interface ResolvedAgent {
  agentId: string;
  cantPath: string;
  typedAgent: CantAgentV3;
  agentDefinition: AgentDefinition;
  aliasApplied: boolean;
  aliasTarget?: string;
}

const DEPRECATED_ALIASES: Record<string, string> = {
  'cleoos-opus-orchestrator': 'cleo-prime',
};
```

Resolution order: DEPRECATED_ALIASES remap → seed-agents dir → .cleo/cant/agents/ → throw AgentNotFoundError.

### 2.6 T891 Wiring Chain
```
classify(task)  [dispatch/domains/orchestrate.ts]
  → { agentId, confidence }
resolveAgent(agentId)  [packages/cant/src/agent-resolver.ts — NEW]
  → { typedAgent, agentDefinition, cantPath }
composeSpawnPayload(agentDefinition, brainCtx, projectHash)  [composer.ts — EXISTS, wire only]
  → { systemPrompt, model, skills, tools, ... }
buildSpawnPrompt(task, agentDef, ...)  [spawn-prompt.ts T882 — outer wrapper]
  → merged prompt string
```

---

## 3. ATOMIC WORKER TASKS

| ID | Title | Files | Size | Blocks |
|----|-------|-------|------|--------|
| W1-1 | Add v3 type definitions to types.ts | packages/cant/src/types.ts + index.ts | medium | W1-2, W1-3, W1-5, W1-6, W1-7 |
| W1-2 | Add toCantAgentV3() mapper + TypedAgentEntry in bundle.ts | packages/cant/src/bundle.ts | medium | W1-3, W1-4, W1-7 |
| W1-3 | Real-file parse tests (v3 shape + v1 backward compat) | packages/cant/tests/agent-fixtures.test.ts | small | — |
| W1-4 | TODO-stub linter S-TODO-001 at error severity | packages/cant/src/bundle.ts | small | W1-5 |
| W1-5 | Migrate cleo-subagent + deprecate cleoos-opus + delete duplicates | packages/agents/seed-agents/ (+1 add +1 edit); packages/cleo-os/seed-agents/ (del 7) | small | W1-6 |
| W1-6 | Update agent-fixtures test for 7-file canonical set | packages/cant/tests/agent-fixtures.test.ts | small | — |
| W1-7 | Create packages/cant/src/agent-resolver.ts | packages/cant/src/agent-resolver.ts (NEW), index.ts | large | W1-8 |
| W1-8 | Export resolveAgentForSpawn bridge | packages/core/src/orchestration/index.ts | small | Lead 3 |

**Critical path:** W1-1 → W1-2 → W1-7 → W1-8 (unblocks Lead 3). W1-3/4/5/6 are parallel quality gates.

---

## 4. CROSS-LEAD DEPENDENCIES
- **Lead 2**: must confirm agent registry IDs match `.cant` filenames (hyphen, no extension); must NOT register cleoos-opus-orchestrator
- **Lead 3**: consumes ResolvedAgent (W1-7) + resolveAgentForSpawn (W1-8); buildSpawnPrompt (T882 outer) merges with composeSpawnPayload (inner), not replaces
- **Lead 4**: confirms skill IDs in `.cant` files match catalog IDs

---

## 5. MIGRATION PLAN (backward compat)
v1/v2 files missing v3 fields get defaults:
- tier='mid', contextSources=[], onOverflow='escalate_tier', mentalModelRef=null, contracts.requires=[], contracts.ensures=[]

TODO stubs in cleo-prime.cant MUST be filled during W1-5 (content: prime orchestrator persona per MEMORY.md).

---

## 6. TOP 3 RISKS
1. **Rust AST shape drift breaks toCantAgentV3 silently** — mitigation: W1-3 parses real files asserting shape; warn on unknown wrapper types
2. **context_sources has 2 syntaxes (dict in starter-bundle vs list in .cleo/cant/)** — mitigation: W1-2 explicitly handles both, W1-3 tests both
3. **TODO stubs reach production if linter is warning not error** — mitigation: W1-4 at error severity, stub fill in W1-5 same PR
