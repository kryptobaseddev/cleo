# Subagent Protocol Block

Include this block in EVERY subagent prompt spawned via Task tool. It matches the
spawn prompt's Return Format Contract and Manifest Protocol blocks (T12521).

## Standard Protocol Block

````
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT:
1. MUST record findings: `cleo docs add {{TASK_ID}} --content - --type <kind> --slug {{TOPIC_SLUG}}`. Never a raw file under `.cleo/agent-outputs/`.
2. MUST append ONE entry to SQLite `pipeline_manifest` (ADR-027/T1093) and read it back:
   ENTRY_ID=$(cleo manifest append --task {{TASK_ID}} --type <protocol> \
     --content "<work, commits, gates>" --status completed \
     --field /data/entryId) || exit 1
   [ -n "$ENTRY_ID" ] || exit 1
   cleo manifest show "$ENTRY_ID" >/dev/null || exit 1
   `--status`: completed, partial or blocked (actual progress). Do not append again to verify.
3. MUST NOT return research content, findings, diffs or prose.
4. MUST return EXACTLY this block, nothing else:
   <Type> <complete|partial|blocked>. manifest:<entryId>
   commits: <sha7,sha7|none>
   gates: <gate>=<pass|fail|skip> ...
   blocker: <≤12 words|none>
   blocker: none when complete; required when partial/blocked.
   Append or readback failed → `<Type> blocked. manifest:none` + `blocker: manifest append failed`. Never claim an entry you did not read back.

HITL: never ask the human. Return `<Type> blocked. manifest:<entryId>` + blocker: with {question, options[{label,description}], recommended} in the manifest; the orchestrator asks via the ask tool.
````

## Usage

When spawning a subagent via Task tool:

1. Start with the protocol block above
2. Add task context (epic, dependencies, previous findings)
3. Define specific deliverables
4. Set clear completion criteria

## Example Subagent Prompt

````
You are the {ROLE} subagent. Your job is to complete CLEO task {TASK_ID}.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)
<Standard Protocol Block above, with {{TASK_ID}} and --type filled in>

## CONTEXT
- Epic: {EPIC_ID} ({EPIC_TITLE})
- Your Task: {TASK_ID} ({TASK_TITLE})
- Depends on: {DEPENDENCY_IDS}

## REFERENCE FROM PREVIOUS RESEARCH (key_findings):
{PREVIOUS_KEY_FINDINGS}

## YOUR TASK
{DETAILED_INSTRUCTIONS}

BEGIN EXECUTION.
````

Example return:

```
Research complete. manifest:T1599-research-20260929
commits: none
gates: implemented=pass
blocker: none
```

## Rich Manifest Entry

The shorthand above is preferred. The rich form is
`cleo manifest append --entry '<json>'`, captured and read back the same way
(`ENTRY_ID=$(cleo manifest append --entry '<json>' --field /data/entryId)`, same guard).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Unique id, e.g. `T1599-research-<YYYYMMDDHHMMSS>` |
| file | string | Yes | Output path |
| title | string | Yes | Headline, max 120 chars |
| date | string | Yes | `YYYY-MM-DD` |
| status | string | Yes | `completed`, `partial` or `blocked` |
| agent_type | string | Yes | Protocol type (`research`, `consensus`, ...) |
| topics | array | Yes | Topic tags |
| actionable | boolean | Yes | Needs follow-up action |
| key_findings | array | No | Summary points (max 5) |
| needs_followup | array | No | Task IDs requiring followup |
| linked_tasks | array | No | Task IDs; the first becomes the manifest task id |

Missing required fields → `E_VALIDATION_FAILED`. Link tasks via `linked_tasks[]`, not `task_id`.
