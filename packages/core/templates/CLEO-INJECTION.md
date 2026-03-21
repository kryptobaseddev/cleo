# CLEO Protocol

Version: 2.1.0
Status: ACTIVE

## Runtime Environment

<!-- CleoOS injects CLEO_RUNTIME=cleoos when launching agents from a workspace -->
<!-- When this variable is absent, assume standalone CLI mode -->

**Mode**: `${CLEO_RUNTIME:-standalone}`

### Channel Preference

| Runtime | Primary Channel | Fallback | Rationale |
|---------|----------------|----------|-----------|
| `standalone` | CLI (`cleo <command>`) | MCP (query/mutate) | CLI is cheaper (fewer tokens), more reliable, and baked into core |
| `cleoos` | Workspace-provided | CLI | CleoOS workspace manages channel routing via capability matrix |

When running in **standalone** mode (the default):
- Prefer CLI commands over MCP tool calls for all CLEO operations
- CLI commands are shorter, use fewer tokens, and bypass the MCP dispatch layer
- Use MCP only when the provider does not support shell execution

When running in **CleoOS** mode:
- Follow the workspace-provided channel routing preferences
- CleoOS manages the capability matrix and optimal channel selection
- This mode is a work-in-progress — fall back to CLI if unsure

## CLEO Identity

You are a CLEO protocol agent. CLEO operations are available via CLI (primary) and MCP (fallback):
- CLI: `cleo <command> [args]` — preferred for token efficiency (flat commands, not domain-prefixed)
- MCP: `query`/`mutate` gateways with `{domain, operation, params}` — use when CLI is unavailable

## Mandatory Efficiency Sequence

Run cheapest-first at session start:
1. `cleo session status` — resume existing? (~200 tokens)
2. `cleo dash` — project overview (~500 tokens)
3. `cleo current` — active task? (~100 tokens)
4. `cleo next` — what to work on (~300 tokens)
5. `cleo show {id}` — full details for chosen task (~400 tokens)

## Agent Work Loop

Repeat until session ends:
1. `cleo current` or `cleo next` → pick task
2. `cleo show {id}` → read requirements
3. Do the work (code, test, document)
4. `cleo complete {id}` → mark done
5. `cleo next` → continue or end session

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

## Session Quick Reference

| Goal | CLI (Primary) | MCP (Fallback) |
|------|--------------|----------------|
| Check active session | `cleo session status` | `query session status` |
| Resume context | `cleo briefing` | `query session briefing.show` |
| Start working | `cleo session start --scope global` | `mutate session start {scope: "global"}` |
| Stop working | `cleo session end` | `mutate session end` |

For advanced session ops (find, suspend, resume, debrief, decisions): see `.cleo/agent-outputs/T5124-session-decision-tree.md`

**Budget note**: `session list` defaults to 10 results (~500-2000 tokens). Prefer `session find` for discovery (~200-400 tokens).

## Memory Protocol

CLEO includes a native BRAIN memory system. Use the 3-layer retrieval pattern for token-efficient access:

| Step | Operation | Gateway | ~Tokens | Purpose |
|------|-----------|---------|---------|---------|
| 1 | `memory find` | query | 50/hit | Search index (IDs + titles) |
| 2 | `memory timeline` | query | 200-500 | Context around an anchor ID |
| 3 | `memory fetch` | query | 500/entry | Full details for filtered IDs |
| Save | `memory observe` | mutate | — | Save observation to brain.db |

**Workflow**: Search first (cheap) → filter interesting IDs → fetch only what you need.

**Example** (CLI):
```
cleo memory find "authentication"
cleo memory fetch O-abc123
cleo observe "Found auth uses JWT" --title "Auth discovery"
```

**Anti-patterns:**
- Fetching all entries without searching first (expensive)
- Skipping memory find and going straight to memory fetch

## Memory Bridge

CLEO auto-generates `.cleo/memory-bridge.md` from brain.db content. This file is `@`-referenced
in AGENTS.md so providers automatically load project memory context at session start.

**Contents**: Last session handoff, key learnings, active patterns, recent decisions, recent observations.

**Refreshes on**: `session.end`, `tasks.complete`, `memory.observe` (decisions), `cleo refresh-memory`.

If the file is missing, run `cleo init` or `cleo refresh-memory` to regenerate it.

## Escalation

For deeper guidance beyond this minimal protocol:
- **Session & lifecycle**: `query admin help` or load `ct-cleo` skill
- **Orchestration**: `query admin help --tier 2` or load `ct-orchestrator` skill
- **Operations reference**: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`

## References

- `docs/specs/CLEO-OPERATIONS-REFERENCE.md`
- `docs/specs/VERB-STANDARDS.md`
