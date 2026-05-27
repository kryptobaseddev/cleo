# The Council — Is T1216 structured to produce trustworthy false-completion verdicts, or will it ship confident conclusions on a flawed premise?

## Evidence pack

1. **T1216 spec** — `cleo show T1216`: 15 children, priority=critical, pipelineStage=research, acceptance includes engine fix (T1222), 176-task backfill, audit report at `docs/audits/2026-04-22-false-completion-audit.md`.

2. **T991 "1 commit HIGHEST RISK" framing is misleading — work shipped under child task IDs.** `git log --all --grep="T991"` = 1 commit (release chore). `git log --all --grep="T99[4-9]"` = T994: 2, T995: 2, T996: 2, T997: 3, T998: 3, T999: 4 → **16 child-task commits** in v2026.4.98. Release `18128e3ce chore(release): v2026.4.98 — T991 + T1000 + T1007 Tier 2 + T1013 hygiene` confirms named ship.

3. **`cleo list --parent T991` returns 0 children** — but git log proves T994–T999 shipped substantive commits. DB-level parent-child relationship broken/missing, yet work is in codebase. "Zero child tasks" per T1216 description ≠ "no work done".

4. **`packages/cleo/src/dispatch/engines/task-engine.ts:831`** — CLEO engine does NOT currently enforce `verification_json` NOT NULL on `tasks.complete`. Re-validates `verification.evidence` IF populated; no path rejects NULL. T1222 is load-bearing.

5. **`T990` precedent (filed 2026-04-19 post-`T949` merge)** — UI false-completion is a real pattern but different shape — quality false-completion, not null-gate false-completion.

6. **BRAIN-integrity reconciliation already merged into v2026.4.133 spine** — per 2026-04-24 Council (observations `O-dfb7f334`, `O-5e7540d6`). T1227 auditing T991 risks re-litigating already-reconciled scope.

7. **176 audit-column-gap tasks is SYSTEMIC** — ALL 176 pre-ADR-051 completions have `modified_by=NULL` + `session_id=NULL`. The 12 "full-NULL" suspects are a subset that additionally lack `verification_json` + audit log + lifecycle history + child tasks. Backfill is a bulk schema correction distinct from per-epic forensic audit.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Lane acknowledgment:** I find failure modes — what breaks at runtime, under load, over time, or under human pressure. I do NOT find correctness errors (First Principles), claim/reality gaps (Outsider), opportunities (Expansionist), or actions (Executor). My findings must name a trigger condition, not a static defect.

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- Evidence item 2 (T991 shipped under child IDs: T994-T999 = 16 commits, release `18128e3ce`) — T1216's own premise treats T991 as a "zero-commit, zero-child" suspect. The audit checklist will operate on the DB view, not the git view.
- Evidence item 3 (`cleo list --parent T991` = 0) — auditors will find 0 children, conclude "no work done," mark T991 false-completion; meanwhile v2026.4.98 is in production.
- Evidence item 4 (`task-engine.ts:831` does not reject NULL `verification_json` on complete) — T1222 is an acceptance criterion of T1216, not a prerequisite; T1216 can progress and produce verdicts while the engine still accepts null-gate completions.
- Evidence item 7 (176 systemic audit-column-gap, 12 are the full-NULL subset) — audit scope is defined by a symptom cluster; the defect produced 176 victims, not 12.
- Evidence item 6 (BRAIN-integrity reconciliation merged into v2026.4.133 spine) — T1227's audit of T991 will re-traverse ground the 2026-04-24 Council already resolved.

**Findings (failure modes):**

1. **DB-view-only audit confidently marks shipped work as false-completion** — triggers when any T1216 child evaluates the 12 suspects by querying `cleo list --parent <epic>` or `tasks.verification_json` alone, without cross-referencing `git log --all --grep="<childId>"`. Fails silently by producing "verdict: FALSE-COMPLETION — no children, no commits" on T991 while 16 commits under T994-T999 sit in v2026.4.98 in production. Audit report at `docs/audits/2026-04-22-false-completion-audit.md` looks authoritative and is dated; reviewers trust it.

2. **T1222 engine fix lands AFTER the audit has already written verdicts, so the same null-gate defect produces new false-completions during T1216's own execution window** — triggers when T1216 children run in parallel (15-child epic, priority=critical, likely waved) and T1222 is scheduled as peer child rather than blocking dependency. Fails by: audit child task X calls `cleo complete TX` without `--evidence`, engine accepts it (task-engine.ts:831 only gates if populated), TX joins the 176-cohort. Detected only by noticing T1216's own children appearing in a future false-completion audit.

3. **Audit report at a dated filesystem path becomes the canonical verdict while DB state drifts, and no mechanism invalidates stale verdicts** — triggers when T1216 ships `docs/audits/2026-04-22-false-completion-audit.md` as static markdown, then BRAIN-integrity reconciliation (evidence 6), T1147 W7 shadow-write, or T1262 memory-doctor produce contradicting findings. `.md` artifact is immutable-by-convention; DB is mutable-by-design. Fails by two sources of truth disagreeing with no precedence rule.

**Verdict from this lens:** The plan ships confident conclusions on a flawed premise. APPROVE with amendments is the maximum the evidence supports; without amendments, REFACTOR before execution.

**Single sharpest point:** T1216 will silently produce a canonical markdown verdict marking T991 "false-completion — no children, no commits" while v2026.4.98 ships 16 commits of T991 work under child-task IDs T994-T999 — triggered the moment any audit child task trusts `cleo list --parent T991` (returns 0) over `git log --all --grep="T99[4-9]"` (returns 16), because the DB's broken parent-child relationship is the prior bug the audit is supposed to illuminate, not the scoring criterion it's built on.

### Advisor: First Principles

**Lane acknowledgment:** I find correctness errors against atomic truth, derived from the world — not runtime failure modes (Contrarian), not artifact claim/reality gaps (Outsider), not opportunities (Expansionist), not actions (Executor). My atoms must hold even if the codebase vanished tomorrow.

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- ADR-051 (evidence-required gate completion) — atomic-truth basis: a completion claim that cannot be re-verified against git/filesystem/toolchain is not a completion, it is an assertion. Holds for any task system, anywhere.
- Evidence item 4 (`packages/cleo/src/dispatch/engines/task-engine.ts:831` re-validates only when populated; no NULL-rejection path) — the enforcement gap is structural, not historical.
- Evidence item 2 (`git log --grep="T99[4-9]"` shows 16 child-task commits; release `18128e3ce` names T991) — the "1 commit" framing is an artifact of a DB relationship, not a work-existence claim.
- Evidence item 7 (176 audit-column-gap rows, 12 of which are full-NULL) — two distinct phenomena, one systemic, one a subset.

**Atomic truths (independent of the artifact):**

1. A completion claim without re-verifiable evidence is indistinguishable from a false claim (core ADR-051 atom).
2. An audit performed while the measurement instrument is still broken produces untrustworthy verdicts. Fix the thermometer before re-taking temperatures.
3. "No database relationship" and "no work performed" are different propositions and require different evidence.
4. Systemic column gaps (N=176) and pointwise evidence gaps (N=12) require different remediations.
5. Re-litigating a closed decision costs more than it yields unless new evidence exists.
6. False-negative verdict and false-positive verdict costs are asymmetric.

**Reconstructed solution:** Land engine NULL-rejection FIRST as standalone mergeable change with tests (atoms 1, 2); then begin per-epic audits. Split into three independent tracks — (a) engine fix, (b) 176-row backfill, (c) 12-suspect forensic audit (atoms 3, 4). Track (c) treats git log, release notes, filesystem artifacts as first-class evidence channels co-equal with tasks DB. Minimum four-outcome verdict schema: `verified-complete`, `verified-incomplete`, `schema-artifact-not-work-defect`, `inconclusive` (atom 6). Explicit carve-out: audit verifies gate state, not architectural conclusions (atom 5, evidence 6).

**Divergences from proposed plan:**
- T1222 as child/acceptance item rather than blocking predecessor — **GENUINE ERROR** against atom 2.
- "Zero child tasks" framing conflated with "no work done" for T991 — **GENUINE ERROR** against atom 3.
- Audit scope overlaps with reconciled BRAIN-integrity spine — path-dependent cruft risking genuine error against atom 5.
- 176-row backfill bundled with 12-epic forensic audit — path-dependent cruft against atom 4.
- Audit verdict taxonomy not explicitly specified — **GENUINE ERROR** against atom 6.

**Verdict from this lens:** REFACTOR before execution. Promote T1222 from acceptance-item to hard predecessor; define minimum four-outcome verdict schema in the audit template; optionally split 176-row backfill into sibling epic.

**Single sharpest point:** An audit of completion-gate integrity, performed by a system that still accepts NULL completion-gate evidence, cannot produce trustworthy verdicts — T1222 is not a backstop, it is the precondition, and its current placement as a peer acceptance item rather than a blocking predecessor is the one thing in T1216 that must change before the wave runs.

### Advisor: Expansionist

**Lane acknowledgment:** I find opportunities, latent assets, and asymmetric bets the plan is NOT attempting. I do NOT enumerate risks (Contrarian), debate correctness (First Principles), surface stranger observations (Outsider), or pick actions (Executor). My single distinguishing test: naming something valuable T1216 is not already attempting.

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- Evidence 7 — 176 audit-column-gap tasks is SYSTEMIC; T1216 scopes this as one-time migration buried inside 12-suspect audit. Latent asset: population-scale ground-truth dataset of pre-ADR-051 completions that could power a permanent "completion quality classifier" across the entire task history.
- Evidence 2 — T991 work shipped under 16 child-task commits across v2026.4.98; the "0 children in DB, but real work in git" mismatch is a latent asset: proves git-log + release-tag correlation can reconstruct lineage the tasks DB lost. Currently one-shot; could be permanent `cleo audit reconstruct` primitive.
- Evidence 4 — T1222 engine fix treated as backstop checkbox. Engine already re-validates evidence atoms at `task-engine.ts:831` when populated. Extending hot path into a structured completion-ledger emits permanent audit exhaust for every future completion.
- Evidence 6 — BRAIN-integrity reconciliation merged into v2026.4.133 spine. T1216's verdict generation produces a second corpus of ground-truth decisions that could feed BRAIN promotion pipeline directly as typed memory Sentient v1 reflex already consumes.

**Findings (opportunities):**

1. **Completion-quality classifier from the 176-task backfill corpus** — labeling happens anyway under T1216; storing it as typed memory is ~1 schema addition + 1 emit hook for permanent predictive telemetry across the entire task corpus. Every future `cleo complete` can be scored against it ("this completion looks like the T991-pattern — 87% of its cohort was later re-opened").

2. **`cleo audit reconstruct` as a first-class SDK primitive** — the git-log + release-tag + commit-message lineage reconstruction T1216 must build internally belongs in `packages/core/` as `audit.reconstructLineage(taskId)` per D023 SDK-first + canonical layering. T1216 has to write this logic anyway; promoting it from private helper to SDK verb is a packaging decision.

3. **T1222's NOT NULL enforcement → structured completion ledger (append-only event stream)** — emit every accepted completion as hash-chained event to `.cleo/audit/completions.jsonl` (mirroring existing `force-bypass.jsonl` pattern). This is the exhaust BRAIN-integrity reconciliation and Sentient v1 dispatch-time reflex are already designed to consume — M6/M7 binding gates land on pre-built substrate instead of retrofitting one.

**Verdict from this lens:** T1216 is sized as a debugging initiative when evidence supports sizing it as the forcing function that produces CLEO's completion-integrity substrate. The 176-task corpus, the lineage-reconstruction logic, and the T1222 hot-path edit are each 90% of a durable asset the project will otherwise rebuild piecemeal across the next three BRAIN-integrity epics.

**Single sharpest point:** T1222's NOT NULL enforcement is a trivially-extended write path — promote it from "backstop" to "structured completion-ledger emitter" in the same commit, because the append-only event stream it would produce is the exact substrate that BRAIN-integrity reconciliation, Sentient v1 dispatch-time reflex, and every future false-completion audit are currently designed to consume from nothing.

### Advisor: Outsider

**Lane acknowledgment:** I find claim/reality gaps and pattern-breaks visible from the artifact alone. I do not predict runtime failures (Contrarian), reason from external truths (First Principles), identify opportunities (Expansionist), or prescribe actions (Executor). Every claim is defensible by pointing at the artifact.

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- T1216 description states "zero child tasks"; `cleo list --parent T991` returns 0 children (pack items 1, 3).
- `git log --all --grep="T99[4-9]"` — 16 commits tagged T994–T999 landed in release `18128e3ce chore(release): v2026.4.98` (pack item 2).
- `packages/cleo/src/dispatch/engines/task-engine.ts:831` — re-validates `verification.evidence` only when populated; no branch rejects NULL `verification_json` (pack item 4).
- T1216 acceptance criteria bundles per-epic audit (12 suspects) + engine fix (T1222) + 176-row backfill migration in one epic (pack items 1, 7).
- Audit memo path `docs/audits/2026-04-22-false-completion-audit.md` named as basis for suspect list but not quoted in T1216 spec body.

**Findings (claim/reality gaps):**

1. **The premise sentence and the git log contradict each other.** "Zero child tasks" is a DB-join result; git log shows 16 commits under child IDs named in release commit. A stranger concludes: "the evidence of non-completion is that a DB join returned empty, not that work is absent." The epic treats them as the same claim.

2. **The epic fuses three structurally different problems under one verdict surface.** (a) 12-suspect audit, (b) engine code change T1222, (c) 176-row backfill for systemic NULL-column issue explicitly broader than 12 suspects. Stranger expects three deliverables with three done-definitions; the artifact presents one epic with one audit report.

3. **The backstop is declared inside the thing it is supposed to backstop.** T1222 is a child of T1216 and part of its acceptance. If engine currently accepts NULL-evidence completions, nothing visible in the spec prevents a task completed during the audit window from landing with the same gap. No ordering constraint — just co-membership.

4. **The rubric for a per-task verdict is not visible in the artifact.** Given finding #1 exposes a case where DB signal and git signal disagree, the absence of a written discriminator between "false completion" / "completed work with incomplete DB bookkeeping" / "completed work inside systemic column-gap cohort" is the load-bearing gap.

**Verdict from this lens:** A thoughtful stranger would not approve this as-is. The structure can produce verdicts, but the epic does not show how those verdicts avoid the exact mistake the T991 evidence already exposes: treating absent DB rows as absent work.

**Single sharpest point:** The epic's own premise ("zero child tasks") is falsified by a one-line `git log` against its own flagship suspect, and nothing in the spec explains how the audit will distinguish that case from a real fraudulent completion.

### Advisor: Executor

**Lane acknowledgment:** I produce exactly one startable-now action with an unambiguous expected outcome. I do NOT debate structure (First Principles), enumerate risks (Contrarian), suggest scopes (Expansionist), or reframe the premise (Outsider). One action, one paragraph, one expected outcome.

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `packages/cleo/src/dispatch/engines/task-engine.ts:834-868` — engine re-validates `task.verification?.evidence` only IF populated; no branch rejects NULL (pack item 4).
- `cleo show T1222` — status=pending, pipelineStage=research, verification not yet initialized. The backstop the audit depends on has not started.
- `cleo show T1216` — 15 children, 0 active; `docs/audits/` does not exist on disk. The audit artifact is future work; the engine gate is the chokepoint (pack item 1).
- Pack items 2 + 4 — 176 audit-column-gap tasks are systemic; the T991 "1 commit" framing is wrong (16 child commits under T994–T999); audit sub-agents running before T1222 can themselves complete with NULL verification.

**The action (one):** Create branch `task/T1222`, open `packages/cleo/src/dispatch/engines/task-engine.ts` and write a failing vitest in the adjacent `.test.ts` that calls the `complete()` flow against a fixture task whose `verification` field is `null` (mirror the existing evidence-stale test's setup) and asserts rejection with the canonical error-code identifier — **first grep `packages/contracts/src/errors` for the correct `E_EVIDENCE_*` identifier** (do NOT use `E_VERIFICATION_NOT_INITIALIZED`; that name is unverified and the ADR-051 pack shows canonical prefix is `E_EVIDENCE_*`). Run `pnpm --filter @cleocode/cleo test task-engine` and confirm the test fails. Commit on branch `task/T1222` with message `test(T1222): failing test — tasks.complete must reject verification_json NULL`.

**Expected outcome (60 minutes from now):** `pnpm --filter @cleocode/cleo test task-engine` exits non-zero with exactly one failure whose name asserts NULL-verification rejection using the grep-verified canonical error code, and that failing test is committed on branch `task/T1222`.

**What this unblocks:** The rest of T1222 (the actual rejection branch + `modified_by`/`session_id` population + 176-row backfill) has a red test to turn green; the 13 per-epic audit children of T1216 can be gated on "T1222 engine fix merged" so their own `cleo complete` calls cannot reproduce the NULL-verification bug they are auditing.

**Verdict from this lens:** APPROVE with amendments — make T1222's engine-rejection test the precondition for dispatching any T1217–T1221 audit child.

**Single sharpest point:** Write the failing NULL-verification-rejection test for `tasks.complete` on branch `task/T1222` and commit it red — that test is the gate the audit depends on.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — Strongest finding: "T1222 as child/acceptance item rather than blocking predecessor — GENUINE ERROR against atom 2." Subject, predicate, classification all named. Atoms themselves have clean subject-predicate structure (atom 2: "An audit performed while the measurement instrument is still broken produces untrustworthy verdicts").
- G2 Evidence grounding: PASS — Cites ADR-051, Evidence #4 (`task-engine.ts:831`), Evidence #2 (`git log --grep="T99[4-9]"` = 16 commits), Evidence #7 (176 rows), Evidence #6 (v2026.4.133 spine). All in the pack.
- G3 Frame integrity: PASS — Self-polices: "T1222's engine-level enforcement question is in my lane (structural correctness); the 'is the audit report accurate' question borders Outsider territory and I will stay off it." Atoms are world-level propositions that hold if the codebase vanished. No runtime failure modes, no opportunities, no actions.
- G4 Actionability: PASS — Verdict cashes out: "Promote T1222 from acceptance-item to hard predecessor. Define minimum four-outcome verdict schema." Taxonomy explicitly named; three-track split specified.

**Strongest finding forwarded:** An audit of completion-gate integrity performed by a system that still accepts NULL completion-gate evidence cannot produce trustworthy verdicts — T1222 is the precondition, not the backstop.

**Gap from Contrarian's frame:** First Principles names the logic error but not the runtime failure mode that the placement error produces. The answer implicit: while the 15-child wave runs in parallel, any auditor who lands `cleo verify --gate implemented` can be accepted by the engine (because `task-engine.ts:831` only re-validates populated evidence, never NULL). The audit campaign produces new rows with identical defect shape as the 176 it was meant to find — silently.

**What I would add:** A hard sequencing constraint: T1222 must merge AND a post-merge smoke test ("verify task with `--evidence` empty → expect `E_EVIDENCE_MISSING`, not success") must pass BEFORE any of the 15 child audit tasks are spawned.

**Disposition:** Accept — atomic reasoning is sound, divergences correctly classified, T1222-as-predecessor is the right hill to die on.

**Single sharpest finding forwarded to Chairman:** T1222's current status as an acceptance-item peer of the audit tasks rather than a hard blocking predecessor is the one structural error in T1216 that must change before the wave runs — an audit performed by a system that still accepts NULL completion-gate evidence cannot produce trustworthy verdicts.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — Strongest finding: "T1222's NOT NULL enforcement is a trivially-extended write path — promote it from 'backstop' to 'structured completion-ledger emitter' in the same commit." Named subject, predicate, asymmetry (extended write path vs. permanent substrate for three downstream consumers). Concrete cost:value ratios across all three findings.
- G2 Evidence grounding: PASS — Cites Evidence #7 (176-task backfill), #2 (16 child-task commits under T991), #4 (task-engine.ts:831), #6 (v2026.4.133 spine). Every item in the pack. Finding 3 correctly chains #4 (engine re-validation hook) with #6 (Sentient v1 already consumes typed memory).
- G3 Frame integrity: PASS — All three findings name "something valuable T1216 is NOT attempting." Classifier (not in 15 children), SDK primitive (packaging decision), completion-ledger emitter (extends T1222 scope). No risk enumeration, no correctness debate, no action selection. Stays in opportunity-identification lane.
- G4 Actionability: PASS — Verdict: "T1216 is sized as a debugging initiative when evidence supports sizing it as the forcing function that produces CLEO's completion-integrity substrate." Concrete re-sizing decision the Chairman can act on.

**Strongest finding forwarded:** T1222's NOT NULL enforcement extended in the same commit into an append-only hash-chained completion ledger produces the exact substrate BRAIN-integrity reconciliation, Sentient v1 dispatch-time reflex, and every future false-completion audit are currently designed to consume.

**Gap from First Principles' frame:** Expansionist never tests whether the atomic truth of "completion integrity" requires ledger emission at T1222's layer or somewhere else. From first principles: the atomic requirement is "every accepted completion must be reconstructible from an immutable record." That record could live in git commits (already immutable, already hash-chained, already the source-of-truth for Evidence #2's 16-commit reconstruction), in the tasks DB with append-only constraints, or in a new `.jsonl`. Expansionist asserts `.jsonl` without testing whether git-as-ledger is the atomic-cheaper substrate.

**What I would add:** The atomic substrate for completion-integrity already exists as git itself; cheapest form may be "canonicalize the git-log + release-tag reconstruction as the ledger" rather than "emit a second append-only stream."

**Disposition:** Accept — three opportunities are genuinely not-attempted-by-T1216, evidence-anchored, materially change the framing. Gap is a sharpening, not a defeater.

**Single sharpest finding forwarded to Chairman:** T1222's NOT NULL write path is a trivially-extended hook that, if promoted to a completion-ledger emitter in the same commit, produces the exact substrate BRAIN-integrity reconciliation, Sentient v1, and every future false-completion audit are already designed to consume from nothing.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — Strongest finding cites concrete artifact mechanics: "T1222 is a child of T1216 and part of its acceptance. If engine currently accepts NULL-evidence completions, nothing prevents a task completed during audit window from landing with the same gap." Every finding names subject, predicate, and what the artifact shows or fails to show.
- G2 Evidence grounding: PASS — All five anchors trace to the shared pack: T1216 spec description (item 1), `git log --grep="T99[4-9]"` 16 commits (item 2), `task-engine.ts:831` (item 4), cleo list returning 0 (item 3), audit memo path (item 1).
- G3 Frame integrity: PASS — Findings stay inside claim/reality gap and pattern-break observation. Finding 1 is pure narrative-vs-query contradiction; Finding 2 is structural-fusion observation; Finding 3 is placement pattern-break; Finding 4 explicitly flags "Rubric for a per-task verdict is not visible in the artifact" — absence reported from artifact, not predicted runtime outcome. No opportunity-naming, no failure-mode prediction, no appeal to external truths.
- G4 Actionability: PASS — Verdict: "A thoughtful stranger would not approve this as-is" plus sharpest point identifies exactly what to fix: "nothing in the spec explains how the audit will distinguish that case from a real fraudulent completion."

**Strongest finding forwarded:** Backstop declared inside the thing it is supposed to backstop — T1222 is a child and part of acceptance, with no ordering constraint shown, just co-membership.

**Gap from Expansionist's frame:** Outsider correctly identifies that the epic fuses three structurally different problems. What the stranger cannot see — and my frame does — is the latent asset inside that fusion: the 176-row backfill cohort is a population-scale dataset that doubles as ground truth for a permanent completion-classifier. The artifact treats the 176 rows as a cleanup burden; they're actually the largest labeled dataset this system will ever produce organically.

**What I would add:** The `git log` vs `cleo list` contradiction on T991 isn't just a premise bug — it's evidence the epic is sitting on a dormant second-signal reconciliation capability (git-log-derived completion truth crossed against DB completion truth) that would be valuable as a standing check, not a one-shot audit.

**Disposition:** Accept — Outsider executed the stranger frame cleanly, stayed in lane across all four findings, surfaced the load-bearing gap (missing per-task verdict rubric).

**Single sharpest finding forwarded to Chairman:** The epic's own premise ("zero child tasks") is falsified by a one-line `git log` against its own flagship suspect, and nothing in the spec explains how the audit will distinguish that case from a real fraudulent completion.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — Named file, named test, named branch (`task/T1222`), named command (`pnpm --filter @cleocode/cleo test task-engine`), named commit message. Expected outcome unambiguous once error-code is grep-verified.
- G2 Evidence grounding: PASS — `task-engine.ts:834-868` maps to pack #4; `cleo show T1222` / `cleo show T1216` map to pack #1; pack #2 cited as backdrop. All referenced items exist in pack.
- G3 Frame integrity: FAIL — Executor drifted twice: (1) into Contrarian territory by enumerating runtime risk ("If audit sub-agents run before T1222 lands, they can themselves complete tasks with NULL verification, reproducing the bug under audit"); (2) into First Principles/Chairman territory with plan-amendment verdict ("make T1222's engine-rejection test the precondition for dispatching any T1217–T1221 audit child"). Executor's lane is "exactly one action, startable now" — not action plus plan-amendment plus dependency recommendation.
- G4 Actionability: PASS — The verdict cashes out to a concrete, startable command. Reader needs zero additional decisions to begin.

**Strongest finding forwarded:** The action produces a red-test artifact on the exact branch (`task/T1222`) where the fix will land — the cheapest proof-of-open-bug and most useful handoff artifact for the rest of T1216.

**Gap from Outsider's frame:** A stranger reading Executor's original output would notice the expected-outcome sentence promises a test named `E_VERIFICATION_NOT_INITIALIZED` but that identifier is not cited from any artifact — the pack shows canonical prefix is `E_EVIDENCE_*` (`E_EVIDENCE_MISSING`, `E_EVIDENCE_INSUFFICIENT`, `E_EVIDENCE_STALE`, `E_FLAG_REMOVED`). Executor invented the error-code name. A test whose expected failure message is itself fabricated is not an unambiguous expected outcome — the 60-minute owner could write a red test against any name and claim success.

**What I would add:** The action should quote the canonical error-code identifier from reading `packages/contracts/src/errors` / `task-engine.ts` error emissions before committing, or phrase the expected failure message as "`complete()` throws because the rejection path does not exist" — grounded in the artifact rather than in a made-up constant. (NOTE: the Executor output above has been corrected — error-code is now "grep-verified" — but the G3 lane-drift in the original remains noted.)

**Disposition:** Modify — action shape, target file, command, branch, and commit format are all correct and startable; the single defect is the fabricated error-code identifier and lane-drift into runtime-risk plus plan-amendment.

**Single sharpest finding forwarded to Chairman:** Executor picked the right target (red test on `task/T1222` for `task-engine.ts`) but invented the error-code name `E_VERIFICATION_NOT_INITIALIZED` without citing it from the codebase — the canonical prefix per ADR-051 pack is `E_EVIDENCE_*`, and any 60-minute execution must first grep `packages/contracts/src/errors` for the correct identifier.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — Strongest finding names subject, predicate, concrete trigger: "triggers when any T1216 child evaluates 12 suspects via `cleo list --parent <epic>` or tasks.verification_json alone without cross-referencing `git log --all --grep='<childId>'`. Fails by producing 'verdict: FALSE-COMPLETION — no children, no commits' on T991 while 16 commits under T994-T999 sit in v2026.4.98 in production. Detected silently." All three findings carry trigger + failure + detection.
- G2 Evidence grounding: PASS — Finding 1 cites items 2 and 3; Finding 2 cites item 4 plus item 7; Finding 3 cites item 6 and item 7. Every cited item present in shared evidence pack.
- G3 Frame integrity: PASS — All three findings name runtime failure modes with trigger conditions (DB-view lookup path at audit-time; parallel wave scheduling at execution-time; markdown-artifact immutability over time). None stray into First Principles' correctness lane, Outsider's claim/reality lane, Expansionist's opportunity lane, or Executor's action lane.
- G4 Actionability: PASS — Verdict: "APPROVE with amendments is maximum; without amendments, REFACTOR before execution." Concrete decision the owner can act on.

**Strongest finding forwarded:** T1216's audit will produce a canonical markdown verdict marking T991 "false-completion — no children, no commits" while v2026.4.98 ships 16 commits of T991 work under T994-T999 — the moment any audit child trusts `cleo list --parent T991` over `git log --all --grep="T99[4-9]"`.

**Gap from Executor's frame:** Contrarian correctly identifies three failure modes but leaves the owner without the cheapest disproof experiment. From my 60-minute lens: the entire finding hinges on the untested assumption that T1216's audit methodology actually uses `cleo list --parent` / `verification_json` rather than git log cross-reference. That is disprovable in one command — read the audit spec and grep for "git log" vs "cleo list". If the audit already cross-references git, finding 1 evaporates.

**What I would add:** Before APPROVE-with-amendments or REFACTOR, run one disproof action: open the T1216 child acceptance criteria and verify whether the audit methodology already includes `git log --all --grep="<childId>"` as a scoring input — if yes, finding 1 is already mitigated and only findings 2 and 3 require amendments.

**Disposition:** Accept — all four gates pass, findings are trigger-anchored, verdict cashes out to a binary decision.

**Single sharpest finding forwarded to Chairman:** T1216 will silently produce a canonical markdown verdict marking T991 "false-completion — no children, no commits" while v2026.4.98 ships 16 commits under T994–T999, triggered the moment any audit child trusts `cleo list --parent T991` (returns 0) over `git log --all --grep="T99[4-9]"` (returns 16).

## Phase 2.5 — Convergence check

**Sharpest points extracted and paired:**

1. **Contrarian**: T991 verdict wrong because DB-view audit trusts `cleo list --parent` over `git log` — subject = T991 verdict, predicate = will be wrong via DB-vs-git gap.
2. **First Principles**: T1222 placement — subject = T1222 sequencing, predicate = must be predecessor not peer.
3. **Expansionist**: T1222 scope — subject = T1222 scope, predicate = expand to completion-ledger emitter.
4. **Outsider**: T1216 premise falsified — subject = premise + verdict rubric, predicate = falsified by git log, no discriminator.
5. **Executor**: T1222 failing test — subject = T1222 red test, predicate = write it now as gate.

**Pairwise convergence:**
- Contrarian (#1) ↔ Outsider (#4): both center on **T991 premise falsified by DB-vs-git asymmetry**. Same subject (T1216 premise / T991 verdict), same predicate (wrong because DB ≠ git). → 2-agent cluster.
- First Principles (#2) ↔ Executor (#5): both center on **T1222-must-come-first sequencing**. FP names the structural axiom; Executor prescribes the red-test artifact that establishes it. → 2-agent cluster.
- Expansionist (#3): unique — substrate-upgrade opportunity. No convergence.

**Threshold: ≥3 agents semantically identical.** Neither cluster reaches 3. The two 2-agent clusters are complementary frame-views of the same issue, which is the expected behavior when frames are correctly separated (Contrarian names the runtime failure the artifact-gap produces; Outsider names the artifact-gap itself; FP names the structural axiom; Executor names the red-test that operationalizes it).

**Result: NO convergence flag. NO rerun required.** Proceed to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary
| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | PASS | full |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist     | PASS | PASS | PASS | PASS | full |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | PASS | PASS | FAIL | PASS | moderate |

### Recommendation
**REFACTOR before execution.** T1216 must be restructured along three axes before any audit child task runs: (1) T1222 promoted from peer acceptance item to blocking predecessor and merged first; (2) verdict taxonomy expanded from binary to four outcomes (`verified-complete`, `verified-incomplete`, `schema-artifact-not-work-defect`, `inconclusive`) with git-log + release-tag declared first-class evidence channels; (3) 176-row backfill split into a sibling epic, not a child of the 12-suspect forensic audit.

### Why this, not the alternatives
The advisor verdicts span APPROVE-with-amendments (Contrarian, Executor) through REFACTOR (First Principles, Outsider implicitly, Expansionist via resize). I adopt REFACTOR because the contention is not over severity — it is over **whether amendments to the current 15-child tree suffice or the tree itself is mis-shaped**. Three of four full-weight advisors independently reach the latter: First Principles names T1222 as precondition (not backstop) and demands three-track split; Outsider names the same fusion defect from a stranger's lens; Expansionist implicitly concedes by proposing T1222 become a ledger emitter (structural rewrite, not amendment). Contrarian's "APPROVE with amendments is maximum" is the weakest full-weight position because it treats T991 premise falsification as an audit-execution risk rather than an epic-structure defect — but the same Contrarian analysis shows the audit cannot execute correctly without the structural changes First Principles demands, so the two converge on REFACTOR in substance. Executor's verdict is discounted (3/4 gates, G3 lane-drift, fabricated `E_VERIFICATION_NOT_INITIALIZED` identifier not present in `packages/contracts/src/errors`) — the action shape (red-test first) is adopted, the verdict weight is not.

### What each advisor got right
- **Contrarian's fatal flaw to mitigate:** T1216 will silently publish a canonical markdown verdict marking T991 "false-completion — zero children" while v2026.4.98 shipped 16 commits of T991 work under T994–T999, the moment any audit child trusts `cleo list --parent T991` over `git log --all --grep="T99[4-9]"`.
- **First Principles' atomic truth worth protecting:** An audit of completion-gate integrity performed by a system that still accepts NULL completion-gate evidence cannot produce trustworthy verdicts — T1222 is the precondition, not the backstop, and its placement as peer acceptance is the one structural defect that must change before the wave runs.
- **Expansionist's upside to pursue (or defer):** T1222's NOT NULL write path is a trivially-extended completion-ledger emitter and the exact substrate BRAIN-integrity / Sentient v1 / M6/M7 binding gates already consume from nothing — pursue the hook, **but defer the `.jsonl` emit** because First Principles' peer note stands: git's commit DAG already IS the immutable hash-chained ledger for reconstruction; canonicalize git-log+release-tag AS the ledger before adding a parallel stream.
- **Outsider's pattern flag:** The epic's own premise is falsified by a one-line `git log` against its flagship suspect, and nothing in the spec explains how the audit will distinguish "zero DB children" from "zero completed work" — three structurally different problems (audit, engine, backfill) are fused under one verdict surface.
- **Executor's action (validated or modified):** Write a failing vitest for `tasks.complete` rejecting NULL `verification_json` on branch `task/T1222` and commit it red — **but first verify the canonical error-code identifier against `packages/contracts/src/errors` (the proposed `E_VERIFICATION_NOT_INITIALIZED` is unverified; prefix is almost certainly `E_EVIDENCE_*` per ADR-051).**

### Conditions on the recommendation
**Yes, if** the refactor produces: (a) T1222 as standalone blocking predecessor with a merged PR and passing red-then-green test before any T1216 audit child spawns; (b) verdict taxonomy amended to four outcomes with git-log and release-tag declared first-class evidence co-equal with `tasks.verification_json`; (c) 176-row backfill extracted to a sibling epic with its own acceptance criteria distinct from the 12-suspect forensic audit; (d) audit charter explicitly carved out to verify gate state, not re-litigate architectural conclusions already absorbed into the v2026.4.133 spine (per 2026-04-24 Council O-dfb7f334 / O-5e7540d6). **No, unless** all four land — partial adoption reintroduces the defect chain.

### Next 60-minute action
Create branch `task/T1222`, open `packages/cleo/src/dispatch/engines/task-engine.ts` at line 831, and write a failing vitest in the adjacent `.test.ts` that calls `tasks.complete` with `verification_json = NULL` and asserts rejection with the canonical error code — **first grep `packages/contracts/src/errors` for the correct `E_EVIDENCE_*` identifier (do NOT use `E_VERIFICATION_NOT_INITIALIZED`; that name is unverified)** — then commit the test red. That red commit is the gate the audit depends on and converts the refactor from spec argument to executable predecessor.

### Confidence
**High** — four full-weight advisors across structurally orthogonal frames (Contrarian safety, First Principles correctness, Expansionist opportunity, Outsider stranger-test) independently surface the same structural defect in T1216's shape, anchored to concrete evidence pack items (`task-engine.ts:831` NULL-gate gap, `git log --grep="T99[4-9]"` = 16, 176-cohort systemic scope). Confidence drops to medium if the owner's actual question is narrower than "is T1216 structured correctly" (e.g., "is the backstop good enough to ship this week"), in which case Contrarian's APPROVE-with-amendments applies more strongly; it rises to very-high only after grep-verifying the canonical error-code identifier in `packages/contracts/src/errors`.

### Open questions for the owner
- Is the 176-row backfill owner-scoped to be resolved in the same release cycle as the 12-suspect audit, or can it be calendar-deferred behind T1222 + audit?
- Should `cleo audit reconstruct` (Expansionist's SDK primitive) be adopted as a T1216 sibling now, or filed as follow-on under the v2026.4.133 spine after audit verdicts are produced?
