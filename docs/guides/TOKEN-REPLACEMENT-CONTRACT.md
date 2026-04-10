# Token Replacement Contract

**Version**: 1.0.0
**Status**: ACTIVE
**Task**: T440 (WS-3 Documentation Lead)

This document specifies the token replacement system used in the CLEO subagent injection pipeline. Tokens are placeholders in agent prompts and protocol templates that are resolved at spawn time by the orchestrator.

---

## Token Inventory

### Required Tokens

These tokens MUST be resolved before a subagent can be spawned. Unresolved required tokens block the spawn.

| Token | Type | Pattern/Format | Description | Example |
|-------|------|----------------|-------------|---------|
| `{{TASK_ID}}` | String | `^T[0-9]+$` | Current task identifier | `T1234` |
| `{{DATE}}` | Date | ISO 8601 date | Current date at spawn time | `2026-04-09` |
| `{{TOPIC_SLUG}}` | String | `^[a-z0-9-]+$` | URL-safe topic name derived from task | `auth-research` |

### Optional Tokens

These tokens have default values and do not block spawning if unresolved.

| Token | Type | Default | Description | Example |
|-------|------|---------|-------------|---------|
| `{{EPIC_ID}}` | String | `""` (empty) | Parent epic task ID | `T250` |
| `{{OUTPUT_DIR}}` | Path | `.cleo/agent-outputs` | Directory for output files | `.cleo/agent-outputs` |
| `{{SESSION_ID}}` | String | `""` (empty) | Active session identifier | `ses_20260409...` |

### Computed Tokens

These tokens are derived from other token values at resolution time.

| Token | Formula | Description | Example |
|-------|---------|-------------|---------|
| `{{RESEARCH_ID}}` | `${TOPIC_SLUG}-${DATE}` | Composite ID for research outputs | `auth-research-2026-04-09` |
| `{{OUTPUT_PATH}}` | `${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md` | Full output file path | `.cleo/agent-outputs/2026-04-09_auth-research.md` |

### Inherited Tokens

These tokens are populated from task metadata at spawn time.

| Token | Source | Description |
|-------|--------|-------------|
| `{{TASK_TITLE}}` | `task.title` | Title of the assigned task |
| `{{TASK_DESCRIPTION}}` | `task.description` | Full description of the task |
| `{{TOPICS_JSON}}` | `task.labels` | JSON-serialized array of task labels |

---

## Resolution Timing and Location

### When Tokens Are Resolved

Tokens are resolved at **spawn time** -- the moment the orchestrator calls `prepareSpawn()` and `buildSpawnPrompt()` to construct the system prompt for the subagent.

**File**: `packages/core/src/orchestration/index.ts` (line 213-238)

```typescript
export async function prepareSpawn(taskId, _cwd, accessor): Promise<SpawnContext> {
  const task = await accessor.loadSingleTask(taskId);
  const protocol = autoDispatch(task);
  const prompt = buildSpawnPrompt(task, protocol);
  const unresolvedTokens = findUnresolvedTokens(prompt);

  return {
    taskId,
    protocol,
    prompt,
    tokenResolution: {
      fullyResolved: unresolvedTokens.length === 0,
      unresolvedTokens,
    },
  };
}
```

### Where Tokens Appear in the Prompt

The `buildSpawnPrompt()` function (line 371-397) constructs the raw spawn prompt using task data. Token values are interpolated directly:

```typescript
function buildSpawnPrompt(task: Task, protocol: string): string {
  const epicId = task.parentId ?? 'none';
  const date = new Date().toISOString().split('T')[0];

  return [
    `## Task: ${task.id}`,           // {{TASK_ID}}
    `**Title**: ${task.title}`,       // {{TASK_TITLE}}
    task.description ? `**Description**: ${task.description}` : '',
    `**Protocol**: ${protocol}`,
    `**Epic**: ${epicId}`,            // {{EPIC_ID}}
    `**Date**: ${date}`,              // {{DATE}}
    '',
    `### Instructions`,
    `1. Start task: \`cleo start ${task.id}\``,
    `2. Execute the ${protocol} protocol`,
    `3. Write output file`,
    `4. Append manifest entry to MANIFEST.jsonl`,
    `5. Complete: \`cleo complete ${task.id}\``,
    '',
    task.acceptance?.length
      ? `### Acceptance Criteria\n${task.acceptance.map(a => `- ${a}`).join('\n')}`
      : '',
    task.depends?.length
      ? `### Dependencies\n${task.depends.map(d => `- ${d}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
}
```

### Unresolved Token Detection

The `findUnresolvedTokens()` function scans the prompt for any remaining `{{...}}` patterns. If any are found, the spawn context reports them:

```typescript
tokenResolution: {
  fullyResolved: false,
  unresolvedTokens: ["{{SESSION_ID}}", "{{TOPIC_SLUG}}"]
}
```

### Spawn Blocking on Unresolved Tokens

In `orchestrateSpawnExecute()` (`packages/cleo/src/dispatch/engines/orchestrate-engine.ts`, line 490-498), unresolved tokens block the spawn:

```typescript
if (!spawnContext.tokenResolution.fullyResolved) {
  return {
    success: false,
    error: {
      code: 'E_SPAWN_VALIDATION_FAILED',
      message: `Unresolved tokens in spawn context: ${spawnContext.tokenResolution.unresolvedTokens.join(', ')}`,
      exitCode: 63,
    },
  };
}
```

---

## Token Declaration in `.cant` Files

Agents declare their expected tokens in the `tokens:` section of their `.cant` file.

**File**: `packages/agents/cleo-subagent/cleo-subagent.cant` (line 81-100)

```cant
tokens:
  required:
    TASK_ID: pattern("^T[0-9]+$")
    DATE: date
    TOPIC_SLUG: pattern("^[a-z0-9-]+$")

  optional:
    EPIC_ID: pattern("^T[0-9]+$") = ""
    SESSION_ID: string = ""
    OUTPUT_DIR: path = ".cleo/agent-outputs"

  computed:
    RESEARCH_ID: string = "${TOPIC_SLUG}-${DATE}"
    OUTPUT_PATH: path = "${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md"

  inherited:
    TASK_TITLE: from task.title
    TASK_DESCRIPTION: from task.description
    TOPICS_JSON: from task.labels
```

### Token Types

| Type | Validation | Example |
|------|-----------|---------|
| `pattern("regex")` | Must match the provided regex | `pattern("^T[0-9]+$")` |
| `date` | ISO 8601 date format | `2026-04-09` |
| `string` | Any string value | `ses_20260409...` |
| `path` | File system path | `.cleo/agent-outputs` |

---

## 4-Phase Lifecycle Protocol

The base subagent protocol (`packages/agents/cleo-subagent/AGENT.md`) defines a 4-phase lifecycle that all spawned agents must follow.

### Phase 1: Initialize

```bash
# Worktree guard (MANDATORY -- first tool call)
WORKTREE="$(pwd)"
[ "$WORKTREE" = "$(git rev-parse --show-toplevel)" ] || { echo "WORKTREE GUARD FAILED"; exit 1; }
case "$WORKTREE" in
  /mnt/projects/cleocode/.claude/worktrees/*) ;;
  *) echo "BAD PATH: not in an expected worktree: $WORKTREE"; exit 1 ;;
esac

# Read task details and start
cleo show {{TASK_ID}}
cleo start {{TASK_ID}}
```

The worktree guard ensures the worker is running in an isolated git worktree, preventing the T335 worktree-leak class of bugs where a worker writes to main-repo files.

### Phase 2: Execute (Skill-Specific)

The agent follows the injected skill protocol for the current RCASD-IVTR+C stage:

| Stage | Activity |
|-------|----------|
| Research | Gather information, cite sources |
| Consensus | Validate claims, vote |
| Specification | Write RFC 2119 spec |
| Decomposition | Break down into tasks |
| Implementation | Write code |
| Validation | Verify compliance |
| Testing | Write tests |
| Contribution | Track attribution |
| Release | Version and changelog |

### Phase 3: Output (Mandatory)

Every agent MUST produce output before returning:

1. **Write output file**: To `{{OUTPUT_DIR}}/{{TASK_ID}}-<slug>.md`
2. **Append manifest entry**: Via `pipeline.manifest.append`
3. **Complete task**: Via `cleo complete {{TASK_ID}}`

The manifest entry structure:

```json
{
  "id": "{{TASK_ID}}-<slug>",
  "task_id": "{{TASK_ID}}",
  "type": "research",
  "content": "<summary text>",
  "source_file": "{{OUTPUT_DIR}}/{{TASK_ID}}-<slug>.md",
  "metadata_json": {
    "title": "Human title",
    "actionable": true,
    "needs_followup": []
  }
}
```

### Phase 4: Return (Summary Only)

Return ONLY one of these messages:
- `"[Type] complete. See pipeline manifest for summary."`
- `"[Type] partial. See pipeline manifest for details."`
- `"[Type] blocked. See pipeline manifest for blocker details."`

**NEVER** return content in the response body. All content goes to output files (BASE-002).

---

## Immutable Constraints (BASE-001 through BASE-008)

These constraints are defined in the base subagent protocol and apply to all spawned agents regardless of role.

| ID | Rule | Enforcement |
|----|------|-------------|
| BASE-001 | MUST append ONE entry to pipeline manifest before returning | Required |
| BASE-002 | MUST NOT return content in response | Required |
| BASE-003 | MUST complete task via `cleo complete` (CLI) | Required |
| BASE-004 | MUST write output file before appending manifest entry | Required |
| BASE-005 | MUST start task before beginning work | Required |
| BASE-006 | MUST NOT fabricate information | Required |
| BASE-007 | SHOULD link memory observations to task via `memory.link` | Recommended |
| BASE-008 | MUST check `success` field on every LAFS response before proceeding | Required |

---

## Error Handling in the Lifecycle

### Status Classification

| Status | Condition | Action |
|--------|-----------|--------|
| `complete` | All objectives achieved | Write full output, complete task |
| `partial` | Some objectives achieved | Write partial output, populate `needs_followup` in manifest |
| `blocked` | Cannot proceed | Document blocker in manifest, do NOT complete task |

### Retryable Exit Codes

Exit codes 7, 20, 21, 22, 60-63 support retry with exponential backoff.

### Common Errors

| Error Code | Meaning | Action |
|------------|---------|--------|
| `E_INVALID_OPERATION` | Operation name not in registry | Check canonical name in VERB-STANDARDS.md |
| `E_INVALID_INPUT` | Missing required parameter | Add the required parameter |
| `E_NOT_FOUND` | Entity does not exist | Verify ID with `cleo find` |
| `E_SPAWN_VALIDATION_FAILED` | Unresolved tokens or failed readiness check | Fix token sources or resolve blockers |

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Returning content in response | Bloats orchestrator context | Write to file, return one-line summary |
| Skipping `cleo start` | Protocol violation (BASE-005) | Always start before working |
| Using `memory.brain.*` prefix | Removed in ADR-021 | Use `memory.find`, `memory.observe` |
| Manual JSONL append | No validation, race conditions | Use `pipeline.manifest.append` |
| Fabricating data when memory is empty | Hallucination (BASE-006) | Use `memory.find` first; state uncertainty if unknown |
| Skipping worktree guard | T335 worktree-leak bugs | Always run guard as first Bash call |

---

## Key File Reference

| File | Purpose |
|------|---------|
| `packages/agents/cleo-subagent/AGENT.md` | Base protocol with constraints and lifecycle |
| `packages/agents/cleo-subagent/cleo-subagent.cant` | CANT version with token declarations |
| `packages/core/src/orchestration/index.ts` | `prepareSpawn()`, `buildSpawnPrompt()`, `findUnresolvedTokens()` |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | Token resolution validation before spawn |
| `packages/cant/src/composer.ts` | `AgentDefinition` with token-related context sources |
