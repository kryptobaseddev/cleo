# @cleocode/skills

CLEO skill definitions - bundled capabilities for AI agents.

## Overview

This package contains pre-built skills and capabilities that extend CLEO agents with specialized functionality. Skills define what an agent can do and how it should do it.

## What are CLEO Skills?

Skills are modular capability packages that:
- Define specific tasks an agent can perform
- Provide detailed instructions and workflows
- Include constraints and best practices
- Extend the base agent protocols
- Are injected at spawn time by orchestrators

## Installation

```bash
npm install @cleocode/skills
```

```bash
pnpm add @cleocode/skills
```

```bash
yarn add @cleocode/skills
```

## Included Skills

Tiers and install behaviour come from each SKILL.md's `metadata` (owner decision
D11157). `packages/skills/skills/manifest.json` is generated from them by
`node scripts/skills/generate-manifest.mjs`; gates 29-31 keep the manifest,
installability and every documented `cleo` command honest.

### Core (installed to every harness, always relevant)

| Skill | Purpose |
|-------|---------|
| **ct-cleo** | CLEO task management protocol - session, task, and workflow guidance. |
| **ct-dev-workflow** | Development workflow orchestration for task-driven development with atomic commits, conventional commit messag… |
| **ct-documentor** | Documentation coordinator with CLEO style guide compliance. |
| **ct-lead** | Phase Lead orchestration playbook for spawning and supervising a parallel worker swarm in one wave. |
| **ct-orchestrator** | Pipeline-aware orchestration skill for managing complex workflows through subagent delegation. |
| **ct-task-executor** | General implementation task execution for completing assigned CLEO tasks by following instructions and produci… |

### On demand (installed; loaded by description or by stage guidance)

| Skill | Purpose |
|-------|---------|
| **ct-adr-recorder** | Records Architecture Decision Records from accepted consensus verdicts. |
| **ct-artifact-publisher** | Builds and publishes artifacts to registries (npm, PyPI, cargo, docker, GitHub releases, generic tarballs) fol… |
| **ct-codebase-mapper** | Orient in an unfamiliar or large codebase with CLEO's code-intelligence graph (cleo nexus) and project map (cl… |
| **ct-consensus-voter** | Runs structured multi-agent voting for decision tasks with confidence scores, conflict detection, and HITL esc… |
| **ct-contribution** | Guided workflow for multi-agent consensus contributions. |
| **ct-council** | Convene "The Council" — a 5-advisor, shuffled gate-based peer-review, chairman-synthesis workflow for reviewin… |
| **ct-epic-architect** | Epic planning and task decomposition for breaking down large initiatives into atomic, executable tasks. |
| **ct-ivt-looper** | Runs a project-agnostic autonomous Implement-then-Validate-then-Test compliance loop on any git worktree. |
| **ct-provenance-keeper** | Generates in-toto v1 attestations, SLSA-level provenance records, SBOMs (CycloneDX or SPDX), and sigstore/cosi… |
| **ct-release-orchestrator** | Orchestrates the canonical 4-verb release pipeline introduced by SPEC-T9345: cleo release plan, then cleo rele… |
| **ct-research-agent** | Multi-source research and investigation combining web search, documentation lookup via Context7, and codebase … |
| **ct-spec-writer** | Technical specification writing using RFC 2119 language for clear, unambiguous requirements. |
| **ct-validator** | Compliance validation for verifying systems, documents, or code against requirements, schemas, or standards. |

### Internal (CLEO development only; never installed to a harness)

| Skill | Purpose |
|-------|---------|
| **ct-grade** | CLEO session grading and A/B behavioral analysis with token tracking. |
| **ct-skill-author** | Create, improve and validate CLEO skills. |

Merged or retired in T12649: ct-docs-write and ct-docs-review are references of
ct-documentor; ct-memory and ct-stickynote are references of ct-cleo;
ct-skill-creator and ct-skill-validator became ct-skill-author; ct-docs-lookup
(use the Context7 MCP) and ct-master-tac were retired; signaldock-connect moved
to the SignalDock repository.

## Skill Structure

Each skill follows a standardized structure:

```
skills/
├── <skill-name>/
│   ├── SKILL.md              # Main skill definition (required)
│   ├── README.md             # User documentation (optional)
│   ├── INSTALL.md            # Installation guide (optional)
│   ├── agents/               # Specialized agent definitions
│   │   ├── analyzer.md
│   │   └── executor.md
│   ├── references/           # Reference documentation
│   │   ├── patterns.md
│   │   └── examples.md
│   └── assets/               # Assets and templates
│       └── template.md
```

## Using Skills

### From CLI

```bash
# Load a skill
cleo skills load ct-research-agent

# Use skill with a task
cleo skills apply ct-research-agent --task T1234

# List available skills
cleo skills list

# Show skill details
cleo skills show ct-research-agent
```

### From Code

```typescript
import { skills } from '@cleocode/core';

// Load a skill
const skill = await skills.load('ct-research-agent');

// Apply skill to a task
await skills.apply({
  skill: 'ct-research-agent',
  taskId: 'T1234',
  context: { topic: 'API design patterns' }
});

// Get skill information
const info = await skills.get('ct-codebase-mapper');
console.log(info.description);
console.log(info.capabilities);
```

### From Agents

Skills are automatically injected when spawning agents:

```typescript
import { orchestration } from '@cleocode/core';

// Skill is injected based on task context
await orchestration.spawn({
  agent: 'cleo-subagent',
  taskId: 'T1234',
  skill: 'ct-implementation' // Injected at spawn
});
```

## Skill Definition Format

Skills are defined in SKILL.md files with YAML frontmatter:

```markdown
---
id: ct-example-skill
name: Example Skill
description: |
  Multi-line description of what this skill does
  and when to use it.
version: 1.0.0
author: CLEO Team
tags:
  - development
  - example
dependencies:
  - ct-cleo
allowed_tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - WebFetch
  - WebSearch
---

# Example Skill

## Overview

Detailed explanation of the skill's purpose and usage.

## Capabilities

- **Capability 1**: Description
- **Capability 2**: Description

## Workflow

1. **Step 1**: Description
2. **Step 2**: Description
3. **Step 3**: Description

## Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| EX-001 | **MUST** follow constraint | Required |
| EX-002 | **SHOULD** consider guideline | Recommended |

## Examples

### Example 1: Basic Usage

```bash
# Command example
```

### Example 2: Advanced Usage

```bash
# Advanced command example
```

## References

- [Related Documentation](path/to/docs.md)
- [Pattern Guide](path/to/patterns.md)
```

## Creating Custom Skills

### 1. Create Skill Directory

```bash
mkdir -p skills/my-custom-skill
```

### 2. Create SKILL.md

```markdown
---
id: my-custom-skill
name: My Custom Skill
description: |
  Description of what this skill does.
version: 1.0.0
author: Your Name
tags:
  - custom
  - specialized
allowed_tools:
  - Read
  - Write
  - Bash
---

# My Custom Skill

## Purpose

Explain what this skill does and when to use it.

## Workflow

1. Analyze the task
2. Execute the work
3. Validate the output

## Output Format

Describe expected output format.
```

### 3. Register the Skill

```typescript
import { skills } from '@cleocode/core';

skills.register({
  id: 'my-custom-skill',
  path: './skills/my-custom-skill',
  version: '1.0.0'
});
```

## Skill Validation

Validate skills before distribution:

```bash
# Validate a skill
cleo skills validate my-custom-skill

# Or programmatically
import { skills } from '@cleocode/core';

const result = await skills.validate('my-custom-skill');
if (result.valid) {
  console.log('Skill is valid ✓');
} else {
  console.log('Issues:', result.issues);
}
```

## Skill Categories

Skills are organized by category:

### Development Skills
- Codebase mapping and analysis
- Implementation guidance
- Testing strategies

### Research Skills
- Information gathering
- Documentation lookup
- Multi-source synthesis

### Orchestration Skills
- Multi-agent coordination
- Workflow management
- Consensus building

### Quality Skills
- Code review
- Documentation review
- Compliance checking

### Domain Skills
- Framework-specific guidance
- Platform integration
- Tool expertise

## Skill Dependencies

Skills can depend on other skills:

```yaml
# In SKILL.md frontmatter
dependencies:
  - ct-cleo          # Base CLEO operations
  - ct-research-agent # Research capabilities
  - ct-validator     # Validation support
```

Dependencies are automatically loaded when a skill is applied.

## Skill Chaining

Skills can be chained together:

```typescript
import { skills } from '@cleocode/core';

// Chain multiple skills
await skills.chain([
  { skill: 'ct-research-agent', taskId: 'T1234' },
  { skill: 'ct-spec-writer', taskId: 'T1235' },
  { skill: 'ct-epic-architect', taskId: 'T1236' }
]);
```

## Skill Profiles

Group skills into profiles for different roles:

```yaml
# profiles/backend-developer.yaml
name: Backend Developer
skills:
  - ct-codebase-mapper
  - ct-research-agent
  - ct-spec-writer
  - drizzle-orm
  - ct-dev-workflow
```

Use profiles:

```bash
cleo skills apply-profile backend-developer --task T1234
```

## Shared Resources

Common patterns and utilities in `skills/_shared/`:

- `manifest-operations.md` - Working with pipeline_manifest via cleo manifest CLI
- `subagent-protocol-base.md` - Base subagent protocols
- `skill-chaining-patterns.md` - Chaining best practices
- `testing-framework-config.md` - Test configuration
- `task-system-integration.md` - Task system integration
- `cleo-style-guide.md` - CLEO documentation style

## Integration with Agents

Skills and agents work together:

1. **Orchestrator** identifies task requirements
2. **Selects appropriate skill** based on task type
3. **Spawns agent** with skill injected
4. **Agent follows** skill instructions
5. **Skill guides** execution within agent framework

Example:

```
Task: "Research authentication patterns"
  ↓
Orchestrator selects: ct-research-agent skill
  ↓
Spawns: cleo-subagent with ct-research-agent injected
  ↓
Agent follows LOOM protocol
  ↓
Skill guides research methodology
  ↓
Output: Research report written to file
```

## Dependencies

This package has no runtime dependencies. It contains:
- Skill definitions (markdown files)
- Reference documentation
- Configuration templates
- Example outputs

## License

MIT License - see [LICENSE](../LICENSE) for details.
