# Subagent Protocol Block

Copy and include this block in EVERY subagent prompt spawned via Task tool.

## Standard Protocol Block

```
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: docs/claudedocs/research-outputs/YYYY-MM-DD_{topic}.md
2. MUST append ONE line to: docs/claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

MANIFEST ENTRY FORMAT:
{"id":"YYYY-MM-DD_{topic}","timestamp":"ISO8601","task_id":"TXXXX","agent":"agent-name","status":"complete","key_findings":["finding1","finding2"],"needs_followup":["next-task-id"],"file":"YYYY-MM-DD_{topic}.md"}
```

## Usage

When spawning a subagent via Task tool:

1. Start with the protocol block above
2. Add task context (epic, dependencies, previous findings)
3. Define specific deliverables
4. Set clear completion criteria

## Example Subagent Prompt

```
You are the {ROLE} subagent. Your job is to complete CLEO task {TASK_ID}.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)
OUTPUT REQUIREMENTS:
1. MUST write findings to: docs/claudedocs/research-outputs/YYYY-MM-DD_{topic}.md
2. MUST append ONE line to: docs/claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

## CONTEXT
- Epic: {EPIC_ID} ({EPIC_TITLE})
- Your Task: {TASK_ID} ({TASK_TITLE})
- Depends on: {DEPENDENCY_IDS}

## REFERENCE FROM PREVIOUS RESEARCH (key_findings):
{PREVIOUS_KEY_FINDINGS}

## YOUR TASK
{DETAILED_INSTRUCTIONS}

BEGIN EXECUTION.
```

## Manifest Entry Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Unique identifier (YYYY-MM-DD_{topic}) |
| timestamp | string | Yes | ISO 8601 timestamp |
| task_id | string | Yes | CLEO task ID (e.g., T1599) |
| agent | string | Yes | Agent identifier |
| status | string | Yes | "complete" or "partial" |
| key_findings | array | Yes | Summary points (max 5) |
| needs_followup | array | No | Task IDs requiring followup |
| file | string | Yes | Output filename |
