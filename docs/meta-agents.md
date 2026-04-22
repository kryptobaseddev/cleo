# Meta-Agents — Developer Guide

**Audience**: Developers authoring new meta-agents for the CLEO ecosystem.
**Canonical example**: `packages/agents/meta/agent-architect.cant`
**Governing ADR**: [ADR-055 D034](./adr/ADR-055-agents-architecture-and-meta-agents.md)
**Research artifact**: `.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R4-META-AGENT-DESIGN.md`

## What is a Meta-Agent?

A **meta-agent** is a CLEO agent whose output is other agents (or other
agent-related artifacts — skills, playbooks, manifest entries). It differs from
a normal subagent in two dimensions:

| Dimension | Subagent | Meta-Agent |
|-----------|----------|------------|
| **Output** | Work product (code, docs, evidence) | Agent artifacts (`.cant` files, skills, manifest entries) |
| **Lifecycle** | Spawned per task; ephemeral | Spawned at bootstrap / reconfiguration; emits artifacts that outlive it |
| **Caller** | An orchestrator + a task | `cleo init`, installation playbooks, reconfiguration flows |
| **Failure mode** | Task retry via IVTR | Halts project bootstrap; requires HITL intervention |

A meta-agent is still a valid CLEO agent — it follows the `cleo-subagent.cant`
protocol, honors the RFC 2119 constraint grammar, emits
`agent-created: {filename}` lines plus a `pipeline.manifest` entry, and returns
one of the three terminal summary strings. The *category* is distinct; the
contract is the same.

## The Canonical Example: `agent-architect`

`packages/agents/meta/agent-architect.cant` is the first meta-agent. Its full
body lives in R4 §2; read that in parallel with this guide. The highlights:

```yaml
---
kind: agent
version: 2
---

agent agent-architect:
  model: opus
  role: specialist
  parent: cleo-prime
  description: "CLEO Meta-Agent: Synthesizes project-specific agents from templates + context"

  prompt: |
    You are agent-architect — the CLEO meta-agent responsible for constructing
    customized project-specific agents.

    You are invoked by `cleo init --install-seed-agents` and given:
    1. project-context.json (project type, conventions, testing framework, etc.)
    2. Generic .cant templates (role-keyed: lead, worker, orchestrator, specialist)
    3. Configuration payload (model preference, tier, skills list, domains)

    Your job: analyze the project context + templates + config, then emit N
    customized .cant agent files written to `.cleo/cant/agents/`.
    # … (see R4 §2 for the full prompt)

  constraints [output]:
    OUT-001: MUST emit one `agent-created: {name}.cant` line per generated agent to stdout
    OUT-002: MUST write valid CANT syntax (validate against kind: agent, version: 2 schema)
    OUT-003: MUST NOT reference unknown skills or domains in the emitted agents
    OUT-004: MUST write agents to `$CANT_AGENTS_DIR` before returning
    OUT-005: MUST return a one-line summary; do not echo generated agent bodies

  constraints [lifecycle]:
    LC-001: MUST read project-context.json from CWD to infer project type + conventions
    LC-002: MUST read generic templates from `packages/agents/seed-agents/`
    LC-003: MUST validate template syntax before synthesis
    LC-004: MUST check for name collisions in `$CANT_AGENTS_DIR` and abort if found
    LC-005: MUST write a manifest entry to `pipeline.manifest` for each generated agent
```

Take this as the reference for shape, constraint style, and return-format
discipline when authoring new meta-agents.

## Authoring a New Meta-Agent

### 1. Decide the output artifact

What does your meta-agent produce?

- New `.cant` agents? → follow `agent-architect`'s pattern.
- New `.cant` skills? → `skill-architect` (planned; see R4 §5).
- New `.cantbook` playbooks? → `playbook-architect` (planned).
- Pipeline manifest entries for synthesized artifacts? → `manifest-architect`
  (planned).

One meta-agent, one artifact class. Composing multiple artifact kinds in a
single meta-agent blurs the reasoning surface and breaks the
"bootstrap-as-dialogue" model.

### 2. Declare inputs, outputs, and side effects

Every meta-agent MUST document:

- **Inputs** — files and environment it reads. For `agent-architect`:
  `.cleo/project-context.json`, `packages/agents/seed-agents/*.cant`,
  `$CANT_AGENTS_DIR`, `MODEL_OVERRIDE`, `TIER_OVERRIDE`.
- **Outputs** — files it writes, stdout lines it emits, manifest entries it
  appends. For `agent-architect`: `.cleo/cant/agents/{name}.cant` per agent,
  one `agent-created:` line per agent, one `pipeline.manifest` entry per agent.
- **Side effects** — everything else. For `agent-architect`: may read the
  CANT schema parser to self-validate before emitting.

Use the `constraints [output]` and `constraints [lifecycle]` blocks to encode
these in RFC 2119 language. The CANT validator enforces well-formedness at
install time; the orchestrator spawn path enforces return-format adherence at
runtime.

### 3. Write the prompt

A meta-agent prompt MUST be explicit about:

- Who invokes it (`cleo init`, a specific playbook node, etc.)
- What inputs it receives (names, shapes, example values)
- What it must output (stdout format, file paths, manifest shape)
- What counts as success, partial, blocked
- Anti-patterns to refuse (copy-without-customization, unknown-skill
  references, hardcoding past configuration choices)

Budget ≈ 60 lines of prompt. Meta-agents need more structure than typical
workers because their output is programmatic, not prose.

### 4. Choose the parent

`parent: cleo-prime` is the default for CleoCode itself; for generic CLEO use
the parent is the local project's orchestrator. Meta-agents are `role:
specialist` — they are not workers (they synthesize; they don't execute tasks)
and not orchestrators (they don't dispatch downstream; they emit artifacts and
return).

### 5. Ship and register

Place the file at `packages/agents/meta/{your-meta-agent}.cant`. Ensure
`packages/agents/package.json#files` includes `meta/` so the tarball ships
the new file. The seed-installer and `agent-resolver` walk
`packages/agents/meta/` alongside `seed-agents/` for agent lookups.

Add a one-line entry to `packages/agents/meta/README.md` (or create it if
yours is the first after `agent-architect`) summarizing purpose and inputs.

## Invocation

### From `cleo init`

The primary invocation path. `ensureSeedAgentsInstalled()` now performs:

1. Version-marker check (same as before).
2. Load `.cleo/project-context.json` and seed templates.
3. Invoke `cleo orchestrate spawn` with `agent: agent-architect`.
4. Fall back to static seed copy if synthesis fails or the dispatcher is
   unavailable.
5. Write the new version marker.

R4 §4 has the ASCII flow diagram.

### From a Playbook

Any `.cantbook` agentic node MAY reference a meta-agent by name. No parser or
schema change is required — R4 §3 verified via the playbook parser
(`packages/playbooks/src/parser.ts`, `parseAgenticNode`) that the `agent` field
accepts any agent identifier and the runtime's `AgentDispatcher.dispatch()` is
agent-class-agnostic.

Example (`installation.cantbook`, abbreviated from R4 §6):

```yaml
version: "1.0"
name: installation

nodes:
  - id: architect_agents
    type: agentic
    agent: agent-architect
    role: specialist
    inputs:
      projectPath: "{{ inputs.projectPath }}"
      skipSynthesis: "{{ inputs.skipAgentSynthesis }}"
    ensures:
      schema: agent_synthesis_report

  - id: architect_skills
    type: agentic
    agent: skill-architect
    role: specialist
    depends: [architect_agents]

edges:
  - from: architect_agents
    to: architect_skills
```

### Direct CLI

```bash
cleo orchestrate spawn --agent agent-architect --task T{bootstrap} \
  --context '{"projectPath":"/path","tier":"2"}'
```

This is the debug path. Production flows should invoke via `cleo init` or a
playbook so the manifest and session linkage are automatic.

## Safety and Constraints

### No circular synthesis

A meta-agent MUST NOT invoke another meta-agent. If your workflow requires
chained synthesis (e.g., agent-architect → skill-architect →
playbook-architect), express the chain as a playbook with explicit `depends:`
edges, not as nested meta-agent calls. R4 §3 "Caveats" documents this
explicitly.

### Name-collision guard

Before writing any artifact, a meta-agent MUST check the destination directory
for name collisions (`LC-004` in `agent-architect`). Overwriting an existing
persona without explicit `--force` is an error.

### Unknown-skill / unknown-domain refusal

A meta-agent MUST cross-check every skill and domain reference against
`@cleocode/contracts` before emitting. Emitting a persona that references a
nonexistent skill causes downstream registry validation failures and breaks
orchestration.

### Return-format discipline

The OUT-001…OUT-005 block on `agent-architect` is the template. Your meta-agent
returns **filenames only**, never artifact bodies. Bodies go to disk; one-line
stdout breadcrumbs go to the orchestrator. This preserves the orchestrator's
context budget and makes the output machine-parseable.

### Idempotency

A meta-agent SHOULD be idempotent across identical inputs. Re-running
`cleo init --install-seed-agents` in an unchanged project MUST NOT regenerate
personas that already exist with matching SHA-256. The version-marker check in
`ensureSeedAgentsInstalled()` guards the outer flow; the meta-agent itself
SHOULD guard via `LC-004` collision check plus a content-hash compare.

### Fallback to static copy

Any meta-agent invoked from `cleo init` MUST tolerate an orchestrator-absent
environment (offline CI, `--skip-agent-synthesis`, missing LLM credentials).
The caller (`ensureSeedAgentsInstalled()`) handles fallback by copying the
generic templates verbatim. Your meta-agent can signal "fallback recommended"
via the blocked terminal return string; it MUST NOT attempt to mask the
missing dispatcher by inventing outputs.

## Testing a Meta-Agent

### Unit: validate the `.cant` body

```bash
cleo cant validate packages/agents/meta/your-meta-agent.cant
```

Must exit 0 before commit. The validator checks frontmatter, required fields,
role coherence, skill references, and parses the prompt as plain text.

### Integration: mock the dispatcher

Follow the pattern used by R4's planned Phase 4 tests (§7, tasks 11–12):

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('agent-architect', () => {
  it('synthesizes agents from a node project context', async () => {
    const mockDispatcher = vi.fn(async ({ agentId, context }) => ({
      status: 'success',
      output: {
        agentsCreated: ['myproj-lead.cant', 'myproj-worker.cant'],
      },
    }));
    const result = await ensureSeedAgentsInstalled({ dispatcher: mockDispatcher });
    expect(mockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-architect' })
    );
    expect(result.installedVersion).not.toBeNull();
  });
});
```

### End-to-end: the smoke test

```bash
cd /tmp/fresh-project
cleo init
cleo init --install-seed-agents
ls .cleo/cant/agents/    # expect the synthesized personas
cleo agent doctor --json # expect zero D-xxx drift codes
```

## Meta-Agent Roster

Current (v2026.4.110):

| Meta-Agent | Status | Ships | Purpose |
|------------|--------|-------|---------|
| `agent-architect` | Shipped | `packages/agents/meta/agent-architect.cant` | Synthesize project-specific agents from templates + context |

Planned (future waves, per R4 §5):

| Meta-Agent | Planned | Purpose |
|------------|---------|---------|
| `skill-architect` | v2026.4.11x | Generate custom skill definitions from project type and tier |
| `playbook-architect` | v2026.4.11x | Generate DAG-shaped `.cantbook` playbooks from a high-level workflow spec |
| `manifest-architect` | TBD | Generate / validate manifest entries for artifacts, tasks, and deployments |

## Troubleshooting

### The synthesized agent references an unknown skill

Cause: `agent-architect`'s cross-check against `@cleocode/contracts` failed,
or a locally-registered skill was renamed. Fix: rerun `cleo cant validate` on
the generated `.cant`, update the offending skill reference, re-register.

### Name collision on re-run

Cause: `.cleo/cant/agents/myproj-lead.cant` already exists from a previous
run. Fix: either delete the old file explicitly, or invoke with `--force`
when your meta-agent supports it. `agent-architect` does not auto-force for
safety.

### Offline CI failed to synthesize

Expected. The fallback static copy of `seed-agents/` runs automatically. If
you need richer personas in CI, export pre-synthesized `.cant` files into the
project's `.cleo/cant/agents/` and commit them.

### Manifest has duplicate `agent_created` entries

Cause: a meta-agent was invoked twice without the dedup guard. Fix: confirm
`LC-004` collision check passes and the version-marker outer guard ran. File
a bug against your meta-agent if both guards report OK and duplicates
persisted.

## See Also

- [ADR-055 — Agents Architecture + Meta-Agents](./adr/ADR-055-agents-architecture-and-meta-agents.md)
- R4 research artifact: `.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R4-META-AGENT-DESIGN.md`
- `packages/agents/README.md` — package-level overview
- `packages/agents/meta/agent-architect.cant` — canonical example
- ADR-053 (playbook runtime) — invocation pathway for meta-agents called from
  a `.cantbook`

---

**Document status**: initial version (v2026.4.110). Update as additional
meta-agents ship and patterns solidify.
