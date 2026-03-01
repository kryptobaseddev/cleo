# CLEO Protocol

Version: 2.1.0
Status: ACTIVE

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

## Escalation

For deeper guidance beyond this minimal protocol:
- **Session & lifecycle**: `cleo_query admin help` or load `ct-cleo` skill
- **Orchestration**: `cleo_query admin help --tier 2` or load `ct-orchestrator` skill
- **Operations reference**: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`

## References

- `docs/specs/CLEO-OPERATIONS-REFERENCE.md`
- `docs/specs/VERB-STANDARDS.md`
