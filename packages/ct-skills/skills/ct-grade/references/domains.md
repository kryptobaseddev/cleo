# CLEO Domain Operation Reference for A/B Testing

**Source**: `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
**Purpose**: Lists the key operations to test in MCP vs CLI A/B comparisons.

---

## MCP vs CLI Equivalents

For each domain, these are the canonical operations to test in A/B mode.
MCP gateway = audit metadata.gateway is `'query'` or `'mutate'` (set by MCP adapter).
CLI = operations routed through CLI do NOT set metadata.gateway.

### tasks (32 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Discovery | `query tasks find { "status": "active" }` | `cleo-dev find --status active` |
| Show detail | `query tasks show { "taskId": "T123" }` | `cleo-dev show T123` |
| List children | `query tasks list { "parent": "T100" }` | `cleo-dev list --parent T100` |
| Create | `mutate tasks add { "title": "...", "description": "..." }` | `cleo-dev add --title "..." --description "..."` |
| Update | `mutate tasks update { "taskId": "T123", "status": "active" }` | `cleo-dev update T123 --status active` |
| Complete | `mutate tasks complete { "taskId": "T123" }` | `cleo-dev complete T123` |
| Exists check | `query tasks exists { "taskId": "T123" }` | `cleo-dev exists T123` |

**Key S2 insight**: `tasks.find` (MCP) vs `cleo-dev find` (CLI). Both count toward find:list ratio in the audit log. MCP find at gateway='query', CLI find also logged but without gateway metadata.

### session (19 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Check existing | `query session list` | `cleo-dev session list` |
| Start | `mutate session start { "grade": true, "scope": "global" }` | `cleo-dev session start --grade --scope global` |
| End | `mutate session end` | `cleo-dev session end` |
| Status | `query session status` | `cleo-dev session status` |
| Record decision | `mutate session record.decision { "decision": "...", "rationale": "..." }` | `cleo-dev session record-decision ...` |

**Critical**: `session.list` (MCP) is what the rubric checks for S1. If CLI does `cleo-dev session list`, it still appears as `domain='session', operation='list'` in the audit log. S1 counts it.

### memory (18 operations) — Tier 1

| Test Op | MCP | CLI |
|---------|-----|-----|
| Search | `query memory find { "query": "authentication" }` | `cleo-dev memory find "authentication"` |
| Store observation | `mutate memory observe { "text": "..." }` | `cleo-dev memory observe "..."` |
| Timeline | `query memory timeline { "anchor": "<id>" }` | N/A (MCP-preferred) |

### admin (44 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Dashboard | `query admin dash` | `cleo-dev dash` |
| Help (S5 key) | `query admin help` | `cleo-dev help` |
| Grade session | `query admin grade { "sessionId": "<id>" }` | `cleo-dev grade <id>` |
| Health check | `query admin health` | `cleo-dev health` |

**Critical for S5**: Only `query admin help` (MCP) satisfies the `helpCalls` filter in S5. CLI `cleo-dev help` does NOT set `metadata.gateway='query'` or match `domain='admin', operation='help'` — it depends on how the CLI routes internally.

### pipeline (42 operations) — LOOM system

| Test Op | MCP | CLI |
|---------|-----|-----|
| Stage status | `query pipeline stage.status` | `cleo-dev pipeline status` |
| Stage validate | `query pipeline stage.validate` | `cleo-dev pipeline validate` |
| Manifest list | `query pipeline manifest.list` | `cleo-dev pipeline manifest list` |

### check (19 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Test status | `query check test.status` | `cleo-dev check test-status` |
| Protocol check | `query check protocol` | `cleo-dev check protocol` |
| Compliance | `query check compliance.summary` | `cleo-dev check compliance` |

### orchestrate (19 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Status | `query orchestrate status` | `cleo-dev orchestrate status` |
| Waves | `query orchestrate waves` | `cleo-dev orchestrate waves` |

### tools (32 operations)

| Test Op | MCP | CLI |
|---------|-----|-----|
| Skill list (S5 key) | `query tools skill.list` | `cleo-dev tools skill list` |
| Skill show (S5 key) | `query tools skill.show { "skillId": "ct-cleo" }` | `cleo-dev tools skill show ct-cleo` |

**S5 note**: `tools.skill.list` and `tools.skill.show` via MCP count toward S5 helpCalls filter.

---

## A/B Domain Test Configurations

### Quick A/B: Tasks Domain

**Goal**: Compare MCP vs CLI for core task operations.
**Operations to execute (both interfaces)**:
1. `session list` — S1
2. `tasks find { "status": "active" }` — S2
3. `tasks show { "taskId": "<valid-id>" }` — S2
4. `session end` — S1

**Expected score difference**: MCP ~30/100 vs CLI ~20/100 (S5 is 0 for CLI)

### Standard A/B: Full Protocol (S4)

**Goal**: Full lifecycle scenario through both interfaces.
**Operations**: Follow S4 scenario (10 ops including admin.help).
**Expected**: MCP 100/100, CLI ~80/100

### Targeted A/B: S5 Isolation

**Goal**: Specifically measure the S5 (progressive disclosure) gap.
**Operations** — same except arm A calls `admin.help`, arm B does not:

Arm A (MCP + help):
```
query session list → query admin help → query tasks find → mutate session end
```

Arm B (CLI — no help call):
```
cleo-dev session list → cleo-dev find → cleo-dev session end
```

**Expected**: Arm A S5 = 20/20, Arm B S5 = 0/20

---

## Tier Notes

- **Tier 0 ops**: Available to all agents without admin.help (tasks, session, check, pipeline, orchestrate, tools, admin, sticky)
- **Tier 1 ops**: Require `admin.help --tier 1` first (memory, manifest, advanced session)
- **Tier 2 ops**: Require `admin.help --tier 2` (nexus, admin advanced, cross-project)

In A/B tests, tier 1+ operations should only appear if the scenario explicitly escalates via admin.help. Otherwise the agent should not have discovered them.
