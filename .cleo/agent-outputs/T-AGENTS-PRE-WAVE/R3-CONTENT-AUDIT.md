# R3 Content Audit — Agent Files Classification & Proposed Tree Layout
**Task**: T1235 (pre-wave epic T1232)  
**Shipping**: v2026.4.110  
**Lead**: R3  
**Date**: 2026-04-21

---

## Executive Summary

Audit of all agent files across 4 locations reveals a **structural misalignment**:

- **`packages/agents/seed-agents/`** (currently ships as STARTER TEMPLATES) contains **5 project-specific personas** (cleo-prime, cleo-dev, cleo-historian, cleo-rust-lead, cleo-db-lead) that reference CleoCode/SignalDock/cleo-specific crates → **MUST MOVE OUT**.
- **`.cleo/cant/agents/`** contains **4 generic agents** (cleo-orchestrator, code-worker, dev-lead, docs-worker) that ARE the true templates → **SHOULD BECOME SEED-AGENTS**.
- **`.cleo/agents/`** is a **legacy dual state**: contains both TODOs (scaffold version of cleo-prime) AND full implementations (companion .md files) → **DEPRECATE & CONSOLIDATE**.
- **`packages/agents/cleo-subagent/`** is **UNIVERSAL** — the base protocol → **PROMOTE TO TOP-LEVEL**.

### Classification Summary

| Category | Count | Examples |
|----------|-------|----------|
| GENERIC-TEMPLATE | 4 | cleo-orchestrator, code-worker, dev-lead, docs-worker |
| CLEO-PROJECT-SPECIFIC | 6 | cleo-prime, cleo-dev, cleo-historian, cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator |
| UNIVERSAL-PROTOCOL-BASE | 2 | cleo-subagent.cant (.cant + /AGENT.md harness adapter) |
| HARNESS-ADAPTER | 1 | packages/agents/cleo-subagent/AGENT.md |
| LEGACY-DEPRECATED | 7 | .cleo/agents/*.cant (TODOs, scaffolds) + .cleo/agents/*.md (bootstrap overrides) |

---

## Detailed File Classification

### A. Seed Agents Currently in `packages/agents/seed-agents/`

| File | Path | Classification | Reason | Action |
|------|------|-----------------|--------|--------|
| `cleo-prime.cant` | `packages/agents/seed-agents/cleo-prime.cant` | CLEO-PROJECT-SPECIFIC | References cleoos-opus-orchestrator parent, SignalDock API, cleo-specific tone ("Pushes back on ambiguity. Quotes evidence from BRAIN + codebase") | Move → `.cleo/agents/` |
| `cleo-dev.cant` | `packages/agents/seed-agents/cleo-dev.cant` | CLEO-PROJECT-SPECIFIC | Mentions "You are cleo-dev — the hands that turn specs into working code" + "cleo-core" parent role, CleoCode-specific workflows | Move → `.cleo/agents/` |
| `cleo-historian.cant` | `packages/agents/seed-agents/cleo-historian.cant` | CLEO-PROJECT-SPECIFIC | References "NEXUS realm", cleo-prime parent, "CLEO canon" enforcement, CLEO naming conventions, SignalDock API | Move → `.cleo/agents/` |
| `cleo-rust-lead.cant` | `packages/agents/seed-agents/cleo-rust-lead.cant` | CLEO-PROJECT-SPECIFIC | Explicitly mentions "cant-core (501 tests), cant-napi, cant-lsp, cant-runtime" — concrete CLEO crates | Move → `.cleo/agents/` |
| `cleo-db-lead.cant` | `packages/agents/seed-agents/cleo-db-lead.cant` | CLEO-PROJECT-SPECIFIC | Explicitly mentions "CleoCode and SignalDock ecosystems", projects: ["cleocode", "signaldock"], Drizzle/Diesel schema files | Move → `.cleo/agents/` |
| `cleoos-opus-orchestrator.cant` | `packages/agents/seed-agents/cleoos-opus-orchestrator.cant` | CLEO-PROJECT-SPECIFIC | Legacy orchestrator, deprecated: true, supersededBy: cleo-prime, references projects: ["cleocode", "signaldock", "llmtxt"] | Move → `.cleo/agents/` |
| `cleo-subagent.cant` | `packages/agents/seed-agents/cleo-subagent.cant` | UNIVERSAL-PROTOCOL-BASE | Pure protocol definition — identical copy of `packages/agents/cleo-subagent/cleo-subagent.cant` | Remove duplicate; keep only in `packages/agents/cleo-subagent/` |
| `README.md` | `packages/agents/seed-agents/README.md` | HARNESS-ADAPTER | Describes the 6 seed personas and their roles in CleoOS team | Update to reflect new generic template layout |

### B. Generic Agents in `.cleo/cant/agents/`

| File | Path | Classification | Reason | Action |
|------|------|-----------------|--------|--------|
| `cleo-orchestrator.cant` | `.cleo/cant/agents/cleo-orchestrator.cant` | GENERIC-TEMPLATE | No project-specific references; describes "Starter Orchestrator", generic task routing, no cleo-specific mentions | Copy → `packages/agents/seed-agents/orchestrator-generic.cant` |
| `dev-lead.cant` | `.cleo/cant/agents/dev-lead.cant` | GENERIC-TEMPLATE | No project-specific references; describes "Development Lead", generic decomposition, dispatcher pattern | Copy → `packages/agents/seed-agents/dev-lead-generic.cant` |
| `code-worker.cant` | `.cleo/cant/agents/code-worker.cant` | GENERIC-TEMPLATE | No project-specific references; describes "Code Worker", generic file globs, testing pattern | Copy → `packages/agents/seed-agents/code-worker-generic.cant` |
| `docs-worker.cant` | `.cleo/cant/agents/docs-worker.cant` | GENERIC-TEMPLATE | No project-specific references; describes "Docs Worker", generic markdown pattern | Copy → `packages/agents/seed-agents/docs-worker-generic.cant` |

### C. Base Protocol in `packages/agents/cleo-subagent/`

| File | Path | Classification | Reason | Action |
|------|------|-----------------|--------|--------|
| `cleo-subagent.cant` | `packages/agents/cleo-subagent/cleo-subagent.cant` | UNIVERSAL-PROTOCOL-BASE | Pure CANT agent protocol definition (version 1, not cleo-specific). T197 prototype for agent syntax. | Promote to `packages/agents/cleo-subagent.cant` (flatten dir) |
| `AGENT.md` | `packages/agents/cleo-subagent/AGENT.md` | HARNESS-ADAPTER | YAML frontmatter + markdown. Claude Code harness adapter for cleo-subagent protocol. | Promote to `packages/agents/harness-adapters/claude-code/cleo-subagent.AGENT.md` |

### D. Legacy in `.cleo/agents/`

| File | Path | Classification | Reason | Action |
|------|------|-----------------|--------|--------|
| `cleo-prime.cant` | `.cleo/agents/cleo-prime.cant` | LEGACY-DEPRECATED | Scaffold version with TODO placeholders ("TODO: Describe how this agent communicates", "TODO: Write the core behavioral instruction"). Superseded by `/mnt/projects/cleocode/packages/agents/seed-agents/cleo-prime.cant` which has full implementation. | **ALREADY PRESENT IN seed-agents** — delete this scaffold |
| `cleo-prime.boot.md` | `.cleo/agents/cleo-prime.boot.md` | CLEO-PROJECT-SPECIFIC | Bootstrap sequence for cleo-prime in CleoCode (SignalDock references, cleobot, signaldock.db) | Keep in `.cleo/agents/` as companion |
| `cleo-dev.cant` | `.cleo/agents/cleo-dev.cant` | CLEO-PROJECT-SPECIFIC | Full implementation (identical to `packages/agents/seed-agents/cleo-dev.cant`) | **ALREADY PRESENT IN seed-agents** — delete this; keep in seed-agents |
| `cleo-dev.md` | `.cleo/agents/cleo-dev.md` | CLEO-PROJECT-SPECIFIC | MVI-tiered bootstrap. Companion to .cant. References ClawMsgr, SignalDock. | Keep in `.cleo/agents/` as companion |
| `cleo-historian.cant` | `.cleo/agents/cleo-historian.cant` | CLEO-PROJECT-SPECIFIC | Full implementation (identical to seed-agents version) | **ALREADY PRESENT IN seed-agents** — delete this |
| `cleo-historian.md` | `.cleo/agents/cleo-historian.md` | CLEO-PROJECT-SPECIFIC | Companion bootstrap. | Keep in `.cleo/agents/` as companion |
| `cleo-rust-lead.cant` | `.cleo/agents/cleo-rust-lead.cant` | CLEO-PROJECT-SPECIFIC | Full implementation (identical to seed-agents) | **ALREADY PRESENT IN seed-agents** — delete this |
| `cleo-rust-lead.md` | `.cleo/agents/cleo-rust-lead.md` | CLEO-PROJECT-SPECIFIC | Companion bootstrap. | Keep in `.cleo/agents/` as companion |
| `cleo-db-lead.cant` | `.cleo/agents/cleo-db-lead.cant` | CLEO-PROJECT-SPECIFIC | Full implementation (identical to seed-agents) | **ALREADY PRESENT IN seed-agents** — delete this |
| `cleo-db-lead.md` | `.cleo/agents/cleo-db-lead.md` | CLEO-PROJECT-SPECIFIC | Companion bootstrap. | Keep in `.cleo/agents/` as companion |
| `cleoos-opus-orchestrator.cant` | `.cleo/agents/cleoos-opus-orchestrator.cant` | CLEO-PROJECT-SPECIFIC | Full implementation (identical to seed-agents) | **ALREADY PRESENT IN seed-agents** — delete this |
| `cleoos-opus-orchestrator.md` | `.cleo/agents/cleoos-opus-orchestrator.md` | CLEO-PROJECT-SPECIFIC | Companion bootstrap. | Keep in `.cleo/agents/` as companion |

### E. Starter Bundle Copy (Already Tracked)

| Location | Status |
|----------|--------|
| `packages/cleo-os/starter-bundle/agents/` | Mirrors `.cleo/cant/agents/` with slight YAML formatting differences. Consolidate into single source `.cleo/cant/agents/`. |

---

## Proposed Final Tree Layout

### 1. `packages/agents/` (Shipped to Users)

```
packages/agents/
├── package.json                           # Update files array (see below)
├── README.md                              # Updated: now describes generic templates only
├── cleo-subagent.cant                     # PROMOTED: universal protocol base (no nesting)
├── harness-adapters/
│   └── claude-code/
│       └── cleo-subagent.AGENT.md        # PROMOTED: Claude Code harness for subagent
├── seed-agents/                           # Generic templates shipped to users
│   ├── README.md                          # Updated to describe generic templates
│   ├── orchestrator-generic.cant          # From .cleo/cant/agents/cleo-orchestrator.cant
│   ├── dev-lead-generic.cant              # From .cleo/cant/agents/dev-lead.cant
│   ├── code-worker-generic.cant           # From .cleo/cant/agents/code-worker.cant
│   ├── docs-worker-generic.cant           # From .cleo/cant/agents/docs-worker.cant
│   └── VARIABLES.md                       # NEW: Coordinate with R2 on template variables
└── meta/
    └── agent-architect.cant               # NEW: Meta-agent for designing new personas
```

#### Updated `package.json` files array:
```json
"files": [
  "cleo-subagent.cant",
  "harness-adapters/",
  "seed-agents/",
  "meta/",
  "README.md"
]
```

### 2. `.cleo/cant/agents/` (Internal Dogfood)

```
.cleo/cant/agents/
├── cleo-orchestrator.cant                # Keep: dogfood orchestrator
├── dev-lead.cant                         # Keep: dogfood dev-lead
├── code-worker.cant                      # Keep: dogfood code-worker
├── docs-worker.cant                      # Keep: dogfood docs-worker
└── [PROPOSED] team-template.cant          # NEW: Example team topology (mirrors team.cant)
```

**Status**: FINAL internal reference. Synchronized with `packages/agents/seed-agents/` for any generic template improvements.

### 3. `.cleo/agents/` (Legacy + CleoCode-Specific Personas)

```
.cleo/agents/
├── cleo-prime.cant                       # CLEO-PROJECT-SPECIFIC: retained
├── cleo-prime.boot.md                    # Companion bootstrap
├── cleo-dev.cant                         # CLEO-PROJECT-SPECIFIC: retained (full version)
├── cleo-dev.md                           # Companion bootstrap
├── cleo-historian.cant                   # CLEO-PROJECT-SPECIFIC: retained
├── cleo-historian.md                     # Companion bootstrap
├── cleo-rust-lead.cant                   # CLEO-PROJECT-SPECIFIC: retained
├── cleo-rust-lead.md                     # Companion bootstrap
├── cleo-db-lead.cant                     # CLEO-PROJECT-SPECIFIC: retained
├── cleo-db-lead.md                       # Companion bootstrap
├── cleoos-opus-orchestrator.cant         # CLEO-PROJECT-SPECIFIC: legacy, retained for compat
├── cleoos-opus-orchestrator.md           # Companion bootstrap
└── DEPRECATED.md                         # NEW: Explanation of deprecation timeline
```

**Status**: DOGFOOD PERSONAS for CleoCode project only. Do NOT ship. Companion .md files are authoritative for local bootstrap. When .cant files are updated, .md versions must be kept in sync.

### 4. Deletion Plan for `.cleo/agents/` Scaffolds

The following **duplicate scaffolds in `.cleo/agents/` are SAFE TO DELETE** because full implementations exist in `packages/agents/seed-agents/`:

1. `.cleo/agents/cleo-prime.cant` (TODO scaffold) → **DELETE** (full version in seed-agents)
2. `.cleo/agents/cleo-dev.cant` (duplicate) → **DELETE** (full version in seed-agents)
3. `.cleo/agents/cleo-historian.cant` (duplicate) → **DELETE** (full version in seed-agents)
4. `.cleo/agents/cleo-rust-lead.cant` (duplicate) → **DELETE** (full version in seed-agents)
5. `.cleo/agents/cleo-db-lead.cant` (duplicate) → **DELETE** (full version in seed-agents)
6. `.cleo/agents/cleoos-opus-orchestrator.cant` (duplicate) → **DELETE** (full version in seed-agents)

**Retain**:
- All `.md` companion files (cleo-prime.boot.md, cleo-dev.md, etc.) — these are bootstrap sequences specific to CleoCode

---

## Template Variables for Generic Agents

Coordinate with **R2 (syntax lead)** on these placeholders for template customization:

| Variable | Usage | Example | Syntax |
|----------|-------|---------|--------|
| `{{tech_stack}}` | Languages, frameworks, runtimes | "TypeScript/Node.js/React" | Used in skill list, tool declarations |
| `{{project_domain}}` | Project purpose | "API authentication", "document processing" | Used in descriptions, permissions |
| `{{test_command}}` | How to run tests | "npm run test" or "cargo test" | Injected into PostToolUse hooks |
| `{{build_command}}` | How to build | "pnpm run build" or "cargo build" | Injected into validation gates |
| `{{repo_structure}}` | File layout | "monorepo with packages/", "single-tree" | Used in file permission globs |
| `{{team_size}}` | Expected team | "1-3 developers", "10+ team" | Affects tier levels and context budgets |

**Recommendation**: Define a `.cant` **interpolation syntax** in R2's CANT parser (e.g., `${VAR_NAME}` or `{{VAR_NAME}}` with runtime substitution). Variables should be marked `REQUIRED` vs `OPTIONAL` with sensible defaults.

---

## Drafted Template Bodies (Ready for Implementation Lead)

### Template 1: `orchestrator-generic.cant`

```cant
---
kind: agent
version: "1"
---

# Starter Orchestrator — coordinates the starter team.
# Generic template suitable for any {{tech_stack}} project.
# Routes tasks to dev-lead and synthesizes results.

agent {{project}}-orchestrator:
  role: orchestrator
  tier: high
  description: "Starter team orchestrator for {{project_domain}}. Reads task context, classifies work, dispatches to the dev-lead, and synthesizes results. Does not execute code — coordinates."
  consult-when: "Cross-team decisions, scope changes, human-in-the-loop escalation, or when the dev-lead reports a blocking ambiguity"

  context_sources:
    - source: decisions
      query: "recent architectural and project decisions"
      max_entries: 5
    - source: patterns
      query: "project conventions and established patterns"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 2000
    on_load:
      validate: true

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write

  skills:
    - ct-cleo
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_user]

  on SessionStart:
    session "Read active tasks and recent decisions to build situational awareness"
      context: [active-tasks, memory-bridge, recent-decisions]

  on TaskCompleted:
    if **the completed task unblocks downstream work**:
      session "Reassess task queue and dispatch next work to dev-lead"
```

### Template 2: `dev-lead-generic.cant`

```cant
---
kind: agent
version: "1"
---

# Development Lead — decides HOW to build. Dispatches to workers.
# Generic template for any {{tech_stack}} project.
# MUST NOT hold Edit/Write/Bash tools (decision-only, review-only authority).

agent {{project}}-dev-lead:
  role: lead
  parent: {{project}}-orchestrator
  tier: mid
  description: "Development lead for {{project_domain}}. Decomposes tasks into concrete implementation steps, reviews worker output, and decides technical approach. Dispatches to code-worker and docs-worker. Does not write code directly."
  consult-when: "Implementation strategy, code architecture, refactoring direction, task decomposition, or when workers need clarification"
  stages: [specification, implementation, validation]
  workers:
    - {{project}}-code-worker
    - {{project}}-docs-worker

  context_sources:
    - source: patterns
      query: "codebase conventions and architecture patterns"
      max_entries: 5
    - source: decisions
      query: "technical decisions affecting implementation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      read: ["**/*"]

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_orchestrator]

  on SessionStart:
    session "Review current task assignments and worker availability"
      context: [active-tasks, memory-bridge]

  on TaskCompleted:
    if **the completed task introduced new code**:
      session "Review worker output for quality and completeness before reporting to orchestrator"
```

### Template 3: `code-worker-generic.cant`

```cant
---
kind: agent
version: "1"
---

# Code Worker — executes code changes within declared file globs.
# Generic template for {{tech_stack}} projects.
# Receives assignments from dev-lead. Writes code, runs {{test_command}}, formats.

agent {{project}}-code-worker:
  role: worker
  parent: {{project}}-dev-lead
  tier: mid
  description: "General-purpose code worker for {{project_domain}}. Reads requirements from the dev-lead, writes code, runs tests, and validates changes. Operates within declared file permission globs."
  consult-when: "Writing code, fixing bugs, running tests, formatting, or any file modification task"

  context_sources:
    - source: patterns
      query: "coding conventions and testing patterns for {{tech_stack}}"
      max_entries: 5
    - source: learnings
      query: "past implementation mistakes and fixes"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: {{repo_structure_write_globs}}
      read: ["**/*"]
      delete: {{repo_structure_write_globs}}

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned task and read relevant source files before starting work"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify the change compiles and passes lint before proceeding"
        commands: ["{{build_command}}", "{{test_command}}"]
```

### Template 4: `docs-worker-generic.cant`

```cant
---
kind: agent
version: "1"
---

# Docs Worker — writes and maintains documentation within declared globs.
# Generic template for {{tech_stack}} projects.
# Receives assignments from dev-lead. Creates docs, updates READMEs, writes TSDoc.

agent {{project}}-docs-worker:
  role: worker
  parent: {{project}}-dev-lead
  tier: mid
  description: "Documentation worker for {{project_domain}}. Writes READMEs, updates guides, adds TSDoc comments, and maintains project documentation. Operates within declared documentation file globs."
  consult-when: "Writing documentation, updating READMEs, adding code comments, or improving existing docs"

  context_sources:
    - source: patterns
      query: "documentation conventions and style patterns"
      max_entries: 3
    - source: decisions
      query: "architectural decisions needing documentation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ["docs/**", "**/*.md", "**/*.mdx"]
      read: ["**/*"]
      delete: ["docs/**"]

  skills:
    - ct-cleo
    - ct-documentor
    - ct-docs-write

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned documentation task and review existing docs for context"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify markdown renders correctly and follows project style conventions"
```

### Template 5: `agent-architect.cant` (Meta-Agent)

```cant
---
kind: agent
version: "1"
---

# Agent Architect — designs new team personas from templates.
# Meta-agent that helps teams adapt generic templates to their project.

agent agent-architect:
  role: specialist
  tier: high
  description: "Agent architect. Helps teams design custom agent personas by adapting generic templates, validating CANT syntax, and generating onboarding docs."
  consult-when: "Designing a new agent persona, adapting templates, validating agent definitions, or creating team topology diagrams"

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write
    tools: read
    admin: read

  skills:
    - ct-cleo
    - ct-spec-writer
    - ct-documentor
    - ct-validator

  tools:
    core: [Read, Write, Glob, Grep]

  context:
    "packages/agents/seed-agents/"
    "docs/specs/CANT-PERSONA-MVI-SPEC.md"
    memory-bridge

  on SessionStart:
    session "Load generic template library and validate CANT syntax"
      context: [active-tasks, memory-bridge]

  on TaskCompleted:
    if **the completed task introduced a new custom agent**:
      session "Validate persona against CANT spec and generate quickstart guide"
```

---

## Migration Matrix (File-Level Instructions)

| Current Path | Target Path | Operation | Notes |
|--------------|-------------|-----------|-------|
| `packages/agents/seed-agents/cleo-subagent.cant` | (DELETE) | Delete duplicate | Identical copy of `packages/agents/cleo-subagent/cleo-subagent.cant` |
| `packages/agents/cleo-subagent/cleo-subagent.cant` | `packages/agents/cleo-subagent.cant` | Move file up (flatten dir) | Universal protocol base, no nesting needed |
| `packages/agents/cleo-subagent/AGENT.md` | `packages/agents/harness-adapters/claude-code/cleo-subagent.AGENT.md` | Move & organize | Harness adapter for Claude Code |
| `.cleo/cant/agents/cleo-orchestrator.cant` | `packages/agents/seed-agents/orchestrator-generic.cant` | Copy | Generic template → users |
| `.cleo/cant/agents/dev-lead.cant` | `packages/agents/seed-agents/dev-lead-generic.cant` | Copy | Generic template → users |
| `.cleo/cant/agents/code-worker.cant` | `packages/agents/seed-agents/code-worker-generic.cant` | Copy | Generic template → users |
| `.cleo/cant/agents/docs-worker.cant` | `packages/agents/seed-agents/docs-worker-generic.cant` | Copy | Generic template → users |
| `packages/agents/seed-agents/cleo-prime.cant` | `.cleo/agents/cleo-prime.cant` | **Keep in both** | Full version shipped in seed-agents; also in .cleo for local dogfood |
| `packages/agents/seed-agents/cleo-dev.cant` | `.cleo/agents/cleo-dev.cant` | **Keep in both** | Full version shipped in seed-agents; also in .cleo for local dogfood |
| `packages/agents/seed-agents/cleo-historian.cant` | `.cleo/agents/cleo-historian.cant` | **Keep in both** | Full version shipped in seed-agents; also in .cleo for local dogfood |
| `packages/agents/seed-agents/cleo-rust-lead.cant` | `.cleo/agents/cleo-rust-lead.cant` | **Keep in both** | Full version shipped in seed-agents; also in .cleo for local dogfood |
| `packages/agents/seed-agents/cleo-db-lead.cant` | `.cleo/agents/cleo-db-lead.cant` | **Keep in both** | Full version shipped in seed-agents; also in .cleo for local dogfood |
| `packages/agents/seed-agents/cleoos-opus-orchestrator.cant` | `.cleo/agents/cleoos-opus-orchestrator.cant` | **Keep in both** | Legacy compat; full version shipped; also in .cleo for dogfood |
| `.cleo/agents/cleo-prime.cant` (TODO scaffold) | (DELETE) | Delete | Superseded by full version in seed-agents |
| `.cleo/agents/cleo-dev.cant` (if scaffold) | (DELETE if different) | Conditional | Check if .cleo version is old scaffold; if so, delete |
| `.cleo/agents/cleo-historian.cant` (if scaffold) | (DELETE if different) | Conditional | Check if .cleo version is old scaffold; if so, delete |
| `.cleo/agents/cleo-rust-lead.cant` (if scaffold) | (DELETE if different) | Conditional | Check if .cleo version is old scaffold; if so, delete |
| `.cleo/agents/cleo-db-lead.cant` (if scaffold) | (DELETE if different) | Conditional | Check if .cleo version is old scaffold; if so, delete |
| `.cleo/agents/cleoos-opus-orchestrator.cant` (if scaffold) | (DELETE if different) | Conditional | Check if .cleo version is old scaffold; if so, delete |
| **ALL `.md` companion files in `.cleo/agents/`** | `.cleo/agents/` | **Keep** | Retain as bootstrap sequences (cleo-prime.boot.md, cleo-dev.md, cleo-historian.md, etc.) |
| `packages/agents/seed-agents/README.md` | `packages/agents/seed-agents/README.md` | Update | Reflect new generic template names (orchestrator-generic, dev-lead-generic, etc.) |
| `packages/agents/README.md` | `packages/agents/README.md` | Update | Add notes on generic templates, variable substitution, harness adapters |
| (NEW) — | `packages/agents/seed-agents/VARIABLES.md` | Create | Document template variables and substitution syntax |
| (NEW) — | `packages/agents/meta/agent-architect.cant` | Create | Meta-agent for custom persona design |
| (NEW) — | `.cleo/agents/DEPRECATED.md` | Create | Explain deprecation timeline and what to update |

---

## Summary Statistics

### File Counts by Category

- **Generic Templates to Ship**: 4 agents (orchestrator, dev-lead, code-worker, docs-worker)
- **CLEO-Project-Specific Personas (Dogfood Only)**: 6 agents (cleo-prime, cleo-dev, cleo-historian, cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator)
- **Universal Base Protocol**: 1 protocol (`cleo-subagent`) + 1 harness adapter (AGENT.md)
- **Companion Bootstrap Docs**: 6 files (kept in `.cleo/agents/`, not shipped)
- **Legacy Scaffolds to Delete**: 5–6 (old TODOs and duplicate .cant files in `.cleo/agents/`)

### Migration Impact

| Impact | Count |
|--------|-------|
| Files moved to `.cleo/agents/` (keep, project-specific) | 6 |
| Files promoted to `packages/agents/seed-agents/` (ship generic) | 4 |
| Files promoted to top-level or new folders | 3 (cleo-subagent.cant, AGENT.md, agent-architect.cant) |
| Files to delete (legacy/duplicates) | 6 |
| New files to create (documentation, templates, meta-agent) | 3 |

---

## Implementation Notes for Implementation Lead

1. **Variable Substitution Syntax**: Work with R2 to define how `{{tech_stack}}`, `{{project_domain}}`, etc. are replaced. Options:
   - Runtime `.cant` parser substitution (recommended)
   - Post-generation sed/jinja
   - Client-side template engine (e.g., Nunjucks, Handlebars)

2. **CANT Syntax for File Globs**: The `code-worker-generic.cant` template uses `{{repo_structure_write_globs}}` — define how projects supply this at init time. Example:
   ```
   cleo init --template code-worker --repo-structure monorepo
   # → expands to: ["src/**", "packages/**", "lib/**", "test/**", "tests/**"]
   ```

3. **Validation Gate**: All new personas must pass:
   ```bash
   cleo cant validate <persona.cant>
   # Should return: valid: true, errorCount: 0
   ```

4. **Backward Compatibility**: The 6 CLEO-project-specific personas remain in `packages/agents/seed-agents/` for v2026.4.110 and documented in the install README as *"CleoCode team reference personas — not recommended for new projects."* Deprecation path: remove in v2026.5.0.

5. **Coordination with R2**: Review template variables, CANT syntax extensions, and any parser changes needed to support `{{...}}` interpolation.

---

## Approval Checklist

- [ ] **Classification Verified**: All files correctly categorized (generic, project-specific, universal, legacy)
- [ ] **Migration Matrix Reviewed**: All move/copy/delete operations understood
- [ ] **Generic Templates Drafted**: 5 templates (orchestrator, dev-lead, code-worker, docs-worker, agent-architect) ready for copy-paste
- [ ] **Variables Coordinated with R2**: Syntax, naming, defaults documented
- [ ] **Deprecation Plan Clear**: `.cleo/agents/` legacy cleanup timeline established
- [ ] **Final Tree Approved**: `packages/agents/` layout, `seed-agents/` contents, `.cleo/agents/` retained personas all aligned

---

## Next Steps (Implementation Phase)

1. **R3 Recommendation**: Execute migration in 3 waves:
   - **Wave 1 (immediate)**: Delete duplicate scaffolds in `.cleo/agents/`, promote cleo-subagent.cant to top-level, create harness-adapters folder
   - **Wave 2 (before RC)**: Copy generic templates to seed-agents/, rename to `-generic` suffix, update README
   - **Wave 3 (ship)**: Validate all .cant files, test `cleo init --install-seed-agents` workflow, publish v2026.4.110

2. **Downstream Coordination**:
   - **Owner**: Approve final tree layout
   - **R2**: Define variable syntax in CANT parser
   - **Impl Lead**: Draft & test all template bodies with real project configs
   - **QA**: Validate all personas pass CANT validation + orchestration smoke tests

---

**End of R3 Content Audit**  
Generated: 2026-04-21  
For T1235 (pre-wave epic T1232)
