# @cleocode/agents/meta — Meta-Agent Tier

**Status**: Shipped in v2026.4.110 (epic T1232, task T1239)
**Design**: [ADR-055](../../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md) · [R4 design doc](../../../.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R4-META-AGENT-DESIGN.md)

## Purpose

Meta-agents are specialised CLEO agents whose sole responsibility is to
construct other agents (or other artifacts — skills, playbooks, manifests).
They differ from subagents in that subagents are task executors spawned
dynamically to perform work, whereas meta-agents are compositional tools that
generate new CANT artefacts; they run during project initialisation (or
re-bootstrap) to customise the agent ecology, whereas subagents run repeatedly
as part of multi-stage playbook flows.

## Roster

| Meta-Agent        | Filename                   | Purpose                                                           |
|-------------------|----------------------------|-------------------------------------------------------------------|
| `agent-architect` | `agent-architect.cant`     | Synthesise project-specific agents from templates + project-context.json |
| `skill-architect` | (future — T1241 roadmap)   | Generate custom skill stubs based on project type                 |
| `playbook-architect` | (future — T1241 roadmap) | Generate DAG-shaped playbooks from high-level workflow specs     |

## Invocation

### Via `cleo init --install-seed-agents`

The CLI dispatch layer calls `ensureSeedAgentsInstalled` from
`@cleocode/core/agents/seed-install`. When a project has
`.cleo/project-context.json` and a runnable orchestrator is available, the
installer hands control to `agent-architect` to synthesise customised agents
into `.cleo/cant/agents/`. When the orchestrator is unavailable OR
project-context.json is missing, the installer falls back to the legacy
static-copy behaviour (with variable substitution via
`@cleocode/core/agents/variable-substitution`).

### Via playbook node

Any `.cantbook` playbook may invoke a meta-agent through the standard
agentic-node contract:

```yaml
- id: architect_agents
  type: agentic
  agent: agent-architect
  role: specialist
  inputs:
    projectName: "my-monorepo"
    tier: "2"
```

The playbook runtime dispatches via `AgentDispatcher` (see
`@cleocode/core/playbooks/agent-dispatcher`), which resolves the agent id
across the 5-tier precedence chain:

```
meta > project > global > packaged > fallback
```

## Safety & Constraints

1. **No circular synthesis** — a meta-agent MUST NOT invoke another meta-agent
   synchronously during its own run. Downstream meta-agents are scheduled via
   separate playbook nodes.
2. **Fail-closed** — when agent-architect errors out, the caller falls back to
   static seed-agents; project init never silently produces an empty agent
   directory.
3. **Manifest-audited** — every synthesised agent appends a
   `pipeline.manifest` row with `type: agent_created`, allowing
   `cleo manifest list --type=agent_created` to reproduce synthesis history.

See [ADR-055](../../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md)
for the full architectural rationale.
