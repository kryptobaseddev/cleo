# T762 — ct-cleo Skill + CLEO-INJECTION.md Audit

**Task**: T762 (child of epic T760 RCASD)
**Date**: 2026-04-16
**Agent**: CT-CLEO + Injection Audit Specialist
**Status**: complete

---

## 1. Executive Summary

The benchmark (T-POMODORO-BENCH-2026-04-16) exposed a CLEO builder agent that never called `cleo orchestrate` despite creating an 8-task epic, never persisted a single BRAIN observation until the schema bug blocked it, and never used attachment workflow or programmatic gate checks. This audit identifies the exact guidance gaps that caused those misses and proposes concrete text diffs for both `CLEO-INJECTION.md` (the lightweight template all agents see) and `ct-cleo/SKILL.md` (the full skill body loaded on demand).

**Root cause in one sentence**: Both documents describe WHAT commands exist but do not supply IF/WHEN triggers — agents can read the entire injection and still not know that creating N tasks should trigger `cleo orchestrate start`, that completing a non-trivial task should trigger `cleo observe`, or that each acceptance-criteria string should be verified via `cleo check gate.status` before closing.

---

## 2. CLEO-INJECTION.md Content Audit

### 2.1 Session Start Sequence — Verdict: Adequate but stale

The cheapest-first session sequence (`session status → dash → current → next → show`) is correct. However it does not distinguish between:
- Solo task execution (stay at tier 0)
- Orchestrated epic execution (must call `cleo orchestrate start --epic` after step 1)

An agent spawned to work on an epic reads this sequence, finds a task, and starts executing single-file. The injection never says "if you are working on an epic with children, invoke `cleo orchestrate start`."

**Gap**: No conditional branch for orchestrated-epic startup.

### 2.2 `cleo orchestrate` — Verdict: Completely absent

Searching `CLEO-INJECTION.md` for "orchestrate" returns zero matches. The injection lists the Escalation block at the bottom: "Load ct-orchestrator skill for multi-agent workflows" — but that is a passive hint, not a trigger rule. An agent that creates an 8-task epic using `cleo add` never encounters a rule that says "now call `cleo orchestrate start`."

**Gap severity**: HIGH. This is the benchmark's most expensive miss. An agent that properly called `cleo orchestrate start --epic T001` would have received dependency wave analysis, spawn prompts, and access to `cleo orchestrate ready` — the entire multi-agent coordination infrastructure sat idle.

### 2.3 `cleo observe` / `cleo memory` During Active Work — Verdict: Critically under-weighted

The injection mentions `cleo observe "text" --title "title"` in the Memory table with token cost `—`. There is no guidance on WHEN to call it. The Memory Protocol (JIT) section describes pulling context, not pushing it. There is zero text saying "after completing a non-trivial task, observe your key findings."

In the benchmark the builder agent produced 8 completed tasks with real acceptance-criteria verification, and zero BRAIN observations (blocked by the schema bug, but the agent never tried until `session end`). If the injection said "after each `cleo complete`, run `cleo observe` with a one-sentence finding," the agent would have attempted observation far earlier — and we would have detected the schema bug in task 2, not at session end.

**Gap severity**: HIGH.

### 2.4 Programmatic Acceptance Criteria / Verification Gates — Verdict: Absent

The injection's Work Loop step 3 says "Do the work (code, test, document)" — no reference to `cleo check gate.status`, `cleo check protocol`, or `pipeline.stage.validate`. The benchmark builder marked gates `qaPassed=true` and `testsPassed=true` without any CLI gate command. Programmatic verification is entirely undiscoverable from the injection.

**Gap severity**: MEDIUM. The full ct-cleo skill body does cover `check` domain operations (Tier 1 Read table) but CLEO-INJECTION.md contains nothing on the subject.

### 2.5 Cheat-Sheet Table Coverage — Verdict: Wrong 20%

The three-row Task Discovery table covers `find`, `show`, and `list --parent`. The Session Commands table covers `status`, `briefing`, `start`, `end`. The Memory table covers `find`, `timeline`, `fetch`, `observe`. This is correct for a solo single-task agent. For an orchestrated-epic agent the missing rows are:

| Missing | Impact |
|---------|--------|
| `cleo orchestrate ready --epic <id>` | Never discovers parallel-safe spawn set |
| `cleo orchestrate spawn <taskId>` | Never uses CLEO spawn machinery |
| `cleo check gate.status` | Never runs programmatic gate verification |
| `cleo update <id> --files <path>` | Never attaches research artifacts to tasks |
| `cleo memory decision store` | Never persists structured decisions |

### 2.6 Sizing Defaults — Verdict: Mentioned but untriggered

The Rules section says "No time estimates — use small, medium, large sizing." There is no guidance on when to pick each size, so agents default to whatever feels right. The ct-epic-architect SKILL.md has a clear size table (epic=large, task=medium, subtask=small) that never flows into the injection.

**Gap severity**: LOW (correctness impact minimal; mostly affects reporting quality).

### 2.7 Attachment / Document Workflow — Verdict: Entirely absent

Neither the injection nor the Work Loop mentions `--files` on `cleo add` or `cleo update <id> --files`. The benchmark's CLEO builder created 8 tasks, none with file attachments despite writing spec documents. The ct-epic-architect skill has a full "File Attachment Patterns" section that CLEO-INJECTION.md does not reference.

**Gap severity**: MEDIUM.

---

## 3. ct-cleo SKILL.md Audit

### 3.1 Coverage vs. CLEO-INJECTION.md

The skill body is substantially better: it contains the complete operation table (all three tiers), the Canonical Decision Tree with ASCII flow diagrams, the full Anti-Pattern Reference, Progressive Disclosure guidance, and the Session Protocol quick-start. These are all correct and well-structured.

### 3.2 Orchestrate Domain — Verdict: Listed but no trigger rule

The skill body lists all `orchestrate.*` operations (Tier 1 Read and Tier 1 Write). The Multi-Agent Coordination goal section shows the ASCII decision tree for "I am the orchestrator." However there is NO rule that says "if you just created an epic with N tasks, you MUST call `cleo orchestrate start` before beginning any child task." An agent reading the skill can learn what orchestrate does — but only if they already know they should be orchestrating.

**Gap**: The skill needs a threshold trigger: "Epic with ≥ 5 child tasks → MUST invoke orchestrate domain before starting implementation."

### 3.3 Research Phase Guidance — Verdict: Missing

The skill body has a LOOM/RCASD section (Pipeline Awareness table listing stages) but no guidance on what a builder agent should do during the research stage. It says "Information gathering and analysis" as stage purpose, but doesn't describe the workflow: `cleo find` for existing work → `cleo memory find --type pattern` for known patterns → `cleo observe` with findings → `cleo update <id> --files <research-artifact>`. The ct-research-agent SKILL.md has this as an explicit 5-step methodology that does not appear in ct-cleo.

**Gap severity**: MEDIUM. Most builder agents skip research-phase primitives entirely.

### 3.4 Acceptance Criteria as Enforceable Gates — Verdict: Not described

The skill explains that tasks have acceptance criteria (mentioned in the LOOM section). It does not say how an agent should USE them. The gap: there is no text saying "before calling `cleo complete`, iterate each acceptance criterion string from `cleo show <id>`, verify each one programmatically, then call `cleo check gate.status` and only proceed if all gates pass." Agents treat acceptance criteria as documentation, not as a pre-complete checklist.

**Gap severity**: HIGH. This is why the benchmark builder passed `testsPassed=true` without an integration test — nothing in the guidance told it to use gate commands as a pre-complete ritual.

### 3.5 When to Spawn Sub-agents — Verdict: Decision tree exists but threshold missing

The skill's Multi-Agent Coordination tree is correct: "I am the orchestrator → call orchestrate start → validate → spawn." But the threshold question — "when does a solo executor become an orchestrator?" — is unanswered. The ct-epic-architect skill implies it (epic = large, 8+ files, multiple features → implies multi-wave), but ct-cleo itself never says "N tasks in your epic = you should be orchestrating, not sequentially executing."

**Gap severity**: HIGH (matches the benchmark's primary failure mode).

### 3.6 Observe-After-Complete Pattern — Verdict: Not mentioned

The skill's Memory Operations goal section describes saving observations. It does not say when to save them relative to task completion. The "Save" row in the memory table is present (`cleo observe`), but there is no "after every non-trivial complete, observe" rule. The 3-JIT-per-phase budget note discourages memory use; it should clarify that observe is a PUSH operation (free-form save) that does not count against the JIT budget, which is a PULL budget.

**Gap severity**: MEDIUM.

### 3.7 Attachment Workflow — Verdict: Not in skill body

The Tier-1 Write table shows `tasks.update` supports notes, but `--files` attachment is not shown anywhere in the ct-cleo skill body. The ct-epic-architect skill has a dedicated "File Attachment Patterns" section with `--files` vs research-link guidance. This information needs to be surfaced in ct-cleo at minimum as a cross-reference.

**Gap severity**: LOW-MEDIUM.

---

## 4. Concrete Diffs

### Diff 1 — CLEO-INJECTION.md: Add orchestrate trigger for large epics

**File**: `/home/keatonhoskins/.local/share/cleo/templates/CLEO-INJECTION.md`

**Before** (Work Loop section):

```markdown
## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo show {id}` → read requirements
3. Do the work (code, test, document)
4. `cleo complete {id}` → mark done
5. `cleo next` → continue or end session
```

**After**:

```markdown
## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo show {id}` → read requirements
3. **If working on an epic with ≥ 5 child tasks**: call `cleo orchestrate start --epic {epicId}` NOW before touching any child. Use `cleo orchestrate ready --epic {epicId}` to identify the parallel-safe spawn set for the current wave.
4. Do the work (code, test, document)
5. Before `cleo complete {id}`: verify each acceptance criterion in the task explicitly. Run `cleo check gate.status` to confirm all lifecycle gates are satisfied.
6. `cleo complete {id}` → mark done
7. After completing a non-trivial task: `cleo observe "key finding" --title "T{id} <slug>"` — persist what you learned for future agents.
8. `cleo next` → continue or end session
```

---

### Diff 2 — CLEO-INJECTION.md: Expand cheat-sheet with orchestrate + gate rows

**Before** (Task Discovery table):

```markdown
## Task Discovery

**Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id>` | 300-600 | Full details for one task |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |
```

**After**:

```markdown
## Task Discovery

**Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id>` | 300-600 | Full details for one task |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |

## Orchestration (Epic with ≥ 5 tasks)

| Trigger | Command | Purpose |
|---------|---------|---------|
| Created epic with N child tasks | `cleo orchestrate start --epic <id>` | Activate multi-wave coordination |
| Before spawning next task | `cleo orchestrate ready --epic <id>` | Get parallel-safe task set for current wave |
| Before any spawn | `cleo orchestrate spawn <taskId> --json` | Generate fully-resolved spawn prompt |
| Check epic progress | `cleo orchestrate status` | Current orchestration state |

## Verification Gates (before every `cleo complete`)

| Check | Command | When |
|-------|---------|------|
| All lifecycle gates green | `cleo check gate.status` | Before completing any task |
| Protocol compliance | `cleo check protocol <taskId>` | Before marking implementation done |
| Acceptance criteria audit | Review each string in `cleo show <id>` `.acceptanceCriteria` | Manually verify each criterion is met |

## Observation (after every non-trivial `cleo complete`)

| Action | Command | Note |
|--------|---------|------|
| Persist key finding | `cleo observe "finding" --title "T{id} slug"` | Free-form; does NOT count against JIT budget |
| Persist structured decision | `cleo memory decision store "decision" --rationale "..." --task <id>` | Use for architectural choices |
| Attach artifact to task | `cleo update <id> --files "path/to/file.md"` | Link research or spec docs to task row |
```

---

### Diff 3 — ct-cleo SKILL.md: Add spawn threshold rule and pre-complete gate ritual

**File**: `/mnt/projects/cleocode/packages/skills/skills/ct-cleo/SKILL.md`

**Before** (Multi-Agent Coordination decision tree intro):

```markdown
### Goal: Multi-Agent Coordination

```
I need to coordinate agent work (orchestrator role)
│
├── I am the orchestrator — start coordinating an epic
│   └── cleo orchestrator start --epic {epicId}  [tier 1]
│       └── cleo orchestrator status  [tier 1]  → current orchestration state
│
├── Spawn a subagent for a task
│   └── (1) cleo orchestrator validate {taskId}  [tier 1]  → pre-spawn gate check
│       (2) cleo orchestrator spawn {taskId}  [tier 1]  → spawn prep
│
└── I am a subagent — complete my work and report
    └── cleo manifest append {entry}  [tier 1]  ← MANDATORY per BASE protocol
        cleo complete {taskId}  [tier 0]
```
```

**After**:

```markdown
### Goal: Multi-Agent Coordination

**THRESHOLD RULE**: If you have created or are working on an epic with ≥ 5 child tasks across multiple waves, you MUST activate the orchestrate domain before executing any child. Solo sequential execution of a multi-wave epic is an anti-pattern — it foregoes parallel execution, dependency-safe ordering, and spawn prompt generation.

```
I need to coordinate agent work (orchestrator role)
│
├── FIRST: Do I have an epic with ≥ 5 tasks?
│   YES → cleo orchestrate start --epic {epicId}  [tier 1]  ← MANDATORY before first child task
│   NO  → continue as solo executor (tier 0 work loop)
│
├── I am the orchestrator — coordinating an active epic
│   └── cleo orchestrate start --epic {epicId}  [tier 1]
│       └── cleo orchestrate status  [tier 1]  → current orchestration state
│
├── Which tasks can I spawn in parallel right now?
│   └── cleo orchestrate ready --epic {epicId}  [tier 1]  → dependency-safe set for current wave
│
├── Spawn a subagent for a specific task
│   └── (1) cleo orchestrate validate {taskId}  [tier 1]  → pre-spawn gate check
│       (2) cleo orchestrate spawn {taskId} --json  [tier 1]  → generate resolved spawn prompt
│       (3) Pass resolved prompt to Agent tool / harness
│
└── I am a subagent — complete my work and report
    └── cleo manifest append {entry}  [tier 1]  ← MANDATORY per BASE protocol
        cleo complete {taskId}  [tier 0]
```

**Anti-pattern blocked**: Calling `cleo next` sequentially on all 8 tasks of a multi-wave epic without ever calling `cleo orchestrate start`. This loses wave analysis, parallel execution, and dependency ordering.
```

**Before** (Progressive Disclosure section — Tier 0 description):

```markdown
**Stay at Tier 0** (default — 80% of work):
- Single task execution (implement, fix, test)
- Task discovery and status updates
- Session start/end
```

**After**:

```markdown
**Stay at Tier 0** (default — 80% of work):
- Single task execution (implement, fix, test)
- Task discovery and status updates
- Session start/end

**Pre-Complete Gate Ritual** (apply before EVERY `cleo complete`):
1. Read acceptance criteria: `cleo show {taskId}` → examine `.acceptanceCriteria` array
2. Verify each criterion explicitly — do not self-certify without evidence
3. Run: `cleo check gate.status` → confirm all lifecycle gates green
4. Run: `cleo check protocol {taskId}` → protocol compliance check
5. Only if all gates pass: `cleo complete {taskId}`
6. Immediately after: `cleo observe "{key finding from this task}" --title "T{id} {slug}"`

**Note on observe budget**: `cleo observe` is a PUSH operation and does NOT count against the 3-JIT-per-phase budget. The JIT budget applies only to PULL operations (`memory.find`, `memory.timeline`, `memory.fetch`). Observe freely; pull sparingly.
```

---

### Diff 4 — ct-cleo SKILL.md: Add attachment workflow cross-reference

**Before** (end of Anti-Pattern Reference table):

```markdown
| Completing task without manifest append | `pipeline.manifest.append` then `tasks.complete` | BASE protocol violation (exit 62) |
| Skipping `session.status` at start | Always check `session.status` first | loses prior context, causes duplicate work |
```

**After**:

```markdown
| Completing task without manifest append | `pipeline.manifest.append` then `tasks.complete` | BASE protocol violation (exit 62) |
| Skipping `session.status` at start | Always check `session.status` first | loses prior context, causes duplicate work |
| Creating tasks with no file attachments despite writing spec/research docs | `cleo update {id} --files "path/to/artifact.md"` or `--files` flag on `cleo add` | Research artifacts become undiscoverable |
| Calling `cleo observe` after schema errors at session end | Try `cleo observe` early (task 1 or 2) — schema bugs surface immediately | Avoids silent data loss across whole session |
| Treating acceptance-criteria strings as documentation only | Verify each criterion with evidence before `cleo complete` | Criteria exist to gate completion, not describe intent |
```

---

### Diff 5 — ct-cleo SKILL.md: Add sizing defaults table

**Before** (Rules section in Session Protocol):

```markdown
## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked
```

**After**:

```markdown
## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked

### Sizing Defaults

| Artifact | Default Size | Override to `large` when |
|----------|-------------|--------------------------|
| Epic | `large` | Always — epics are always large |
| Task (feature) | `medium` | Cross-cuts ≥ 5 files or requires sub-tasks |
| Task (fix/docs) | `small` | Single file, narrow scope |
| Subtask | `small` | Always — subtasks are always small |

**Upgrade trigger**: If a task grows to require its own child tasks, it should have been an epic. Reparent: `cleo reparent {taskId} {newParentId}` or delete and recreate as epic.
```

---

### Diff 6 — CLEO-INJECTION.md: Add escalation triggers (replacing passive hint)

**Before** (Escalation section):

```markdown
## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
```

**After**:

```markdown
## Escalation

**Triggers — escalate IMMEDIATELY when these conditions are true:**

| Condition | Escalation |
|-----------|-----------|
| Working on epic with ≥ 5 child tasks | `cleo orchestrate start --epic <id>` then load ct-orchestrator skill |
| Task has `type: epic` | You are in planning mode — load ct-epic-architect skill |
| Acceptance criteria include testing requirements | Load ct-dev-workflow skill for gate discipline |
| Research/investigate keyword in task title | Load ct-research-agent skill for methodology |
| Token budget approaching 80% | Delegate remaining work via orchestrate spawn |

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
- Load **ct-epic-architect** skill for epic decomposition
```

---

## 5. New Cheat-Sheet Rows Summary

The following rows are proposed as additions to CLEO-INJECTION.md cheat sheets:

| Row | Table | Command | Trigger |
|-----|-------|---------|---------|
| 1 | Orchestration | `cleo orchestrate start --epic <id>` | Epic has ≥ 5 child tasks |
| 2 | Orchestration | `cleo orchestrate ready --epic <id>` | Before spawning next wave |
| 3 | Orchestration | `cleo orchestrate spawn <taskId> --json` | Before any spawn |
| 4 | Orchestration | `cleo orchestrate status` | Check epic progress |
| 5 | Verification Gates | `cleo check gate.status` | Before every complete |
| 6 | Verification Gates | `cleo check protocol <taskId>` | Before marking implementation done |
| 7 | Observation | `cleo observe "text" --title "..."` | After every non-trivial complete |
| 8 | Observation | `cleo memory decision store "..."` | After every architectural choice |
| 9 | Attachment | `cleo update <id> --files "path"` | When writing spec/research docs |
| 10 | Escalation | Trigger table with 5 rows | On condition match |

**Total new cheat-sheet rows**: 10 (across 4 new sub-tables)

---

## 6. Cross-Skill Gaps Not Yet Addressed

| Gap | Recommendation |
|-----|---------------|
| ct-research-agent methodology not surfaced in ct-cleo | Add cross-ref: "For research-phase tasks, load ct-research-agent for 5-step methodology" |
| ct-epic-architect file attachment patterns absent in ct-cleo | Add `--files` examples to ct-cleo Tier-1 Write table description |
| `cleo memory decision store` trigger never specified | Add to ct-cleo Memory Operations tree: "after every architectural choice" |
| `cleo check test.run` not mentioned anywhere in injection | Add to verification gate ritual: "run tests before marking `testsPassed: true`" |
| REQ-ID traceability (SUPREME_REPORT §7 recommendation 1) | Future feature: `cleo req add` — placeholder note in ct-cleo spec references |
| Stage-transition timestamps (`--history` flag) | Future feature: placeholder note in ct-cleo loom-lifecycle.md reference |

---

## 7. Priority Matrix

| Diff | Impact | Effort | Ship With |
|------|--------|--------|-----------|
| Diff 1 (Work Loop orchestrate trigger) | HIGH | LOW | CLEO-INJECTION.md v2.5.0 |
| Diff 3 (Spawn threshold rule in SKILL.md) | HIGH | LOW | ct-cleo v next |
| Diff 3b (Pre-complete gate ritual) | HIGH | LOW | ct-cleo v next |
| Diff 2 (Cheat-sheet expansion) | HIGH | MEDIUM | CLEO-INJECTION.md v2.5.0 |
| Diff 6 (Escalation triggers) | MEDIUM | LOW | CLEO-INJECTION.md v2.5.0 |
| Diff 4 (Attachment anti-pattern row) | MEDIUM | LOW | ct-cleo v next |
| Diff 5 (Sizing defaults table) | LOW | LOW | ct-cleo v next |

---

## 8. What Would Have Changed in the Benchmark

With these diffs applied, the CLEO builder in the benchmark would have:

1. **After `cleo add` for T001 + 8 children**: hit the ≥ 5 task threshold, called `cleo orchestrate start --epic T001`, received wave analysis, and could have dispatched parallel workers for Wave 0 tasks. The benchmark's single-agent sequential execution would have become a properly-tiered multi-agent run.

2. **After completing T002** (first child task): called `cleo observe "key finding" --title "T002 core-timer"` — this would have hit the schema bug (no such column: provenance) at task 2, not at session end. The agent would have known to work around it (write a sticky note or file-based observation) for the remaining 6 tasks instead of silently losing all BRAIN data.

3. **Before completing each task**: run `cleo check gate.status` as a pre-complete ritual. For the task that marked `testsPassed: true`, the gate ritual would have forced the agent to confirm "did you actually run tests?" before proceeding, potentially catching the missing integration test.

4. **When writing `docs/` or `specs/`**: used `cleo update T00x --files "docs/timer-spec.md"` to attach research artifacts to the task row, making them queryable via `cleo show` for any future agent picking up the project.

---

## 9. Recommended Next Steps

1. Apply Diff 1 and Diff 6 to `CLEO-INJECTION.md` (version bump to 2.5.0).
2. Apply Diffs 3, 3b, 4, 5 to `ct-cleo/SKILL.md` (patch release).
3. Fix `cleo memory observe` schema migration (no such column: provenance) before v2026.4.66 — referenced in SUPREME_REPORT §7. Without this fix the "observe after complete" ritual fails silently.
4. Re-run the pomodoro benchmark with diffs applied + tiering working. Expected outcome: CLEO arm should activate orchestrate domain, persist BRAIN observations, and ship an integration test — all three gaps the benchmark exposed.
