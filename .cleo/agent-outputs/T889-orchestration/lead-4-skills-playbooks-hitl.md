# Lead 4 — Skills + Playbooks + HITL
## T889 Orchestration Coherence v3 | Research Phase
**Date**: 2026-04-17 | **Scope**: T902 (skill composition), T904 (Playbook DSL), T907 (thin-agent), T908 (HITL resume tokens)

---

## 1. CURRENT-STATE FINDINGS

### 1A. Skill Catalog
`packages/skills/skills/manifest.json` (schemaVersion 2.4.0): 21 tracked skills + 7 on-disk-not-manifested (ct-grade-v2-1, ct-memory, ct-skill-validator, ct-stickynote, ct-master-tac, ct-skill-creator tier-3, signaldock-connect).

| Tier | Count | Token budgets |
|------|-------|---------------|
| 0 | 3 (ct-cleo, ct-orchestrator, ct-task-executor) | 6000-8000 |
| 1 | 4 (ct-epic-architect, ct-research-agent, ct-spec-writer, ct-validator) | 6000-8000 |
| 2 | 12 (ct-dev-workflow, ct-documentor, ct-docs-*, ct-contribution, ct-grade, ct-adr-recorder, ct-ivt-looper, ct-consensus-voter, ct-release-orchestrator, ct-artifact-publisher, ct-provenance-keeper) | 6000-10000 |
| 3 | 1 (ct-skill-creator) | 8000 |

Chains: ct-documentor → ct-docs-lookup/write/review; ct-release-orchestrator → ct-artifact-publisher → ct-provenance-keeper.

### 1B. Existing Dispatch Pipeline
`packages/core/src/skills/dispatch.ts:autoDispatch(task, cwd)` — 5-tier confidence: label (0.9), catalog (0.75-0.85), type (0.85), keyword (0.7), fallback ct-task-executor (0.5).
`prepareSpawnMulti(skillNames, tokenValues, cwd)` at line 366: primary = full content, secondary = `loadProgressive()` (frontmatter + first section), returns `MultiSkillComposition { skillCount, primarySkill, skills[], totalEstimatedTokens, prompt }`.
**Gap**: `prepareSpawnMulti` takes explicit `skillNames[]` — nothing calls it with task-derived sets. `composeSkillBundle` fills this gap, wrapping (not replacing) `prepareSpawnMulti`.

### 1C. Recommendation API
`packages/caamp/src/core/skills/recommendation-api.ts` — `searchSkills` + `recommendSkills` (7-dimension scoring: mustHave, prefer, queryTokens, stars, metadata, modernity, exclusion).
**Gap**: Returns marketplace hits (network). Must cross-reference with `discoverAllSkills()` local install list.

### 1D. AcceptanceGate vs Resume Token
- **AcceptanceGate** (packages/contracts/src/acceptance-gate.ts): task-completion verification at `cleo complete`. 6 kinds. Stored in `tasks.acceptance_json`. Runtime at `packages/core/src/tasks/gate-runner.ts`.
- **Resume Token** (NEW): playbook-execution pause. Stored in new `playbook_approvals` table. HMAC-SHA256 of runId+nodeId+bindings. Different lifecycle — no overlap.

### 1E. Safestop
`packages/core/src/system/safestop.ts:safestop()` — ends active session, NOT a pause-and-resume. HITL approval is architecturally distinct.

---

## 2. FINAL-STATE ARCHITECTURE

### 2A. composeSkillBundle(task, agentId)
Single function in `packages/playbooks/src/skill-composer.ts`. Three-source merge (highest→lowest precedence):

1. **agent_skills DB** (Lead 2's table, source='agent-override'): `SELECT skill_id FROM agent_skills WHERE agent_id=? AND task_id=?` — mandatory inclusions
2. **CANT .cant skills[]** (source='cant-declared'): parsed from task's .cant OR via autoDispatch(task)
3. **Recommendation API** (source='recommendation'): only if totalTokens < tierBudget - 500 buffer; filter to local-installed via `discoverAllSkills()`

**Tier budgets**: `TIER_BUDGETS = { 0: 500, 1: 2000, 2: 5000 }`

**Disclosure modes per skill**:
- `full` — primary skill, if budget allows (entry.estimatedTokens = skill.token_budget)
- `preamble` — `loadProgressive()` frontmatter + first section (~15% of full)
- `ref` — single line `cleo skills info <skillId>` (8 tokens)

**Integration**: delegates actual prompt construction to `prepareSpawnMulti` — does not duplicate.

**Output type** `SkillBundle`:
```typescript
interface SkillBundle {
  taskId: string; agentId: string; tier: 0|1|2;
  primarySkill: string; entries: SkillBundleEntry[];
  totalEstimatedTokens: number; prompt: string;
}
interface SkillBundleEntry {
  skillName: string;
  source: 'agent-override' | 'cant-declared' | 'recommendation';
  mode: 'full' | 'preamble' | 'ref';
  estimatedTokens: number;
}
```

### 2B. Playbook DSL (.cantbook) — YAML Grammar

```yaml
version: "1.0"
name: rcasd
description: "RCASD planning phase"
inputs: [{ name: epicId, required: true }]
nodes:
  - id: research
    type: agentic
    skill: ct-research-agent
    role: lead
    inputs: { TASK_ID: "{{epicId}}-research" }
    ensures:
      outputFiles: [".cleo/agent-outputs/{{epicId}}/research.md"]
      exitCode: 0
  - id: biome-check
    type: deterministic
    command: pnpm
    args: ["biome", "ci", "."]
    on_failure:
      inject_into: research
      max_iterations: 3
  - id: approve-ship
    type: approval
    prompt: "Approve to proceed?"
    policy: conservative
edges:
  - { from: research, to: consensus, contract: { requires: [outputFiles], ensures: [outputFiles] } }
error_handlers:
  - { on: iteration_cap_exceeded, action: hitl_escalate }
```

**Node types:**
| Type | Executor | Failure |
|------|----------|---------|
| agentic | spawn payload → Lead 3 pipeline | retry via loopback, max 3/node |
| deterministic | `child_process.spawn` (never shell:true) | stderr → `inject_into` node context |
| approval | write `playbook_approvals` row, suspend | resume only via `cleo orchestrate approve` |

### 2C. State Schema (NEW tables in tasks.db)

```sql
CREATE TABLE playbook_runs (
  run_id TEXT PRIMARY KEY,
  playbook_name TEXT NOT NULL,
  playbook_hash TEXT NOT NULL,
  current_node TEXT,
  bindings TEXT DEFAULT '{}',
  error_context TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','paused','completed','failed','cancelled')),
  iteration_counts TEXT DEFAULT '{}',
  epic_id TEXT, session_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE TABLE playbook_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT, approver TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  auto_passed INTEGER DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES playbook_runs(run_id) ON DELETE CASCADE
);
```

Drizzle schema in `packages/playbooks/src/schema.ts`. Migration in `packages/core/src/store/migrations/` (existing pattern). **Same tasks.db — not a new DB.**

### 2D. Thin-Agent Enforcement (Role × Tool Matrix)

| Role | Agent/Task spawn | File/Bash | cleo CLI |
|------|-----------------|-----------|---------|
| orchestrator | ALLOWED | ALLOWED | ALLOWED |
| lead | DISALLOWED | ALLOWED | ALLOWED |
| worker | DISALLOWED | ALLOWED | ALLOWED |

- **Parse-time** (Lead 1's CANT v3 parser calls `validateThinAgentConstraint`): reject role=worker|lead with Agent or Task in permissions → E_THIN_AGENT_VIOLATION
- **Runtime** (Lead 3's spawn): strip Agent/Task from allowedTools when role!=orchestrator; worker spawn request → HARD REJECT
- **DB**: `agent_instances.can_spawn INTEGER DEFAULT 0` (Lead 2 owns migration)
- **Exit code**: 84 (E_THIN_AGENT_VIOLATION) — add to packages/contracts/src/errors.ts

### 2E. HITL Resume Tokens

```typescript
function generateResumeToken(runId, nodeId, bindings) {
  const secret = process.env['CLEO_PLAYBOOK_SECRET'] ?? 'cleo-playbook-default-secret';
  const payload = `${runId}:${nodeId}:${JSON.stringify(bindings, Object.keys(bindings).sort())}`;
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}
```

**Auto-Policy** (packages/playbooks/src/policy.ts) — conservative defaults:
- ALWAYS require-human: `npm publish`, `pnpm publish`, `git push`, `git tag`, `gh release create`, destructive SQL, external HTTP, ssh/scp/rsync
- Auto-approve: `pnpm test`, `pnpm biome`, `tsc`, `cleo verify/check/show/find`
- Default fallthrough: require-human
- require-human rules checked FIRST (cannot be bypassed)

**CLI**:
```
cleo playbook run <name> [--input k=v] [--epic <epicId>]
cleo playbook status <runId> | list | resume <runId> --token <t>
cleo orchestrate approve <runId> --token <t> [--reason "..."]
cleo orchestrate reject <runId> --token <t> [--reason "..."]
cleo orchestrate pending
```

Integration with `cleo safestop`: paused runs survive session end, tokens preserved, prompt on resume.

---

## 3. NEW PACKAGE STRUCTURE

```
packages/playbooks/
├── src/
│   ├── schema.ts         # Drizzle: PlaybookRun, PlaybookApproval
│   ├── parser.ts         # .cantbook YAML → PlaybookDefinition
│   ├── runtime.ts        # State machine
│   ├── state.ts          # DB CRUD
│   ├── policy.ts         # evaluatePolicy()
│   ├── approval.ts       # token gen + approval ops
│   └── skill-composer.ts # composeSkillBundle()
├── starter-playbooks/
│   ├── rcasd.cantbook
│   ├── ivtr.cantbook
│   └── release.cantbook
├── __tests__/
│   ├── parser.test.ts
│   ├── runtime.test.ts
│   ├── policy.test.ts
│   ├── skill-composer.test.ts
│   └── integration/release-playbook.test.ts
├── package.json  (deps: @cleocode/contracts, @cleocode/core, @cleocode/caamp, drizzle-orm^1.0.0-beta, js-yaml^4.1.0)
└── tsconfig.json
```

---

## 4. ATOMIC WORKER TASKS (17 workers)

### T902 — Dynamic Skill Composition (5 workers)
| ID | Title | Files | Size | Blocks |
|----|-------|-------|------|--------|
| W4-1 | SkillBundle type contracts | packages/contracts/src/skill-bundle.ts (NEW) + index.ts | small | W4-2,3,4 |
| W4-2 | composeSkillBundle source 1+2 (agent_skills + CANT) | packages/playbooks/src/skill-composer.ts | medium | W4-5 |
| W4-3 | composeSkillBundle source 3 (recommendation) | packages/playbooks/src/skill-composer.ts (extends W4-2) | small | W4-5 |
| W4-4 | Budget-gated progressive disclosure | packages/playbooks/src/skill-composer.ts (extends W4-2) | small | W4-5 |
| W4-5 | Integration: compose feeds spawn prompt | packages/core/src/orchestration/spawn-prompt.ts | medium | — |

### T904 — Playbook DSL (7 workers)
| ID | Title | Files | Size | Blocks |
|----|-------|-------|------|--------|
| W4-6 | PlaybookDefinition types + schema.ts | packages/playbooks/src/schema.ts + packages/contracts/src/playbook.ts | medium | W4-7,8,9,10 |
| W4-7 | .cantbook YAML parser | packages/playbooks/src/parser.ts | medium | W4-10 |
| W4-8 | Playbook DB state layer + migration SQL | packages/playbooks/src/state.ts + migration | medium | W4-10 |
| W4-9 | Policy engine | packages/playbooks/src/policy.ts | small | W4-10 |
| W4-10 | Playbook runtime state machine | packages/playbooks/src/runtime.ts | large | W4-11,12 |
| W4-11 | Starter playbooks (rcasd, ivtr, release) | packages/playbooks/starter-playbooks/ | small | — |
| W4-12 | CLI cleo playbook domain | packages/cleo/src/dispatch/domains/playbook.ts + commands | medium | — |

### T907 — Thin-Agent (3 workers)
| ID | Title | Files | Size | Blocks |
|----|-------|-------|------|--------|
| W4-13 | E_THIN_AGENT_VIOLATION error code | packages/contracts/src/errors.ts | small | W4-14,15 |
| W4-14 | Runtime thin-agent enforcer | packages/core/src/orchestration/thin-agent-guard.ts (NEW) | small | W4-15 |
| W4-15 | Wire enforcer into spawn pipeline | packages/core/src/orchestration/spawn-prompt.ts + index.ts | small | — |

### T908 — HITL Resume (2 workers)
| ID | Title | Files | Size | Blocks |
|----|-------|-------|------|--------|
| W4-16 | Token gen + approval DB ops | packages/playbooks/src/approval.ts | medium | W4-17 |
| W4-17 | CLI orchestrate approve/reject/pending | packages/cleo/src/dispatch/domains/orchestrate.ts + engine | medium | — |

**Parallel dispatch waves:**
- Phase 1: W4-1 alone
- Phase 2: W4-2, W4-3, W4-4, W4-6, W4-13 in parallel
- Phase 3: W4-5, W4-7, W4-8, W4-9, W4-14 in parallel
- Phase 4: W4-10, W4-15 in parallel
- Phase 5: W4-11, W4-12, W4-16 in parallel
- Phase 6: W4-17 alone

---

## 5. CROSS-LEAD DEPENDENCIES

- **From Lead 1**: `CantNodeRole` type from CANT v3 schema; parse-time thin-agent hook
- **From Lead 2**: `getAgentSkills(agentId, taskId)` from agent_skills table; `can_spawn` column on agent_instances
- **From Lead 3**: spawn pipeline calls `composeSkillBundle` and `validateSpawnRole`
- **Lead 4 provides**: composeSkillBundle, validateSpawnRole, evaluatePolicy, E_THIN_AGENT_VIOLATION

---

## 6. TOP 3 RISKS

1. **Infinite deterministic→agentic feedback loop** — hard cap=3 in iteration_counts; at cap set status='failed' + error_context; `cleo playbook resume --skip-node` override audited
2. **Token budget blowout** — hard ref-mode fallback (≤8 tokens); practical max 1 full + 3 preamble + N refs; W4-4 test gate before W4-10 runtime wire
3. **HITL policy misconfig allows unsafe auto-approval** — require-human rules evaluated FIRST; explicit opt-in file for overrides; startup validation rejects override patterns matching block list; full audit including auto_passed=1
