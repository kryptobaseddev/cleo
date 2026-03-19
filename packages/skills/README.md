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

### Core Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-codebase-mapper** | Analysis | Maps project structure, stack, and architecture |
| **ct-memory** | Memory | Manages persistent knowledge storage and retrieval |
| **ct-orchestrator** | Orchestration | Coordinates multi-agent workflows and spawning |
| **ct-task-executor** | Execution | General task execution with protocol compliance |
| **ct-validator** | Validation | Validates compliance against rules and schemas |

### Research Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-research-agent** | Research | Multi-source research aggregation and synthesis |
| **ct-epic-architect** | Planning | Epic decomposition and task planning |
| **ct-spec-writer** | Specification | RFC 2119 technical specification writing |
| **ct-docs-lookup** | Documentation | Library and framework documentation queries |

### Documentation Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-documentor** | Documentation | Documentation creation and management |
| **ct-docs-write** | Writing | User-facing documentation writing |
| **ct-docs-review** | Review | Documentation style guide compliance |

### Workflow Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-dev-workflow** | Development | Git workflows, commits, releases |
| **ct-contribution** | Contribution | Multi-agent consensus contributions |
| **ct-skill-creator** | Skill Dev | Creating and validating CLEO skills |
| **ct-skill-validator** | Validation | Skill compliance validation |

### Quality Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-grade** | Grading | Session quality evaluation |
| **ct-grade-v2-1** | Grading V2 | Enhanced grading with scenarios |
| **ct-stickynote** | Notes | Quick ephemeral sticky notes |

### Integration Skills

| Skill | Purpose | Description |
|-------|---------|-------------|
| **ct-cleo** | CLEO | Task management protocol operations |

### Specialized Skills

Additional skills for specific domains:
- **better-auth-svelte** - Better-Auth with SvelteKit
- **drizzle-orm** - Drizzle ORM guidance
- **expo-production-deploy** - Expo app deployment
- **flarectl** - Cloudflare CLI management
- **github-guru** - GitHub workflows
- **neonctl** - Neon Postgres CLI
- **payment-provider-oauth** - Payment provider OAuth
- **railway** - Railway infrastructure
- **resend** - Resend email API
- **svelte5-sveltekit** - Svelte 5 development
- **yt-dlp-webapp** - YouTube download backends

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

- `manifest-operations.md` - Working with MANIFEST.jsonl
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
