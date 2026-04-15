# @cleocode/agents

CLEO agent protocols and templates.

## Overview

This package contains agent protocols, templates, and base configurations for CLEO subagents. These agents follow standardized protocols to ensure consistency and compliance when working within the CLEO ecosystem.

## What are CLEO Agents?

CLEO Agents are specialized AI workers that:
- Follow standardized protocols (LOOM methodology)
- Work within the CLEO task management system
- Produce outputs in defined formats
- Maintain compliance with CLEO constraints
- Communicate through structured channels

## Installation

```bash
npm install @cleocode/agents
```

```bash
pnpm add @cleocode/agents
```

```bash
yarn add @cleocode/agents
```

## Available Agents

### cleo-subagent

The base protocol for all CLEO subagents. Every subagent in the CLEO ecosystem extends this foundation.

**File**: `cleo-subagent/AGENT.md`

#### Key Features

- **Protocol Compliance**: Follows RFC 2119 constraint definitions
- **LOOM Lifecycle**: Implements Logical Order of Operations Methodology
- **Structured Output**: Writes to files, returns only summaries
- **Manifest Integration**: Automatically appends to MANIFEST.jsonl

#### Immutable Constraints (RFC 2119)

| ID | Rule | Enforcement |
|----|------|-------------|
| BASE-001 | **MUST** append ONE line to MANIFEST.jsonl | Required |
| BASE-002 | **MUST NOT** return content in response | Required |
| BASE-003 | **MUST** complete task via `cleo complete` | Required |
| BASE-004 | **MUST** write output file before manifest | Required |
| BASE-005 | **MUST** set focus before starting work | Required |
| BASE-006 | **MUST NOT** fabricate information | Required |
| BASE-007 | **SHOULD** link research to task | Recommended |

#### LOOM Lifecycle Protocol

The **LOOM** (Logical Order of Operations Methodology) is the systematic framework for processing project threads through the RCASD-IVTR+C pipeline.

**Phase 1: Spawn (Initialization)**

```bash
# 1. Read task context
cleo show {{TASK_ID}}

# 2. Start task (marks task active)
cleo start {{TASK_ID}}
```

**Phase 2: Execute (Skill-Specific)**

Follow the injected skill protocol for the current LOOM stage:
- **Research**: Gather information, cite sources
- **Consensus**: Validate claims, vote
- **Specification**: Write RFC 2119 spec
- **Decomposition**: Break down into tasks
- **Implementation**: Write code
- **Validation**: Verify compliance
- **Testing**: Write BATS tests
- **Contribution**: Track attribution
- **Release**: Version and changelog

**Phase 3: Output (Mandatory)**

```bash
# 1. Write output file
# Location: {{OUTPUT_DIR}}/{{TASK_ID}}-<slug>.md

# 2. Append manifest entry (single line JSON)
echo '{"id":"{{TASK_ID}}-slug",...}' >> {{MANIFEST_PATH}}

# 3. Complete task
cleo complete {{TASK_ID}}
```

**Phase 4: Return (Summary Only)**

Return ONLY one of these messages:
- `"[Type] complete. See MANIFEST.jsonl for summary."`
- `"[Type] partial. See MANIFEST.jsonl for details."`
- `"[Type] blocked. See MANIFEST.jsonl for blocker details."`

**NEVER** return content in the response. All content goes to output files.

#### Token Reference

**Required Tokens:**
| Token | Description | Example |
|-------|-------------|---------|
| `{{TASK_ID}}` | Current task identifier | `T1234` |
| `{{DATE}}` | Current date (ISO) | `2026-01-29` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `auth-research` |

**Optional Tokens:**
| Token | Default | Description |
|-------|---------|-------------|
| `{{EPIC_ID}}` | `""` | Parent epic ID |
| `{{OUTPUT_DIR}}` | `.cleo/agent-outputs` | Output directory |
| `{{MANIFEST_PATH}}` | `{{OUTPUT_DIR}}/MANIFEST.jsonl` | Manifest location |

#### Error Handling

**Status Classification:**

| Status | Condition | Action |
|--------|-----------|--------|
| `complete` | All objectives achieved | Write full output |
| `partial` | Some objectives achieved | Write partial, populate `needs_followup` |
| `blocked` | Cannot proceed | Document blocker, do NOT complete task |

**Retryable Errors:**

Exit codes 7, 20, 21, 22, 60-63 support retry with exponential backoff.

#### Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Returning content | Bloats orchestrator context | Write to file, return summary |
| Pretty-printed JSON | Multiple lines in manifest | Single-line JSON only |
| Skipping start | Protocol violation | Always `cleo start` first |
| Loading skills via `@` | Cannot resolve | Skills injected by orchestrator |

## Agent Structure

Agents in this package follow a standardized structure:

```
agents/
├── <agent-name>/
│   ├── AGENT.md          # Main agent definition
│   ├── protocols/        # Protocol-specific docs
│   ├── templates/        # Output templates
│   └── examples/         # Example outputs
```

## Using Agents

### From Skills

Skills can spawn agents using the orchestration API:

```typescript
import { orchestration } from '@cleocode/core';

await orchestration.spawn({
  agent: 'cleo-subagent',
  taskId: 'T1234',
  context: {
    skill: 'ct-research-agent',
    topic: 'authentication patterns'
  }
});
```

### From CLI

Spawn agents directly from the command line:

```bash
# Spawn a research agent
cleo orchestrate spawn --agent cleo-subagent --task T1234 --skill ct-research-agent

# Spawn with context
cleo orchestrate spawn --agent cleo-subagent --task T1234 --context '{"topic":"API design"}'
```

### From MCP

Use the MCP server to spawn agents:

```json
{
  "domain": "orchestrate",
  "operation": "spawn",
  "params": {
    "agent": "cleo-subagent",
    "taskId": "T1234",
    "context": {
      "skill": "ct-implementation"
    }
  }
}
```

## Creating Custom Agents

To create a custom agent that extends the base protocol:

1. **Create agent directory**:
   ```bash
   mkdir -p agents/my-custom-agent
   ```

2. **Create AGENT.md**:
   ```markdown
   ---
   name: my-custom-agent
   description: |
     Custom agent for specialized tasks. Extends cleo-subagent base protocol.
   model: sonnet
   allowed_tools:
     - Read
     - Write
     - Bash
   ---
   
   # My Custom Agent
   
   Extends [cleo-subagent](./cleo-subagent/AGENT.md).
   
   ## Additional Constraints
   
   | ID | Rule | Enforcement |
   |----|------|-------------|
   | CUST-001 | **MUST** validate output format | Required |
   
   ## Specialization
   
   This agent specializes in [your domain].
   
   ## Usage
   
   ```bash
   cleo orchestrate spawn --agent my-custom-agent --task T1234
   ```
   ```

3. **Register the agent**:
   ```typescript
   import { agents } from '@cleocode/core';
   
   agents.register({
     name: 'my-custom-agent',
     path: './agents/my-custom-agent',
     baseProtocol: 'cleo-subagent'
   });
   ```

## Agent Protocols

### Base Protocol

All agents extend the `cleo-subagent` base protocol which provides:

- **Constraint System**: RFC 2119 (MUST, SHOULD, MAY) rules
- **Lifecycle Management**: LOOM phases (Spawn, Execute, Output, Return)
- **Output Standards**: File-based outputs with manifest tracking
- **Error Handling**: Standardized status classification
- **Token System**: Template variables for dynamic content

### Protocol Inheritance

```
cleo-subagent (base)
    │
    ├── research-subagent
    │       └── Extends with research-specific constraints
    │
    ├── implementation-subagent
    │       └── Extends with coding-specific constraints
    │
    └── validation-subagent
            └── Extends with compliance-specific constraints
```

### Protocol Compliance

Agents are validated for protocol compliance:

```typescript
import { compliance } from '@cleocode/core';

// Validate agent definition
const result = await compliance.validateAgent({
  agentPath: './agents/my-agent',
  baseProtocol: 'cleo-subagent'
});

if (result.valid) {
  console.log('Agent is protocol compliant ✓');
} else {
  console.log('Compliance issues:', result.issues);
}
```

## Integration with Skills

Agents work closely with skills:

- **Skills provide**: Capabilities, instructions, constraints
- **Agents provide**: Execution context, protocol compliance, output handling

Example workflow:

```
1. Orchestrator identifies need for research
2. Loads ct-research-agent skill
3. Spawns cleo-subagent with research skill injected
4. Agent follows LOOM phases
5. Research skill guides information gathering
6. Agent writes output, appends to manifest
7. Returns summary to orchestrator
```

## Dependencies

This package has no runtime dependencies. It contains only:
- Agent protocol definitions (markdown)
- Template files
- Example outputs

## License

MIT License - see [LICENSE](../LICENSE) for details.
