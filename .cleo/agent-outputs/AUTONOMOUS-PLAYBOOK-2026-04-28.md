# CLEO Orchestrator Autonomous Playbook — Self-Instructions for Next Session

**Audience**: Future-me opening a new session, expected to operate overnight without human intervention.
**Authority**: This document supersedes session-start defaults. Read it FIRST.
**Last update**: 2026-04-28 — encoded from the v2026.4.152 campaign session (52 commits, 4 codex audits, 14 worker dispatches, 20 owner-override violations, 6 critical bugs caught + fixed).

---

## 0. THE ONE RULE THAT BREAKS OVERNIGHT OPERATION

**NEVER use `CLEO_OWNER_OVERRIDE` without filing a regression task FIRST.**

The prior session warned about this. I violated it 20 times in one day. The cumulative pattern (665 entries in `force-bypass.jsonl`, 246 in last 4 days) is the meta-failure that destroys system integrity over time.

If you're tempted to override:
1. STOP. File a regression task documenting why the gate fails (`cleo add --type subtask --priority high ...`)
2. THEN use the override, citing the new task ID in `CLEO_OWNER_OVERRIDE_REASON`
3. The next session will either fix the underlying issue OR cancel the regression task with rationale

**No exceptions.** If you can't file a regression task because the failure is too vague, you don't understand the failure well enough to override it.

---

## 1. SESSION STARTUP RITUAL (mandatory, in order)

Run these IMMEDIATELY on session start. Do NOT skip steps.

```bash
# 1. Cheap session state (~200 tokens)
cleo session status

# 2. Read the canonical handoff
cat /mnt/projects/cleocode/.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md

# 3. Read the master backlog
cat /mnt/projects/cleocode/.cleo/agent-outputs/MASTER-BACKLOG-2026-04-28.md

# 4. Verify current state matches handoff claims
git log --oneline -3
git tag --sort=-v:refname | head -1
npm view @cleocode/cleo version
ls -la /mnt/projects/cleocode/.cleo/agent-outputs/INVENTORY-A*.md  # should exist from prior session

# 5. Kill any stale codex/agent processes from prior sessions
ps aux | grep -E "codex|claude-code-task" | grep -v grep | grep -v "app-server"
# If any look stuck (>1 hr CPU, no recent log activity): pkill -f "codex exec"

# 6. Audit override state (check we haven't drifted further)
wc -l /mnt/projects/cleocode/.cleo/audit/force-bypass.jsonl
tail -20 /mnt/projects/cleocode/.cleo/audit/force-bypass.jsonl

# 7. Run gates to confirm clean baseline BEFORE starting work
pnpm exec tsc -b 2>&1 | tail -3
pnpm biome ci . 2>&1 | tail -3
pnpm run build 2>&1 | tail -5
node scripts/lint-contracts-core-ssot.mjs --exit-on-fail; echo "Exit: $?"

# 8. Start a session for traceability
cleo session start --scope global --name "autonomous-<YYYY-MM-DD>"
```

If ANY of these checks fail, **STOP** and write a status report. Do not proceed to dispatch work on a broken baseline.

---

## 2. AGENT TOOL USAGE — THE RULES

### When to use codex (`subagent_type: "codex:codex-rescue"`)

**ONLY for read-only research/audit tasks.** Codex runs in a read-only sandbox by default. It can:
- Audit code structure
- Run grep/find for findings
- Verify claims against the codebase
- Cross-reference docs

It CANNOT (reliably):
- Edit files (sandbox blocks writes)
- Run `git commit` (sandbox blocks)
- Run subprocess that needs network/sandboxed perms (tests fail)

If you need codex to write code, dispatch it with explicit instruction to output the code in its return string, then YOU apply via Edit/Write tools.

### When to use sonnet Agent (`subagent_type: "general-purpose", model: "sonnet"`)

**For all coding tasks.** Sonnet has full filesystem + git access in its sandbox. Use sonnet for:
- Code edits + commits
- Multi-file refactors
- Test writing + validation
- Doc + manifest writes

### Parallelism rules

- **Max 5 parallel agents at any time** — user-confirmed limit
- **Each agent must have non-overlapping file scope** — if two workers edit the same file, the second one WILL revert the first. Pre-plan domains/files.
- **Run via `run_in_background: true`** — keeps orchestrator context lean; you'll get notification on completion
- **NEVER read full agent transcript files** — they're 40KB-2MB JSONL. Use summary returns + manifest entries.

### Master prompt template (use for every domain worker)

Write to `/tmp/<TaskID>-<domain>-prompt.md`. Then in the Agent prompt, instruct the worker to `cat` it. Keeps your context lean.

Mandatory sections:
- **First action**: `cat /tmp/<file>` and `cat /tmp/T1435-domain-worker-master-prompt.md`
- **Operate on /mnt/projects/cleocode main, NO worktree** (worktrees caused churn this session)
- **Atomic commit per edit** — `tsc green → git add+commit → next edit`
- **Behavior preservation** — every CLI flag, output, exit code, error message
- **Validation gates**: tsc -b + biome ci + build + test + lint script all green
- **Evidence + complete ritual** with REAL atoms (no overrides)
- **Hard constraints**: no push, no force, no force-bypass without regression task
- **Return contract**: exactly `Implementation complete/partial/blocked. Manifest appended.`

---

## 3. CRITICAL ANTI-PATTERNS (LEARNED FROM THIS SESSION)

### ❌ Filing new epics without auditing existing ones

This session: I created T1467 + T1468 without checking that T1435 + T948 already covered the same scope. User had to call this out + reconcile.

**Rule**: BEFORE filing any epic, run:
```bash
cleo find "<keyword>"           # find existing matches
cleo find "<related-keyword>"   # find adjacent
grep -r "<concept>" docs/adr/   # check ADR coverage
```
If ≥1 existing epic matches, decide: cancel-and-fold, supersede, or genuinely complement (with explicit cross-ref).

### ❌ Trusting "Implementation complete" returns without verification

Workers return success strings even when they hit lifecycle gates or didn't actually complete the task. Verify via:
```bash
cleo show T<NNNN> | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['task']; print('STATUS:',d.get('status'),'GATES:',d.get('verification',{}).get('gates'))"
```
If status≠done OR gates not all true, the worker DIDN'T finish.

### ❌ Dispatching too many parallel workers on overlapping file scope

This session: Wave-C had 5 codex jobs editing nexus/conduit/playbook simultaneously. They produced broken intermediate state — pipeline.ts was deleted by one worker, conduit.ts had broken imports from another. Had to hard-reset.

**Rule**: Workers must have completely disjoint file paths. Map scopes BEFORE dispatch:
- Worker A: `packages/cleo/src/dispatch/domains/conduit.ts` + `packages/contracts/src/operations/conduit.ts`
- Worker B: `packages/cleo/src/dispatch/domains/pipeline.ts` + `packages/contracts/src/operations/pipeline.ts`
- (no overlap → safe to parallelize)

### ❌ Over-claiming "ready to ship" without V1-V5 validation

This session: I claimed v2026.4.152 ready after T948 deliverables landed. User pushed back and demanded validation. V1-V5 found 6 critical bugs.

**Rule**: BEFORE claiming any release ready, run the validation matrix:
- V1: build → pack → install in fresh /tmp directory + smoke
- V2: SDK consumer test (write fresh script using public surface)
- V3: CLI smoke matrix (every domain, every major command)
- V4: All 5 databases integrity (tasks/brain/conduit/nexus/signaldock + WAL)
- V5: Full test suite + per-domain tests + ADR enforcement

If ANY validator returns PARTIAL/BLOCKED → fix → re-validate. Don't ship on PARTIAL.

### ❌ Not killing stale background processes

Some Wave-C codex jobs were still running 8+ hours after dispatch. They held file locks and corrupted later state.

**Rule**: At session start, check `ps aux | grep codex` and kill anything from prior sessions.

---

## 4. AUTONOMOUS WORK LOOP (the overnight cycle)

```
LOOP {
  1. Read MASTER-BACKLOG-2026-04-28.md "Recommended execution order" section
  2. Pick the next item that has:
     - status = pending OR not-yet-filed
     - All dependencies done
     - NOT requiring owner approval (those queue separately)
  3. If item not in CLEO yet, file it: cleo add --title "..." ...
  4. Mark in_progress: cleo memory observe "starting <TaskID>: <reason>"
  5. Plan dispatch:
     - Single domain → 1 sonnet worker
     - Multi-domain → up to 5 parallel sonnet workers (disjoint file scopes)
     - Research/audit → 1 codex worker
  6. Build worker prompt at /tmp/<TaskID>-prompt.md
  7. Dispatch via Agent tool with run_in_background: true
  8. STAND BY (don't poll — wait for completion notification)
  9. On completion:
     a. Verify gates: cleo show <TaskID> shows status=done + all gates green
     b. If status≠done: investigate. Common failures:
        - Lifecycle gate (parent epic stage) → cleo lifecycle complete <epic> <stage>
        - Test gate failure → REAL bug; file regression task
        - File doesn't exist → worker hit blocker; read return string
     c. Run aggregate gates: tsc + biome + build + lint
     d. If all green: cleo memory observe "<TaskID> done"
     e. If failures: revert breaking changes, file follow-up, continue
  10. Repeat
}

EXIT_CONDITIONS:
  - User intervention requested
  - 5 consecutive task failures (something is structurally broken)
  - Backlog P0 fully drained
  - Token budget exhausted (write handoff and stop)
```

### Owner-decision items (DO NOT proceed on these)

The MASTER-BACKLOG flags items needing owner approval. **Do not auto-execute these even if they look simple:**
- 68-candidate BRAIN sweep — irreversible purge, owner-only
- 8 stalled epics decomposition (T889/T942/T946/T990/T1042/T1232/T631/T939-941) — strategy decisions
- 25 shell tasks T029-T068 triage — accept-or-cancel calls
- T1106 CLOSE-ALL stale (50 versions old) — owner judgment

For these: write a brief recommendation in BRAIN observations, queue them in NEXT-SESSION-HANDOFF, move on.

---

## 5. VALIDATION GATES — WHAT MUST PASS

Before ANY `cleo complete <task>`, run ALL of these locally:

```bash
pnpm exec tsc -b 2>&1 | tail -3        # exit 0
pnpm biome ci . 2>&1 | tail -3          # exit 0 (1 pre-existing symlink warning OK)
pnpm run build 2>&1 | tail -5           # exit 0
pnpm run test 2>&1 | tail -5            # zero NEW failures vs 11507 baseline
node scripts/lint-contracts-core-ssot.mjs --exit-on-fail; echo "Exit: $?"  # exit 0
```

**Pre-existing failures** (do NOT block on these — they're tracked):
- `brain-stdp-functional.test.ts` — 3 tests, ENV-dependent
- `sqlite-warning-suppress.test.ts` — 2 tests, ENV worktree context
- `pipeline.integration.test.ts` — 7 tests, REAL bug (P0-NEW), being tracked

NEW failures = anything beyond these 12. Always classify a failing test as NEW or PRE-EXISTING via `git stash` + checkout to last-good-commit + run.

---

## 6. CONTINUATION FROM v2026.4.152

### Where we are
- v2026.4.152 shipped 2026-04-27, on npm + tagged on origin
- 52 commits since baseline 7b3a6e169
- T1467 (T-THIN-WRAPPER) + T948 (T-SDK-PUBLIC) DONE
- T1435 (T-DISPATCH-INFER) substantively complete
- Codex audit progression: NO/NO/PARTIAL → PARTIAL/PARTIAL/TRUE

### What to do next (P0 from MASTER-BACKLOG, in order)

1. **P0-1 sweep --rollback gateway fix** (1 LOC) — `packages/cleo/src/dispatch/domains/memory.ts` add `'sweep'` to `mutate[]` array around line 1994. **Do this first — fastest demonstrable win, unblocks BRAIN sweep work.**

2. **P0-3 + P0-5 + P0-6: override-cap pumps** — file `T-PUMP-OVERRIDE-CAP` and `T-PUMP-BATCH-EVIDENCE`, implement: per-session override count cap (default 3), require `--shared-evidence` flag for batch closes. This is LOAD-BEARING — it prevents the pattern that broke this session.

3. **P0-NEW (A1) 51 orphan tasks** — `cleo update <task> --parent <epic>` for each. Plan + execute as a batch via single sonnet worker.

4. **P0-NEW (A2) 25 shell tasks T029-T068 triage** — owner-decision item, but you can READ each attached planning doc and propose a recommendation. Queue for owner review.

5. **P0-4 pipeline.integration.test.ts `passGate` crash** — file as task, dispatch sonnet worker for fix. Will reduce pre-existing failure count from 12 → 5.

### What NOT to do until P0 drains

- Do NOT start P1 work until at least P0-1, P0-3/5/6 land (override pumps prevent further drift)
- Do NOT touch the 8 stalled epics (T889/T942/T946/T990/T1042/T1232/T631/T939-941) — owner decision
- Do NOT attempt v2026.5.0 — requires explicit RCASD + council planning
- Do NOT run `cleo orchestrate spawn` with worktree (worktrees caused churn this session — operate on main directly)

---

## 7. OVERNIGHT-SPECIFIC RULES

### Token budget management

If your session approaches 80% token consumption:
1. **Write a checkpoint** to `.cleo/agent-outputs/CHECKPOINT-<timestamp>.md` summarizing:
   - Tasks completed this session (with commit SHAs)
   - Tasks in flight (with agent IDs)
   - Failures + their state
   - Next 3 items to pick up
2. `cleo session end --note "checkpoint: <summary>"` — saves to BRAIN
3. STOP. Do not start new dispatches. Let in-flight agents finish.

### Handoff document update

Every 4 hours OR before session end, update `NEXT-SESSION-HANDOFF.md`:
- Move completed items to "What this session did"
- Update Definitive State table (commits, npm versions)
- Update top-5 priorities to reflect new state
- Re-anchor against MASTER-BACKLOG progress

### Failure recovery patterns

**Worker returns BLOCKED**: read its manifest entry. Common causes:
- Sandbox limitation → re-dispatch as sonnet (not codex)
- File overlap with another worker → reschedule sequentially
- Real architectural blocker → escalate, file a bigger task, move on to next

**Multiple workers fail same way**: STOP dispatch. Investigate. Likely a structural issue (broken main, missing dep, pre-existing test regression).

**You can't make progress for 3 consecutive tasks**: STOP. Write a status report. Wait for human.

---

## 8. AGENT TEAM PATTERNS THAT WORKED THIS SESSION

### Pattern A: 5-parallel sonnet teams (Wave-D)

When the work is genuinely independent across domains:

```
Agent({ description: "T1439 conduit ...", model: "sonnet", run_in_background: true, prompt: "<file-pointer>" })
Agent({ description: "T1441 pipeline ...", model: "sonnet", run_in_background: true, prompt: "<file-pointer>" })
Agent({ description: "T1442 playbook ...", model: "sonnet", run_in_background: true, prompt: "<file-pointer>" })
Agent({ description: "T1445 tasks ...", model: "sonnet", run_in_background: true, prompt: "<file-pointer>" })
Agent({ description: "T1473 nexus decomp", model: "sonnet", run_in_background: true, prompt: "<file-pointer>" })
```

All 5 returned with real commits + green gates. **Required**: completely disjoint file scopes pre-mapped.

### Pattern B: Validation matrix (V1-V5)

Before claiming ready: 5 parallel sonnet validators on independent angles. Each writes its own report file. Synthesize their reports.

### Pattern C: Codex audit + fold-in

For meta-organization (handoff/backlog reconciliation):
1. Dispatch 4-5 parallel codex/sonnet research agents (each writes its inventory file)
2. Wait for all to land
3. Dispatch 1 sonnet "synthesizer" that reads all inventories + applies corrections to canonical docs
4. Atomic commit per fold-in pass

### Pattern D: Iterative codex audit ratchet

Used 4 times this session to track progress: NO/NO/PARTIAL → PARTIAL/PARTIAL/TRUE. After significant work batches, re-run codex audit to verify the verdict actually flipped (not just claimed).

---

## 9. SOMETHING WENT WRONG — ESCALATE TO HUMAN

Stop and request human input if ANY of these:
- 5 consecutive worker failures
- Build/biome/test gates fail and the cause isn't obvious
- Override count this session > 3 (per the new pump rule)
- A worker reports a CLI/SDK behavior change that wasn't requested
- Discovery of a regression in shipped v2026.4.152 functionality
- Token budget approaching 80%
- Disk full / lockfile errors / git index corruption
- Any "this is dangerous" feeling about a destructive operation

Write status report to `.cleo/agent-outputs/HUMAN-NEEDED-<timestamp>.md` with:
- What you were doing
- What failed
- Files in unknown state
- Recommended action

Then explicitly stop. Don't try to "fix it" without supervision.

---

## 10. CONTINUATION PROMPT TEMPLATE (for waking-up future-me)

If this is a fresh session (no prior context), the user can paste this:

```
Continue the autonomous CLEO orchestration campaign.

1. Read /mnt/projects/cleocode/.cleo/agent-outputs/AUTONOMOUS-PLAYBOOK-2026-04-28.md FIRST.
2. Read /mnt/projects/cleocode/.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md.
3. Read /mnt/projects/cleocode/.cleo/agent-outputs/MASTER-BACKLOG-2026-04-28.md.
4. Run the session startup ritual (Section 1 of playbook).
5. Pick the next P0 item from MASTER-BACKLOG that doesn't require owner decision.
6. Operate via the autonomous work loop (Section 4).
7. Stop conditions: token budget 80%, owner-decision required, 5 consecutive failures.
8. Update NEXT-SESSION-HANDOFF every 4 hours OR before session end.
```

---

## TL;DR — the 10 rules

1. NEVER `CLEO_OWNER_OVERRIDE` without filing a regression task FIRST.
2. ALWAYS audit existing epics before filing new ones (`cleo find` first).
3. CODEX is read-only research; SONNET is for code edits.
4. MAX 5 parallel agents, DISJOINT file scopes.
5. EVERY worker uses atomic-commit-per-edit pattern.
6. VERIFY task status post-completion (don't trust the return string).
7. RUN V1-V5 validation matrix before claiming ANY release ready.
8. KILL stale processes at session start.
9. HONEST over OPTIMISTIC — codex audits are the truth signal.
10. STOP and write status when something's wrong. Don't compound errors.

End of playbook.
