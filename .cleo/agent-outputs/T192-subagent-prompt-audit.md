# T192: Subagent Prompt Pipeline — Component Inventory

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

The current subagent prompt pipeline is a 4-component system that composes agent prompts from markdown templates, token injection, protocol base, and task context. The pipeline is functional and well-structured but entirely markdown-based with string-template token resolution.

---

## Component Inventory

### Component 1: AGENT.md (Agent Definition)

**File**: `packages/agents/cleo-subagent/AGENT.md`
**Purpose**: Defines the cleo-subagent identity, model, allowed tools, and base protocol.
**Format**: YAML frontmatter + markdown body
**Key sections**:
- Frontmatter: `name`, `description`, `model`, `allowed_tools` (32 tools listed)
- Body: Immutable constraints (BASE-001..008), 10 canonical domains, CQRS gateways, LAFS envelope, progressive disclosure tiers, lifecycle protocol, memory protocol, token reference, error handling, anti-patterns

**Token usage**: `{{TASK_ID}}`, `{{DATE}}`, `{{TOPIC_SLUG}}`, `{{EPIC_ID}}`, `{{OUTPUT_DIR}}`

**Size**: ~305 lines, ~8,000 tokens estimated

---

### Component 2: subagent-protocol-base.md (Protocol Template)

**File**: `packages/skills/skills/_shared/subagent-protocol-base.md`
**Purpose**: RFC 2119 protocol for subagent output and handoff. Injected into every subagent spawn.
**Format**: Pure markdown with token placeholders
**Key sections**:
- Output Requirements (OUT-001..004)
- Output File Format template
- Manifest Entry Format (references manifest-operations.md)
- Task Lifecycle Integration (LOOM/RCASD-IVTR+C)
- Research Linking
- Completion Checklist
- Token Reference (required + optional + task system tokens)

**Token usage**: `{{OUTPUT_DIR}}`, `{{DATE}}`, `{{TOPIC_SLUG}}`, `{{MANIFEST_PATH}}`, `{{TASK_ID}}`, `{{EPIC_ID}}`, `{{SESSION_ID}}`, task command tokens

**Size**: ~227 lines, ~5,000 tokens estimated

---

### Component 3: placeholders.json (Token Registry)

**File**: `packages/skills/skills/_shared/placeholders.json`
**Purpose**: Canonical registry of ALL template placeholders. Schema-validated, typed, with patterns and defaults.
**Format**: JSON with `$schema` reference
**Key sections**:
- `required`: 3 tokens (TASK_ID, DATE, TOPIC_SLUG)
- `context`: 6 tokens (EPIC_ID, SESSION_ID, RESEARCH_ID, TITLE, OUTPUT_DIR, MANIFEST_PATH)
- `taskCommands`: 15 command tokens (TASK_SHOW_CMD, TASK_START_CMD, etc.)
- `manifest`: 8 manifest entry tokens
- `taskContext`: 10 task-specific tokens populated from CLEO task data
- `skillSpecific`: per-skill tokens (epicArchitect, validator, taskExecutor)
- `conventions`: naming and validation rules

**Token count**: 42 unique tokens across all categories

**Size**: ~434 lines

---

### Component 4: subagent.ts (Injection Engine)

**File**: `packages/core/src/skills/injection/subagent.ts`
**Purpose**: TypeScript injection engine that composes the final prompt from all components.
**Format**: TypeScript module with exported functions
**Key functions**:
- `loadProtocolBase()` — Reads subagent-protocol-base.md from disk
- `buildTaskContext(taskId)` — Loads task from DB, builds context block
- `filterProtocolByTier(content, tier)` — MVI progressive disclosure (tier 0/1/2)
- `injectProtocol(skillContent, taskId, tokenValues)` — Main composition function
- `orchestratorSpawnSkill(taskId, skillName, tokenValues)` — Full spawn workflow
- `prepareTokenValues(taskId, topicSlug, epicId)` — Builds token value map

**Composition order**:
```
[Resolved Skill Content]
---
## SUBAGENT PROTOCOL (RFC 2119)
[Protocol base with tokens resolved, tier-filtered]
---
## Task Context
[Task details from CLEO DB]
```

**Dependencies**: `token.js` (token injection), `discovery.js` (skill finder), `data-accessor.js` (DB access)

---

### Supporting Component: token.ts (Token Resolver)

**File**: `packages/core/src/skills/injection/token.ts`
**Purpose**: String-template token resolution (`{{TOKEN}} → value`)
**Pattern**: Simple regex-based `{{TOKEN_NAME}}` replacement

---

### Supporting Component: .cant Persona Files

**Directory**: `.cleo/agents/*.cant`
**Count**: 8 files in cleocode repo (all 9 agents covered with signaldock-frontend in separate repo)
**Purpose**: Structured agent identity definitions in CANT grammar
**Current integration with prompt pipeline**: NONE — .cant files exist alongside .md persona files but are NOT consumed by the subagent injection engine

**Gap**: The subagent.ts injection engine reads only markdown skill files and subagent-protocol-base.md. It does not read or parse .cant files. The CANT persona definitions are currently metadata-only with no runtime integration.

---

## Pipeline Flow

```
Orchestrator (ct-orchestrator skill)
  └── orchestratorSpawnSkill(taskId, skillName, tokens)
        ├── findSkill(name) → loads SKILL.md content
        ├── loadProtocolBase() → reads subagent-protocol-base.md
        ├── buildTaskContext(taskId) → queries CLEO DB
        ├── filterProtocolByTier(content, tier) → MVI filtering
        ├── injectTokens(content, tokenValues) → resolves {{placeholders}}
        └── Returns composed prompt string
              ↓
        Agent Tool (Claude Code) receives prompt as instruction
```

---

## Key Findings for T191

1. **The pipeline is entirely markdown + string templates.** No parsing, no validation, no static analysis. Tokens that don't resolve silently pass through as `{{UNRESOLVED}}`.

2. **.cant files are disconnected.** They define agent identity but are not consumed by the spawn pipeline. The pipeline uses AGENT.md (markdown) and skill SKILL.md files.

3. **42 tokens with no compile-time checking.** placeholders.json defines the schema but the runtime injection is pure string replacement. Typos in token names are invisible.

4. **MVI tier filtering exists but is marker-based.** Uses HTML comments (`<!-- TIER:minimal -->`) in markdown. Works but is fragile and invisible to standard markdown renderers.

5. **Protocol base duplicates AGENT.md content.** Both files describe the 10 domains, CQRS gateways, LAFS envelope. The subagent receives both, leading to redundancy (~3,000 tokens of overlap).

6. **No import/composition model.** Skills are loaded as flat files. No mechanism to compose a skill from reusable fragments or inherit from a base definition.

---

## Recommendations for CANT Integration (T193-T200)

| Area | Current (Markdown) | CANT Could Provide |
|------|--------------------|--------------------|
| Token resolution | String replacement, no validation | Typed properties with schema validation |
| Agent definition | AGENT.md frontmatter | Structured `agent` blocks with permissions, hooks |
| Protocol constraints | Inline markdown rules | RFC 2119 constraint syntax with validation |
| Skill composition | Flat file loading | Import model with tier-based visibility |
| Error detection | Silent pass-through | Static analysis at parse time |
| Redundancy | Manual dedup | Single source definitions with references |

---

## Linked Tasks

- Epic: T191
- Task: T192
- Related: T193 (Layer 2 syntax), T197 (prototype cleo-subagent.cant), T199 (token cost analysis)
