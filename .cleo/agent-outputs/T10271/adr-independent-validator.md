# ADR-079 — Independent Validator Role with Lead↔Worker Loop and Max-N Escalation

- **Status:** Proposed
- **Date:** 2026-05-23
- **Saga:** T10268 SG-IVTR-AUTONOMY (Wave 1)
- **Task:** T10271
- **Deciders:** Saga-T10268 synthesis quartet (Wave 1 of 4 parallel ADRs)
- **Supersedes:** none
- **Related:** ADR-051 (programmatic gate integrity), ADR-070 (three-tier orchestration), ADR-070 (verifier-backed AC auditor loop), ADR-053 (playbook runtime), ADR-055 (agents architecture), T9154 consensus, T9216 audit phase

---

## 1. Context

### 1.1 The structural defect

Today's IVTR loop (`packages/core/src/lifecycle/ivtr-loop.ts:45`) has five
phases — `implement | validate | audit | test | released`. The **same agent
identity** typically writes the `implemented` evidence atom in `validate`,
the `qaPassed` atom in `audit`, and the `testsPassed` atom in `test`. The
T9216 `audit` phase added a *time slot* for validation but no distinct
*agent role*: `IvtrPhaseEntry.agentIdentity`
(`ivtr-loop.ts:54`) just records whoever ran that phase. The orchestrator
that decided what to implement is the same context that decides whether
implementation satisfies acceptance.

This is the **confirmation-bias rubber-stamp** the steal-table calls out:
> "The execution context has strong priors toward the code it just wrote.
> A fresh verification context doesn't. The validator must not see the
> builder's reasoning. Only the output." — mindstudio (cited in
> `ivtr-external-systems-steal-table` §2.3.6).

### 1.2 What the steal-table establishes

The companion artifact `ivtr-external-systems-steal-table` (T10269)
catalogs how four external systems converged on the same answer:

| Source | Pattern | Verdict |
|---|---|---|
| GSD-2 `/gsd:verify-work` | Fresh-context Verifier sub-agent, separate model tier, reads SUMMARY.md vs REQUIREMENTS.md | **ADOPT** |
| OpenCode `permission.task` + `hidden` + `mode: subagent` | Primary agents declare which sub-agents they can invoke; sub-agents hidden from `@` autocomplete | **ADOPT** |
| Ralph `prd.json.userStories[].passes:bool` + `<promise>COMPLETE</promise>` stop-hook | Per-AC stable IDs + iteration loop gated by validator emission | **ADAPT** |
| Claude Code `Stop` hook + `--session-id` fresh-context | Hook returns exit-2 to reject "I'm done"; cache-busting session id | **ADOPT** |
| Hermes `DELEGATE_BLOCKED_TOOLS` | Hard-coded tool blocklist per role | **ADAPT** (per-role, not global) |
| Letta-Evals Builder→Extractor→Grader→Gate pipeline | Typed verification pipeline | **ADOPT** (cross-cutting) |

T9154 nailed the orchestration LAYER (3-tier control/data-plane split) but
left validation SEMANTICS untouched. This ADR closes that gap.

### 1.3 The audit confirms

`ivtr-current-state-audit` (T10270) records five concrete defects this ADR
must address:

- **G4** — `DelegateTaskChild.role = 'leaf' | 'worker'` only; no validator
  role (`packages/contracts/src/spawn.ts:69`).
- **G5** — `lead-rollup.ts` is **passive**: read-only, no spawn, no publish,
  no advancement (`packages/core/src/orchestration/lead-rollup.ts:67-200`).
- **G6** — T9216 `audit` phase has no distinct agent identity, prompt
  template, or skill.
- **G11** — `CLEOSpawnAdapter` (`packages/contracts/src/spawn-types.ts:90-123`)
  has no streaming event channel for validator handoff.
- **G12** — No `subagent_type: 'validator'` discriminator routes a Validator
  to a different adapter or prompt.

### 1.4 Owner constraint

> "Lead↔Worker iteration **WITHOUT** HITL/Prime until escalation at Max-N
> loops."

The validator MUST NOT call the orchestrator back into the inner loop.
The Lead — already an established three-tier role under ADR-070 — owns
the retry budget. Only when the Lead exhausts its budget does HITL
re-enter.

---

## 2. Decision

### 2.1 D1 — A distinct `validator` role at the contract layer (Decision 1)

The system **MUST** introduce a fifth agent role: `validator`.

- `DelegateTaskChild.role` (`packages/contracts/src/spawn.ts:69`) **MUST**
  extend to `'leaf' | 'worker' | 'validator'`.
- `CLEO_AGENT_ROLE` env var **MUST** carry `'validator'` as a recognized
  value alongside `'worker' | 'lead' | 'subagent'`.
- `validator` **MUST** be added to `forbiddenRoles` for `CLEO_OWNER_OVERRIDE`
  (no validator may bypass another validator's verdict).
- `validator` `mode: subagent`, `hidden: true` (per OpenCode `permission.task`
  pattern, ADOPT verdict from steal-table). Only `orchestrator` and `lead`
  manifests **MAY** declare `permission.task.validator: ask`. Worker
  manifests **MUST NOT** include `validator` in `permission.task`.

### 2.2 D2 — Validator subagent contract (Decision 1, continued)

The Validator subagent contract is:

```ts
interface ValidatorSpawnInput {
  taskId: string;
  acceptanceCriteria: AcceptanceCriterion[];   // resolved AC rows (see ADR companion T10272 for AC stable IDs)
  diff: { commitSha: string; files: string[]; patchRef: string };
  specRefs: Array<{ docKind: DocKind; slug: string; sha256: string }>;
  testTargets: string[];                        // tool: identifiers the Validator MAY run
  attemptOrdinal: number;                       // 1-based; for max-N tracking
  previousFindings?: ValidatorFinding[];        // empty on first attempt
}
```

Inputs explicitly **EXCLUDED** by contract:

- Worker's spawn prompt or system message.
- Worker's intermediate scratch memory (BRAIN retrieval bundle is scoped to
  `validator` memory root — see D3).
- Lead's coordination history (Validator MUST NOT see prior wave rollups
  for sibling tasks).
- The full task description body BEYOND the resolved AC list and spec docs
  (the Validator validates AC satisfaction, not subjective task intent).

The Validator output is **structured** (see D4) — never freeform prose,
never `<promise>COMPLETE</promise>` substring scan (the steal-table rejects
that as fragile in §2.6.1).

### 2.3 D3 — Validator capability surface

Per OpenCode `Plan` agent pattern (ADOPT in steal-table):

- Default permissions: `edit: deny, write: deny, bash: ask`. Bash is gated
  to a whitelist of tool runners (`test`, `lint`, `typecheck`, `audit`,
  `security-scan` — the canonical names from ADR-051 §"Tool resolution").
- `task: deny` — Validator MUST NOT spawn further subagents (terminal node).
- BRAIN retrieval bundle scope: `{ taskId, acRefs, specRefs }` only. No
  worker scratch memory; no decision-history fishing.
- `THIN_AGENT_SPAWN_TOOLS` (`packages/core/src/orchestration/spawn.ts`)
  **MUST** become `BLOCKED_TOOLS_BY_ROLE: Record<Role, string[]>` with
  `validator` getting a strict read-only subset.

### 2.4 D4 — Finding schema (Decision 2)

Validator output **MUST** conform to:

```ts
type ValidatorVerdict =
  | { kind: 'pass'; verdictSha256: string; gradedAcs: AcFinding[] }
  | { kind: 'fail'; verdictSha256: string; gradedAcs: AcFinding[] }
  | { kind: 'escalate'; reason: string };

interface AcFinding {
  acId: string;                                  // stable AC ID (T10272)
  status: 'pass' | 'fail' | 'partial' | 'inapplicable';
  finding: string;                               // ≤ 280 chars, rationale
  evidenceObserved: Array<EvidenceAtomRef>;     // pointers to atoms validator ran
  evidenceNeeded?: string;                       // what worker should add on retry
  graderUsed: GraderRef;                         // which grader produced the score (see Wave-2 ADR for grader catalog)
  score?: number;                                // 0.0-1.0 if rubric/custom grader (Letta-Evals ADOPT)
  graderRationale?: string;                      // only when LLM-judge grader used
}
```

Persistence (binding decision):

- A new table `validator_verdicts` **MUST** be added to `tasks.db`:
  `id, task_id, attempt_ordinal, validator_agent_id, model_id, session_id,
  verdict_kind, verdict_sha256, gradedAcs_json, spawned_at, completed_at,
  duration_ms`.
- A new table `ac_findings` (one row per `AcFinding`) **SHOULD** be added
  for query efficiency. If not, the `gradedAcs_json` blob is the
  authoritative form.
- The verdict **MUST** be published to the Conduit topic
  `epic-<TID>.wave-<n>.findings` with `kind: 'validator.verdict'`.
  This makes Lead/Orchestrator subscription the integration seam (D6).
- `pipeline_manifest` (`packages/core/src/store/schema/manifest.ts:44`)
  **MUST** gain an `agent_type` value `validator` in addition to existing
  values; `content_hash` for validator rows **MUST** equal
  `verdict_sha256` for cross-reference (closes G15 from the audit).
- A new evidence atom kind `verdict:<verdict_sha256>` **SHOULD** be added
  to `evidence.ts` atom grammar so the Lead can record "this gate was
  closed under verdict X" — distinct from the Worker's `commit:<sha>`
  atom for the same gate. (Coordinate with Wave-2 ADR on grammar
  extension; this ADR mandates only the existence of the binding.)

### 2.5 D5 — Loop semantics (Decision 3)

The Lead — NOT the Worker, NOT the Orchestrator — owns the inner loop.

**State machine** (one task, one wave):

```
                 ┌─────────────────────────────────────────┐
                 │              Lead (active)              │
                 │  (spawns Worker, awaits, spawns         │
                 │   Validator, decides next action)       │
                 └─┬───────────────┬────────────────┬──────┘
                   │ spawn         │ spawn          │ resolve
                   ▼               ▼                ▼
              [Worker]        [Validator]      [next wave / escalate]
                   │               │
       worker.complete       validator.verdict
       (Conduit publish)     (Conduit publish)
                   │               │
                   └──────┬────────┘
                          ▼
                    Lead loop step
```

Binding rules (RFC 2119):

- The Lead **MUST** spawn the Validator **only** after the Worker publishes
  `worker.complete` to `epic-<TID>.wave-<n>` AND a `commit:<sha>` evidence
  atom is recorded against the task.
- The Validator **MUST** run in a **fresh process** (new spawn-adapter
  invocation) — not in the Lead's context. (Closes the
  confirmation-bias defect.)
- The Validator **MUST** receive a fresh LLM `session-id`
  (cache-busting; ADOPT from Claude Code steal-table §2.6.2). The session
  id format `validator-<taskId>-<attemptOrdinal>-<unix-seconds>`
  **SHOULD** be canonical.
- The Validator **MUST NOT** be permitted to spawn a Worker, a sub-Validator,
  a sibling, or any other agent. It is a terminal leaf in the spawn tree.
- On `validator.verdict { kind: 'fail' }`, the Lead **MUST** respawn the
  Worker with `previousFindings` injected into the spawn prompt
  (`composeSpawnPayload` extension — ADOPT Claude Code per-iteration
  re-injection from steal-table). The Worker **MUST NOT** self-respawn;
  the Lead is the loop controller.
- On `validator.verdict { kind: 'pass' }`, the Lead **MUST** publish
  `lead.advance` to `epic-<TID>.coordination` with the verdict reference,
  and the Lead **MAY** then close the task's gate via
  `cleo verify --gate <g> --evidence "verdict:<sha>"`.
- On `validator.verdict { kind: 'escalate' }`, the Lead **MUST** treat the
  attempt as exhausted (counts toward Max-N) and proceed per D6.

The Orchestrator **MUST NOT** be in this loop. The Orchestrator subscribes
to `epic-<TID>.coordination` only (consistent with ADR-070 three-tier)
and sees `lead.advance` or `lead.escalate` events — never raw
`validator.verdict` events.

### 2.6 D6 — Max-N escalation contract (Decision 4)

The escalation ladder **MUST** be encoded in the Lead's state machine, with
configurable bounds and a default policy of:

| Outcome | Action | Counter incremented |
|---|---|---|
| Worker → Validator → pass | Close gate, advance | — |
| Worker → Validator → fail (attempt < N=2) | Respawn Worker with `previousFindings` | `worker.retryCount += 1` |
| Worker → Validator → fail (attempt == N=2) | Spawn Lead-intervention agent (different LLM session, same Lead identity, may write code) | `lead.interventionCount += 1` |
| Lead intervention → Validator → fail (attempt < M=1) | Re-attempt Lead intervention with cumulative findings | `lead.interventionCount += 1` |
| Lead intervention → Validator → fail (attempt == M=1) | Publish `lead.escalate` to `epic-<TID>.coordination`; HITL takes over | — |
| Validator → `escalate` | Publish `lead.escalate` immediately | — |

**Default values**: `N = 2` Worker retries (so 3 Worker spawns max),
`M = 1` Lead intervention (so 1 Lead-as-implementer attempt before HITL).
These defaults **MUST** be overridable per-task via
`task.metadata.ivtrPolicy = { maxWorkerRetries: number,
maxLeadInterventions: number }` and per-saga via `playbook.cantbook`.

**Counter persistence**:

- `IvtrState.loopBackCount` (`ivtr-loop.ts:96`) already tracks counts per
  phase; **MUST** be extended with `validatorRejectCount: number` and
  `leadInterventionCount: number`. `IvtrState.schemaVersion` advances to
  3 (forward-only migration).
- Each transition **MUST** append an `IvtrPhaseEntry` recording
  `{phase: 'audit', agentIdentity, attemptOrdinal, verdictSha256}` —
  forensic chain remains intact.

**Audit trail**:

- All Lead↔Worker↔Validator transitions **MUST** be logged to
  `.cleo/audit/gates.jsonl` via existing `appendGateAuditLine`
  (`packages/core/src/tasks/gate-audit.ts:155`) with a new
  `kind: 'validator-loop-transition'` line type.
- `lead.escalate` events **MUST** also be recorded to
  `.cleo/audit/force-bypass.jsonl` (existing channel) so HITL takeover
  shares the same forensic stream as `CLEO_OWNER_OVERRIDE` usage.

**Infinite-loop detection**:

- If the Lead state machine processes a `worker.complete` event for the
  same `(taskId, commitSha)` twice, it **MUST** treat the second as
  `validator.verdict { kind: 'escalate', reason: 'no-progress-detected' }`.
- A wall-clock budget **MUST** apply at the Lead level:
  `LEAD_LOOP_BUDGET_MS` default 30 minutes per task (independent of
  `SPAWN_BUDGET_MS = 60_000` which is per-process). Exceeding the budget
  → automatic `lead.escalate`.
- The Lead **MUST** track an "advancement signal" per retry: if two
  consecutive Validator failures have identical `gradedAcs` (same AC IDs
  fail with identical status), this counts as zero progress and HALVES
  the remaining retry budget for that task (rounded down). At zero
  retries remaining, escalate.

### 2.7 D7 — Validator failure modes (Decision 5)

The Validator itself can hallucinate. Mitigations, in order of cost:

1. **Grader-anchored verdicts** (cheapest, MUST). Every `AcFinding.status`
   **MUST** be backed by `evidenceObserved` (a list of actually-executed
   atoms). Verdicts with `gradedAcs[i].evidenceObserved = []` **MUST** be
   rejected by the Lead and the Validator respawned (no charge against
   Worker retry budget — this is Validator malfunction).

2. **Cross-check against test results** (cheap, MUST). When a `testsPassed`
   gate is involved, the Validator's verdict for the corresponding AC
   **MUST** be consistent with the `test-run:<json>` atom's
   `numFailedTests` field. Inconsistency → Validator respawn with a
   "you must reconcile your verdict with the test-run evidence" hint.

3. **Different-tier model for Validator vs Worker** (cost: discipline only,
   SHOULD). Per GSD-2 cost-tier table (ADOPT in steal-table §2.3.4),
   the Validator **SHOULD** run on a different model family or tier from
   the Worker. The
   `config/model-profiles.ts` `playbook.cantbook` node decl
   `validator: { model: <id> }` is the integration point.

4. **Two-validator quorum** (expensive, MAY). For high-severity tasks
   (`task.severity ∈ {P0, P1}`), the Lead **MAY** spawn two Validators
   in parallel and require agreement. If they disagree, the Lead **MUST**
   escalate immediately (do not run a tiebreaker — that re-introduces
   confirmation bias). This is OFF by default; opt-in via
   `task.metadata.ivtrPolicy.dualValidator = true`.

5. **Validator-of-validator** (REJECTED). Recursive validation has no
   stopping criterion that doesn't reduce to one of the above. Adding
   a third level is theater.

### 2.8 D8 — Integration with existing primitives (Decision 6)

This ADR **MUST** layer onto existing primitives — no greenfield rewrite.

- **`cleo orchestrate ivtr <id>` CLI** (already exists per
  CLEO-INJECTION.md) **MUST** gain a `--next` behavior change: the
  `audit` phase transition now spawns a `validator` subagent instead of
  recording an `agentIdentity`-only entry. Backwards compat: tasks with
  `task.metadata.ivtrPolicy.skipValidator = true` retain the old
  self-attest path (see D9 migration).

- **`lead-rollup.ts` becomes active** (closes G5). The function gains an
  `options.mode: 'passive' | 'active'` parameter. In `active` mode it:
  - Subscribes to `epic-<TID>.wave-<n>` via Conduit on first call.
  - On `worker.complete`, spawns Validator (per D5).
  - On `validator.verdict`, applies the Lead state machine (per D6).
  - On `readyToAdvance = true`, publishes `lead.advance`.
  This MUST be additive — existing passive callers (`cleo orchestrate
  waves`) continue to work unchanged.

- **Conduit topic kinds** (closes G13). `topic_messages.kind`
  (`packages/core/src/store/conduit-schema.ts:391`) **MUST** gain a
  validated enum subset for the IVTR loop:
  `'worker.complete' | 'validator.spawned' | 'validator.verdict' |
  'lead.advance' | 'lead.escalate' | 'lead.intervention.spawned' |
  'message'`. Other kinds remain free-form (back-compat).

- **`pipeline_manifest`** (closes G15). The Worker writes
  `agent_type: 'worker'`. The Validator writes `agent_type: 'validator'`
  with `content_hash = verdictSha256`. The Lead's rollup query
  (`packages/core/src/orchestration/lead-rollup.ts:251-277`) **MUST**
  load both rows and surface the divergence.

- **Spawn adapter** (closes G11/G12). `CLEOSpawnAdapter.spawn(context)`
  receives `context.subagent_type` which already exists as a free-form
  string (`packages/contracts/src/spawn.ts:71`). This ADR
  **MUST** constrain it to a discriminated union:
  `subagent_type: 'worker' | 'validator' | 'lead-intervention'`.
  Per-provider adapters (`packages/adapters/src/providers/*`) route
  accordingly. **No change to the 6-method `CLEOSpawnAdapter`
  surface** — context discrimination is sufficient. (We do not adopt
  T9154's proposed `ExtendedSpawnAdapter` here — that was rejected by
  the audit as never-landed; we use the context-discriminator route.)

- **Skill definition for Validator role**. A new skill
  `.cleo/skills/cleo-validator/SKILL.md` (or equivalent CAAMP package)
  **MUST** ship with the validator's `<role>`, `<philosophy>`,
  `<tool_strategy>`, `<output_formats>`, `<execution_flow>`, and
  `<success_criteria>` sections (GSD-2 ADOPT pattern from steal-table
  §2.3.3). The skill is `hidden: true` and `mode: subagent`
  (OpenCode ADOPT).

---

## 3. Consequences

### 3.1 Cost (token + wall-clock)

- **Spawn multiplier**: each task that previously needed 1 Worker spawn
  now needs `1 + V*W` spawns where W = Worker retries (default ≤ 3), V
  = Validators per Worker (default 1, dual = 2). Worst case under defaults:
  `1 worker + 3 validators + 1 lead-intervention + 1 validator` = 6
  spawns. Realistic case (most tasks pass first attempt): 1 Worker +
  1 Validator = 2 spawns. **Approximate multiplier: 2x at p50, 3-4x at
  p90, 6x at p99**.
- **LLM-token cost**: Validator runs on cheaper model (Sonnet vs Opus
  Worker per GSD-2 profile) typically, partially offsetting the spawn
  count. Expected net cost increase: ~1.5x at p50, ~2.5x at p90.
- **Wall-clock**: Worker → Validator is sequential. Each round-trip
  adds ~30-90s. Two retries adds 60-180s. For long tasks (p50 ~5 min),
  +20-60%; trivial tasks bear proportionally heavier overhead — hence
  the per-task opt-out (D8).

### 3.2 Prompt cache

- Validator spawns with fresh `session-id` per attempt **MUST** miss the
  Worker's cache. This is by design (per D5).
- Across Validator attempts for the same task, the Validator system
  prompt + spec docs + AC list can stay cache-stable; only the `diff`
  and `previousFindings` change. Expected Validator cache-hit rate per
  task: ~70% on attempts ≥ 2.
- The Lead's coordination loop runs in-process or in a long-lived
  Lead subagent; cache discipline for the Lead is unchanged.

### 3.3 Latency

- **Best case** (Worker passes first attempt): +1 sequential Validator
  spawn (~30-90s).
- **p90** (1 retry): +2 Validator spawns + 1 Worker respawn (~3-6 min added).
- **Worst case before HITL**: 3 Worker spawns + 3 Validator spawns + 1
  Lead-intervention + 1 Validator = ~10-15 min before HITL takes over.
  This is bounded by `LEAD_LOOP_BUDGET_MS` (default 30 min hard cap).

### 3.4 False-positive risk

- Validator hallucination is the dominant risk (D7). Grader-anchored
  verdicts + test-result cross-check eliminate the obvious cases.
- The Lead state machine's "no-progress detector" (D6) prevents the
  loop from burning the full retry budget on identical failures.
- Dual-validator quorum is the escape hatch for P0/P1 tasks where
  false-positive cost dominates.

### 3.5 Audit trail expansion

- `gates.jsonl` and `force-bypass.jsonl` gain new line kinds. Existing
  consumers (`packages/core/src/tasks/gate-audit.ts` readers) MUST be
  updated to tolerate the new shapes — additive, not breaking.
- `validator_verdicts` table is the new forensic chain root: every
  closed gate can be traced back to a specific Validator agent,
  session, model, and verdict sha256.

### 3.6 What this does NOT solve

- AC stable IDs are a **prerequisite** but defined in the companion
  Wave-2 ADR (T10272 — AC stable IDs + atom grammar). Without
  AC stable IDs, `AcFinding.acId` cannot exist; rollout depends on that
  ADR landing first or in lockstep.
- The grader catalog (`tool | rubric | custom`) is defined in the Wave-3
  ADR (T10273 — Docs-as-validator + grader pipeline). `GraderRef` in
  D4 is a stub until that ADR lands.
- `metricsImproved` and other Tier-3 extended gates remain governed by
  existing extended-gate logic (`packages/core/src/verification/gates.ts`)
  and are not in scope for this ADR.

---

## 4. Alternatives Considered

### 4.1 On the Validator role

**Alt-A: Worker self-validates** (status quo). REJECTED — this is the
defect this ADR exists to fix. Steal-table §2.3.6 quote and the
T9187 audit (ADR-070-verifier-backed) prove this fails in practice.

**Alt-B: Tests are the only validator**. REJECTED — owner explicitly
called this out as insufficient. The audit (T10270 §2.1) shows
`validateCommit` already does reachability + file-overlap, but no
atom proves AC SATISFACTION as distinct from test passage. A test
suite can pass while AC is unsatisfied (e.g., AC says "feature X is
toggleable" and tests cover only the on-path).

**Alt-C: Validator is the Lead** (not a fresh agent). REJECTED — the
Lead is already the spawner and the rollup-reader. Putting validation
on the Lead defeats fresh-context isolation. The Lead's role is
coordination, not adjudication.

**Alt-D: Pre-flight verifier script** (per ADR-070-verifier-backed).
PARTIALLY KEPT — verifier scripts remain useful for programmatic ACs
and this ADR composes with them: the Validator runs verifier scripts
AMONG its tools. Verifier-only is insufficient for subjective ACs.

### 4.2 On the loop controller

**Alt-E: Worker self-respawns**. REJECTED — the Worker has no way to
know if the Validator's verdict is honest; if Worker reads the verdict
and decides whether to respawn, we've reintroduced builder-as-judge
through the back door.

**Alt-F: Orchestrator drives the loop**. REJECTED — owner's explicit
constraint. The Orchestrator's context floods at scale (ADR-070
three-tier rationale); putting the inner loop on the Orchestrator
breaks the 3-tier scaling model.

**Alt-G: New "Loop Controller" agent distinct from Lead**. REJECTED —
the Lead already supervises 4-12 workers and owns commit cadence
(ADR-070); extending to Worker↔Validator dance is marginal, not a new
role.

### 4.3 On Max-N values

**Alt-H: Unlimited retries until budget**. REJECTED — budget-only stop
burns on one task. Per-attempt + total budget is defense-in-depth.

**Alt-I: N=5 (more forgiving)**. REJECTED — diminishing returns past
N=3 (ralph evidence); the no-progress detector (D6) gives effective
retries when there IS progress and cuts faster when there isn't.

**Alt-J: N=1 (more aggressive)**. REJECTED — too brittle for the
typical case where the Worker missed one AC and needs structured
feedback. N=2-3 is the empirical sweet spot.

### 4.4 On Validator failure handling

**Alt-K: Trust the Validator unconditionally**. REJECTED — Validator
hallucination is documented (steal-table §2.6.3 model-welfare note;
LLM-as-judge literature). At minimum, grader-anchoring (D7.1) is
required.

**Alt-L: Always dual-validator (quorum)**. REJECTED — doubles cost.
Reserve for P0/P1 per D7.4.

**Alt-M: Validator validates Validator (recursive)**. REJECTED — no
stopping criterion; reduces to one of the cheaper mitigations.

### 4.5 On integration

**Alt-N: New `ExtendedSpawnAdapter` interface** (from T9154 consensus).
REJECTED — audit (T10270 §2.7) confirms this never landed and the 9
existing provider adapters would all need updates. Using the existing
`subagent_type` discriminator on the existing `CLEOSpawnAdapter.spawn`
context is sufficient.

**Alt-O: HTTP-server tool dispatcher** (OpenCode pattern).
REJECTED in steal-table — CLI-only dispatch is the existing constraint.

---

## 5. Migration

### 5.1 Phased rollout

- **Phase 0 (no-op, default-off)**: Ship the contract — `validator` role
  in spawn types, `validator_verdicts` table, Conduit kind enum
  extensions, skill file. Set `ivtrPolicy.skipValidator = true` for all
  existing tasks by default. CI gates unchanged. Zero behavior change.

- **Phase 1 (opt-in via label)**: Tasks with `task.label = 'ivtr-validator'`
  (or `task.metadata.ivtrPolicy.skipValidator = false`) get the validator
  loop. Lead-rollup runs in `active` mode for those tasks only. All
  other tasks see the self-attest path. Run for ≥ 2 release cycles;
  collect false-positive / false-negative rate from
  `validator_verdicts` joined against `task.status` final outcome.

- **Phase 2 (opt-out via flag)**: Default flips to validator-on. Tasks
  with explicit `ivtrPolicy.skipValidator = true` retain self-attest.
  Document the migration in `CHANGELOG.md` + an ADR-051 cross-reference
  amendment.

- **Phase 3 (deprecate self-attest)**: After ≥ 3 release cycles of
  Phase 2 stability, remove the `skipValidator` opt-out. The
  validator loop becomes mandatory for all IVTR-eligible tasks. Tasks
  with severity below `P3` and size `small` MAY remain self-attest
  via `ivtrPolicy.lite = true` if telemetry shows the cost is
  disproportionate.

### 5.2 Backwards compatibility for existing tasks

- `IvtrState.schemaVersion = 2` rows continue to work — the new
  `validatorRejectCount` and `leadInterventionCount` fields default to
  `0` on read (per the existing T9216 backward-compat pattern in
  `ivtr-loop.ts:340-345`). Schema version advances to 3 on first
  validator-loop transition.
- `pipeline_manifest` rows from pre-validator era have
  `agent_type = 'worker'` or `'lead'`; rollup queries that filter on
  `agent_type IN ('worker', 'validator')` MUST tolerate absence.
- `cleo verify --gate <g> --evidence "verdict:<sha>"` SHOULD NOT fail
  closed-gate replays of historical evidence (the atom is additive).
- `cleo orchestrate ivtr --next` retains exact existing semantics when
  `ivtrPolicy.skipValidator = true` (Phase 0-2). No CLI flag changes.

### 5.3 Coordination with sibling ADRs

This ADR is Wave 1 of the Saga T10268 quartet. It MUST land in
lockstep with:

- **Wave 2 (T10272)** — AC stable IDs + atom grammar (provides `AcFinding.acId`).
- **Wave 3 (T10273)** — Docs-as-validator + grader pipeline (provides
  `GraderRef` and the grader catalog).
- **Wave 4 (T10274)** — CORE tool registry surfacing
  `spawn-validator`, `pull-ac`, `request-hitl` as Category A SDK tools.

If any of Wave 2/3/4 slip, this ADR ships in **Phase 0 only** (contract +
skill, no active loop) until prerequisites land. The Phase-1 opt-in
flip MUST NOT precede Wave 2 + Wave 3.

### 5.4 Test plan

- Unit: Lead state machine transitions (each path, each Max-N exit,
  no-progress detector).
- Integration: Worker → Validator → fail → Worker → Validator → pass.
- Integration: N=2 exhaustion → Lead intervention → M=1 exhaustion →
  `lead.escalate` published.
- Integration: Validator hallucination (empty `evidenceObserved`) →
  Validator respawn, no retry charged.
- Forensic: every transition recorded in `gates.jsonl`; every
  `lead.escalate` recorded in `force-bypass.jsonl`.

---

## 6. References

### Internal (CLEO)

- **ADR-051** — Programmatic gate integrity (atom grammar)
- **ADR-053** — Playbook runtime (HMAC resume tokens, HITL gates)
- **ADR-055** — Agents architecture & meta-agents
- **ADR-070-three-tier-orchestration** — Orchestrator/Lead/Worker tiers
- **ADR-070-verifier-backed-ac-auditor-loop** — Verifier-script pattern (composes with this ADR)
- **T9154 consensus** (slug `t9154-consensus`) — Three-tier orchestration + Conduit topics consensus
- **T9216** — `audit` phase added to `IvtrPhase`
- **T9187 campaign** — Scaffold-and-mark-done failure mode

### Saga T10268 Wave artifacts

- **T10269** (slug `ivtr-external-systems-steal-table`) — External-pattern steal table
- **T10270** (slug `ivtr-current-state-audit`) — Current-state audit
- **T10272** — AC stable IDs + atom grammar (Wave 2 sibling — must land in lockstep)
- **T10273** — Docs-as-validator + grader pipeline (Wave 3 sibling — must land in lockstep)
- **T10274** — CORE tool registry (Wave 4 sibling — must land in lockstep)

### External (cited via steal-table)

- GSD-2 `/gsd:verify-work` — fresh-context verifier sub-agent
  (https://github.com/gsd-build/gsd-2; ADOPT)
- OpenCode `permission.task`, `hidden`, `mode: subagent`
  (https://opencode.ai/docs/agents; ADOPT)
- Ralph `prd.json.userStories[].passes`
  (https://github.com/snarktank/ralph; ADAPT)
- Claude Code `--session-id` fresh-context isolation
  (https://www.mindstudio.ai/blog/automated-code-review-multiple-ai-agents; ADOPT)
- Hermes `DELEGATE_BLOCKED_TOOLS` (ADAPT — per-role)
- Letta-Evals grader pipeline
  (https://docs.letta.com/guides/evals/concepts/graders; ADOPT)

---

*End of ADR-079.*
