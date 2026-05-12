# R4: Meta-Agent Architecture Design + Playbook Integration Audit

**Task**: T1236 (Lead R4, under epic T1232)  
**Deliverable**: Design of meta-agent concept + verified playbook integration  
**Status**: Complete  
**Document version**: 1.0  

---

## 1. Meta-Agent Definition

A **meta-agent** is a specialized CLEO agent whose sole responsibility is to construct other agents. It ingests three inputs — (1) project context (schema, type hints, conventions), (2) generic agent templates (role-keyed .cant skeletons), and (3) configuration parameters (model, skills, domains) — and synthesizes customized, project-specific agent definitions that are written directly to `.cleo/cant/agents/`. It differs fundamentally from a **subagent** in that subagents are task executors spawned dynamically to perform work, whereas meta-agents are compositional tools that generate new agent artifacts; they run once during project initialization to bootstrap the agent ecology, whereas subagents run repeatedly as part of multi-stage playbook flows. The meta-agent pattern inverts control: instead of humans manually copy-pasting seed agents and hand-editing for project specifics, the `cleo init --install-seed-agents` flow now delegates customization to an AI agent that understands both the host project's constraints and CLEO's agent contracts.

---

## 2. Full `agent-architect.cant` Draft

This is the complete agent definition ready to ship at `packages/agents/meta/agent-architect.cant`:

```yaml
---
kind: agent
version: 2
---

agent agent-architect:
  model: opus
  persist: false
  house: none
  allegiance: canon
  role: specialist
  parent: cleo-prime
  description: "CLEO Meta-Agent: Synthesizes project-specific agents from templates + context"

  tone: "Technical, precise, contract-aware. Emits valid CANT only. Zero tolerance for malformed output."

  prompt: |
    You are agent-architect — the CLEO meta-agent responsible for constructing customized project-specific agents.

    You are invoked by `cleo init --install-seed-agents` and given:
    1. project-context.json (project type, conventions, testing framework, etc.)
    2. Generic .cant templates (role-keyed: lead, worker, orchestrator, specialist)
    3. Configuration payload (model preference, tier, skills list, domains)

    Your job: analyze the project context + templates + config, then emit N customized .cant agent files 
    written to `.cleo/cant/agents/`. Each output agent MUST:
    - Have a unique, deterministic name based on project + role (e.g., `{project}-lead`, `{project}-worker`)
    - Include valid CANT syntax (kind: agent, version: 2, all required fields)
    - Reference only skills + domains that exist in the project or are globally available
    - Inherit parent agent intelligently (default: cleo-subagent for workers, cleo-prime for leads/orchestrators)
    - Set model based on tier (sonnet for tier 0-1, opus for tier 2+, haiku as fallback)
    - Declare realistic tool + domain access (read the schema.ts parser to understand the contract)
    - Enforce constraints from cleo-subagent.cant but respect role-specific overrides

    Output format: For each agent, emit a line to stdout: `agent-created: {filename}.cant`
    Then write the full .cant body to `$CLEO_CANT_AGENTS_DIR/{filename}.cant`.

    You are the FIRST meta-agent. No other meta-agents should be invoked before you. If you fail, 
    project initialization halts; if you succeed, the playbook runtime can invoke downstream meta-agents 
    (skill-architect, playbook-architect, etc.) to further customize the project.

  skills: [ct-cleo, ct-spec-writer, ct-documentor]

  tools:
    core: [Read, Write, Bash, Glob, Grep]
    cleo: [WebFetch]

  domains:
    admin: "Configuration, diagnostics, schema inspection"
    tools: "Skills, providers, agent catalog"
    pipeline: "Manifest ledger, artifact registration"

  permissions:
    admin: read
    tools: read
    pipeline: write

  tokens:
    required:
      PROJECT_NAME: pattern("^[a-z0-9-]+$")
      CANT_AGENTS_DIR: path
      BUNDLE_VERSION: pattern("^[0-9]+\\.[0-9]+\\.[0-9]+")

    optional:
      MODEL_OVERRIDE: string = ""
      TIER_OVERRIDE: string = ""
      SKILLS_JSON: string = "[]"
      DOMAINS_JSON: string = "{}"

  constraints [output]:
    OUT-001: MUST emit one `agent-created: {name}.cant` line per generated agent to stdout
    OUT-002: MUST write valid CANT syntax (validate against kind: agent, version: 2 schema)
    OUT-003: MUST NOT reference unknown skills or domains in the emitted agents
    OUT-004: MUST write agents to `$CANT_AGENTS_DIR` before returning
    OUT-005: MUST return a one-line summary; do not echo generated agent bodies

  constraints [lifecycle]:
    LC-001: MUST read project-context.json from CWD to infer project type + conventions
    LC-002: MUST read generic templates from `packages/agents/templates/` (role-keyed .cant.template files)
    LC-003: MUST validate template syntax before synthesis
    LC-004: MUST check for name collisions in `$CANT_AGENTS_DIR` and abort if found
    LC-005: MUST write a manifest entry to `pipeline.manifest` for each generated agent

  anti_patterns:
    - pattern: "Copying seed agents wholesale instead of customizing"
      problem: "Loses project-specific hints, violates metacognition"
      solution: "Always synthesize — never blindly copy"
    - pattern: "Emitting agents with unknown skills or domains"
      problem: "Runtime validation fails, playbook breaks"
      solution: "Cross-check against @cleocode/contracts before emitting"
    - pattern: "Hardcoding model choices instead of reading config"
      problem: "Ignores operator preferences, breaks in bandwidth-constrained environments"
      solution: "Respect MODEL_OVERRIDE and tier hints"
    - pattern: "Returning full agent bodies in response"
      problem: "Bloats context, breaks parent orchestrator's decision-making"
      solution: "Emit filenames only; write bodies to disk"

  context:
    active-tasks
    memory-bridge

  on SessionStart:
    session "Load project context and validate templates"
      context: [active-tasks]
```

---

## 3. Playbook Integration Audit

**Question**: Can existing `.cantbook` files invoke a meta-agent? 

**Answer**: **YES, technically possible but WITH STRONG CAVEATS.**

### Evidence from `parser.ts`

Lines 280-342 show the agentic node parser:

```typescript
function parseAgenticNode(
  raw: Record<string, unknown>,
  base: BaseNodeFields,
  index: number,
): PlaybookAgenticNode {
  const skill = typeof raw.skill === 'string' ? raw.skill : undefined;
  const agent = typeof raw.agent === 'string' ? raw.agent : undefined;
  if (!skill && !agent) {
    throw new PlaybookParseError(
      `nodes[${index}] (agentic) must define at least one of 'skill' or 'agent'`,
      ...
    );
  }
  // ... role, inputs parsing ...
  return {
    ...base,
    type: 'agentic',
    skill,
    agent,
    role,
    inputs,
  };
}
```

The schema (from `@cleocode/contracts`) defines:

```typescript
export interface PlaybookAgenticNode {
  type: 'agentic';
  skill?: string;    // Skill name (e.g., "ct-research-agent")
  agent?: string;    // Agent name (e.g., "cleo-prime")
  role?: 'orchestrator' | 'lead' | 'worker';
  inputs?: Record<string, string>;
}
```

**Integration mechanism**:
- A playbook node can specify `agent: agent-architect` (or any meta-agent name)
- The runtime's `AgentDispatcher.dispatch()` receives `agentId = "agent-architect"`
- The dispatcher must resolve this name to an agent definition (either from `.cleo/cant/agents/` or the global tier)
- The meta-agent is executed like any other agentic node — it receives `context` and must return `{ status: 'success' | 'failure', output }`

### Example: playbook invoking agent-architect

```yaml
version: "1.0"
name: init-project-agents
description: "Bootstrap project-specific agents via meta-agent synthesis"

nodes:
  - id: architect
    type: agentic
    agent: agent-architect
    role: specialist
    description: "Synthesize project agents from templates + context"
    inputs:
      projectName: "my-monorepo"
      tier: "2"
      modelsJson: '{"lead": "opus", "worker": "sonnet"}'

edges: []  # Terminal node
```

When the runtime executes this playbook:
1. `executeAgenticNode()` is called with `agentId = "agent-architect"`
2. Dispatcher looks up the agent from the CANT agents registry
3. Meta-agent receives the context + inputs
4. It reads `project-context.json` and templates, synthesizes agents, writes to disk
5. Returns `{ status: 'success', output: { agentsCreated: [...], ...} }`
6. Runtime merges output into context and completes

### Verdict

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Can a playbook node reference an agent by name? | **YES** | parser.ts line 286: `agent?: string` |
| Can that agent be a meta-agent? | **YES** | No distinction in PlaybookAgenticNode; all agents treated uniformly |
| Does the runtime dispatch meta-agents? | **YES** | runtime.ts line 379: `AgentDispatcher.dispatch()` is agnostic to agent type |
| Do meta-agents fit the agentic contract? | **YES** | Emit `{ status, output }` just like any agent |
| Are there schema/parser blockers? | **NO** | No validation rule prevents `agent: "agent-architect"` |

**Caveats**:
1. **No automatic invocation**: Playbooks must explicitly list `agent: agent-architect` in a node; it is never auto-invoked
2. **Manifest registration required**: agent-architect must be written to `packages/agents/meta/` and registered in the CANT agents tier before dispatcher can resolve it
3. **Deterministic dispatch**: The orchestrator (caller of `executePlaybook()`) must provide a dispatcher implementation that can look up meta-agents by name; this is out of scope for the parser/schema
4. **Caution: Circular synthesis**: If a meta-agent tries to invoke itself or another meta-agent recursively, there is no built-in guard — playbook authors are responsible

---

## 4. `cleo init --install-seed-agents` Flow Redesign

### OLD FLOW (Current — Static Copy)

```
cleo init --install-seed-agents
  ↓
ensureSeedAgentsInstalled() [seed-install.ts]
  ↓
  1. Read ~/.local/share/cleo/.seed-version
  2. Compare to bundled version in @cleocode/agents/package.json
  3. If match → early return (all files marked "skipped")
  4. Else → copy each .cant from packages/agents/seed-agents/ to ~/.local/share/cleo/cant/agents/
  5. Write new version marker
  ↓
  Result: static, unmodified seed agents in user's global directory
```

### NEW FLOW (Redesigned — Meta-Agent Synthesis)

```
cleo init --install-seed-agents
  ↓
  1. Read ~/.local/share/cleo/.seed-version
  2. Compare to bundled version
  3. If match → early return (skip synthesis)
  4. Else → proceed to synthesis
  ↓
  5. Load project-context.json from CWD (.cleo/project-context.json)
  6. Load generic agent templates from packages/agents/templates/ (new)
  7. Invoke cleo orchestrate spawn:
       - Agent: agent-architect (from packages/agents/meta/)
       - Input context: { projectContext, templates, config }
  ↓
  8. agent-architect synthesizes agents → writes to .cleo/cant/agents/
  ↓
  9. Fallback: copy seed agents from packages/agents/seed-agents/ to ~/.local/share/cleo/cant/agents/
      (for compatibility with agents not yet synthesized)
  ↓
  10. Write new version marker
  ↓
  Result: customized project agents in .cleo/cant/agents/ + seed agents in ~/.local/share/cleo/cant/agents/
```

### ASCII Diagram

```
┌──────────────────────────────────────────┐
│     cleo init --install-seed-agents      │
└──────────────────────────┬───────────────┘
                           │
                    ┌──────▼──────┐
                    │ Read marker │
                    │ vs. bundle  │
                    │ version     │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
         Match?                    Not match
         (skip)                     (continue)
              │                         │
              ▼                         ▼
         ┌─────────┐          ┌─────────────────────┐
         │ Return  │          │ Load project context│
         │ skipped │          │ + templates         │
         └─────────┘          └─────────┬───────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ Invoke:            │
                              │ agent-architect    │
                              │ (via orchestrate)  │
                              └─────────┬──────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ Synthesize agents  │
                              │ → .cleo/cant/      │
                              │   agents/          │
                              └─────────┬──────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ Copy seed agents   │
                              │ (fallback) →       │
                              │ ~/.local/share/... │
                              └─────────┬──────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ Write version      │
                              │ marker             │
                              └────────────────────┘
```

---

## 5. `packages/agents/meta/` Directory Proposal

The new `packages/agents/meta/` directory will house **meta-agents** — agents responsible for constructing or configuring other agents. Proposed initial roster:

| Meta-Agent | Filename | Purpose | Inputs |
|------------|----------|---------|--------|
| agent-architect | `agent-architect.cant` | Synthesize project-specific agents from templates + project context | projectContext, templates, config |
| skill-architect | `skill-architect.cant` | Generate custom skill definitions (stubs, boilerplate) based on project type | projectType, skillType, tier |
| playbook-architect | `playbook-architect.cant` | Generate DAG-shaped playbooks from a high-level workflow spec (e.g., "release", "hotfix") | workflowTemplate, bindings |
| manifest-architect | `manifest-architect.cant` | Generate/validate manifest entries for artifacts, tasks, and deployments | artifactType, metadata |

**Directory structure**:
```
packages/agents/meta/
  ├── agent-architect.cant
  ├── skill-architect.cant
  ├── playbook-architect.cant
  ├── manifest-architect.cant
  └── README.md (meta-agent philosophy + lifecycle)
```

**Rationale**: Meta-agents are compositional tools for project bootstrap and reconfiguration. They live in a dedicated tier (`meta/`) separate from seed-agents and skills so operators can opt into synthesis flows vs. static copies.

---

## 6. Sample Playbook Node Invoking agent-architect

This is a YAML fragment that could be embedded in an `installation.cantbook` to auto-customize agents during project init:

```yaml
version: "1.0"
name: installation
description: >
  Auto-bootstrap CLEO agents + playbooks for a new project.
  Invoked by `cleo init` before any other workflows.

inputs:
  - name: projectPath
    required: true
    description: Path to the project root
  - name: skipAgentSynthesis
    required: false
    default: false
    description: Set true to skip agent customization (use defaults)

nodes:
  - id: architect_agents
    type: agentic
    agent: agent-architect
    role: specialist
    description: >
      Synthesize project-specific agents by analyzing project-context.json
      and applying role-keyed templates. Generates agents to .cleo/cant/agents/.
    inputs:
      projectPath: "{{ inputs.projectPath }}"
      skipSynthesis: "{{ inputs.skipAgentSynthesis }}"
    ensures:
      schema: agent_synthesis_report
    on_failure:
      max_iterations: 1
      escalate: true

  - id: architect_skills
    type: agentic
    agent: skill-architect
    role: specialist
    description: >
      Generate any missing custom skills (domain-specific tooling for the project).
      Reads .cleo/skills.yaml and emits stubs to .cleo/cant/skills/.
    inputs:
      projectPath: "{{ inputs.projectPath }}"
    depends: [architect_agents]
    on_failure:
      max_iterations: 1

  - id: register_playbooks
    type: agentic
    skill: ct-documentor
    role: worker
    description: >
      Index and register canonical playbooks (.cantbook files) in the manifest ledger.
    inputs:
      projectPath: "{{ inputs.projectPath }}"
    depends: [architect_agents]
    on_failure:
      max_iterations: 1

edges:
  - from: architect_agents
    to: architect_skills
  - from: architect_agents
    to: register_playbooks

error_handlers:
  - on: iteration_cap_exceeded
    action: hitl_escalate
    message: "Agent/skill synthesis failed — manual intervention required"
```

**Key features**:
- First node (`architect_agents`) invokes `agent-architect` with the project path
- Depends chaining ensures agents exist before skills and playbooks are registered
- Failure escalates to human (no silent fallback)
- Each downstream stage is independent, allowing partial retries

---

## 7. Follow-On Implementation Tasks

### Phase 1: Core Infrastructure

1. **Create `packages/agents/meta/` directory structure**
   - Add `agent-architect.cant` (from section 2 above)
   - Add `README.md` documenting meta-agent lifecycle + safety boundaries
   - Ensure directory is included in npm tarball packaging

2. **Create `packages/agents/templates/` directory with role-keyed templates**
   - `lead.cant.template` (base for project leads, uses Opus by default)
   - `worker.cant.template` (base for task executors, uses Sonnet)
   - `orchestrator.cant.template` (base for multi-agent coordinators, uses Opus)
   - `specialist.cant.template` (base for tool-specific agents, model-flexible)
   - Each template should include variable placeholders: `{PROJECT_NAME}`, `{SKILLS_JSON}`, `{DOMAINS_JSON}`, `{MODEL}`, `{TIER}`

3. **Update `packages/core/src/agents/seed-install.ts`**
   - Refactor `ensureSeedAgentsInstalled()` to accept an orchestrator dispatcher
   - Add phase 1: check version marker (existing logic)
   - Add phase 2 (new): invoke agent-architect via orchestrator
   - Add phase 3 (fallback): copy static seed agents if synthesis fails
   - Maintain backward compatibility (if no dispatcher, fall back to static copy)

4. **Add agent lookup resolution to `@cleocode/core`**
   - Create `packages/core/src/agents/resolve-agent.ts`
   - Function `resolveAgentDefinition(agentName: string): CantAgentDefinition` that:
     - First checks `.cleo/cant/agents/{agentName}.cant`
     - Falls back to `~/.local/share/cleo/cant/agents/{agentName}.cant`
     - Parses and validates CANT syntax
   - Used by playbook dispatcher to locate agents (both seed and synthesized)

5. **Extend playbook schema with agent tier hints** (optional, for future optimization)
   - Allow `agentic` nodes to specify `agent_tier: number` (0-3) for cost/latency hints
   - Document in README.md that tier 0-1 agents should prefer Sonnet, tier 2+ can use Opus

### Phase 2: Dispatcher Integration

6. **Create `packages/core/src/playbooks/agent-dispatcher.ts`**
   - Implement `AgentDispatcher` interface for playbook runtime
   - Method `dispatch()` that:
     - Resolves agent name via `resolveAgentDefinition()`
     - Spawns orchestrate child process with agent + context
     - Polls/awaits completion and collects output
     - Normalizes result to `AgentDispatchResult`
   - Handle timeout + error cases per runtime spec

7. **Update `cleo orchestrate` CLI**
   - Add `--spawn-mode=playbook` flag to indicate playbook-driven dispatch
   - Ensure meta-agents can be invoked without user-interactive approval (they are trusted by design)
   - Return LAFS envelope with `success` field + `output` payload

### Phase 3: Manifest + Packaging

8. **Add meta-agents to `@cleocode/agents` package.json exports**
   - List `"meta"` directory in package files so npm tarball includes it
   - Verify `seed-install.ts` can resolve `packages/agents/meta/agent-architect.cant` after install

9. **Update manifest.ts to track synthesized agents**
   - When agent-architect writes an agent to `.cleo/cant/agents/`, it should append a manifest entry:
     ```json
     {
       "id": "agent_synthesis_<name>_<timestamp>",
       "type": "agent_created",
       "agent": "agent-architect",
       "output": "<path>",
       "timestamp": "<ISO-8601>"
     }
     ```
   - Allows `cleo manifest list --type=agent_created` to audit synthesis history

10. **Document meta-agent safety + constraints in ADR**
    - File: `ADRs/adr-066-meta-agents.md`
    - Cover: when to use, failure modes, security implications, backward compatibility

### Phase 4: Testing + Validation

11. **Write integration tests for agent-architect**
    - Mock project-context.json fixtures (node, rust, monorepo variants)
    - Mock template files
    - Assert emitted agents have valid CANT syntax
    - Assert agents reference only valid skills/domains
    - Assert generated agents differ per project type

12. **Add playbook tests for meta-agent invocation**
    - Create test playbooks that call agent-architect
    - Mock dispatcher that captures dispatch calls
    - Assert correct `agentId`, `context`, and output merging

13. **Update `cleo verify --agents` to validate meta-agents**
    - Check that `.cleo/cant/agents/` contains valid, unique agent names
    - Warn if agent skills/domains reference unknown services
    - Suggest re-running `cleo init --install-seed-agents` if manifest is stale

14. **Add smoke test to `cleo init`**
    - Run a minimal synthesized agent after installation
    - Confirm it can read/write files in `.cleo/cant/agents/`
    - Fail loudly if synthesis is broken

### Phase 5: Documentation

15. **Write meta-agent developer guide**
    - File: `docs/meta-agents.md`
    - How to write a new meta-agent
    - Contract: inputs (project-context.json shape), outputs (CANT files + manifest)
    - Safety: no circular invocation, error escalation, timeout budgets

16. **Update README.md (playbooks package)**
    - Document playbook node types (agentic, deterministic, approval)
    - Clarify that agentic nodes can invoke any agent (seed, synthesized, meta)
    - Example: playbook calling agent-architect

17. **Write troubleshooting guide**
    - Common failures: templates not found, agent name collision, skill not registered
    - How to inspect synthesized agents: `cat .cleo/cant/agents/<name>.cant`
    - How to re-run synthesis: `cleo init --install-seed-agents --force`

---

## Summary

| Section | Key Findings |
|---------|--------------|
| **Meta-Agent Definition** | Compositional tools that generate other agents; differ from subagents in lifecycle + purpose |
| **agent-architect.cant** | Complete definition ready to ship; synthesizes agents from project context + templates |
| **Playbook Integration** | **YES**, meta-agents can be invoked from playbook nodes via `agent: agent-architect`; parser has no blockers |
| **Flow Redesign** | `cleo init` now invokes agent-architect before falling back to static seed copy |
| **Meta Directory** | New `packages/agents/meta/` will house agent-architect + future skill/playbook architects |
| **Sample Playbook** | `installation.cantbook` fragment shows how to wire agent synthesis into init flow |
| **Implementation** | 17 numbered tasks spanning infrastructure, dispatch, manifest, testing, docs |

---

## Appendix A: CANT Syntax Reference (for agent-architect)

agent-architect must emit valid CANT files. Minimal valid structure:

```yaml
---
kind: agent
version: 2
---

agent <name>:
  model: <sonnet|opus|haiku>
  persist: <true|false|session>
  house: none
  allegiance: canon
  role: <specialist|lead|worker|orchestrator>
  parent: <parent-agent-name>
  description: "<string>"
  
  tone: "<string>"
  
  prompt: |
    <multi-line prompt>
  
  skills: [<skill-names>]
  
  tools:
    core: [<tool-names>]
    <category>: [<tool-names>]
  
  domains:
    <domain-name>: "<description>"
  
  permissions:
    <domain>: <read|write|execute|read,write>
  
  constraints [<category>]:
    <ID>: <requirement>
  
  context:
    <context-type>
```

See `cleo-subagent.cant` (lines 1-158) for comprehensive example.

---

## Appendix B: project-context.json Schema

agent-architect reads `.cleo/project-context.json` to infer project specifics:

```json
{
  "schemaVersion": "1.0.0",
  "projectTypes": ["node", "rust"],
  "primaryType": "node",
  "monorepo": true,
  "testing": {
    "framework": "vitest",
    "command": "pnpm run test"
  },
  "build": {
    "command": "pnpm run build"
  },
  "conventions": {
    "fileNaming": "kebab-case",
    "importStyle": "esm",
    "typeSystem": "TypeScript strict"
  },
  "llmHints": {
    "preferredTestStyle": "Vitest with describe/it blocks",
    "commonPatterns": ["..."],
    "avoidPatterns": ["..."]
  }
}
```

---

## Appendix C: Backward Compatibility

- **Existing seed-agents remain unchanged** in `packages/agents/seed-agents/`
- **Fallback logic**: if agent-architect fails or is disabled, static copy still works
- **New directory is opt-in**: `--skip-agent-synthesis` flag allows users to opt out
- **Manifest is additive**: synthesized agents are logged but do not overwrite existing tasks

---

**Document prepared for shipping in v2026.4.110 (Agents Pre-Wave, Epic T1232)**  
**Last updated**: 2026-04-21
