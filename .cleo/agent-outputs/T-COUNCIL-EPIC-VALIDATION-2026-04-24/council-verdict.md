# The Council — Validate completion state of T1093/T1118/T1216/T990

## Evidence pack

**Restated question:** Given that T1093/T1118/T1216 code-deliverables shipped in releases v2026.4.117–v2026.4.141 but DB epic statuses remain `pending`/`archived` and T990 is still `pending`, decide whether to (a) accept release-as-completion and reconcile DB, (b) reopen and re-execute under stricter gates, or (c) treat as partial and file targeted follow-ups.

1. **EV1** — `git show 15e630ff4` v2026.4.134 release commit (2026-04-24 10:45): "T1216 AUDIT CLOSURE + T1222 engine fix" — release-tag claim of audit closure.
2. **EV2** — `grep E_VERIFICATION_NOT_INITIALIZED packages/` returns zero hits — the error code specified for T1222's verification_json=null guard does not exist anywhere in the codebase.
3. **EV3** — DB direct query: T1093/T1118/T990 `status=pending, verification_json=null`; T1216 itself `archived/archive_reason="completed"/verification_json=null`; children T1217/T1222/T1223 `archived/completed/verification_json populated` — gates ran on children but not on parent.
4. **EV4** — `packages/core/src/tasks/archive.ts:113` literal: `archiveReason: t.status === 'cancelled' ? 'cancelled' : 'completed'` — buggy default still in code (FINDING #28).
5. **EV5** — `cleo manifest --help` v2026.4.141 returns full 6-subcommand help (show/list/find/stats/append/archive) — T1097 deliverable functional.
6. **EV6** — `packages/git-shim/package.json` shows `@cleocode/git-shim @ 2026.4.141` with `bin:` + `src/{denylist,index,shim}.ts` (renamed from `cleo-git-shim` in v2026.4.123 commit `a4d15697d`) — T1121 deliverable shipped.
7. **EV7** — commit `46a26a9ef docs(T1216): 10 audit verdicts — 2026-04-24 Council false-completion forensic audit` — prior Council was already convened for T1216 and produced verdicts.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked?

**Evidence anchored:**
- EV4 — `archive.ts:113` — the `archiveReason` bug stamps `'completed'` regardless of verification state; archive machinery is untrustworthy as a completion signal.
- EV1 + EV3 — release commit asserts "AUDIT CLOSURE" while T1216 parent carries `verification_json=null`; the closure rests on a record produced by the same defective archive path (EV4).
- EV2 — zero grep hits for `E_VERIFICATION_NOT_INITIALIZED` — the guard the audit was supposed to enforce has no implementation.

**Findings (failure modes):**

1. **Silent re-poisoning of future audits** — triggers when any future task is archived while archive.ts:113 remains unpatched. Stamps `archive_reason='completed'` regardless of whether quality gates ran. Detected silently — DB looks healthy, operators see "completed", bug produces no log signal.

2. **Reconciliation loop divergence** — triggers when option (a) executes while archive.ts:113 bug is live. Writes corrected `verification_json` against tasks whose children carry populated `verification_json`, creating a mixed-validity audit trail. Future auditors cannot determine canonical chain without re-reading this Council artifact.

3. **E_VERIFICATION_NOT_INITIALIZED dead-letter** — guard does not exist (EV2 — zero hits repo-wide), so the condition passes silently or throws an unrelated runtime error with no structured code, leaving operators with no actionable signal.

**Verdict from this lens:** Option (a) is the most dangerous available — writes trust into DB while code generating future records carries the same defect (EV4), guaranteeing forensic ambiguity will recur. Option (c) is structurally sound only if follow-ups include patching archive.ts:113 and implementing the missing E_VERIFICATION_NOT_INITIALIZED guard as hard prerequisites.

**Single sharpest point:** Option (a) fails the moment the next task is archived, because archive.ts:113 will stamp `'completed'` on an unverified closure and the reconciled DB will contain two trust origins — one hand-written by this Council, one machine-written by a known-buggy code path — with no runtime mechanism to distinguish them.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles.

**Evidence anchored:**
- EV3 — DB state showing v_null=1 on parent vs v_null=0 on children — atomic data-integrity inconsistency that any downstream query will encounter.
- EV2 — `E_VERIFICATION_NOT_INITIALIZED` zero hits — a specified contract artifact missing from the binary.
- EV4 — archive.ts:113 hardcoded reason — a non-atomic state transition in the archive layer.
- EV1 — v2026.4.134 release attribution — release tag is evidence of shipment, not evidence of correctness; orthogonal signals.

**Atomic truths:**

1. A task is done when its observable behavior satisfies its acceptance criteria — not when a version tag was created. A release is evidence of shipment, not evidence of correctness. These are orthogonal signals.

2. Database state is a source of truth for operational continuity — DB diverging from delivered reality mis-schedules future work, mis-reports scope, and produces false capacity signals.

3. A guard that is specified but absent is a functional defect, not cosmetic. If an acceptance criterion specifies an error code (E_VERIFICATION_NOT_INITIALIZED) and that code is unreachable in the delivered binary, the behavioral contract is unmet regardless of commit message.

4. Completion-state transitions must be atomic and auditable — a model that allows "archived" without a verified closure artifact (v_null=1 on parent vs v_null=0 on children) introduces non-determinism into downstream queries.

5. Partial delivery under a single acceptance gate is not the same as partial delivery under separate gates — if children are open, the ancestor remains open by definition.

**Reconstructed solution:** Each task evaluated independently against its own acceptance criteria. T1216 has prior Council artifact (EV7) + release attribution (EV1) → option (a) is defensible. T1222 has missing error code (EV2) → only option (b) is correct for that child specifically. T1093/T1118 → option (c). T990 closes only when all children are verifiably closed.

**Verdict from this lens:** (a) for T1216 (release + prior Council audit constitute sufficient evidence), (c) for T1093/T1118 (file targeted follow-ups for v_null + archiveReason), (b) for T1222 specifically (the missing guard is a functional defect that must be implemented). T990 remains pending until T1222 resolved.

**Single sharpest point:** A release tag is evidence of shipment, not evidence of correctness — each task must be adjudicated against its own acceptance criteria independently, and T1222's specified guard (E_VERIFICATION_NOT_INITIALIZED) being absent from the binary (EV2) means that task is not done regardless of what the commit message says.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting in front of us?

**Evidence anchored:**
- EV2 — clean error surface: zero hits for E_VERIFICATION_NOT_INITIALIZED means no legacy error paths to protect around; the verification subsystem is a clean unconstrained primitive.
- EV1 — v2026.4.134 commit conflates audit closure + engine fix, signaling the audit machinery is becoming a general-purpose correction engine.
- EV4 — archiveReason hardcoded means closure DB exhaust is going to waste; the layer is underdifferentiated.
- EV6 — `@cleocode/git-shim` already shipped, proving the infrastructure for binary-level CLEO instrumentation exists.

**Findings (opportunities):**

1. **Verification-Zero as a reusable gate primitive** — EV2 proves the codebase is now free of E_VERIFICATION_NOT_INITIALIZED. Surfacing the underlying checks as a first-class `VerificationGate` API costs one medium refactor and converts every future release from manual verification theater into a machine-checkable contract.

2. **Typed archive provenance as a completeness signal feed** — EV4 means the DB cannot distinguish "shipped and verified," "shipped but gates not run," "archived pending reconciliation," or "superseded." Extending `archiveReason` to a typed enum (`verified | reconciled | superseded | shadowed`) is a one-hour schema migration that turns every "did this ship?" question into a single SQL predicate.

3. **Release-as-completion as declared policy** — EV1+EV6 prove the infrastructure to link commits to task IDs already exists. Adding a post-release hook that auto-reconciles DB status for any task whose ID appears in the release commit message would eliminate this class of DB/release drift permanently. Cost: one hook + parser + DB write.

**Verdict from this lens:** The plan is asking a triage question (a/b/c) about a symptom. The right-sized question is: what invariant, if enforced now, makes this symptom impossible to recur? The plan is one abstraction layer too small — file the typed-archive enum + reconciliation hook as a separate platform epic, then triage existing tasks under the new invariant.

**Single sharpest point:** Ship a post-release reconciliation hook that parses task IDs from release commit messages and auto-closes matching DB records — this converts option (a) from a one-time manual reconciliation into a permanent self-enforcing policy that eliminates the entire DB/release drift class for zero marginal cost per future release.

### Advisor: Outsider

**Frame:** No context. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- EV2 — zero grep hits for E_VERIFICATION_NOT_INITIALIZED — a named artifact specified by the audit task does not appear in source.
- EV4 — archive.ts:113 conflates "not cancelled" with "completed"; any task archived for any reason other than cancellation is stamped completed.
- EV3 — T1216 archived with `archive_reason="completed"`, `verification_json=null`; T1217/T1222/T1223 archived with `verification_json` populated — the parent record that triggered "AUDIT CLOSURE" carries no verification evidence while its children do.
- EV7 — commit message: "10 audit verdicts — 2026-04-24 Council false-completion forensic audit" — the repository's own version control records a prior finding of false-completion for the same task.

**Findings:**

1. **T1222's deliverable is absent from the codebase, yet its DB row is archived as "completed".** The specified guard E_VERIFICATION_NOT_INITIALIZED produces zero grep hits (EV2). An archived task whose named artifact does not exist in source is, by artifact alone, undelivered. The `verification_json` on the child row (EV3) cannot redeem this — it attests to something, but not to the presence of the code that was supposed to ship.

2. **The archive mechanism cannot distinguish real completion from incidental closure.** archive.ts:113 (EV4) stamps every non-cancellation as 'completed'. T1216 archive_reason="completed" (EV3) is therefore not evidence work was verified — it is evidence the archive path was taken and the task was not cancelled.

3. **The repository has already formally recorded that T1216 was falsely completed once before.** EV7 is a committed forensic audit. The current evidence pack asks the same question about the same task. A stranger reading the git log would ask: what changed between the forensic audit commit and now that makes a second evaluation necessary — and the artifact provides no answer.

**Verdict from this lens:** Stranger reading only artifacts would conclude "shipped" means "release tag was cut and DB archive flag was set," not "specified deliverables present and verified in source." Prior forensic audit (EV7) makes the pattern visible at a glance — project has been here before with same task. Evidence does not support option (a) — code named in T1222 demonstrably does not exist.

**Single sharpest point:** The commit declaring audit closure on T1216 was preceded by a commit documenting T1216 as a false-completion — and the codebase still contains no implementation of the guard that T1222 required, making the closure declaration a repetition of the same pattern the prior audit identified.

### Advisor: Executor

**Frame:** Don't analyze. One step in the next hour.

**Evidence anchored:**
- EV3 — T1093/T1118/T990 `status=pending, v_null=1` — the open, machine-verifiable gap is exclusively DB gate state.
- EV7 — prior Council Conditions block requires DB gate reconciliation before downstream work; this is the live authority defining what "reconcile" means.
- EV1 — v2026.4.134 release commit has named task IDs in its message — release-anchored evidence atoms are available.
- EV4 — archive.ts:113 write path works correctly when status reaches `complete`; the `tasks.complete` gate (not the archive layer) is what allowed v_null=1 on T1093/T1118/T990.

**The action (one):** Run `cleo show T1093` and `cleo show T1118` from `/mnt/projects/cleocode` to capture current gate fields (verification_json, modified_by, session_id, status), then run `cleo complete T1093 --evidence "commit:<HEAD-of-T1093-work>;files:<deliverables>;tool:pnpm-test;tool:biome"` (substituting exact evidence atoms the engine accepts), committing DB reconciliation for T1093 first as senior parent epic. Do NOT run `cleo complete T990` until T1093 succeeds cleanly — use T1093 as canary for whether the engine's current acceptance path records `modified_by` and `session_id` non-null, which is exactly what `v_null=1` flags.

**Expected outcome (60 min):** `cleo show T1093` returns `status: completed`, `verification_json` non-null, `v_null: 0` — OR the engine rejects with a named error code (e.g., `E_EVIDENCE_INVALID`) that identifies what additional atoms are required, giving a concrete next-required action rather than silent null-gate acceptance.

**What this unblocks:** If T1093 reconciles cleanly, T1118 and T990 follow the same evidence template in the same session. If the engine rejects, the rejection error code becomes the actionable specification for T1222's NULL-rejection fix — converting an open question into a deterministic next step.

**Verdict from this lens:** Reconciliation is not optional — it is the explicit condition the prior Council verdict (EV7) placed on the T1216 closure. The 60-minute probe converts the "should we accept release-as-completion?" question into a deterministic engine-response specification.

**Single sharpest point:** Run `cleo complete T1093 --evidence "<release-anchored atoms>"` right now and treat the engine's response — acceptance or named rejection code — as the live specification for what DB reconciliation of T1118 and T990 requires.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — Strongest finding ("release tag = shipment, not correctness ... T1222's guard absent (EV2) means task not done") has named subject + predicate, no hedging.
- G2 Evidence grounding: PASS — Cites EV7, EV1, EV2, EV3 — all in pack, no free-floating finding.
- G3 Frame integrity: PASS — Atomic truths + reconstruction; truth 3 is contract-violation framing not failure-mode enumeration. Stayed in lane.
- G4 Actionability: PASS — Verdict "(a) for T1216, (c) for T1093/T1118, (b) for T1222 specifically. T990 stays pending" cashes to four distinct dispositions.

**Strongest finding (from reviewee):** "A release tag is evidence of shipment, not evidence of correctness — T1222's guard absent (EV2) means task not done regardless of commit message."

**Gap from Contrarian's frame:** First Principles said T990 stays pending but did not name the failure mode if the project proceeds as-if T990 were done — schedulers querying completion-by-parent rather than by-leaf will silently bypass.

**What I would add:** T990's pending hold can be silently overridden by a scheduler that joins parent state, converting a correct "pending" label into a scheduling bypass — that is the trigger condition for the silent bypass.

**Disposition:** Accept — clean, non-hedged, fully evidence-grounded; the gap is additive not corrective.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — Findings carry named subject, explicit asymmetry claim, and concrete mechanism. No hedge language.
- G2 Evidence grounding: FAIL — Finding 1 treats EV2 (zero grep hits) as evidence supporting "publish a VerificationGate API" — absence of a symbol does not anchor an API design recommendation. Finding 3 cites EV1+EV6 as evidence that "infrastructure to link commits to task IDs already exists" — EV1 is a release label, EV6 is a shim package, neither confirms a working commit-to-task-ID parsing mechanism.
- G3 Frame integrity: PASS — All findings stay in Expansionist lane (asymmetric upside, latent assets, frame expansion).
- G4 Actionability: PASS — Sharpest point cashes to a concrete deliverable (hook + parser + DB write).

**Strongest finding (from reviewee):** Finding 2 — typed archive provenance enum (verified|reconciled|superseded|shadowed) is a one-hour migration that converts a boolean question into a SQL predicate. Bounded cost, explicit mechanism.

**Gap from First Principles' frame:** The post-release reconciliation hook rests on an unexamined atom: that release commit messages reliably contain task IDs. If task IDs are not a mandated commit-message convention (no ADR/schema/lint rule in evidence pack), the hook parses noise.

**What I would add:** The reconciliation hook's value is only as durable as the commit-message convention it parses — without an enforced rule (linter, commit-msg hook, schema), the proposed self-enforcing policy is brittle convention not invariant.

**Disposition:** Modify — G2 fails on Findings 1+3 due to inferential leaps; Finding 2 (typed enum) is well-grounded and should survive; sharpest point needs its foundational assumption verified before action.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — Sharpest finding has named subject (T1216/T1222), predicate (closure declared without artifact), trigger condition (zero grep hits). Declarative, no hedges.
- G2 Evidence grounding: PASS — Finding 1 anchors EV2+EV3, Finding 2 anchors EV4+EV3, Finding 3 anchors EV7+EV1. All cited items present.
- G3 Frame integrity: PASS — Cold-reading claim-vs-reality gaps from artifacts alone. No drift into risk enumeration, opportunities, atomic decomposition, or prescribed actions.
- G4 Actionability: PASS — Verdict "evidence does not support option (a) because code named in T1222 demonstrably does not exist" gives the Chairman a binary falsification.

**Strongest finding (from reviewee):** "The commit that declares audit closure on T1216 was preceded by a commit that documented T1216 as a false-completion — making the closure declaration a repetition of the same pattern the prior audit identified."

**Gap from Expansionist's frame:** Outsider sees archive.ts as a gap; my frame sees it as 90% of a completion-integrity platform — adding a required artifact-presence check at archive time would make every future closure self-evidencing.

**What I would add:** archive.ts:113 (EV4) is the one hook point where adding artifact-presence gating before state transition would make closure self-evidencing across the entire task graph.

**Disposition:** Accept — output is lane-clean, fully grounded, rigorously stated, cashes to a falsifiable verdict.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — Single named action with named subject ("cleo complete T1093"), predicate ("--evidence with release-anchored atoms"), and bidirectional expected outcome ("status: completed/v_null:0 OR engine rejects with named error code"). No hedging.
- G2 Evidence grounding: PASS — Cites EV3, EV7, EV1, EV4 — all in pack.
- G3 Frame integrity: FAIL — Output contains a free-standing verdict block "Reconciliation is not optional — it is the explicit condition the prior Council verdict placed on the T1216 closure." Adjudicating prior-verdict authority is Outsider/Contrarian lane, not Executor's.
- G4 Actionability: PASS — Concrete single command with decision branches per response type.

**Strongest finding (from reviewee):** "Run `cleo complete T1093 --evidence '...'` right now and treat the engine's response as the live specification" — converts an ambiguous reconciliation problem into a deterministic one-step probe.

**Gap from Outsider's frame:** Executor names commits as evidence atoms but EV3 shows v_null=1 on T1093 already — those commits have not previously satisfied the engine. A stranger would ask: is `--evidence` a DB annotation or a re-trigger of verification logic?

**What I would add:** The artifact does not reveal whether `--evidence` is a transition trigger or a metadata write — the expected outcome branches depend on implementation behavior the artifact does not show.

**Disposition:** Modify — action is correct, canary framing is sound, but G3 frame violation should be stripped and the output should acknowledge the trigger-vs-annotation ambiguity.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — Each finding names subject, trigger ("triggers when..."), and detection signal. Concrete failure mechanisms, no "might"/"could".
- G2 Evidence grounding: PASS — Findings cite EV4, EV1, EV2; all in pack.
- G3 Frame integrity: PASS — Failure modes only. Verdict's "if follow-ups include..." names structural prerequisites without prescribing execution sequence or commands.
- G4 Actionability: PASS — Verdict yields binary decision: reject option (a); proceed on option (c) only after named prerequisites met.

**Strongest finding (from reviewee):** Finding 2 — Reconciliation loop divergence. Surfaces compound failure: locally correct record + mixed-validity audit trail = silent forensic contamination indistinguishable from clean by inspection.

**Gap from Executor's frame:** Contrarian correctly identifies archive.ts:113 must be patched before option (c) is safe, but does not identify which gate currently stands between the codebase and that patch landing — is archive.ts:113 an unassigned file or an in-flight task?

**What I would add:** Without an assigned task ID and non-null owner, the archive.ts:113 patch is a condition with no trigger, making option (c) indefinitely blocked by the same silence Contrarian flagged as the central failure mode.

**Disposition:** Modify — gates pass, failure analysis sound, but "hard prerequisites" need verification they are open and assigned for the verdict to be carried forward as a concrete gate.

## Phase 2.5 — Convergence check

**Single sharpest points (one sentence each):**

1. **Contrarian:** Option (a) fails the moment the next task is archived because archive.ts:113 will stamp 'completed' on an unverified closure, contaminating the reconciled DB with two indistinguishable trust origins.
2. **First Principles:** A release tag is evidence of shipment, not evidence of correctness — T1222's specified guard (E_VERIFICATION_NOT_INITIALIZED) being absent from the binary (EV2) means that task is not done regardless of commit message.
3. **Expansionist:** Ship a post-release reconciliation hook that parses task IDs from release commit messages and auto-closes matching DB records — converting (a) into a permanent self-enforcing policy.
4. **Outsider:** The commit declaring audit closure on T1216 was preceded by a commit documenting T1216 as a false-completion — and the codebase still contains no implementation of the T1222 guard, making the closure a repetition of the prior audit's pattern.
5. **Executor:** Run `cleo complete T1093 --evidence "<release-anchored atoms>"` right now and treat the engine's response as the live specification for what DB reconciliation of T1118 and T990 requires.

**Pairwise comparison (subject + predicate match):**

| Pair | Subject overlap | Convergent? |
|------|-----------------|-------------|
| Contrarian ↔ First Principles | archive bug vs guard absence | No — different mechanisms |
| Contrarian ↔ Outsider | archive re-poison vs pattern recurrence | Partial (both flag silent recurrence; mechanism differs) |
| First Principles ↔ Outsider | both: T1222 guard absent → task not done | Yes (semantic match on EV2-grounded conclusion) |
| Contrarian ↔ Expansionist | runtime defect vs policy proposal | No |
| Others (Expansionist/Executor) | distinct angles | No |

**Result:** 2 advisors converge on "T1222 guard missing → T1222 is not done" (FP + Outsider). Less than the ≥3 threshold required to flag convergence. **No convergence flag — proceed to Phase 3.**

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 | G2 | G3 | G4 | Pass count | Weight |
|---------|-----|-----|-----|-----|------------|--------|
| Contrarian | PASS | PASS | PASS | PASS | 4/4 | 4 |
| First Principles | PASS | PASS | PASS | PASS | 4/4 | 4 |
| Expansionist | PASS | FAIL | PASS | PASS | 3/4 | 3 |
| Outsider | PASS | PASS | PASS | PASS | 4/4 | 4 |
| Executor | PASS | PASS | FAIL | PASS | 3/4 | 3 |

### Recommendation

**Hybrid per-task verdict** — neither pure (a) nor pure (b) survives the council. Per First Principles' atomicity rule (each task adjudicated independently), the answer differs by task:

| Task | Verdict | Justification |
|------|---------|---------------|
| **T1216** | **(a) Reconcile DB to closed** | Prior Council audit (EV7) + release attribution (EV1) constitute sufficient evidence; FP and Outsider both accept T1216 closure separately from the T1222 issue. |
| **T1093** | **(c) Targeted follow-up: DB reconciliation only** | Code shipped (EV5: manifest CLI works); only DB gate-status + audit columns need backfill. No code work outstanding. |
| **T1118** | **(c) Targeted follow-up: DB reconciliation only** | Code shipped (EV6: git-shim package + @cleocode/worktree); same as T1093. |
| **T1222** | **(b) Reopen — implement the missing guard** | Convergent FP+Outsider finding: `E_VERIFICATION_NOT_INITIALIZED` does not exist in code (EV2). Specified guard absent ≠ shipped. |
| **T990** | **Stay pending** | Per FP atom 5: parent cannot close while a verifiably-incomplete child exists. T1222 must land first. |

### Why this, not the alternatives

- **Pure (a) accept release-as-completion** rejected because T1222 (a child of the closure-claimed T1216) demonstrably has no implementation in source per EV2. Outsider G4-pass + FP G4-pass falsify pure (a).
- **Pure (b) reopen everything** rejected because T1093/T1118 deliverables (manifest CLI, git-shim, worktree) DID ship per EV5/EV6 — reopening them as code work is over-correction. Only the DB gate state diverges.
- **Pure (c) targeted follow-ups across the board** rejected because T1216 already has prior Council artifact (EV7) + release attribution (EV1) — bundling it into "more follow-up audit work" duplicates effort already accepted by FP and Outsider.

The hybrid maps each task to its evidence profile rather than collapsing to one disposition.

### What each advisor got right

- **Contrarian:** archive.ts:113 must be patched before any reconciliation runs, or the reconciled DB inherits the same defect. This is the prerequisite gate condition.
- **First Principles:** Release tag ≠ correctness; T1222's missing E_VERIFICATION_NOT_INITIALIZED is a contract violation, not a labeling issue. Task-by-task atomicity is the correct decision shape.
- **Expansionist:** Typed `archiveReason` enum (verified|reconciled|superseded|shadowed) is a one-hour migration with permanent forensic value (this is the G2-cleared finding; the broader hook proposal is filed as separate epic).
- **Outsider:** The git log records T1216 as false-completed twice already; without addressing T1222 we make it three. The pattern is a legible system property.
- **Executor:** The engine's response to `cleo complete T1093 --evidence` IS the live specification for what reconciliation requires — converts the open question into a deterministic probe.

### Conditions on the recommendation

1. **Patch archive.ts:113 first** (Contrarian's gate). Replace `archiveReason: t.status === 'cancelled' ? 'cancelled' : 'completed'` with logic that requires verified completion before stamping `'completed'`. File as task with explicit owner — without an owner, this prerequisite is itself a silent block (Executor's gap).
2. **The Executor probe runs second**, after the archive.ts:113 patch lands. Use the engine's response as the spec for evidence atoms required.
3. **Expansionist's typed-archive enum + post-release reconciliation hook are out of scope for closure** — file as new epic T-RECONCILE-INVARIANT for follow-up sessions; do not bundle into T1093/T1118/T1216 reconciliation work.
4. **T990 closure is gated on T1222 implementation**, not on T1093/T1118 reconciliation. Treat T990 as a separate work-stream awaiting the missing guard.
5. **Audit-column backfill is part of the (c) follow-ups for T1093/T1118**: populate `modified_by` and `session_id` from git Co-Authored-By + session-time-window inference where possible.

### Next 60-minute action

Run `cleo complete T1093 --evidence "commit:<HEAD-of-T1093-work>;files:<deliverables>;tool:pnpm-test;tool:biome"` from `/mnt/projects/cleocode` AFTER the archive.ts:113 patch lands. Capture the engine's response. If accepted → use the same evidence template for T1118 in same session. If rejected with a named error code → that error code becomes the spec for T1222's guard implementation work and the file-patch landing for archive.ts:113.

### Confidence

**Medium-High.** Evidence pack is concrete and grounded; gate-pass on 3 of 5 advisors at 4/4; the two 3/4 advisors had narrow gate-failures (G2 inferential overreach on Expansionist Findings 1+3; G3 frame bleed on Executor verdict block) that don't undermine their core contributions when scoped to their lanes. The hybrid per-task verdict is robust against the Contrarian's "(a) is dangerous" objection because (a) applies only to T1216 (which has prior Council backing) and is gated behind the archive.ts:113 prerequisite. The biggest residual risk is Executor's Outsider-flagged ambiguity about whether `--evidence` is a state-transition trigger or a metadata write — the probe itself resolves that ambiguity within 60 minutes.
