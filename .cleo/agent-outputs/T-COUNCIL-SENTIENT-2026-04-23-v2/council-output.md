# The Council — Given the BRAIN integrity crisis and Sentient Tier 1–3 foundation, what is the highest-leverage intervention to advance CLEO toward persistent-never-forget memory and deeper autonomous sentience?

## Evidence pack

1. `MEMORY.md:67` — BRAIN Integrity Crisis: 2440 noise patterns, 45+ junk entries, no graph data, no dedup.
2. `MEMORY.md:20` — T991 BRAIN Integrity epic (8 children auto-done), T1000 BRAIN Advanced (6 children auto-done), T1008 Sentient Tier 2, T1015 architecture cleanup.
3. `MEMORY.md:66` — T-BRAIN-LIVING PRIORITY: 5-substrate graph + Hebbian/STDP. Hebbian at `packages/core/src/memory/brain-lifecycle.ts:911`.
4. `T1151` — MASTER: Sentient Self-Healing Orchestrator, pending/critical, parent=T942.
5. `T1107` — Wire 14 Living Brain verbs through dispatch, **blocked**/critical.
6. `T1134` — brain-ingester text vs narrative column bug; implemented gate closed via commit `abf1dabdb`; testsPassed + qaPassed still open. Real path: `packages/core/src/sentient/ingesters/brain-ingester.ts`.
7. `MEMORY.md:106` — Owner Memory Philosophy (NON-NEGOTIABLE): tiered memory, chat≠memory, extraction pipeline, ground truth, typed memory, instrumentation.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- MEMORY.md:67 — 2440 noise baseline makes every intervention multiplicative.
- MEMORY.md:66 — Hebbian shipped with "no dedup" means reinforcement compounds duplicates.
- T1107 blocked/critical — verbs unreachable.
- T1151 pending/critical — self-healing on corrupt substrate.
- T1134 pending — ingester column bug.
- MEMORY.md:20 — auto-done status masks post-ship defects.

**Findings (failure modes, from my frame only):**
1. **Schema drift write amplification** — trigger: any Tier-2 ingester run before T1134 gates close writes to text/narrative column split. Mode: 2440 noise count grows monotonically; dedup impossible with split join key. Detected silently.
2. **Hebbian-without-dedup runaway** — trigger: repeated co-activation of duplicate noise patterns. Mode: duplicate edges accumulate weight superlinearly; whichever pattern has most dupes wins retrieval — noise reinforced into ground truth. STDP compounds.
3. **Blocked-verb dispatch gap masks silent drops** — trigger: any subsystem assuming verb surface; mode: writes route to fallback paths bypassing typed-memory validation.
4. **Self-healing orchestrator on corrupt substrate** — trigger: first self-heal tick reading BRAIN state. Mode: closed-loop corruption amplifier — the orchestrator's remediations are derived from garbage and written back.
5. **Auto-done epic false-green** — trigger: planning against "T991 done" while noise count hasn't moved. Mode: new epics inherit unverified assumption.
6. **Chat-as-memory reintroduction vector** — trigger: ingester with transcript source lacking extraction pipeline. Mode: raw chat inflates noise, defeats tiered layer.

**Verdict from this lens:** All six failure modes fire on the *next* Tier-2 tick, not on a future scale threshold. The failure domain is today, with the current 2440/45 baseline.

**Single sharpest point:** Any intervention adding new autonomous write paths (STDP, self-healing, 14 verbs) before T1134 closes and 2440 noise is quarantined will amplify corruption faster than it heals — "never-forget" becomes "never-forget-the-garbage."

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- Owner Memory Philosophy (MEMORY.md:106) — user-need atoms.
- T1134 — write contract open; implemented but unproven.
- T1107 blocked — reads unreachable.
- MEMORY.md:67 — substrate corrupted at rest.
- T1151 — proposed autonomy on unverified substrate.

**Atomic truths (independent of the artifact):**
1. A memory system that retains noise is not memory — it is a landfill. Signal density is the only metric; volume is liability.
2. "Never forget" is meaningless without "never confuse." Persistence without discrimination is amnesia by dilution.
3. Every write is a commitment. Unbounded writes with no compaction guarantee thermodynamic collapse.
4. Plasticity strengthens *used* things. Use-based decay cannot fix a polluted store — pruning must be orthogonal to reinforcement.
5. A broken ingester is worse than no ingester: it writes confidently-wrong data downstream consumers trust. Fix ingest *quality* before scaling *volume*.
6. Self-healing on corrupt substrate amplifies corruption. Autonomy gates on integrity, not the reverse.
7. Blocked verbs wiring = hands that cannot reach. Unblocking motor before perception = confident wrong action.
8. Typed memory is the minimum precondition for automated pruning.
9. Instrumentation is the precondition for knowing whether any intervention worked.
10. Correct order under crisis: stop bleed → triage → typed intake → instrument → plasticity → autonomy.

**Reconstructed solution (from atoms, before reading the plan):**
Leverage = (impact) / (cost) × (unblocks). By atoms 5–6–10: T1151 on 2440-noise substrate violates atom 6. T1107 unblock without ingester repair violates atom 7. Plasticity on polluted store violates atom 4. The critical path is: fix ingester (T1134) → typed-memory discrimination → instrument → then plasticity → then verbs → then self-healing.

**Reconstruction vs. the proposed plan:**
- Convergences: T1134 and T1107 already flagged critical.
- Divergences: T1151 held as peer to T1107+T1134 — **genuine error** (atoms 3–4). STDP queued after Hebbian — **genuine error** (atom 3: plasticity over noise strengthens noise). Memory-depth vs sentience-depth framing — **genuine error** (both depend on same precondition).

**Verdict from this lens:** The plan's task graph has the right atoms but its priorities treat substrate repair and integration/autonomy as peers, when atoms 1–4 force strict ordering.

**Single sharpest point:** Prove T1134 (close testsPassed + qaPassed), sweep the 2440, instrument the pipe — then earn the right to talk about sentience.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- MEMORY.md:66 — Hebbian at brain-lifecycle.ts:911 is a metering engine bound to one substrate; 4 others already produce edges.
- MEMORY.md:20 + T1151 — ingester→propose→accept/reject loop is a supervised-labeling machine; labels discarded.
- T1107 + T1134 + T1151 — three pending/blocked items share a write-path seam.
- MEMORY.md:67 — 2440 "junk" is the negative-class training corpus no one is harvesting.

**Findings (opportunities, from my frame only):**

1. **Fuse T1107 + T1134 (tests/QA) + T1151 into single shipping wave.** Unblock 14 verbs and wire Sentient Self-Healing in the same PR that closes T1134's remaining gates. Asymmetry: marginal cost of fusing these is lowest it will ever be — T991/T1000/T1008 foundation is paid for.
2. **Leverage multiplier claimed 8×**: T1107 unblocks 14 verbs → 3 downstream epics (T-BRAIN-LIVING, Hebbian, STDP) activate.
3. **Directive-density**: Fusion advances ~5 of the 14 Owner Memory Philosophy directives (tiered, typed, ground-truth promotion, extraction pipeline, instrumentation) in one wave.

**Verdict from this lens:** The plan is sized as "fix BRAIN dedup + ship STDP." The biggest version is "persistent-never-forget substrate ships the moment verbs are live — everything else is downstream addition."

**Single sharpest point:** Spawn T1107 as the immediate next wave with T1134 tests+QA and T1151 orchestrator wiring as parallel siblings under a fused epic — the keystone that converts shipped foundation into 5-substrate living graph.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- MEMORY.md:67 — "CRITICAL NEXT SESSION: 2440 noise patterns"
- MEMORY.md:20 — T991 + T1000 listed as "auto-done"
- T1134 — impl gate closed via commit abf1dabdb; tests+QA still open
- T1107 — blocked/critical
- MEMORY.md:66 cites `packages/core/src/brain/brain-lifecycle.ts:911`; file actually at `packages/core/src/memory/brain-lifecycle.ts`, line 911 inside quality-recompute code, not obviously a Hebbian call site.

**Findings (from a stranger's eyes only):**
1. **Claim/reality gap on "BRAIN Integrity Crisis."** MEMORY.md:67 names crisis CRITICAL NEXT SESSION; MEMORY.md:20 (nine lines above) lists T991 + T1000 as auto-done. Same document cannot tell whether the crisis is open, closed, or partial.
2. **"auto-done" is undefined in the artifact.** Used for the two load-bearing BRAIN-integrity epics without definition in the memory-of-record.
3. **Sentient Tier-2 shipped while ingester has open column bug.** MEMORY.md:20 claims T1008 (3 ingesters) shipped; evidence item 6 shows `brain-ingester.ts` tests+QA open post-commit abf1dabdb.
4. **Hebbian citation points at wrong path.** MEMORY.md:66 `brain/brain-lifecycle.ts:911` does not resolve; actual file under `memory/`, line 911 is quality-recompute, not obviously Hebbian.

**What the artifact claims vs. shows:**
Narrative claims BRAIN integrity + Tier-2 ingesters + Hebbian shipped. Artifacts show: integrity flagged CRITICAL in same doc; ingester tests/QA open; Hebbian citation misroutes.

**Verdict from this lens:** A stranger concludes the memory artifact cannot be trusted as a status ledger for its own subject matter: a memory system whose own memory file contradicts itself about whether the memory-integrity crisis is resolved.

**Single sharpest point:** Same file says BRAIN integrity crisis is critical next priority AND that the two epics built to fix it are already done — insiders have stopped noticing their memory-of-record about the memory system is internally inconsistent.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `cleo show T1134` (verified): status=pending, gates={implemented:true, testsPassed:false, qaPassed:false}, commit=abf1dabdb reachable.
- `packages/core/src/sentient/ingesters/brain-ingester.ts:83` (verified via Read): `SELECT id, title, narrative, citation_count, quality_score` — fix already in tree.

**The action (one):**
Close T1134 evidence gates — zero new code, zero new files. Only attestation missing.
```
pnpm --filter @cleocode/core exec vitest run packages/core/src/sentient/__tests__/brain-ingester.test.ts --reporter=json --outputFile=/tmp/t1134-vitest.json
pnpm biome ci . && pnpm run build
cleo verify T1134 --gate testsPassed --evidence "test-run:/tmp/t1134-vitest.json"
cleo verify T1134 --gate qaPassed --evidence "tool:biome;tool:tsc"
cleo show T1134
cleo complete T1134
cleo memory observe "T1134 closed: brain-ingester SELECT narrative matches brain_observations schema" --title "T1134 verified"
```

**Expected outcome (60 minutes from now):**
T1134 gates testsPassed + qaPassed close with programmatic evidence; `cleo complete T1134` exits 0; memory observation recorded.

**What this unblocks:**
Sentient ingester path formally trusted; T1107 unblock work and BRAIN integrity sweepers re-runnable against a proven write-path.

**Verdict from this lens:** Persistent-memory vision is gated by one open-gate close. Everything larger (STDP, dedup, T1151, T1107-unblock) depends on a trustworthy BRAIN read path. T1134 is the one open-gate blocker on that path.

**Single sharpest point:** Close T1134 evidence gates — zero new code, only attestation missing. Textbook highest-leverage-in-60-minutes.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — strongest atom "plasticity strengthens *used* things → use-based decay can't fix polluted store" carries subject + predicate + condition. Sequencing atom (10) is ordered and concrete.
- G2 Evidence grounding: PASS — each atom maps to pack item (T1134 gates, 2440 noise, STDP/Hebbian, T-BRAIN-LIVING deferred). No free-floating claims.
- G3 Frame integrity: PASS — atoms are constraint-shaped, not runtime-failure-shaped. No trespass into my lane (no "will cascade at 3am").
- G4 Actionability: PASS — "Close T1134 fully, then one-shot typed-classification + dedup sweep" is a gated, testable instruction with explicit falsification branch.

**Strongest finding (from reviewee):** "Self-healing on corrupt substrate amplifies corruption" — the atom that forecloses T1139/T1140-style optimism.

**Gap from Contrarian's frame:** The reviewee treats the "one-shot sweep over 2440 entries" as safe — but it is itself an unbounded write event against atoms (3) and (6). Failure mode: sweep classifier mislabels a class, commits in single transaction, 2440 becomes 800 *wrong* entries with higher confidence — silent failure, because downstream plasticity strengthens the misclassifications. No rollback path, no dry-run / shadow-write / sampling-validation gate, no idempotency guarantee named.

**What I would add:** The sweep must run shadow-write (classify → `brain_v2_candidate` table, not live BRAIN) with a human-sampled validation set (100 stratified entries) passing before cutover — otherwise atom (6) applies to the sweep itself.

**Disposition:** Modify — atoms and ordering are right, but the remediating action inherits the exact failure class the atoms warn against.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: FAIL — strongest "T1107 unblocks 14 verbs → 3 downstream epics activate" has subject + predicate. Weakest: "~5/14 directives" signals the number is sketched; "10%/tick × 7 ticks = ~52%" compounds multiplicatively without naming tick semantics, decay model, or dedup rate. Asymmetry numbers stated with precision they do not possess.
- G2 Evidence grounding: FAIL — task IDs map to the pack, but the asymmetry math ("8× leverage", "O(log n) passes", "52% clearance", "~5/14 directives") cites no artifact. Inferred arithmetic, not grounded telemetry. An 8× leverage claim requires a measured baseline; none cited.
- G3 Frame integrity: PASS — names an opportunity the plan isn't attempting; no risks, atoms, stranger-observations, or actions. Lane: clean.
- G4 Actionability: PASS — "Spawn T1107 as immediate next wave with T1134 tests+QA and T1151 orchestrator wiring as parallel siblings" is an executable decision.

**Strongest finding (from reviewee):** "Foundation paid for" — marginal cost of T1107+T1151 is lowest it will ever be because T991/T1000/T1008 already shipped. Real compounding argument.

**Gap from First Principles' frame:** The reviewee never asks whether the atoms beneath "5-substrate living graph" are actually true. A user needs durable recall + retrieval-under-ambiguity + decay + provenance — none of these require 5 substrates. Also: "self-healing converges in O(log n)" assumes convergence; the atom "garbage collection converges iff generator rate < clear rate" is not established. If new noise outpaces 10%/tick, backlog never drains.

**What I would add:** Derive the minimum substrate count from user-need atoms; cut any substrate not required. Asymmetry may be larger if scope is smaller, not bigger.

**Disposition:** Modify — opportunity is real and timing argument holds, but asymmetry numbers are fabricated arithmetic dressed as leverage.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — sharpest names MEMORY.md lines 20 + 67 + concrete path mismatch on brain-lifecycle.ts with line number.
- G2 Evidence grounding: PASS — every finding cites MEMORY.md line numbers or commit SHA in the pack.
- G3 Frame integrity: PASS — all four findings read directly off the artifact. Finding 2 (undefined "auto-done") is textbook Outsider move.
- G4 Actionability: PASS — sharpest point cashes out: "is T991/T1000 closed or is the crisis open?" — testable line of inquiry.

**Strongest finding (from reviewee):** MEMORY.md simultaneously claims BRAIN Integrity Crisis is CRITICAL NEXT SESSION and that T991 + T1000 are auto-done — memory-of-record is internally inconsistent.

**Gap from Expansionist's frame:** Outsider flagged the contradiction but stopped at "insiders stopped noticing." That contradiction is a **latent asset**: MEMORY.md is canonical project memory, and the same inconsistency-detection the stranger performed manually is a **product surface** CLEO doesn't ship. BRAIN's logs (`verifyAndStore`, promotion, quality recompute) already have the pipeline to flag contradictions. Wiring a `cleo memory doctor` command is single-digit hours and makes every future MEMORY.md drift self-reporting.

**What I would add:** The four gaps are not four bugs — they are four training examples for a `cleo memory doctor` command that runs the stranger-test on every `session end`, turning Outsider-style audits into a shippable BRAIN capability.

**Disposition:** Accept — cold-read is clean, findings artifact-anchored, sharpest point is exactly the insider-blindness this frame surfaces.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — action names exact commands, task ID, file paths, evidence atoms. Expected outcome is binary-testable.
- G2 Evidence grounding: PASS — (Outsider independently verified via Bash/Read): `cleo show T1134` shows `gates:{implemented:true,testsPassed:false,qaPassed:false}`, `brain-ingester.test.ts` exists at cited path (5184 bytes), commit `abf1dabdb` resolves, line 83 reads `SELECT id, title, narrative, citation_count, quality_score`. Pre-action verification discharged per executor.md's new hard rule.
- G3 Frame integrity: PASS — one action chain, no risk enumeration, no atomic reasoning, no opportunity-hunting, no naïve observations. Stays in lane.
- G4 Actionability: PASS — copy-pasteable, startable in under 60 seconds, unambiguous success criterion (`cleo complete T1134` exits 0).

**Strongest finding (from reviewee):** "Close T1134 evidence gates — zero new code, only attestation missing." A stranger reading only `cleo show T1134` sees the same thing: fix is landed, gates are the only open surface.

**Gap from Outsider's frame:** The evidence block shows `capturedBy:"unknown"` on 2026-04-21; today is 2026-04-23. A stranger asks "why was `implemented` captured two days ago but never followed through?" The action presumes the staleness window hasn't invalidated existing `implemented` evidence. `cleo complete` re-validates hard atoms; if any file sha256 drifted (e.g., unrelated edit), the chain stalls at `E_EVIDENCE_STALE` on the `implemented` gate — not on the two the Executor is closing.

**What I would add:** Prepend `cleo verify T1134 --gate implemented --evidence "commit:abf1dabdb;files:packages/core/src/sentient/ingesters/brain-ingester.ts,packages/core/src/sentient/__tests__/brain-ingester.test.ts"` to refresh 2-day-old evidence before the two new gate writes.

**Disposition:** Modify — action is correct, verified against artifacts, startable now; only change is one-line prepend to insulate against staleness failure.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — all six findings follow `trigger → mode` shape; "all 6 fire on next Tier-2 tick" summary removes hedging.
- G2 Evidence grounding: FAIL — findings cite T1134, T1107, T1151, T991, T1000, 2440 noise as anchors, but those are task IDs and headline numbers, not file:line / commit / symbol citations. Findings 4 and 6 cite only task IDs with no source artifact.
- G3 Frame integrity: PASS — every finding names runtime/over-time failure with trigger. Finding 5 sits on edge of Outsider territory but framed as future planning failure, keeping it in lane.
- G4 Actionability: FAIL — verdict "any intervention will amplify corruption" cashes out to implicit "don't ship." No quoted line names a gate to close, task to freeze, or test to run in next 60 minutes. "Quarantine 2440" is gestured at but never operationalized — no target file, mechanism, or closure criterion. An Executor cannot start in 60 seconds without making 3+ additional decisions (which ingester to freeze, what "quarantine" means, which of T1134/T1107/T1151 to act on first).

**Strongest finding (from reviewee):** Hebbian-without-dedup runaway — specific algorithm (Hebbian strengthener shipped) × specific state (no dedup, 2440 duplicates) = specific runtime outcome (noise promoted to canon). Trigger fires on normal operation, not edge cases.

**Gap from Executor's frame:** The analysis stops at "the next tick corrupts things" without naming *which tick, in which process, writing to which table*. If all 6 fire on "next Tier-2 tick," the 60-minute action is obvious — disable Tier-2 proposer or Hebbian strengthener write path until T1134 closes. "Freeze Tier-2" vs "freeze Hebbian" vs "freeze ingesters" are three different killswitches with three different blast radii; Contrarian conflates them.

**What I would add:** Name the single write path whose disablement most reduces P(corruption amplification) on next tick — Hebbian strengthener at brain-lifecycle.ts:911 running without dedup is the load-bearing failure mode; gating *that one call* behind a T1134-closed flag is the surgical mitigation.

**Disposition:** Modify — diagnosis sound, failure modes well-shaped, but needs concrete source citations (G2) and one write-path target (G4).

## Phase 2.5 — Convergence check

Extracted five "single sharpest point" statements:
1. Contrarian: "Any intervention adding autonomous write paths before T1134 + 2440 quarantine amplifies corruption faster than it heals on next tick."
2. First Principles: "Prove T1134, sweep 2440, instrument pipe — then earn right to talk about sentience."
3. Expansionist: "Fuse T1107 + T1134 tests/QA + T1151 into single wave — persistent-never-forget ships when verbs go live."
4. Outsider: "Same file says crisis is CRITICAL and T991/T1000 are auto-done — memory-of-record internally inconsistent."
5. Executor: "Close T1134 evidence gates — zero new code, only attestation missing."

**Pairwise analysis:** Three advisors touch T1134 but through categorically different predicates:
- Contrarian: "don't ship anything autonomous until T1134"
- First Principles: "close T1134 THEN sweep THEN earn autonomy in ordered steps"
- Executor: "close T1134 gates today, in 60 minutes"
- Expansionist: "fuse T1134 WITH T1107+T1151 into one wave" (contradicts Contrarian's gating)
- Outsider: bookkeeping-layer observation, categorically distinct

Three positions on "what to do about T1134" (gate everything / sequence after / fuse with others) + two categorically distinct findings. Not semantically convergent. No flag. Proceed to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Disposition |
|---|---|---|---|---|---|
| Contrarian       | PASS | FAIL | PASS | FAIL | Modify |
| First Principles | PASS | PASS | PASS | PASS | Modify |
| Expansionist     | FAIL | FAIL | PASS | PASS | Modify |
| Outsider         | PASS | PASS | PASS | PASS | Accept |
| Executor         | PASS | PASS | PASS | PASS | Modify |

Convergence check: no collapse. Five semantically distinct positions retained.

### Recommendation

**Close T1134's remaining gates (testsPassed + qaPassed) as the single surgical act this session — and use that closure as the frozen write-path behind which the 2440-entry sweep, instrumentation, and T1107/T1151 activation are sequenced.**

T1134 is the switch. It is not glamorous. It is also the only intervention where all five advisors' sharpest points are simultaneously honored without contradiction.

### Why this, not the alternatives

The contested points reconcile cleanly once T1134's role is seen correctly — it is not a task, it is the **write-path freeze-point**:

- **Not "ship T1107/T1151 now" (Expansionist's fuse-the-wave)**: Expansionist's asymmetry math failed G1/G2 peer review. More importantly, activating 14 Living Brain verbs or a self-healing orchestrator on a substrate with 2440 noise entries, no dedup, and an open `implemented`-only gate is exactly Contrarian's 6-failure-mode scenario firing on the next tick. The foundation is paid for, but the foundation is also contaminated. You don't pour the second floor on a cracked slab to save on concrete trucks.

- **Not "sweep the 2440 first" (First Principles' order)**: First Principles had the cleanest frame but peer review flagged the missing rollback envelope. A sweep without a frozen, tested, QA'd write-path is an unbounded write on corrupt data — it can't distinguish signal from noise because the ingest gate hasn't passed its own tests yet. Sweep comes *after* T1134 closes, not before.

- **Not "don't ship" (Contrarian's position as written)**: Peer review failed this on G4 — it names the danger but not the switch to flip. The switch *is* T1134. Contrarian's contribution is absorbed as the reason for urgency, not as a competing action.

- **Not "note the doc contradiction" (Outsider alone)**: Accepted in full, but an observation is not an intervention. Its value here is **procedural**: Outsider's prepend-re-verify instruction is what prevents the next 60 minutes from failing on `E_EVIDENCE_STALE`.

- **Yes, Executor's action — with Outsider's prepend**: Executor passed all gates. The only peer-review modification (re-verify `implemented` before closing the other two) is a 30-second insurance premium against a 2-day-old commit triggering staleness rejection at `cleo complete`.

The meta-point: the team's own memory-of-record says "BRAIN Integrity Crisis: CRITICAL NEXT SESSION" while simultaneously marking T991/T1000 auto-done. That contradiction is itself evidence that *nothing downstream of T1134 should go live until the ingest gate is provably closed*. Fix the one switch that freezes the write-path; everything else sequences from there.

### What each advisor got right

- **Contrarian**: The 6 failure modes are not hypothetical — they fire on the next Tier-2 tick against today's 2440/45 baseline, and that urgency is why T1134 cannot wait.
- **First Principles**: The correct dependency order is stop-bleed → triage → typed intake → instrument → plasticity → autonomy; T1134 is literally the "stop-bleed" step.
- **Expansionist**: The marginal cost of closing T1134 is at its all-time low because T991/T1000/T1008 already paid the foundation cost — this is the cheapest possible moment to act.
- **Outsider**: MEMORY.md is internally contradictory about its own crisis state, and insiders have stopped noticing; re-verify before complete, or the doc's staleness becomes your error envelope.
- **Executor**: Zero new code, zero new files — only attestation is missing; the path is `vitest → biome+build → cleo verify --evidence → cleo complete → cleo memory observe`.

### Conditions on the recommendation

1. **Prepend re-verification of `implemented` gate** before closing the other two (Outsider's peer-review addition) to avoid `E_EVIDENCE_STALE` on the 2-day-old `abf1dabdb` commit.
2. **Do not touch T1107 or T1151 in the same session.** Wave-fusion is explicitly rejected until T1134 closes clean.
3. **Do not start the 2440-entry sweep in the same session.** Sweep requires a shadow-write envelope (`brain_v2_candidate` + 100-entry stratified human validation) per Contrarian→First Principles peer addition — that is the *next* session's work, not this one's.
4. **Run the stranger-test artifact afterward.** File a follow-up task for `cleo memory doctor` (Expansionist→Outsider peer addition) to auto-run on `session end` — this is how the doc-contradiction problem stops recurring.
5. **If any gate fails** (tests red, biome red, tsc red, staleness): do NOT use `CLEO_OWNER_OVERRIDE`. Fix the root cause. This is the freeze-point; bypass defeats the entire intervention.

### Next 60-minute action

Run, in order, from `/mnt/projects/cleocode`:

```bash
# 0. Refresh implemented gate against the 2-day-old commit (Outsider prepend)
cleo verify T1134 --gate implemented \
  --evidence "commit:abf1dabdb;files:packages/core/src/sentient/ingesters/brain-ingester.ts,packages/core/src/sentient/__tests__/brain-ingester.test.ts"

# 1. Run tests for brain-ingester and capture evidence
pnpm --filter @cleocode/core exec vitest run \
  packages/core/src/sentient/__tests__/brain-ingester.test.ts \
  --reporter=json --outputFile=/tmp/t1134-vitest.json
cleo verify T1134 --gate testsPassed --evidence "test-run:/tmp/t1134-vitest.json"

# 2. Run QA gates and capture evidence
pnpm biome ci . && pnpm run build
cleo verify T1134 --gate qaPassed --evidence "tool:biome;tool:tsc"

# 3. Close the task
cleo complete T1134

# 4. Record the learning
cleo memory observe "T1134 write-path frozen: brain-ingester text-vs-narrative gate closed before T1107/T1151/2440-sweep — prevents 6-failure-mode cascade on next Tier-2 tick" \
  --title "T1134 freeze-point closure"
```

### Confidence

**High.**

What would lower it:
- If `pnpm vitest` on `brain-ingester.test.ts` reveals the `implemented` evidence at `abf1dabdb` did not actually wire the narrative-gate code paths the tests expect (i.e., the commit is structurally incomplete, not just unverified). In that case, the recommendation becomes "reopen T1134 scope" rather than "close its gates," and First Principles' order-of-operations takes precedence over Executor's close-it-now path.
- If `cleo verify --gate implemented` rejects the re-verification, signaling schema drift in the evidence atom format since the original verify — that is itself a signal that the T991 "auto-done" state is less solid than MEMORY.md claims, and Outsider's contradiction-signal becomes load-bearing.

### Open questions for the owner

None. The path is unambiguous, the conditions are bounded, and the 60-minute action is self-contained.
