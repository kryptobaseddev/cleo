# CLEO Domain Operation Reference for A/B Testing

**Source**: `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
**Purpose**: Lists the key operations to test in A/B comparisons.

All operations use the CLI (`cleo` / `cleo-dev`). There is no MCP interface.

---

## CLI Operations by Domain

For each domain, these are the canonical operations to test in A/B mode.

### tasks (32 operations)

| Test Op | CLI |
|---------|-----|
| Discovery | `cleo-dev find --status active` |
| Show detail | `cleo-dev show T123` |
| List children | `cleo-dev list --parent T100` |
| Create | `cleo-dev add "title" --description "..."` |
| Update | `cleo-dev update T123 --status active` |
| Complete | `cleo-dev complete T123` |
| Exists check | `cleo-dev exists T123` |

**Key S2 insight**: `cleo-dev find` counts toward find:list ratio in the audit log. Always prefer find over list for discovery.

### session (19 operations)

| Test Op | CLI |
|---------|-----|
| Check existing | `cleo-dev session list` |
| Start | `cleo-dev session start --grade --scope global` |
| End | `cleo-dev session end` |
| Status | `cleo-dev session status` |
| Record decision | `cleo-dev session record-decision --decision "..." --rationale "..."` |

**Critical**: `session.list` is what the rubric checks for S1. It must appear as `domain='session', operation='list'` in the audit log.

### memory (18 operations) -- Tier 1

| Test Op | CLI |
|---------|-----|
| Search | `cleo-dev memory find "authentication"` |
| Store observation | `cleo-dev observe "..."` |
| Timeline | `cleo-dev memory timeline <id>` |

### admin (44 operations)

| Test Op | CLI |
|---------|-----|
| Dashboard | `cleo-dev dash` |
| Help (S5 key) | `cleo-dev help` |
| Grade session | `cleo-dev check grade --session "<id>"` |
| Health check | `cleo-dev health` |

**Critical for S5**: `cleo-dev help` satisfies the `helpCalls` filter in S5 Progressive Disclosure scoring.

### pipeline (42 operations) -- LOOM system

| Test Op | CLI |
|---------|-----|
| Stage status | `cleo-dev pipeline stage.status --epic <id>` |
| Stage validate | `cleo-dev pipeline stage.validate --epic <id> --stage <stage>` |
| Manifest list | `cleo-dev manifest list` |

### check (19 operations)

| Test Op | CLI |
|---------|-----|
| Test status | `cleo-dev check test-status` |
| Protocol check | `cleo-dev check protocol` |
| Compliance | `cleo-dev check compliance` |

### orchestrate (19 operations)

| Test Op | CLI |
|---------|-----|
| Status | `cleo-dev orchestrator status` |
| Waves | `cleo-dev orchestrator waves` |

### tools (32 operations)

| Test Op | CLI |
|---------|-----|
| Skill list (S5 key) | `cleo-dev skill list` |
| Skill show (S5 key) | `cleo-dev skill show ct-cleo` |

**S5 note**: `tools.skill.list` and `tools.skill.show` count toward S5 helpCalls filter.

---

## A/B Configuration Test Examples

### Quick A/B: Tasks Domain

**Goal**: Compare two configurations for core task operations.
**Operations to execute (both arms)**:
1. `cleo-dev session list` -- S1
2. `cleo-dev find --status active` -- S2
3. `cleo-dev show <valid-id>` -- S2
4. `cleo-dev session end` -- S1

### Standard A/B: Full Protocol (S4)

**Goal**: Full lifecycle scenario through both configurations.
**Operations**: Follow S4 scenario (10 ops including admin.help).
**Expected**: 100/100 for protocol-complete arm

### Targeted A/B: S5 Isolation

**Goal**: Specifically measure the S5 (progressive disclosure) gap.
**Operations** -- same except arm A calls `admin.help`, arm B does not:

Arm A (with help):
```bash
cleo-dev session list && cleo-dev help && cleo-dev find --status active && cleo-dev session end
```

Arm B (no help call):
```bash
cleo-dev session list && cleo-dev find --status active && cleo-dev session end
```

**Expected**: Arm A S5 = 20/20, Arm B S5 = 10/20

---

## Tier Notes

- **Tier 0 ops**: Available to all agents without admin.help (tasks, session, check, pipeline, orchestrate, tools, admin, sticky)
- **Tier 1 ops**: Require `admin.help --tier 1` first (memory, manifest, advanced session)
- **Tier 2 ops**: Require `admin.help --tier 2` (nexus, admin advanced, cross-project)

In A/B tests, tier 1+ operations should only appear if the scenario explicitly escalates via admin.help. Otherwise the agent should not have discovered them.
