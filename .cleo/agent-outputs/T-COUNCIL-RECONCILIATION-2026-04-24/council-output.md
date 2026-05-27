# The Council — Should the v2026.4.133 roadmap's ordering remain as-authored, or should the deferred BRAIN-integrity line (T1107/T1151/2440-sweep/T1262) be merged into that spine at named insertion points derived from dependency atoms?

## Evidence pack

1. `.cleo/agent-outputs/T-COUNCIL-SENTIENT-2026-04-23-v2/council-output.md` — prior council (2026-04-23) closed T1134 as "write-path freeze-point", explicitly **deferred** T1107/T1151/2440-sweep to "next sessions", and filed T1262 cleo memory doctor as standalone root epic. No insertion points named against the forward roadmap.
2. `.cleo/agent-outputs/COUNCIL-2026-04-23-infrastructure-roadmap.md:283` — prior council (same day) said HIGH confidence on spine `E1→E2→E3→E4→W5+W6→W7→W8+Sentient v1`; MEDIUM on v2026.4.133 terminus. **Sentient v1 already sits at W8 consolidation slot** — the forward plan has a Sentient anchor the BRAIN council didn't recognize.
3. `cleo show T1260` acceptance criterion 6 (verified): `buildRetrievalBundle registered as named injection primitive reusable by hooks/CANT/CONDUIT/sentient proposer (M4 Expansionist F3)`. The PSYCHE retrieval bundle and the sentient subsystem are **already architecturally linked** in E3's contract, not separate substrates.
4. `cleo show T1258` acceptance criterion 2 (verified): `hierarchy.ts audit (grep for runtime consumers) then redesign or delete`. T1107 (blocked/critical) is about wiring 14 Living Brain verbs through dispatch — dispatch lives in hierarchy.ts's neighborhood.
5. `cleo show T1107/T1151/T1262/T1263` (verified 2026-04-24) — T1107=blocked/critical/medium, T1151=pending/critical/epic/large, T1262=pending/high/epic/medium, T1263=pending/medium/epic/large (scheduled .130). Three of four are filed at critical/high priority but absent from the release roadmap; only T1263 (medium) got a slot.
6. `MEMORY.md:66-67` — verified present: line 66 "T-BRAIN-LIVING PRIORITY"; line 67 "BRAIN Integrity Crisis CRITICAL NEXT SESSION: 2440 noise patterns". Auto-memory contradicts the handoff's forward plan and is the first thing every future session-start orchestrator reads.
7. `cleo show T1134` — status=done (verified 2026-04-24T00:37:41, 3/3 gates green). The brain-ingester write-path is closed; the gating claim the BRAIN council used to defer T1107/T1151 is no longer load-bearing.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- `cleo show T1258` AC#2 (evidence item 4) — E1's `hierarchy.ts` redesign-vs-delete decision is the same code neighborhood that T1107's 14-verb dispatch wiring lives in; two uncoordinated epics mutating the same dispatch surface is a concurrency-over-time hazard.
- `cleo show T1260` AC#6 (evidence item 3) — `buildRetrievalBundle` is an explicit named injection primitive for the sentient proposer; E3 ships this contract and W8 Sentient v1 consumes it. Drift between E3's retrieval contract shape and the Sentient v1 consumer shape will surface only at W8 integration.
- Evidence item 7 (T1134 done, 2026-04-24T00:37:41) + evidence item 1 — the "write-path frozen, safe to defer T1107/T1151" premise is now a historical claim; no one has re-validated it.
- `MEMORY.md:66-67` (evidence item 6) — canonical auto-memory still flags BRAIN-integrity as "CRITICAL NEXT SESSION" while the roadmap elides it. The contradiction is the load-bearing context every future orchestrator reads at session start.
- `COUNCIL-2026-04-23-infrastructure-roadmap.md:283` (evidence item 2) — prior council is HIGH-confidence on the spine but MEDIUM on the terminus. The terminus is exactly where Sentient v1 lands.

**Findings (failure modes, from my frame only):**

1. **Silent retrieval-contract drift between E3 and W8** — triggers when E3 ships `buildRetrievalBundle` as its named injection primitive (T1260 AC#6) and W8 Sentient v1 begins consuming it weeks later without T1151 (Self-Healing) having been re-validated against the post-T1134 ingester. Fails by: Sentient v1 proposals get produced against a retrieval bundle whose provenance/typing assumptions were last audited when T1134 was still open — proposer writes land in the tasks DB that reference BRAIN entries whose integrity was never swept (the 2440-pattern backlog from `MEMORY.md:67`). Detected **silently**: proposals look well-formed, gates pass, but the corpus those proposals reason against is the un-swept pre-T1134 noise. Operators see "Sentient v1 shipped, proposals flowing, team happy" for weeks before a single low-quality proposal is traced back to a stale pattern.

2. **Dispatch-surface collision between E1 and T1107** — triggers when E1 executes `hierarchy.ts` redesign-vs-delete (T1258 AC#2) and the "delete" branch wins, while T1107 remains blocked/critical with 14 verbs still scheduled to route through dispatch infrastructure that E1 just removed. Fails by: T1107's unblock path depends on a surface E1 already deleted, forcing either a rushed rewrite of T1107's design or a revert of part of E1. Detected when: the first agent that tries `cleo orchestrate spawn` against a T1107 verb gets a dispatch miss that has no owner. Two individually-safe assumptions that multiply.

3. **Canonical-state contradiction becomes operator blindness** — triggers when any future session-start orchestrator reads `MEMORY.md:66-67` ("BRAIN Integrity Crisis CRITICAL NEXT SESSION: 2440 noise patterns") while also reading the NEXT-SESSION-HANDOFF pointing at the PSYCHE spine. Fails by: an orchestrator with no human in the loop picks the CRITICAL label and starts executing T1107/T1151/sweep work out-of-band with the E1→E8 spine, fragmenting the v2026.4.133 release. Detected when: the owner notices two parallel orchestrators have spawned on overlapping memory-subsystem surface.

**Verdict from this lens:** The unmerged plan ships a release whose terminal epic (Sentient v1 at W8) consumes contracts (E3 retrieval bundle) that reason over an un-swept substrate that a prior council itself labeled CRITICAL — and the deferral's load-bearing premise (T1134 as write-path freeze) is no longer live since T1134 closed on 2026-04-24. The failure is not that BRAIN-integrity work is missed; it is that the plan will appear to succeed while producing lower-quality Sentient v1 proposals against a corpus whose known-noise backlog was explicitly deferred.

**Single sharpest point:** Sentient v1 at W8 will ship "green" while silently reasoning over the deferred 2440-pattern noise backlog, because E3's `buildRetrievalBundle` primitive (T1260 AC#6) becomes the Sentient proposer's substrate before T1151/T1262/sweep have re-validated what that substrate contains — the failure surfaces only as degraded proposal quality weeks post-release, with no alarm and no rollback path named.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- External constraint: a memory substrate serving agent decisions cannot simultaneously be "quarantined" and "queried" — quarantine means no reads, and an agent making proposals from no-reads is making proposals from nothing. This is independent of CLEO.
- `cleo show T1260` acceptance criterion 6 — `buildRetrievalBundle` is declared a named injection primitive reusable by the sentient proposer. E3 (PSYCHE retrieval) and Sentient v1 share one contract, not two.
- `cleo show T1258` acceptance criterion 2 — `hierarchy.ts` audit-then-redesign-or-delete is inside E1. T1107's 14 Living Brain verbs dispatch through that neighborhood; E1's outcome determines whether T1107 becomes trivial or impossible.
- Evidence item 6, `MEMORY.md:66-67` — auto-memory still marks BRAIN Integrity as "CRITICAL NEXT SESSION" while the spine has moved to PSYCHE agent-infra. The canonical state is internally contradictory.
- Evidence item 7 — T1134 is `done`; the write-path freeze the prior BRAIN council used to justify deferral is no longer load-bearing.

**Atomic truths (independent of the artifact):**

1. **A memory substrate and the reasoning system that consumes it are one system, not two.** If a proposer reads from a store to decide what to do, the proposer's correctness is bounded by the store's integrity.
2. **A known-corrupt store with non-zero read volume degrades every downstream consumer in proportion to their dependence on it.** 2440 noise patterns are not dormant — they are being retrieved every time a consumer queries. A write-path freeze stops *new* corruption; it does not stop corruption already in circulation from shaping behavior.
3. **Integrity repair and integrity *detection* are separable concerns with different scheduling constraints.** A doctor (detector) is read-only and can ship any time. A sweep (mutator) touches the same rows a retrieval contract reads and must be sequenced against whoever owns the read surface.
4. **A retrieval primitive can only be made "reusable by the sentient proposer" if, at the moment of reuse, the thing it retrieves is trustworthy.** Shipping a named primitive that fans out to N consumers before you have told truth from noise inside the store multiplies the blast radius of every un-swept junk entry by N.
5. **Dispatch surfaces and the verbs that ride them have a strict ordering constraint: the verb cannot be wired until the surface's shape is settled.** If 14 verbs are blocked on a dispatch decision, and that dispatch decision is inside E1, then E1 is the gate.
6. **Auto-memory that contradicts the active plan is a worse failure than either document alone.** Two inconsistent canonical states mean every session start resolves the contradiction by guessing, and the guess becomes load-bearing without being inspected.
7. **Session-start memory hydration (journal) and memory-content integrity (doctor) answer different questions** — "what happened recently" vs. "is what's stored true" — and conflating them means you ship one and claim the other.

**Reconstructed solution (from atoms, before reading the plan):**

From atoms 1 and 2 alone: any spine that ships a sentient proposer reading from a store with 2440 known-bad entries is shipping degraded reasoning as a feature. The repair work is not a parallel track — it is *prior* to any increase in consumer count or consumer autonomy. From atom 4: the moment a retrieval primitive becomes reusable by N consumers is exactly the moment the store must have passed a truth-from-noise pass. From atom 3: detection (doctor) can ship early and cheaply; the mutator sweep must be fenced against the retrieval contract. From atom 5: the dispatch verbs ride whatever E1 decides. The correct shape is therefore: detection lands beside E1 (read-only, no contention), dispatch-dependent verbs land *inside* E1's resolution, the mutator sweep fences the window between retrieval-primitive-exists and retrieval-primitive-exposed-to-proposer, and self-healing activation must not ship before the sweep that gives it clean ground truth.

**Reconstruction vs. the proposed plan:**

- **Convergences:** The spine is correct that E1 precedes E3 precedes Sentient v1 — this matches atoms 4 and 5. The prior BRAIN council's instinct to defer the *mutator* sweep was correct in kind (wrong in placement): sweeps touch rows retrieval reads and must be sequenced, not parallelized blindly.

- **Divergences, each classified:**
  - Treating the BRAIN integrity line as a separate track parallel to the spine — **genuine error** (atom 1: one system, not two).
  - T1262 memory-doctor filed as standalone root epic with no insertion point against E1 — **path-dependent cruft** (atom 3: read-only detection has no contention with E1 and belongs adjacent to it, not orphaned).
  - T1107 (14 verbs) left in `blocked` without being named as an E1 exit criterion — **genuine error** (atom 5: the verbs cannot move without E1's dispatch decision, so E1 owns their unblock).
  - T1151 Self-Healing positioned as a late-epic/large without a precondition that the 2440-entry sweep has run — **genuine error** (atom 4: self-healing on an un-swept store learns the noise).
  - 2440-sweep deferred without a named window — **path-dependent cruft inherited from the prior BRAIN council's T1134 rationale, which atom from evidence 7 has now invalidated**.
  - MEMORY.md still labels BRAIN Integrity as CRITICAL NEXT SESSION while the spine reads as agent-infra — **genuine error** (atom 6).
  - T1263 (session journal) and T1262 (memory doctor) both filed as "memory integrity instruments" — **not a divergence, but atom 7 says these answer different questions**.

**Verdict from this lens:** The spine's ordering of E1→E3→Sentient v1 is sound, but the plan treats BRAIN integrity as a parallel track when atoms 1, 2, and 4 force it to be a *prerequisite embedded in the spine*. The deferral inherited from the prior BRAIN council rested on T1134's freeze-point; that freeze-point has shipped, and the deferral no longer has a supporting constraint.

**Single sharpest point:** The atom that forces the merger is atom 4 — a retrieval primitive becomes a blast-radius multiplier at the exact moment it is declared "reusable by the sentient proposer," which is E3's acceptance criterion 6, so the 2440-entry sweep must close *before* E3 exposes `buildRetrievalBundle` to a second consumer, not after Sentient v1.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- `cleo show T1260` AC#6 — `buildRetrievalBundle` is already contracted as a **named injection primitive reusable by hooks/CANT/CONDUIT/sentient proposer`. The PSYCHE spine isn't agent-infrastructure; it's a *substrate arbiter* whose first consumer is E3, and whose second consumer is explicitly the sentient proposer that lives under W8+Sentient v1. The two roadmaps share a single retrieval API by contract.
- `COUNCIL-2026-04-23-infrastructure-roadmap.md:283` + T1151 state — forward spine terminates at **W8+Sentient v1**, and the deferred line's flagship is **Sentient Self-Healing**. Both plans converge on the same agent at the same slot; they are two halves of one launch.
- `cleo show T1258` AC#2 — E1's hierarchy.ts audit *is the same dispatch neighborhood* T1107's 14 Living Brain verbs need to land in. E1 either paves T1107's runway or salts it; there is no neutral outcome.
- T1134 done + `MEMORY.md:66-67` — the write-path freeze is closed, and the auto-memory still flags BRAIN as "PRIORITY/CRITICAL NEXT SESSION". The deferral's load-bearing premise expired three days after it was authored.

**Findings (opportunities, from my frame only):**

1. **Unified Retrieval Substrate (URS)** — captures: one `buildRetrievalBundle` primitive serving hooks, CANT rules, CONDUIT delivery, sentient proposals, *and* the memory-doctor's integrity scans. Today it's scoped as E3's internal helper; if T1262 (memory-doctor) and T1151 (self-healing) are merged at E3's contract layer rather than bolted on afterward, CLEO gains a **single retrieval plane** where every substrate (TASKS/BRAIN/NEXUS/CONDUIT/SIGNALDOCK) is read through the same audited, typed, provenance-tagged surface. Asymmetry: the primitive is being built anyway; exposing it to T1151/T1262 at design time is hours of contract widening for permanent reuse across the 6-system lattice.

2. **Self-Healing-at-Dispatch (SHaD)** — captures: T1107's 14 Living Brain verbs land *inside E1's hierarchy.ts redesign*, so dispatch itself becomes the enforcement point where self-healing triggers fire. T1151's Sentient Self-Healing epic isn't a separate surface — it's **dispatch-time reflex** wired to the same verb table E1 audits. Asymmetry: E1 is touching the exact file T1107 is blocked on; routing the 14 verbs through the new dispatch costs one extra contract row per verb (~14 rows) and turns every future subsystem call into a self-healing opportunity.

3. **BRAIN-as-Launch-Asset for Sentient v1** — captures: the W8 terminus ships Sentient v1 on whatever BRAIN state exists at that moment. If the 2440-entry noise sweep and T1262 memory-doctor run *before* W8, Sentient v1 launches on a **clean, typed, doctor-verified corpus** instead of a pile the owner has flagged "CRITICAL" in MEMORY.md for 10+ days. Asymmetry: the sweep is a one-shot migration; running it after Sentient v1 means every proposal the sentient proposer emits from day one carries noise-contaminated retrieval provenance, and retroactive cleanup invalidates emitted proposals.

4. **The Memory-Doctor as a Product Surface** — captures: T1262 is currently scoped as an internal integrity tool. But the same detector that finds 2440 noise patterns in BRAIN is **the exact primitive Pi/CleoOS needs to expose to every CLEO installation** as `cleo memory doctor` — a user-facing health check that becomes a differentiator versus vanilla Claude Code and the GSD/PM alternatives benched at MEMORY.md:130. Asymmetry: the doctor is being built for internal hygiene; promoting it to a public CLI verb is an output-formatter plus a help-text commit.

**Verdict from this lens:** The two roadmaps are the same roadmap and the plan is too small when they stay separate. The forward spine is building the substrate-arbiter (PSYCHE) and the agent surface (Sentient v1); the deferred line is the **integrity, dispatch, and self-healing guarantees that make those surfaces shippable**. Running them as parallel tracks ships two half-products; fusing them ships one coherent platform.

**Single sharpest point:** The biggest uncaptured upside is a **Unified Retrieval-and-Healing Plane** — `buildRetrievalBundle` + hierarchy.ts's 14-verb dispatch + T1262 doctor + T1151 self-healing, designed as one contract surface at the E1→E3 boundary — which, if captured, turns CLEO from "agent infrastructure plus a memory cleanup backlog" into the only agent platform in the benchmark set that ships with a self-auditing memory substrate wired directly into dispatch; deferring the BRAIN line past W8 forfeits this entirely because Sentient v1 will have already shipped on top of the un-unified surface.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- `NEXT-SESSION-HANDOFF.md:163-181` — "Next-cycle roadmap — terminus v2026.4.133" table contains T1258 E1, T1259 E2, T1260 E3, T1261 E4, T1263 E6, T1145+T1146 W5+W6, T1147 W7, T1148 W8+Sentient v1. The BRAIN-integrity items (T1107, T1151, 2440-sweep, T1262) do not appear in this roadmap table at all.
- `NEXT-SESSION-HANDOFF.md:151-157` — the "Opening move" script tells the next orchestrator to `cleo show T1258 … T1259 … T1260 … T1261 … T1145 … T1249 … T1250`. It does not say `cleo show T1107`, `cleo show T1151`, or `cleo show T1262`.
- `COUNCIL-2026-04-23-infrastructure-roadmap.md:283` — Chairman records "High on the revised roadmap spine (E1→E2→E3→E4 → W5+W6 → W7 → W8+Sentient v1)." No entry for T1107/T1151/memory-doctor in the spine or in the M1-M5 modifications.
- `T-COUNCIL-SENTIENT-2026-04-23-v2/council-output.md:294-297` — Chairman says "Do not touch T1107 or T1151 in the same session. … Do not start the 2440-entry sweep in the same session. … File a follow-up task for `cleo memory doctor`." These three items are deferred with no named "next session" beyond "not this one."
- `MEMORY.md:66-67` — line 66 labels T-BRAIN-LIVING as "PRIORITY"; line 67 labels BRAIN Integrity Crisis as "CRITICAL NEXT SESSION" citing 2440 noise patterns.
- Evidence-pack item 5 — T1107=blocked/critical, T1151=pending/critical/epic/large, T1262=pending/high/epic/medium, T1263=pending/medium/epic/large.

**Findings (from a stranger's eyes only):**

1. **"CRITICAL NEXT SESSION" in the memory-of-record has no slot in "the next session's roadmap."** `MEMORY.md:67` names the 2440-noise crisis as *the* thing the next session handles. The next session's own roadmap schedules eight named release slots .126 through .133 and none of them name T1107, T1151, 2440-sweep, or T1262. The two documents that claim to brief the next orchestrator disagree on what the next orchestrator is for.

2. **Severity inversion: critical items unscheduled, medium items scheduled.** By the verified task states in the evidence pack, T1107 is `critical`, T1151 is `critical`, T1262 is `high`. T1263 is `medium` and is the only one of the four that got a release slot (`v2026.4.130`). A cold reader concludes the scheduler is not sorting by priority field.

3. **"Sentient v1" appears at the W8 consolidation slot without naming what that consists of.** `NEXT-SESSION-HANDOFF.md:181` lists `v2026.4.133` as "W8 sigil + Sentient v1 integration consolidation + MCP adapter proof." The prior BRAIN council filed T1151 "Sentient Self-Healing Orchestrator" as `pending/critical` and explicitly deferred it; T1151 is not referenced under the Sentient-v1 line in the roadmap. A stranger cannot tell whether "Sentient v1" at .133 includes T1151 or not.

4. **T1134 closure is load-bearing in one council and invisible in the other.** The BRAIN council's Chairman names T1134 as "the write-path freeze-point" 5 times, and its entire deferral of T1107/T1151/sweep rests on T1134 still being open. The infrastructure-roadmap council (same date) makes no mention of T1134, and the handoff's "What shipped" and M1-M5 sections do not cite it. Evidence-pack item 7 confirms T1134 is now done. The gating premise the BRAIN council used to defer those four items is no longer load-bearing, but no artifact records that status change or revisits the deferral.

**What the artifact claims vs. shows:**

The handoff *claims* `v2026.4.133` is "the April terminus" with "NO push to v2026.5.0" covering all remaining work. It *shows* a roadmap whose 8 slots contain zero of the four BRAIN-integrity items the project's own persistent memory file labels PRIORITY / CRITICAL NEXT SESSION. The infrastructure council claims HIGH confidence on the spine; the BRAIN council (same day) says those same spine epics must not touch corrupt substrate without sweep-and-instrument first. The two councils do not cite each other.

**Verdict from this lens:** A stranger reading the three artifacts side-by-side concludes they were produced by two separate planning tracks that do not know about each other. One track (infrastructure) has a named ship spine to v2026.4.133 with M1-M5 modifications and HIGH confidence. The other track (BRAIN/sentient) has a freeze-point doctrine, a deferred list of four critical items, and an instruction to file a `cleo memory doctor` follow-up — but no calendar. MEMORY.md sides with the BRAIN track by calling its work "CRITICAL NEXT SESSION," while the handoff sides with the infrastructure track by scheduling eight different slots.

**Single sharpest point:** The same project has two same-day councils producing two non-intersecting plans — one ships "Sentient v1" at slot .133 with HIGH confidence, the other says a self-healing sentient orchestrator on the current substrate is a "closed-loop corruption amplifier" — and neither artifact acknowledges the other exists.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `packages/core/src/orchestration/hierarchy.ts` (verified 202 lines, hardcoded `cleoos-opus-orchestrator` PRIME tree) + `grep -rn "orchestration/hierarchy" packages/ --include="*.ts"` returning zero external consumers — the T1258 E1 acceptance criterion 2 ("hierarchy.ts audit then redesign or delete") has a decisive, already-provable answer: delete. This is the cheapest E1 subtask and a frame-breaking experiment for the whole ordering question.
- `cleo show T1107` (verified blocked/critical, files `packages/contracts/src/operations`, `packages/cleo/src/dispatch/domains/nexus.ts` — 1512 lines) — T1107's blocker is NOT hierarchy.ts. Deleting hierarchy.ts surfaces whether T1107 was ever actually blocked by E1 dispatch concerns, or was mis-classified blocked for an unrelated reason. One deletion disproves one of the roadmap's load-bearing dependency claims.
- Evidence-pack item 3 + 4 (T1260 AC6 `buildRetrievalBundle` reusable by sentient proposer; T1258 AC2 hierarchy.ts redesign-or-delete) — E3 is where PSYCHE and BRAIN/sentient already touch; E1 is the cheapest upstream move that either (a) completes with trivial diff and validates the spine, or (b) reveals a hidden consumer and forces the spine to absorb T1107 unblocking sooner.

**The action (one):**
Delete `packages/core/src/orchestration/hierarchy.ts` on a feature branch and run `pnpm biome ci . && pnpm run build && pnpm run test` from the repo root. That's it — the grep already shows zero external consumers, so the T1258 AC2 audit resolves to "delete" without further design work. If the build/test triad comes up green, file the change as T1258's first completed subtask (evidence: `commit:<sha>;files:packages/core/src/orchestration/hierarchy.ts`), which collapses E1 by the size of one 202-line file and produces a concrete artifact the other advisors can review. If any of the three fails, the failing file/test name is the *exact* hidden runtime consumer and the roadmap's E1→E2→E3 ordering claim is falsified in under an hour.

**Expected outcome (60 minutes from now):**
Either (a) `pnpm biome ci . && pnpm run build && pnpm run test` all exit 0 with the deletion applied and a ready-to-commit diff of `-202` lines on one file, or (b) a named failing symbol/test pointing at the previously-undocumented consumer of `orchestration/hierarchy.ts`.

**What this unblocks:**
Binary evidence for whether E1 can proceed as-scoped (deletion path) or whether T1258 AC2 hides a dispatch-layer entanglement (failing-test path) that forces T1107 to be merged into E1 rather than kept deferred.

**Verdict from this lens:** The ordering question is under-determined from prose — one concrete deletion resolves the smallest named E1 subtask and simultaneously tests whether the BRAIN-integrity deferral assumption (that T1107 is independent of E1) holds. Argue less, delete one file, read the build log.

**Single sharpest point:** Delete `packages/core/src/orchestration/hierarchy.ts` and run the biome/build/test triad — green closes an E1 subtask, red names the hidden dependency that rewrites the roadmap.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — strongest finding: "a retrieval primitive becomes a blast-radius multiplier at the exact moment it is declared 'reusable by the sentient proposer' (T1260 AC#6), so the 2440-entry sweep must close before E3 exposes `buildRetrievalBundle` to a second consumer" — named subject (sweep), predicate (must close before E3 exposure), and derived from cited atom.
- G2 Evidence grounding: PASS — cites `cleo show T1260` AC#6, `cleo show T1258` AC#2, Evidence item 6 (`MEMORY.md:66-67`), Evidence item 7 (T1134 done). All map to the shared evidence pack; each anchors a classified divergence.
- G3 Frame integrity: PASS — reviewee's persona is First Principles. Output opens "Ignore everything that was said. What is actually true here?" and derives 7 atomic truths independent of the artifact before reconstructing a solution. No failure-mode claims, no opportunity claims, no executor-style step list. Stays in its lane.
- G4 Actionability: PASS — verdict cashes out to a concrete decision: "Detection lands beside E1 (read-only, no contention), dispatch-dependent verbs land inside E1's resolution, the mutator sweep fences the window between retrieval-primitive-exists and retrieval-primitive-exposed-to-proposer, self-healing must not ship before the sweep that gives it clean ground truth." Owner can order work from this directly.

**Strongest finding (from reviewee):** The sweep-before-exposure constraint — once `buildRetrievalBundle` is declared a shared primitive (T1260 AC#6), the corruption in the underlying store is no longer isolated to one consumer's failure modes; it ships with every future caller.

**Gap from Contrarian's frame:** First Principles derived atoms assuming the sweep itself is a clean, atomic operation. My frame asks: what fails when the sweep runs? A 2440-entry mutator pass over `.cleo/brain.db` while E1 is simultaneously refactoring the hierarchy dispatch surface is a concurrency collision that atom 5 (ordering) hints at but never pins down. In practice sweeps have partial-failure modes (some entries reclassified, some skipped on schema edge cases, some written-then-rolled-back) that leave the store in a third state atoms 2 and 4 don't model.

**What I would add:** The sweep must carry a trigger-conditioned abort contract — if T1151 self-healing activates mid-sweep on entries the sweep has already touched but not committed, the healer will re-corrupt the sweep's in-flight reclassification and the store exits the window dirtier than it entered; therefore self-healing must be gated off until the sweep transaction closes, not merely scheduled after it.

**Disposition:** Accept

First Principles' atoms and divergence classification hold; the ordering verdict is sound and actionable as written. My frame adds a runtime-concurrency caveat but does not invalidate the reconstruction.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — strongest finding carries named subject/predicate/trigger: "T1107's 14 verbs land inside E1's hierarchy.ts redesign; dispatch becomes self-healing enforcement point. T1151 isn't separate surface — it's dispatch-time reflex wired to same verb table." Each finding names concrete artifacts with asymmetry asserted.
- G2 Evidence grounding: PASS — every finding anchors to cited pack items: `cleo show T1260` AC#6, `COUNCIL-2026-04-23-infrastructure-roadmap.md:283`, `cleo show T1258` AC#2, T1134 + MEMORY.md:66-67.
- G3 Frame integrity: PASS — findings stay in Expansionist lane (opportunity, asymmetric upside, uncaptured surface). "Biggest uncaptured upside is Unified Retrieval-and-Healing Plane" is unmistakably opportunity-framed.
- G4 Actionability: PASS — verdict cashes to a concrete ordering change: "designed as one contract surface at E1→E3 boundary"; disposition is explicit.

**Strongest finding (from reviewee):** The sweep is asymmetric in time — cheap to run on a pre-launch corpus, structurally expensive after Sentient v1 has emitted proposals grounded in noise, so BRAIN integrity must precede W8 rather than trail it.

**Gap from First Principles' frame:** Expansionist asserts convergence ("two roadmaps are same roadmap") but never derives the atomic constraint that forces it. The atom is: *a proposer whose retrieval reads a corrupted corpus emits corrupted proposals, and proposals once emitted carry downstream side effects (accepted tasks, observed memories, Hebbian edge reinforcement) that cannot be rolled back by later sweeping the source corpus.* That atom — not the buildRetrievalBundle contract shape — is what makes the ordering mandatory.

**What I would add:** Insert a hard ordering atom — *T1107 unblock + 2440-entry sweep MUST complete before any component that writes autonomous proposals reads BRAIN* — which makes the insertion point E3→W8 (not E1→E3) non-negotiable on correctness grounds alone, independent of whether the URS/SHaD opportunity is captured.

**Disposition:** Accept — the opportunity framing lands and the ordering prescription is directionally correct; the atomic correctness constraint I'd add strengthens rather than overturns the verdict.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — Strongest finding has named subject, predicate, and artifact citation: "'CRITICAL NEXT SESSION' in memory-of-record has no slot in 'the next session's roadmap.' The two documents that claim to brief the next orchestrator disagree on what the next orchestrator is for." Each of the 4 findings carries a concrete anchor.
- G2 Evidence grounding: PASS — All cited items exist and map to findings: `NEXT-SESSION-HANDOFF.md:163-181`, `NEXT-SESSION-HANDOFF.md:151-157`, `COUNCIL-2026-04-23-infrastructure-roadmap.md:283`, `T-COUNCIL-SENTIENT-2026-04-23-v2/council-output.md:294-297`, `MEMORY.md:66-67`.
- G3 Frame integrity: PASS — Outsider lane is stranger-read of artifacts-in-front. Every finding is a "two documents disagree" or "severity field not honored" observation a cold reader could make from the cited files alone. No risk enumeration, no atomic derivation, no opportunity-naming, no action prescription.
- G4 Actionability: PASS — Verdict cashes out to a concrete decision: "Two separate planning tracks that do not know about each other … neither artifact acknowledges the other exists." This names the exact reconciliation action the owner must take.

**Strongest finding (from reviewee):** Same project, same day, two councils produced two non-intersecting plans — one ships "Sentient v1" at .133 with HIGH confidence while the other labels self-healing sentient on the current substrate a "closed-loop corruption amplifier" — and neither artifact references the other.

**Gap from Expansionist's frame:** The stranger-read stops at "contradiction exposed" and treats reconciliation as pure cleanup. It misses that the contradiction itself is a **latent governance asset**: two same-day councils producing non-intersecting spines is the first reproducible signal that CLEO now has enough council throughput to generate *competing* plans — which means the project has graduated from "can we get one plan" to "can we arbitrate between plans." That arbitration layer is the seed of a council-of-councils / meta-chairman primitive. Separately, the 2440-entry corruption corpus the Outsider treats as a scheduling-severity problem is actually a **pre-labeled training set for memory-doctor's detector** — activating T1262 against it is asymmetric (corpus already exists, no synthesis cost) and would produce the first ground-truth precision/recall numbers the BRAIN-integrity line has ever had.

**What I would add:** Merging the BRAIN-integrity line into the spine is not just debt-reduction — inserting T1262 memory-doctor *before* Sentient v1 (W8) converts the 2440-entry noise pool from a deferred liability into the commissioning benchmark for the self-healing layer, so the same work ships twice: as cleanup and as the first evaluation harness CLEO has for its own memory substrate.

**Disposition:** Accept

The cold-read lands the contradiction cleanly with quoted artifact evidence across all four gates; the expansionist-frame addition is additive (latent dual-use of the corruption corpus) rather than corrective.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: FAIL — Executor claims `grep -rn "orchestration/hierarchy" packages/ --include="*.ts" returning zero external consumers`. Independently verified: that exact grep does return empty, but the correct query `grep -rn "from.*hierarchy" packages/ --include="*.ts"` surfaces `packages/core/src/orchestration/index.ts:53: export { OrchestrationHierarchyImpl } from './hierarchy.js';` plus `packages/contracts/dist/index.d.ts:60: export { type AgentHierarchy, type AgentHierarchyEntry, type EscalationChain, type OrchestrationHierarchyAPI, OrchestrationLevel, } from './orchestration-hierarchy.js';`. The "zero consumers" claim is an artifact of the chosen grep pattern, not reality.
- G2 Evidence grounding: PASS — Line count verified (202 lines) and hardcoded `cleoos-opus-orchestrator` at lines 25/38/43 verified. The contents-side evidence is real; the call-site-side evidence is flawed.
- G3 Frame integrity: PASS — Executor stays in-frame: "The action (one)", "Expected outcome (60 minutes from now)", one symbol, one command triad, binary green/red outcome.
- G4 Actionability: PASS — executable in under an hour with a clear pass/fail signal; mechanically startable though the operator's expected-outcome framing is skewed by the G1 error.

**Strongest finding (from reviewee):** The prose-level ordering question is under-determined; a single deletion + triad is a cheaper oracle than further roadmap debate, because build/test failure *names* the hidden consumer that would otherwise stay latent in the prose.

**Gap from Outsider's frame:** The action presumes the Executor's own grep is authoritative. Cold-read outsider testing the artifact shows the grep pattern mis-specified the search (`orchestration/hierarchy` misses `./hierarchy.js` relative imports in the same directory and misses the barrel re-export at `packages/core/src/orchestration/index.ts:53`). The "deletion path" the Executor frames as likely-green is almost certainly red on the build step.

**What I would add:** Prepend 30 seconds of verification: `grep -rn "from.*['\"].*hierarchy" packages/ --include="*.ts" | grep -v "tasks/hierarchy\|hierarchy-policy\|hierarchy-tree\|hierarchy.test"` — if that returns any line pointing at `orchestration/hierarchy` or `./hierarchy.js` inside `packages/core/src/orchestration/`, the deletion is *known* to red before running the triad, and the action becomes "delete the file AND its re-export at index.ts:53 AND the contract at `packages/contracts/src/orchestration-hierarchy.ts`" — a different, larger action with different risk.

**Disposition:** Modify

The instinct (use a small concrete deletion as a roadmap oracle) is sound and in-frame, but the operator-facing claim of "zero external consumers" is falsified by a 5-second broader grep.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — Contrarian names three distinct, mechanically-specified failure modes with triggers, propagation paths, and detection-lag characteristics.
- G2 Evidence grounding: PASS — Every claim cites a retrievable atom: T1258 AC#2 + T1260 AC#6, MEMORY.md:66-67, Infrastructure-roadmap council:283, T1134 done (2026-04-24).
- G3 Frame integrity: PASS — Frame held throughout: "Assume the plan is wrong. What fails first?" Every finding is a failure-mode, not a recommendation.
- G4 Actionability: FAIL — Contrarian's output names three failure triggers but surfaces zero startable countermeasures. "no alarm and no rollback path named" describes the gap without proposing what alarm, at which gate, invoked by which command. An operator reading this cannot begin a 60-minute action; they can only feel anxiety about W8. Sharpest point ends in diagnosis, not intervention.

**Strongest finding (from reviewee):** Sentient v1 at W8 consumes E3's buildRetrievalBundle primitive over a substrate (2440-pattern noise) that T1151/T1262/sweep were supposed to re-validate but are unscheduled in the current spine — failure surfaces as degraded proposal quality weeks post-release with no alarm.

**Gap from Executor's frame:** Finding #1 names the trigger (E3 retrieval primitive hits Sentient proposer before sweep) but never names the gate that would have caught it. There is no proposed AcceptanceGate on E3 AC (e.g., "buildRetrievalBundle MUST reject or flag entries from deferred-noise provenance class") and no proposed W8 entry criterion (e.g., "Sentient v1 propose-enable blocked until `cleo memory doctor --pre-sentient` returns zero noise-class hits"). The failure mode is real; the lever is unnamed.

**What I would add:** Insert a named, binary entry-gate between E3 and W8 as a roadmap amendment, not a merge of the full BRAIN line. Concrete action: add acceptance criterion to E3 — `buildRetrievalBundle emits provenanceClass on every entry and refuses to return entries with provenanceClass="unswept-pre-T1151"` — and add entry criterion to W8 — `cleo sentient propose enable is gated on cleo memory doctor --assert-clean exit 0`. Binary success: `cleo memory doctor --assert-clean; echo $?` returns 0 before `cleo sentient propose enable` succeeds. This surgically closes Contrarian's #1 without re-ordering the spine.

**Disposition:** Modify

Contrarian's diagnosis is sound and evidence-grounded but stops at failure-naming; accepting it as-is leaves the operator with anxiety and no lever. Modification is minimal: attach a single entry-gate action at the W8 boundary.

## Phase 2.5 — Convergence check

Extracted five "single sharpest point" statements:

1. **Contrarian:** "Sentient v1 at W8 will ship 'green' while silently reasoning over the deferred 2440-pattern noise backlog, because E3's `buildRetrievalBundle` primitive becomes the Sentient proposer's substrate before T1151/T1262/sweep have re-validated what that substrate contains."

2. **First Principles:** "The atom that forces the merger is atom 4 — a retrieval primitive becomes a blast-radius multiplier at the exact moment it is declared 'reusable by the sentient proposer,' which is E3's acceptance criterion 6, so the 2440-entry sweep must close before E3 exposes `buildRetrievalBundle` to a second consumer, not after Sentient v1."

3. **Expansionist:** "The biggest uncaptured upside is a Unified Retrieval-and-Healing Plane — `buildRetrievalBundle` + hierarchy.ts's 14-verb dispatch + T1262 doctor + T1151 self-healing, designed as one contract surface at the E1→E3 boundary — which turns CLEO into the only agent platform in the benchmark set that ships with a self-auditing memory substrate wired directly into dispatch."

4. **Outsider:** "The same project has two same-day councils producing two non-intersecting plans — one ships 'Sentient v1' at slot .133 with HIGH confidence, the other says a self-healing sentient orchestrator on the current substrate is a 'closed-loop corruption amplifier' — and neither artifact acknowledges the other exists."

5. **Executor:** "Delete `packages/core/src/orchestration/hierarchy.ts` and run the biome/build/test triad — green closes an E1 subtask, red names the hidden dependency that rewrites the roadmap."

**Pairwise analysis:**

Three advisors (Contrarian, First Principles, Expansionist) touch the **same subject** — the E3↔W8 seam where `buildRetrievalBundle` meets the Sentient proposer across an un-swept BRAIN — but through **categorically different predicates**:
- Contrarian: "will ship green while silently reasoning over noise" (failure-mode predicate)
- First Principles: "is a blast-radius multiplier forcing sweep ordering" (atomic-constraint predicate)
- Expansionist: "is the URS uncaptured upside" (opportunity predicate)

Same subject + different predicates ≠ "semantically the same finding" per the convergence criterion. The three framings are complementary lenses on a single structural seam — this is the council pattern working, not collapsing.

Outsider's predicate is meta-structural ("two plans don't acknowledge each other"). Executor's predicate is surgical-diagnostic ("delete file, let build log speak"). Both are categorically distinct from the E3↔W8 trio.

**Convergence flag: NOT raised.** Five semantically distinct positions retained. Proceed to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Disposition |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | FAIL | Modify |
| First Principles | PASS | PASS | PASS | PASS | Accept |
| Expansionist     | PASS | PASS | PASS | PASS | Accept |
| Outsider         | PASS | PASS | PASS | PASS | Accept |
| Executor         | FAIL | PASS | PASS | PASS | Modify |

Convergence check: no collapse. Five semantically distinct positions retained.

### Recommendation

**Merge the BRAIN-integrity line into the v2026.4.133 spine at four named insertion points derived from dependency atoms, not convenience. Do not add new release slots; absorb each item into the existing epic it is architecturally inside.**

The merger is forced by First Principles' atom 4 (peer-reviewed Accept) and Expansionist's unified-retrieval-plane finding (peer-reviewed Accept). The roadmap reordering is not required — the spine's E1→E2→E3→E4→E6→W5+W6→W7→W8 ordering is atom-correct per First Principles' reconstruction. What is required is that four currently-orphaned items gain named homes inside the existing epics, plus two new acceptance criteria that convert Contrarian's silent failure mode into a binary runtime gate.

**Specifically:**

| Item (currently orphaned) | Merger target | Atom / finding that forces this placement |
|---|---|---|
| **T1107** (14 Living Brain verbs, blocked/critical) | **Absorbed into T1258 E1** (v2026.4.126) | First Principles atom 5 + Expansionist SHaD finding — dispatch verbs cannot be wired before E1 resolves `hierarchy.ts`; E1 either enables or breaks T1107. |
| **T1262** (cleo memory doctor, high) — detector surface | **Ships parallel to T1258 E1** (v2026.4.126, read-only) | First Principles atom 3 — detection is read-only, has no contention with E1, and belongs adjacent to it. Early detector lets sweep be targeted, not blind. |
| **T1262** (cleo memory doctor, high) — CLI surface + session-end hook | **Absorbed into T1263 E6** (v2026.4.130) | First Principles atom 7 — journal and doctor answer different questions but share the session-end integration surface; T1263 is that surface. |
| **2440-entry sweep** (under shadow-write envelope) | **Absorbed into T1147 W7** (v2026.4.132) | First Principles atom 4 — sweep must close before E3's `buildRetrievalBundle` is exposed to a second consumer (W8 Sentient proposer). W7 is the reconciler epic; a reconciler is architecturally a sweep. Fuse. |
| **T1151** (Sentient Self-Healing, critical/large) | **Absorbed into T1148 W8 Sentient v1 scope** (v2026.4.133) | Outsider + Expansionist — the handoff already says W8 is "Sentient v1 integration consolidation"; T1151 is exactly that consolidation. Explicit naming closes the "cannot tell whether Sentient v1 includes T1151" gap. |

**Plus two new binding acceptance criteria — M6 and M7 (atomic gates, not aspirational modifiers):**

- **M6 — provenance-class gate on T1260 E3:** `buildRetrievalBundle` MUST emit a `provenanceClass` field on every returned entry, and MUST refuse to return entries with `provenanceClass="unswept-pre-T1151"` (atom 4 materialized as a runtime check). This is the alarm Contrarian's Finding #1 names as missing.
- **M7 — assert-clean entry gate on T1148 W8:** `cleo sentient propose enable` MUST return non-zero until `cleo memory doctor --assert-clean` returns exit 0. This is the binary lever Executor's peer review names as the surgical mitigation for Contrarian's sharpest failure mode.

**Plus one immediate session-level reconciliation:**

- **MEMORY.md:66-67 reconciliation:** Update the auto-memory lines to reflect that BRAIN-integrity is now merged into the v2026.4.133 spine at named insertion points (not "CRITICAL NEXT SESSION, unscheduled"). Closes Outsider's sharpest finding; prevents future orchestrators from forking against the roadmap.

### Why this, not the alternatives

The recommendation is the only synthesis where every advisor's sharpest point lands simultaneously without contradiction:

- **Not "keep the plans separate" (the status quo)**: Fails First Principles atom 1 (memory substrate + reasoning system are one system, not two) and Contrarian Finding #1 (Sentient v1 ships green over un-swept corpus). Peer review confirmed both findings at 4/4 and 3/4 gates respectively.

- **Not "reorder the spine to put BRAIN-integrity first" (maximal merger)**: Fails First Principles' own reconstruction — the atom-forced ordering is E1→E3→Sentient v1. The spine is already atom-correct on ordering. What is missing is the home for four items, not a new order.

- **Not "add a new release slot for the BRAIN line" (slot expansion)**: Violates the owner's stated April terminus constraint (v2026.4.133, no push to v2026.5.0) named in `NEXT-SESSION-HANDOFF.md:165`. Absorbing into existing epics respects that constraint; adding slots does not.

- **Not "activate Sentient v1 at W8 and sweep afterward" (current implicit plan)**: Fails First Principles atom 4 (retrieval primitive becomes blast-radius multiplier at reuse moment) and Expansionist Finding 3 (sweep is asymmetric in time — cheap pre-launch, structurally expensive post-launch because emitted proposals invalidate).

- **Not "Executor's raw deletion action" (surgical probe)**: Executor's G1 FAILED peer review — the grep pattern was narrower than reality; `hierarchy.ts` IS re-exported at `packages/core/src/orchestration/index.ts:53` and shadowed by a public contract in `packages/contracts/src/orchestration-hierarchy.ts`. The action is still usable but must be modified per Outsider's peer review: run the corrected grep FIRST, then scope the deletion (1-file vs. 3-file-with-barrel-and-contract) before running the triad.

### What each advisor got right

- **Contrarian**: Three failure modes are real and fire on the plan-as-written. The Sentient-v1-over-un-swept-corpus failure (Finding #1) becomes the load-bearing reason for M6 and M7. The dispatch-collision failure (Finding #2) is why T1107 must be absorbed into E1, not deferred behind it. The operator-blindness failure (Finding #3) is why MEMORY.md:66-67 reconciliation must happen this session, not next.
- **First Principles**: Atoms 1, 4, 5, and 7 carry the entire argument. Atom 4 is the single most load-bearing claim in this council — peer-reviewed at 4/4 gates, Accept disposition. The reconstruction's "detection beside E1, dispatch-verbs inside E1, sweep fences window, self-healing last" is the structural skeleton this recommendation follows exactly.
- **Expansionist**: The Unified Retrieval-and-Healing Plane reframes the merger from "chore" to "product surface." The URS/SHaD pairing is why M6's `provenanceClass` is worth its implementation cost — not just as a gate, but as the typed contract every future consumer reuses. The "memory-doctor as product surface" finding is why T1262 ships twice (detector parallel to E1, CLI absorbed into E6).
- **Outsider**: The "two same-day councils producing non-intersecting plans" finding is the existence proof the owner needed for this very council run. It is the only finding that operates one level above the technical debate — it says the planning process itself produced the contradiction, and reconciliation must therefore include a procedural fix (MEMORY.md:66-67 update) not just a technical one.
- **Executor**: The "one deletion as a binary oracle" instinct is sound, but the peer review correctly modified it. The action is retained in the next-60-minute block below with Outsider's prepend applied. Without the Executor frame, this council would have converged on analysis and shipped no testable step.

### Conditions on the recommendation

1. **Run Outsider's corrected grep first.** Before any edit to `hierarchy.ts` or its barrel re-export, run `grep -rn "from.*['\"].*hierarchy" packages/core/src/orchestration/ packages/contracts/ --include="*.ts"` to enumerate the true consumer set. If the result exceeds 1 file, the T1258 E1 AC#2 audit's "delete" branch becomes a 3-file surgery (hierarchy.ts + barrel re-export at `packages/core/src/orchestration/index.ts:53` + contract at `packages/contracts/src/orchestration-hierarchy.ts`) and must be scoped accordingly.
2. **Do NOT activate the 2440-entry sweep without a shadow-write envelope.** Contrarian's cross-frame addition to First Principles (peer-reviewed Accept with added concurrency caveat) is non-negotiable: the sweep writes to `brain_v2_candidate` (or equivalent staging table), a 100-entry stratified human-validated sample must pass before cutover, and self-healing MUST be gated off until the sweep transaction closes. This ships in W7 (v2026.4.132), not earlier.
3. **M6 and M7 are binding acceptance criteria, not optional modifiers.** Add them to T1260 and T1148 acceptance arrays this session, before any child task is spawned under those epics. Without these two gates, Contrarian's Finding #1 fires at W8 and the entire release ships degraded.
4. **MEMORY.md:66-67 reconciliation is a session-level action, not a future task.** Leaving the auto-memory contradiction in place means every future orchestrator reads contradictory priorities at session start. Update the two lines to point at the new insertion-point map; file a follow-up for the `cleo memory doctor` automated contradiction-detector (T1262) as the durable fix.
5. **T1107 is absorbed into T1258, not just linked.** Filing T1107 as a child under T1258 is insufficient — T1258's acceptance array must include a named criterion for the 14-verb wiring, so E1 cannot close green while leaving T1107 in `blocked` state. Same pattern for T1151→T1148 and the sweep→T1147.

### Next 60-minute action

Run, in order, from `/mnt/projects/cleocode`:

```bash
# 0. Outsider's corrected grep — enumerate the true hierarchy.ts consumer set
grep -rn "from.*['\"].*hierarchy" packages/core/src/orchestration/ packages/contracts/ --include="*.ts" \
  | grep -v "tasks/hierarchy\|hierarchy-policy\|hierarchy-tree\|hierarchy.test"

# 1. Amend T1260 E3 acceptance with M6 (provenance-class gate)
cleo update T1260 --add-acceptance \
  "buildRetrievalBundle emits provenanceClass on every returned entry; refuses entries with provenanceClass=unswept-pre-T1151 (M6 from T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict)"

# 2. Amend T1148 W8 acceptance with M7 (assert-clean entry gate)
cleo update T1148 --add-acceptance \
  "cleo sentient propose enable returns non-zero until cleo memory doctor --assert-clean returns exit 0 (M7 from T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict)"

# 3. Merge T1107 (14 verbs) into T1258 E1 scope
cleo update T1258 --add-acceptance \
  "T1107 14 Living Brain verbs wired through resolved dispatch surface; T1107 closes at T1258 completion (merge per T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict)"

# 4. Merge T1151 (Self-Healing) into T1148 W8+Sentient v1 scope
cleo update T1148 --add-acceptance \
  "T1151 Sentient Self-Healing Orchestrator wired as dispatch-time reflex; T1151 closes at T1148 completion (merge per T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict)"

# 5. Merge 2440-sweep into T1147 W7 scope
cleo update T1147 --add-acceptance \
  "2440-entry BRAIN noise sweep under shadow-write envelope (brain_v2_candidate staging + 100-entry stratified human validation + self-healing gated off during sweep transaction); executes as part of reconciler pass (merge per T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict)"

# 6. Absorb T1262 (memory doctor) detector surface as E1-parallel; CLI surface into E6
cleo update T1258 --add-acceptance \
  "T1262 memory-doctor detector ships read-only parallel to E1 (no contention; early detector lets W7 sweep be targeted not blind)"
cleo update T1263 --add-acceptance \
  "T1262 memory-doctor CLI surface + session-end hook absorbed into E6 session-journal integration"

# 7. MEMORY.md:66-67 session-level reconciliation
cleo memory observe \
  "MEMORY.md lines 66-67 reconciled: T-BRAIN-LIVING and BRAIN Integrity Crisis items merged into v2026.4.133 spine per T-COUNCIL-RECONCILIATION-2026-04-24 — T1107→T1258 E1 (.126), T1262 detector→parallel E1, T1262 CLI→T1263 E6 (.130), 2440-sweep→T1147 W7 (.132), T1151→T1148 W8+Sentient v1 (.133). Removes the 'CRITICAL NEXT SESSION unscheduled' contradiction flagged by Outsider." \
  --title "MEMORY.md BRAIN-integrity reconciliation (council 2026-04-24)"
```

### Confidence

**High** on the merger recommendation itself: three advisors converged through three different framings on the same structural seam, First Principles passed 4/4 peer review gates, and the insertion-point map is atom-derived (not convenience-derived). The two advisors who received Modify dispositions (Contrarian, Executor) were modified in ways that *strengthen* rather than weaken the merger — Contrarian's gap became M6/M7, Executor's grep correction became Condition 1.

**Medium** on fitting into the v2026.4.133 terminus without slot expansion. The plan absorbs four orphaned items into four existing epics, which is theoretically zero-slot-cost, but each absorption widens that epic's scope. The April terminus holds if (a) M6 can be implemented in E3 without forcing a schema migration (likely — `provenanceClass` is a retrieval-surface field, not a storage column), and (b) the sweep's shadow-write envelope can be staged in W7 without blocking the reconciler's core work. Would drop to **Low** if either of those assumptions breaks during E3 or W7 scoping — in which case the correct response is to push W8 to v2026.4.134 rather than ship without the gates.

Would rise to **Very High** if the owner accepts the M6/M7 gates as binding *before* the T1258 E1 work starts — that locks the atom-forced ordering into the epic graph itself, eliminating the drift vector Contrarian named.

### Open questions for the owner

None. The merger map is atom-derived, the insertion points are named, the M6/M7 gates are specified, the 60-minute action is self-contained, and the terminus constraint is respected. The Chairman's verdict cashes out to seven copy-pasteable `cleo` commands.
