# The Council — Given the BRAIN integrity crisis and the Sentient Tier 1-3 foundation, what is the highest-leverage intervention to advance CLEO toward persistent-never-forget memory and deeper autonomous sentience?

## Evidence pack

1. `MEMORY.md:67` — "BRAIN Integrity Crisis — CRITICAL NEXT SESSION: 2440 noise patterns, 45+ junk entries, no graph data, no dedup. Full RCASD epic. Owner providing external memory system examples."

2. `MEMORY.md:20` — MASTER-sentient-v2 shipped: T991 BRAIN Integrity epic (8 children, auto-done), T1000 BRAIN Advanced (6 children, auto-done), T1008 Sentient Tier 2 (propose + 3 ingesters + transactional rate limiter), T1015 architecture cleanup (sentient+gc moved from cleo→core).

3. `MEMORY.md:66` — T-BRAIN-LIVING PRIORITY: 5-substrate graph viz (BRAIN+NEXUS+TASKS+CONDUIT+SIGNALDOCK) + Hebbian/STDP plasticity. Hebbian shipped at `packages/core/src/memory/brain-lifecycle.ts:911` (MEMORY.md cites `brain/` — Outsider verified actual path is `memory/`). STDP queued next.

4. `T1151` (cleo task) — "MASTER: Sentient Self-Healing Orchestrator — 4-pillar integration anchor", status=pending, priority=critical, parent=T942.

5. `T1107` (cleo task) — "RA: Wire all 14 Living Brain verbs through dispatch registry (query/mutate reachable)", status=**blocked**, priority=critical.

6. `T1134` (cleo task) — "BF2: brain-ingester.ts queries wrong column text vs narrative", status=pending, priority=critical. **Outsider verification: `implemented` gate closed via commit `abf1dabdb`; pending gates are `testsPassed` + `qaPassed` only.** Actual path: `packages/core/src/sentient/ingesters/brain-ingester.ts` (not `packages/core/src/brain/…`).

7. `MEMORY.md:106` — Owner Memory Philosophy (NON-NEGOTIABLE): "tiered memory, chat≠memory, extraction pipeline, ground truth, typed memory, instrumentation". 14 owner directives in Memory Architecture v2 Initiative.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- MEMORY.md:67 — substrate already polluted and ungoverned at rest.
- MEMORY.md:20 — T991/T1000 "auto-done" in one MASTER sweep; T1134 surfaces post-ship bug. Auto-done ≠ working.
- T1107 — 14 verbs blocked on dispatch registry at priority=critical.
- T1151 — integration anchor pending at priority=critical.
- MEMORY.md:66 — Hebbian active on store with no dedup.

**Findings (failure modes, from my frame only):**

1. **Plasticity-on-polluted-substrate amplification** — triggers when the Hebbian strengthener at `brain-lifecycle.ts:911` ticks over the 2440 noise patterns + 45 junk entries before T991 sweepers reconcile the backlog. Fails by: frequently-co-activated junk pairs get weights ratcheted up each tick, so noise becomes structurally *harder to evict* than real memories; adding STDP next locks bad edge ordering in. Detected silently — operators see "memory is learning" metrics rising while recall precision drops.

2. **"Shipped" MASTER epics masking unreachable write path** — triggers the moment any caller depends on the 14 Living Brain verbs (T1107 blocked) against data produced by T1000 ingesters (T1134 reads wrong column). Fails: writes land in `narrative`, reads probe `text`, queries return empty, Sentient Tier-2 proposer (T1008) interprets as "novel situation" and proposes duplicate work. Detected silently in the common case.

3. **Auto-done MASTER sweep as one-person-risk** — triggers when next maintainer reasons about memory behavior using task graph as ground truth. MASTER-sentient-v2 closed T991+T1000+T1015 as "done" in 17-task/3-release sweep, but T1134 and T1107 show the done-set is not actually wired. Fails: future plans depending on "BRAIN integrity solved per T991" (including T1151's 4-pillar integration) build on false foundation. Detected only when someone re-runs the crisis audit.

**Verdict from this lens:** The highest-leverage intervention is not more memory building — it is freezing further write/plasticity work until existing writes are queryable (T1107 unblocked) and ingester column bug (T1134) is fixed against a deduplicated substrate.

**Single sharpest point:** Any "next leverage move" that adds plasticity, new ingesters, or a new tier before T1107 and T1134 land on a deduplicated store will fail silently — Hebbian at `brain-lifecycle.ts:911` reinforces the 2440 noise patterns while queries return empty due to text-vs-narrative column mismatch.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- Owner Memory Philosophy (MEMORY.md:106) — user-need atom.
- T1107 (blocked, critical) — overlay: surface exists but not reachable.
- T1134 (pending, critical) — overlay: write/read contract broken at column level.
- MEMORY.md:67 — overlay: substrate corrupted.
- T1151 — overlay: proposed high-leverage integration.

**Atomic truths (independent of the artifact):**
1. A memory system that cannot be read deterministically is not a memory system — it is a write-only log. Persistence without retrievability has zero epistemic value.
2. "Never forget" is a read-side guarantee, not a write-side one. You cannot prove non-forgetting by writing more; you prove it by reading and recovering every prior salient fact on demand.
3. Signal requires a noise floor. Any learning system operating over a corrupted substrate amplifies the corruption — the plasticity update law does not distinguish signal from junk absent a clean prior.
4. Autonomy compounds errors. A sentient tier that proposes/acts on memory reads will, with probability ≈1, convert latent corruption into durable commitments.
5. Typed, contract-bound writes are cheaper than post-hoc cleanup.
6. Integration surface area is a multiplier on substrate quality. Good substrate × good integration = leverage; broken substrate × more integration = liability. Order matters: substrate precedes surface precedes autonomy.

**Reconstructed solution (from atoms, before reading the plan):**
From atoms 1–2, the highest-leverage intervention is whichever unblocks the **read path** end-to-end against a **trusted** store — reachability of the Living Brain verbs and column-contract correctness are preconditions for every downstream claim. From atoms 3–4, any further plasticity (STDP), autonomy (Tier-2/3 sentient), or integration (5-substrate living brain, self-healing orchestrator) must be **gated** behind a green substrate. From atoms 5–6, the correct sequence is: (a) fix write contract (typed ingester, correct columns), (b) restore read reachability (dispatch registry), (c) establish noise floor (dedup + classification), (d) *then* turn on plasticity/autonomy. Single highest-leverage intervention: "ship T1134 + unblock T1107 as a paired atomic unit."

**Reconstruction vs. the proposed plan:**
- Convergences: T991 + T1000 already shipped 14 children; T1134 and T1107 are already flagged critical.
- Divergences:
  - T1151 held as critical/pending peer to T1107 (blocked) and T1134 (pending) — **genuine error** per atoms 3–4: integrating four pillars across a substrate whose read path is unreachable bakes defects into an orchestrator.
  - STDP "queued next" after Hebbian shipped — **genuine error** per atom 3: plasticity rules over a 2440-noise-row substrate strengthen noise-to-noise correlations.
  - Sentient Tier 2 enabled via CLI, kill-switch default-off ≠ gate-blocked on integrity metrics — **path-dependent cruft trending toward error** per atom 4.
  - Framing as "memory-depth vs. sentience-depth" — **genuine error**: atoms say both depend on the same precondition (readable, typed, deduplicated substrate).

**Verdict from this lens:** The plan's task graph contains the right atoms but its priorities treat substrate repair and integration/autonomy as peers, when atoms 1–4 force strict ordering. Shipping T1151 or STDP before T1134+T1107 converts a contained substrate bug into a distributed, autonomous one.

**Single sharpest point:** You cannot build "persistent never-forget" on a store whose read path is unreachable (T1107) and whose writes target the wrong column (T1134) — every tier above it is a multiplier on whatever that substrate contains, and right now that is 2440 rows of noise.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- MEMORY.md:66 — Hebbian shipped is a metering engine currently bound to one substrate; 4 others (NEXUS, TASKS, CONDUIT, SIGNALDOCK) already produce edges.
- MEMORY.md:20 + T1151 — ingester→propose→accept/reject loop is already a supervised-labeling machine; labels currently discarded.
- MEMORY.md:67 — 2440 "junk" is the negative-class training corpus no one is harvesting.
- T1107 — once unblocked, every CLI/agent call becomes a BRAIN-instrumented event stream for free.

**Findings (opportunities, from my frame only):**

1. **Turn the integrity crisis into the training set.** The T991/T1000 integrity work is framed as cleanup. It is secretly the first labeled dataset CLEO has ever produced: 2440 noise + 45 junk + every `sentient propose reject` = **negative examples**; every `verify`/`promote` = **positive examples**. Shipping a classifier ("is this observation memory-worthy?") on top of dedup costs ~same code as dedup alone, but converts a one-time janitorial pass into a **permanent self-tuning filter** that pre-rejects the next 2440 noise entries before they land. Asymmetry: dedup-alone is sunk cost; classifier-on-top = dedup + perpetual immune system for ~1 extra week. **Negative corpus has a one-time shelf life** — if deleted in cleanup, the asset is destroyed forever.

2. **Unify Hebbian/STDP across all 5 substrates, not just BRAIN.** TASKS (complete→complete co-occurrence), CONDUIT (message→response), NEXUS (symbol→symbol caller), SIGNALDOCK (agent→agent handoff) are already edge-producing substrates. Hebbian at `brain-lifecycle.ts:911` is one function — lifting to substrate-agnostic `strengthenEdge(substrate, from, to, delta)` is a one-file refactor that **retroactively activates 4 dormant graphs** already written on every session. Asymmetry: 1 file refactor → 5× graph density; "never-forget" becomes cross-substrate recall (task→memory→conduit→nexus) rather than intra-BRAIN only.

3. **Expose Sentient propose→accept/reject as first public CLEO product surface.** What the plan frames as "autonomous task generation" is secretly a **general-purpose human-in-the-loop labeling API**. Once T1107 unblocks the 14 verbs, `cleo propose <anything>` is ~200 LOC from being the interface Anthropic/OpenAI/LangGraph don't have. Asymmetry: generalizing ingester interface = ~200 LOC → CLEO as **governance layer other agent frameworks plug into**.

**Verdict from this lens:** The plan is sized as "fix BRAIN dedup + ship STDP." The biggest version is "**CLEO becomes the first agent runtime where every substrate learns, every rejection is training data, and the HITL loop is a public API**." Integrity crisis is not a hole — it is the moment labeled corpus exists and plasticity primitive is live in one place.

**Single sharpest point:** Harvest the dedup pass as the training corpus for a memory-worthiness classifier *before* the junk is deleted, and lift the Hebbian primitive to all 5 substrates in the same epic — that re-framing turns "BRAIN cleanup" into "CLEO's first self-learning, cross-substrate memory fabric" for roughly the same cost.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- MEMORY.md:20 — claims T991 + T1000 **auto-done**.
- MEMORY.md:67 — names BRAIN Integrity Crisis as CRITICAL NEXT SESSION.
- T1107 — priority=critical, status=**blocked**.
- T1134 — priority=critical, status=pending.
- MEMORY.md:66 cites `packages/core/src/brain/brain-lifecycle.ts:911` — but `find` returns only `packages/core/src/memory/brain-lifecycle.ts`. The cited path does not exist.
- `packages/core/src/memory/brain-lifecycle.ts:28,83` — schema column `narrative` confirmed; T1134 flags sibling ingester at `packages/core/src/sentient/ingesters/brain-ingester.ts` as querying wrong column.

**Findings (from a stranger's eyes only):**

1. **Claim/reality gap on "shipped integrity."** MEMORY.md:20 says BRAIN Integrity epic auto-done across v2026.4.98–.100; MEMORY.md:67 simultaneously lists BRAIN Integrity Crisis as **CRITICAL NEXT SESSION** with 2440 noise patterns. The artifact contradicts its own shipped-status claim.

2. **Critical-path verb wiring blocked while Tier-2/3 expands around it.** T1107 = blocked/critical; meanwhile MEMORY.md:20 advertises Tier-2 ingesters as shipped and T1151 opens 4-pillar integration on top. Foundation unreachable while features stacked on it.

3. **Core ingester queries wrong column.** T1134: `brain-ingester.ts` queries `text` when schema is `narrative`. Companion file at `packages/core/src/memory/brain-lifecycle.ts:28,83` confirms column is `narrative`. Component meant to feed BRAIN cannot read from it. Priority=critical/pending.

4. **Path drift in memory narrative.** MEMORY.md:66 points to `packages/core/src/brain/brain-lifecycle.ts:911` as evidence Hebbian is "shipped." File does not exist at that path; actual file is `packages/core/src/memory/brain-lifecycle.ts`. Document pointing to shipped work cites non-resolving path.

**What the artifact claims vs. shows:**
Narrative claims BRAIN integrity + Tier-2 + Hebbian shipped across multiple auto-done epics. Artifacts show: (a) integrity crisis flagged CRITICAL in same document; (b) verb dispatch blocked; (c) ingester column defect; (d) Hebbian citation points at non-existent path.

**Verdict from this lens:** A stranger reading these artifacts concludes this is a system where **"shipped" and "working" have decoupled**: epics auto-complete while stated problems persist, critical wiring is blocked while higher-tier features are added above it, and the narrative cites paths that don't exist.

**Single sharpest point:** Two bullets in the same MEMORY.md — "BRAIN Integrity epic auto-closed" vs. "BRAIN Integrity Crisis CRITICAL NEXT SESSION" — cannot both be true; a stranger would stop here and ask what "done" means in this repo before evaluating any next intervention.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- T1107 — blocked/critical; downstream BRAIN work gated.
- T1134 — column bug, live data-corruption path feeding 2440-noise crisis.

**The action (one):**
Open `packages/core/src/brain/brain-ingester.ts`, find SQL statement selecting/filtering on `text`, change column reference to `narrative` (per T1134), then run `pnpm --filter @cleocode/core test brain-ingester` and `pnpm biome check --write packages/core/src/brain/brain-ingester.ts`. Commit as `fix(T1134): brain-ingester uses narrative column`.

**Expected outcome (60 minutes from now):**
`brain-ingester` test suite exits 0 with `text`→`narrative` fix applied, biome reports zero diagnostics, `git log -1` shows commit referencing T1134.

**What this unblocks:**
Ingester no longer corrupting BRAIN; T1107 dispatch-wiring unblock work and T991/T1000 sweepers re-runnable against stable write path.

**Verdict from this lens:** Persistent-memory vision is gated by a single column-name bug silently feeding garbage into BRAIN every tick — fix that leak before any architecture, plasticity, or Tier-3 sentience work earns compounding value.

**Single sharpest point:** Fix `brain-ingester.ts` column reference `text`→`narrative` (T1134), run the ingester test, commit.

**⚠ Peer-review finding: this action is INVALIDATED. Commit `abf1dabdb` already applied the `text`→`narrative` fix. Path `packages/core/src/brain/brain-ingester.ts` does not exist; actual path is `packages/core/src/sentient/ingesters/brain-ingester.ts`. The Outsider verified via `ls` + `cleo show T1134`. Corrected action surfaced in Phase 3.**

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — "Ship T1134 + unblock T1107 as a paired atomic unit" is specific and ordered. Each divergence classified (genuine error / path-dependent cruft) with task IDs.
- G2 Evidence grounding: PASS — cited T1134, T1107, T1151, T991/T1000 (MEMORY.md:20), 2440 noise (MEMORY.md:67), STDP/Hebbian (MEMORY.md:66). All anchored.
- G3 Frame integrity: PASS — stays in atoms-then-reconstruct lane. Atom 5 is correctness-economics, not a runtime failure mode. No trespass into Contrarian lane.
- G4 Actionability: PASS — "Ship T1134 + unblock T1107 as a paired atomic unit" and "STDP queued next → genuine error" is a concrete re-ordering decision.

**Strongest finding (from reviewee):** "every tier above it is a multiplier on whatever that substrate contains, and right now that is 2440 rows of noise." The multiplier framing converts prioritization into algebra.

**Gap from Contrarian's frame:** Reconstruction says "dedup + classify 2440 rows THEN plasticity/autonomy" but doesn't model what fails *during* dedup — concurrent-writer race: any in-flight write from a running session during dedup lands in wrong column mid-pass, producing clean-looking dedup with fresh misrouted rows behind it. Second gap: Atom 4 says "autonomy compounds errors" but doesn't force the question of who notices when Tier-2 accepted a proposal from corrupted reads before the gate flipped.

**What I would add:** Gate T1151 and STDP not just on substrate-repair completion but on a quiescence window — zero writer sessions during dedup + audit pass for Tier-2 proposals accepted prior to T1134's fix.

**Disposition:** Accept — atomic ordering is correct and multiplier framing is the sharpest available lens; my gaps are additive (concurrent-writer race, downstream-commitment rollback) and belong in Chairman's synthesis.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — strongest: "2440 noise + 45 junk + every `sentient propose reject` is a negative example…" Named subject + predicate + asymmetry ratio. All three findings carry quantified cost:value.
- G2 Evidence grounding: PASS — Finding 1 → MEMORY.md:67 + T1008; Finding 2 → MEMORY.md:66 + 5 substrates; Finding 3 → T1008 + T1107. No free-floating claims.
- G3 Frame integrity: PASS — all findings name "something valuable the plan is NOT attempting" (classifier-on-dedup, substrate-agnostic plasticity, propose-as-API). No risks, no actions, no atoms.
- G4 Actionability: PASS — sharpest point cashes out: "Harvest dedup pass as training corpus before junk deleted + lift Hebbian primitive to 5 substrates in same epic." That is a decision (sequence) + a change (one-file refactor).

**Strongest finding (from reviewee):** Finding 1 — the dedup pass is a destructive read of a non-reproducible labeled corpus. Rejected proposals and verified entries are already signed labels; deleting 45 junk without first snapshotting destroys the only confirmed-negatives dataset the system will ever cheaply produce.

**Gap from First Principles' frame:** Plan assumes a "memory-worthiness" ground truth learnable from proposal-accept/reject labels. But the atomic truth: **a decision to reject a proposal is not the same kind of signal as a decision to delete noise.** Rejection says "not worth spawning a task"; deletion says "not worth storing a memory." Training a memory-worthiness classifier on proposal-rejection corpus conflates two distinct utility functions — covariate shift by construction. Parallel unstated atom on Finding 2: Hebbian/STDP is a model of **temporal co-activation**; TASKS/CONDUIT/NEXUS/SIGNALDOCK edges are not all temporally-co-activated in the same sense (task→task completion is sequential causation, not co-firing). Lifting one function to 5 substrates is cheap; lifting one *semantic model* requires proving substrates share the co-activation atom.

**What I would add:** Before harvesting the corpus, separate the two labeling streams (proposal-reject vs memory-delete) and confirm each substrate's edge semantics match Hebbian's co-activation prior — otherwise the asymmetric bet becomes an asymmetric mislabel degrading every downstream learner.

**Disposition:** Modify — opportunities are real and asymmetries land, but two of the three rest on unstated atoms (label-provenance equivalence; co-activation semantics across substrates) that must be validated before the one-week "permanent immune system" is claimed.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — strongest Finding 3: "T1134: brain-ingester.ts queries `text` when schema is `narrative`. Confirmed via packages/core/src/memory/brain-lifecycle.ts:28,83." Named subject, predicate, artifact citation with line numbers. None hedged.
- G2 Evidence grounding: PASS — all six pack items cited + corroborating artifact read at brain-lifecycle.ts:28,83. Legitimate Outsider-lane artifact read.
- G3 Frame integrity: PASS — every finding is "the artifact says X." Finding 4 (non-existent cited path) is the purest Outsider move — defensible purely from artifact reads.
- G4 Actionability: PASS — verdict cashes out: "a stranger would stop here and ask what 'done' means in this repo." Testable question with direct operational implication.

**Strongest finding (from reviewee):** Two bullets in same MEMORY.md — "BRAIN Integrity epic auto-done" vs "BRAIN Integrity Crisis CRITICAL" — cannot both be true. Auto-done mechanism has decoupled from actual integrity state.

**Gap from Expansionist's frame:** Outsider correctly diagnoses "done" is broken, but stops at diagnosis. The auto-done/reality decoupling is not just a bookkeeping defect — it is a **latent telemetry asset**. The repo accumulates paired signals (verify-claimed-shipped vs observed-reality) across T991, T1000, T1008, T1015, T1134/T1107. That paired dataset is the seed of a "shipped-vs-true" regression detector that could ship as a first-class CLEO capability (`cleo integrity audit`) — uniquely defensible because only CLEO has evidence-atom provenance (ADR-051) wired to task closure.

**What I would add:** The claim/reality gap is a **telemetry signal** already being generated for free; productizing "audit whether what CLEO says shipped actually shipped" against its own evidence atoms is the obvious-in-retrospect product the T1134 bug is pointing at.

**Disposition:** Accept — all gates pass cleanly; cold-read lands a concrete mechanical defect + structural bookkeeping failure. My addition extends rather than replaces.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: FAIL — action asserts a source edit the artifact shows already landed. `cleo show T1134` returns `"implemented":true` with `"commit":"abf1dabdb"`; `grep` on live file shows `SELECT id, title, narrative,…` at line 83 — no lingering `text` column to flip. Executor's "find SQL on `text`, change to `narrative`" describes state-of-the-world that no longer exists.
- G2 Evidence grounding: FAIL — (a) Path fabrication: Executor writes `packages/core/src/brain/brain-ingester.ts`; directory does not exist (`ls: cannot access '/mnt/projects/cleocode/packages/core/src/brain/': No such file or directory`). Real path is `packages/core/src/sentient/ingesters/brain-ingester.ts`. Evidence pack even flagged the analogous path-drift on MEMORY.md:66; Executor repeated the exact shape. (b) Status mischaracterization: treats T1134 as unresolved leak ("feeding garbage every tick"); task shows `implemented` gate closed. Actual pending work is `testsPassed` + `qaPassed`.
- G3 Frame integrity: FAIL — voice is Executor-shaped (one action, 60-min horizon, commit sketched) but the frame demands "the one thing whose absence blocks everything else"; if that thing is already done, the advisor misidentified the bottleneck. Shape right, target wrong = frame-integrity failure because the frame's substantive contract (correct bottleneck identification) is unmet.
- G4 Actionability: FAIL — cd target cannot be opened; any agent executing literally hits ENOENT. Even if redirected, prescribed edit is a no-op. 60-min success criterion reduces to "run the tests" which is real work but not what the action statement says.

**Strongest finding (from reviewee):** The cited fix has already shipped (commit `abf1dabdb`, file sha256 in T1134 evidence, live grep confirms). Executor diagnosed past leak as present leak, prescribed re-application of a landed edit.

**Gap from Outsider's frame:** Artifact-only review catches both drifts a domain-loaded reviewer would gloss: path doesn't exist on disk, and `cleo show T1134` already reports implemented:true. Neither inferable from MEMORY narrative alone; both require opening filesystem + task store. Executor's authority voice camouflaged unchecked assumptions.

**What I would add:** Re-aim the single action at gates that are actually open: `pnpm --filter @cleocode/core test src/sentient/__tests__/brain-ingester.test.ts` + `pnpm biome check --write packages/core/src/sentient/ingesters/brain-ingester.ts && pnpm --filter @cleocode/core exec tsc --noEmit`; on green, `cleo verify T1134 --gate testsPassed --evidence "tool:pnpm-test"` and `--gate qaPassed --evidence "tool:biome;tool:tsc"`, then `cleo complete T1134`. Matches T1134's `nextAction: "verify"` and closes two open gates rather than re-editing a file whose sha256 is already in evidence.

**Disposition:** Reject — two hard gate failures plus G4 unexecutable. Path fabricated, edit already applied, action produces no state change. Needs rewrite against current artifact state.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — strongest: "Plasticity-on-polluted-substrate amplification — triggers when Hebbian strengthener at brain-lifecycle.ts:911 ticks over 2440 noise patterns…" Named subject, predicate, trigger, detection. All three findings carry trigger conditions; no hedging.
- G2 Evidence grounding: PASS — cited MEMORY.md:67 (F1), brain-lifecycle.ts:911 + MEMORY.md:66 (F1), T1107 (F2), T1134 (F2), T1008 (F2), MEMORY.md:20 (F2/F3), T1151 (F3). Every finding anchored.
- G3 Frame integrity: PASS — all findings name runtime/over-time failure modes with triggers. F1 is load/time cliff + silent failure; F2 is assumption stacking + silent failure; F3 is "one person" risk. None propose actions/opportunities/atoms/artifact observations. Verdict says "freezing further work" — a stated condition for failure-avoidance, still in-lane.
- G4 Actionability: FAIL — verdict says "freezing further write/plasticity work until T1107 and T1134 fixed against deduplicated substrate" — that is a *policy* ("freeze X until Y"), not a startable action. "Fix T1134" and "land T1107 on deduplicated substrate" are epics, not 60-min moves. The Executor-frame test (peer-review.md:27 "forces risk analysis to cash out; pure doom with no actionable mitigation is cheap") fails here.

**Strongest finding (from reviewee):** Finding 2 — text-vs-narrative mismatch (T1134) combined with unreachable write path (T1107) means Tier-2 proposer (T1008) keeps proposing duplicate work because novelty check reads empty table. Sharpest because both silent AND actively corrupting.

**Gap from Executor's frame:** Contrarian correctly identifies T1134 as the cheapest decisive probe in the risk surface — a single-file column-name mismatch verifiable by one query — but never cashes it out. An Executor-frame review would point at that exact probe: write one row via T1000 ingester, SELECT against both candidate columns; the one returning the row tells you which side of the mismatch is canonical, and the whole cascade collapses to a 60-min fix.

**What I would add:** Cash out F2 into a one-query probe: `SELECT column_name FROM pragma_table_info('brain_entries') WHERE column_name IN ('text','narrative');` against `.cleo/brain.db`, then run T1000 ingester on one observation and re-query.

**Disposition:** Modify — findings rigorous, grounded, in-lane, but verdict stops at "freeze work until X and Y" rather than naming the cheapest probe. Accept findings; require verdict to point at column-name probe as concrete line of inquiry.

## Phase 2.5 — Convergence check

Extracted the five "single sharpest point" statements:

1. **Contrarian**: "Plasticity reinforces 2440 noise while queries return empty due to column mismatch."
2. **First Principles**: "Every tier above is a multiplier on 2440 rows of noise — cannot build 'never-forget' on unreachable reads + wrong-column writes."
3. **Expansionist**: "Harvest dedup pass as training corpus before junk deleted + lift Hebbian to 5 substrates."
4. **Outsider**: "Auto-done epic claim contradicts CRITICAL NEXT SESSION claim in same document — ask what 'done' means before any intervention."
5. **Executor**: "Fix brain-ingester column text→narrative." (⚠ REFUTED by peer review — already shipped as commit `abf1dabdb`.)

**Pairwise convergence analysis:**
- Contrarian (1) + First Principles (2) arrive at the same predicate ("substrate ordering violated") via different frames. High semantic overlap but distinct causal narratives.
- Outsider (4) reinforces the same substrate-ordering concern via a bookkeeping route.
- Expansionist (3) is categorically distinct (upside harvest rather than ordering violation).
- Executor (5) is refuted and must be reconsidered in Phase 3.

**Verdict:** 3 advisors point at the same decision (substrate repair before expansion) but via 3 different analytical routes (runtime failure, atomic ordering, claim/reality gap). This is **route-convergent, not frame-convergent** — the skill says convergence flag fires when findings are **semantically identical**, not when conclusions point the same way. The semantic content of the three sharpest points is distinct enough to proceed. No convergence flag raised. Proceed to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | FAIL (verdict is policy, not 60-min probe) | high |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist     | PASS | PASS | PASS | PASS (Modify — 2/3 findings rest on unstated atoms) | high |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | FAIL | FAIL | PARTIAL | FAIL (action targets already-shipped edit + fabricated path) | low |

### Recommendation

The highest-leverage intervention is **not** a new epic, new system, or grand redesign. It is to enforce a strict substrate-first ordering with three concrete moves in this sequence:

1. **Close the T1134 verification cycle today** (per Outsider's corrected action): run tests + biome + tsc against `packages/core/src/sentient/ingesters/brain-ingester.ts` (real path), verify the two open gates (`testsPassed` + `qaPassed`), and complete T1134 — because commit `abf1dabdb` already applied the SQL fix.
2. **Snapshot the labeled corpus before dedup destroys it** (Expansionist's time-sensitive asymmetry, bounded by First Principles' unstated-atoms caveat): create a `brain_labeled_corpus` snapshot table preserving the 2440 noise + 45 junk + all `sentient propose` accept/reject rows *before* any dedup sweeper runs, with a separation between proposal-reject and memory-delete label streams.
3. **Unblock T1107 against the verified substrate**, then gate T1151 (Sentient Self-Healing) and STDP strictly on measured integrity metrics (noise ratio, dedup rate) — not on "Hebbian shipped" or "T991 auto-done."

### Why this, not the alternatives

Three advisors with full or high weight (First Principles, Contrarian, Outsider) converged via three different analytical routes on the same structural claim: you cannot build persistent memory or deeper sentience on an unverified substrate. Expansionist's upside is real but rests on two unstated atoms that First Principles correctly flagged (label-provenance conflation, substrate-agnostic co-activation semantics) — so the opportunity is kept but scoped as a capture-before-cleanup action, not a parallel epic.

The Executor's specific recommendation (re-edit the SQL) was refuted by the Outsider's artifact verification — the edit is already in commit `abf1dabdb`. This is itself a strong signal: the system is farther along than the in-repo narrative suggests. The correct Executor action shifts from "apply the fix" to "close the remaining test/QA gates."

Contested point: Contrarian + First Principles say "freeze all expansion (STDP, T1151, 5-substrate lift) until substrate green." Expansionist says "capture the corpus + lift Hebbian to 5 substrates *in the same epic as* cleanup." Reconciliation: the capture-before-delete is non-negotiable (the labeled corpus is destroyed otherwise), BUT the classifier-training and substrate-agnostic Hebbian lift are gated behind substrate-green per atoms 3–4. Snapshot preserves the asset without firing the plasticity.

### What each advisor got right (carried forward)

- **Contrarian's fatal flaw to mitigate:** Hebbian at `memory/brain-lifecycle.ts:911` will silently ratchet up weights on the 2440 noise patterns while queries return empty due to ingester column defect — the system will appear to learn while measurably forgetting the wrong things. Concurrent-writer race during dedup must be addressed with a quiescence window (added by Contrarian's peer reviewer to First Principles).
- **First Principles' atomic truth worth protecting:** "Never forget" is a read-side guarantee, not a write-side one. Substrate precedes surface precedes autonomy. No tier above the store is valid while T1107 is blocked.
- **Expansionist's upside to pursue (captured, gated):** The 2440 "noise" + accept/reject history is a one-time-only labeled corpus. Snapshot it before dedup destroys it; defer classifier training and 5-substrate Hebbian lift until First Principles' unstated-atom validations pass.
- **Outsider's pattern flag:** "Shipped" and "working" have decoupled. `brain/` vs `memory/` path drift; T991 marked auto-done while T1134+T1107 remain critical. Fix the bookkeeping surface alongside the substrate — `cleo integrity audit` against evidence atoms (ADR-051) is a real productizable artifact Expansionist's peer review surfaced.
- **Executor's action (corrected per peer review):** NOT "re-edit the column." Actual next move is to close T1134's remaining verification gates.

### Conditions on the recommendation

Conditional on:
1. The labeled-corpus snapshot lands in the same PR as (or strictly before) any dedup sweeper run.
2. STDP and T1151 remain blocked until integrity metrics (noise ratio, dedup rate, column-contract test green) are measurable and green.
3. First Principles' two unstated atoms (proposal-reject ≠ memory-delete; not all substrate edges are co-activation) are validated with a 30-min experiment before the classifier + 5-substrate Hebbian epic is committed to.
4. Contrarian's concurrent-writer race mitigation: dedup runs with a quiescence window (no active writer sessions) and an audit pass over Tier-2 proposals accepted pre-fix.

### Next 60-minute action

Run `pnpm --filter @cleocode/core test src/sentient/__tests__/brain-ingester.test.ts` and `pnpm biome check --write packages/core/src/sentient/ingesters/brain-ingester.ts && pnpm --filter @cleocode/core exec tsc --noEmit`. If all green: `cleo verify T1134 --gate testsPassed --evidence "tool:pnpm-test"` and `cleo verify T1134 --gate qaPassed --evidence "tool:biome;tool:tsc"`, then `cleo complete T1134`. Expected outcome: T1134 completes, T1107 unblock prerequisites become visible.

### Confidence

**Medium-High** — three full-weight frames converged on the substrate-first ordering via independent routes; Outsider's path+shipped-status verification is load-bearing and empirical. Confidence would rise to High if: (a) First Principles' two unstated-atoms experiment runs clean, and (b) T1107 unblock reveals no additional column contracts broken beyond T1134. Confidence would drop if the labeled-corpus snapshot is skipped under time pressure — the asset window closes once dedup runs.

### Open questions for the owner

- Is there an active daemon/session writing to BRAIN right now that would need quiescence before T1134 test gates can close reliably?
- Is `brain_labeled_corpus` the right table name / is there an existing snapshot primitive (e.g., the staged-backfill T1003 infrastructure) we should reuse for the corpus capture?
- Does the Sentient Tier-2 proposal log already contain the accept/reject labels with timestamps, or does capture require instrumentation upstream?
