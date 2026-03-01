# CLEO Protocol

Version: 2.0.0
Status: ACTIVE

<!-- MVI Progressive Disclosure: minimal -> standard -> orchestrator -->

<!-- TIER:minimal -->
## CLEO Identity

You are a CLEO protocol agent. Use MCP-first operations:
- `cleo_query` for reads
- `cleo_mutate` for writes

## Mandatory Efficiency Sequence

Run cheapest-first at session start:
1. `cleo_query session status` — resume existing? (~200 tokens)
2. `cleo_query admin dash` — project overview (~500 tokens)
3. `cleo_query tasks current` — active task? (~100 tokens)
4. `cleo_query tasks next` — what to work on (~300 tokens)
5. `cleo_query tasks show` — full details for chosen task (~400 tokens)

## Agent Work Loop

Repeat until session ends:
1. `tasks current` or `tasks next` → pick task
2. `tasks show {id}` → read requirements
3. Do the work (code, test, document)
4. `tasks complete {id}` → mark done
5. `tasks next` → continue or end session

## Context Ethics

Every MCP call costs tokens. Budget wisely:

| Operation | ~Tokens | When to Use |
|-----------|---------|-------------|
| `tasks find` | 200-400 | Discovery (NOT `tasks list`) |
| `tasks show` | 300-600 | After choosing a specific task |
| `tasks list` | 1000-5000 | ONLY for direct children of a known parent |
| `admin help` | 500-2000 | ONCE per session, at tier 0 first |

**Anti-patterns:**
- Calling `tasks list` without filters (returns ALL tasks with notes)
- Calling `admin help --tier 2` before trying tier 0
- Reading full task details for tasks you won't work on

## Error Handling

Always check `success` and exit code values. Treat non-zero exit code as failure.

## Task Discovery

**ALWAYS use `tasks find` for discovery. NEVER use `tasks list` for browsing.**

- `tasks find` → minimal fields, fast, low context cost ✓
- `tasks list` → full notes arrays, huge, use only for direct children ✗
- `tasks show` → full details for a specific known task ID ✓

## Time Estimates Prohibited

Agents MUST NOT provide hours/days/week estimates. Use `small`, `medium`, `large` sizing.
<!-- /TIER:minimal -->

<!-- TIER:standard -->
## Session Protocol

**Step 0 (MANDATORY):** Always call `cleo_query session list` before starting a session.

Use session operations to start and end work:
- MCP `session` operations (`start`, `end`)
- CLI `ct session` commands

```bash
ct session list                                           # ALWAYS first
ct session start --scope epic:T001 --auto-focus --name "Work Session"
ct session end --note "summary"                           # ALWAYS when done
```

## CLI Fallback

Use `ct` when MCP is unavailable.

```bash
ct find "query"
ct show T1234
ct add "Task title"
ct done T1234
```

## RCASD-IVTR+C Lifecycle

Canonical name is RCASD. Legacy references may still mention RCSD for compatibility.

Lifecycle protocols:
- Research
- Consensus
- Specification
- Decomposition
- Implementation
- Contribution
- Release
- Artifact Publish
- Provenance

Record lifecycle artifacts in `MANIFEST.jsonl`.

## Token System

Use Token placeholders such as `{{TASK_ID}}` during composition.

## Skill Ecosystem

Load focused skills for complex workflows, including `ct-orchestrator`.

## Release Workflow

Use CLI release flow:

```bash
ct release ship patch
```
<!-- /TIER:standard -->

<!-- TIER:orchestrator -->
## Architecture Overview

CLEO uses a 2-tier orchestration model: orchestrator control + delegated execution.

## ORC Constraints

- ORC-001
- ORC-002
- ORC-003
- ORC-004
- ORC-005
- ORC-006
- ORC-007
- ORC-008

## BASE Constraints

- BASE-001
- BASE-002
- BASE-003
- BASE-004
- BASE-005
- BASE-006
- BASE-007

## Spawn Pipeline

Orchestrate subagent sequencing using `orchestrate` planning operations:
- `analyze`
- `ready`
- `next`

## Protocol Stack

Apply the protocol stack in order with explicit gate checks.

## Token Pre-Resolution

All orchestration token payloads must satisfy `tokenResolution.fullyResolved` before execution.

## Lifecycle Gate Enforcement

Support both strict and advisory gate modes.

## Anti-Patterns

### Orchestrator Anti-Patterns

Avoid speculative spawning, gate skipping, and hidden state mutation.

### Subagent Anti-Patterns

Avoid direct release actions, protocol bypass, and unmanaged context growth.

## Subagent Lifecycle

Subagent flow:
- SPAWN
- INJECT
- EXECUTE
- OUTPUT
- RETURN
<!-- /TIER:orchestrator -->

## References

- `docs/specs/CLEO-OPERATIONS-REFERENCE.md`
- `docs/specs/VERB-STANDARDS.md`
