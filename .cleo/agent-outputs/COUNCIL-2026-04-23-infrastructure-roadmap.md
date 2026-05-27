# The Council — Is the v2026.4.126-.133 CLEO infrastructure roadmap complete, correctly-ordered, and free of missing substrate work?

## Evidence pack

1. `packages/core/src/orchestration/hierarchy.ts:25-80` — cleoos-opus-orchestrator PRIME with hardcoded `projectId:'cleocode'`; verifies E1 scope is real, a hardcoded dogfood persona is in the ship surface today.
2. `packages/core/src/orchestration/classify.ts:126-132` — classifier emits `agentId: 'cleo-prime'` from hardcoded PersonaEntry; confirms E1 scope independently of hierarchy.ts.
3. `packages/core/src/orchestration/spawn.ts:360` — `composeSpawnPayload` does NOT call `buildRetrievalBundle`; only `packages/core/src/sessions/briefing.ts:215` does; verifies the SDK-complete-but-not-wired gap for E3 (T1260).
4. `packages/core/src/init.ts:842-868` — seed-agent install is a pure static `copyFile()` loop with no agent-architect invocation; confirms E2 scope as D034 meta-agent wiring being stubbed.
5. `packages/agents/meta/agent-architect.cant:1-30` — declares `parent: cleo-prime`; confirms E2 has a dogfood-coupling cleanup that transitively depends on E1 completing first.
6. `docs/adr/ADR-055-agents-architecture-and-meta-agents.md` — D032 (ship surface = 4 generic templates + meta-agent; dogfood NOT shipped) + D034 (meta-agent invoked at install); E1+E2 must satisfy this contract.
7. Commit `4f4426ad9 refactor(T1257): clean-forward purge of dogfood special cases` — clean-forward policy forbidding DEPRECATED_ALIASES; anchors the constraint across all four epics.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked?

**Evidence anchored:**
- `hierarchy.ts:25-80` + `classify.ts:126-132` — two independent hardcoded cleo-prime sites create a partial-rename hazard.
- `spawn.ts:360` vs `briefing.ts:215` — memory is on the briefing path, not spawn.
- `init.ts:842-868` — no agent-architect invocation; install is static copy.
- Commit `4f4426ad9` — clean-forward policy; no DEPRECATED_ALIASES escape hatch.

**Findings:**

1. **E1 rename partial-application crash under `cleo init`** — triggers when E1 misses one of the two independent hardcoded sites. Fresh `cleo init` installs generic templates but classify.ts or hierarchy.ts still resolves spawn parents to old persona; first `cleo orchestrate spawn` produces `E_PERSONA_NOT_FOUND`. Commit 4f4426ad9 removed DEPRECATED_ALIASES so no soft-fallback. Detected silently at install, loudly at first spawn.

2. **E2-before-E3 locks in a second-version broken spawn contract.** Every agent the meta-agent mints between E2 ship and E3 ship is born with spawn contract lacking `buildRetrievalBundle`. Clean-forward policy forbids retroactive alias, so those agents' recorded provenance needs re-minting. Silent failure: spawn returns success but reasoning is strictly worse than briefing-path agents. No gate catches the quality regression.

3. **T1249 + T1250 as unsequenced "cross-cutting" is assumption-stack that kills the roadmap.** Both hit simultaneously on fresh install (tier-0 default + agent hasn't seen CLI surface); spawn prompt truncates silently because tier-0 overflow emits no error; agent executes wrong ops; writes garbage to TASKS/BRAIN. T5158 data-loss class, but on meta-minted agents.

**Verdict from this lens:** Sequencing E1→E2→E3→E4 puts non-reversible install-time behavior change (E2) upstream of spawn-payload fix (E3), so every agent minted between E2 ship and E3 ship carries a worse contract than the briefing path already delivers. The "cross-cutting" bucket (T1249, T1250, T1255) explicitly not gating any epic is the operational definition of a blind spot. Not wrong in content but wrong in ordering and in what it declared non-blocking.

**Single sharpest point:** E2 (T1259) shipping before E3 (T1260) mints agents whose spawn contract lacks `buildRetrievalBundle` — and because commit `4f4426ad9` forbids back-compat shims, those agents cannot be silently upgraded later; they need re-minting, which the handoff does not plan for.

### Advisor: First Principles

**Frame:** Ignore what was said. What is actually true? Build from zero.

**Evidence anchored:**
- ADR-055 D032/D034 — canonical contract independent of today's code.
- Commit `4f4426ad9` — external clean-forward constraint.
- `spawn.ts:360` vs `briefing.ts:215` — overlay anchor for hot-path wiring claim.
- `hierarchy.ts:25-80` + `classify.ts:126-132` — overlay anchor for dogfood-in-ship-surface violation.
- `init.ts:842-868` — overlay anchor for install-time meta-agent stub.

**Atomic truths:**

1. An agent framework shipping project-specific identity as default cannot be installed cleanly by a second user; ship surface must be generic by construction.
2. Install-time composition must materialize project identity, or users inherit author's dogfood state and must undo it.
3. Dependency order is fixed by reference direction — if A names B, B must be defined before A stabilizes.
4. "Capability installed" differs from "capability wired on the hot path."
5. Substrate correctness must precede substrate consumption, or each consumer becomes an additional migration site.
6. Governance is only real if the boundary cannot be bypassed; weakest path defines the actual contract.
7. Stale task record for shipped work is bookkeeping, not substrate; reconcile but do not inflate.

**Reconstructed solution:** E1 canonical naming → E2 install-time meta-agent → E3 memory on hot path → E4 governed pipelines → PSYCHE feature waves. This matches the proposed plan spine.

**Divergences:**

- T1249 (tier-0 overflow) as "cross-cutting" is path-dependent cruft; belongs *inside* E2 or E3, not floating.
- T1250 (surface compression) must be sequenced *after* E1 or *inside* E1; else creates a second renaming wavefront colliding with E1.
- T1255 (stale rename) belongs in E1 cleanup.
- "SDK-complete ≠ wired" framing applied only to E3 is under-scoped; E4 must pass same hot-path test.
- No explicit cross-system acceptance matrix for 6 systems × 5 DBs.

**Verdict from this lens:** The four-epic sequence is well-founded and the ordering is forced by atoms 2-5; it is not arbitrary. The plan's core correctness claim — substrate before consumers, naming before composition, composition before wiring, wiring before governance — holds up against zero-based reconstruction. The weaknesses are in the floaters (T1249/T1250/T1255 need homes) and the hot-path criterion must apply uniformly to E4, not just E3.

**Single sharpest point:** A generic ship surface must precede any wiring, because every wire laid against a project-specific surface becomes a future migration — the plan honors this; the only gap is that the same truth (hot-path wiring, not nominal wiring) must be enforced uniformly across E3 AND E4, not just named in E3.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version? What opportunity is hiding in plain sight?

**Evidence anchored:**
- `init.ts:842-868` + `agent-architect.cant` — meta-agent declared but invoked nowhere; a latent producer.
- `spawn.ts:360` vs `briefing.ts:215` — retrieval bundle already shaped for one callsite; a latent primitive.
- ADR-055 D032 + commit `4f4426ad9` — clean-forward dogfood-free templates; a latent publishable artifact.

**Findings:**

1. **Meta-agent as a public product surface, not an internal install step.** Expose `cleo agent mint <spec.cant>` as first-class CLI verb backed by the same meta-agent. Every seed install becomes one invocation of a generally-callable factory. Asymmetry: wiring for E2 is already required; adding a CLI verb + `.cant` input path is hours not weeks. Converts one-shot bootstrap into on-demand synthesis primitive. Cost ~1 task; value: the .cantz packaging vision finally gets its missing producer.

2. **The E1→E4 output is 90% of a shippable `@cleocode/agents-starter` package.** Adding `pnpm pack`/publish at the end of E2 is ~2 hours; upside = every CLEO adopter and every benchmark starts from a shared versioned starter surface instead of re-deriving one. Pomodoro bench already shows CLEO narrow quality win; published starter compounds into distribution moat.

3. **E3's memory-spawn wiring is secretly a universal context-injection bus.** `buildRetrievalBundle` is already the right shape for ANY injection point (spawn, hooks, CANT runtime, CONDUIT message enrichment, sentient proposer). Once E3 establishes the spawn callsite, registering the bundle as a named injection primitive is trivial, but means the four "competing injection paths" flagged in system audit memory can converge on a single BRAIN-backed pipeline. One small refactor replaces four divergent paths permanently.

**Verdict from this lens:** The plan is correctly-ordered for what it's trying to do — but it's framing four epics as infrastructure hygiene when the same work slightly re-shaped produces three independently valuable platform surfaces (agent factory, starter package, universal injection bus). The roadmap is too small by one conceptual layer: it thinks it's cleaning up before PSYCHE, when it's actually building the substrate future benchmarks and adopters run on.

**Single sharpest point:** Treat the E1→E2 output as `@cleocode/agents-starter` and the agent-architect wiring as a public `cleo agent mint` verb — the same ~5 extra hours turns 'internal cleanup' into the first shippable piece of the CleoOS Agent Platform vision that's been sitting in memory for 15 days without a producer.

### Advisor: Outsider

**Frame:** No context. Ignore all backstory. Read what's in front of you. What would a stranger conclude?

**Evidence anchored:**
- `NEXT-SESSION-HANDOFF.md:1` title "v2026.4.125 SHIPPED" vs line 6 TL;DR "v2026.4.121 is SHIPPED".
- `NEXT-SESSION-HANDOFF.md:41-74` "What shipped" describes .121; lines 66-74 quality gates 11,177 pass vs line 228 11,180 pass.
- `NEXT-SESSION-HANDOFF.md:107` T1258 "no dependencies" vs line 240 "direct continuation of T1257" vs line 195 "clean up T1255 before E1".
- `NEXT-SESSION-HANDOFF.md:156-187` roadmap table + ASCII graph — no system taxonomy names (TASKS/LOOM/BRAIN/NEXUS/CANT/CONDUIT absent).
- Cross-check against evidence pack item 3 (`spawn.ts:360` vs `briefing.ts:215`) corroborates line 109 "SDK-complete ≠ wired".

**Findings:**

1. **Title/body version disagreement.** File titled `v2026.4.125 SHIPPED`; TL;DR opens with `v2026.4.121 is SHIPPED`. The canonical "What shipped" narrative and quality-gate block describe .121. A stranger cannot tell if 11,177-pass or 11,180-pass is current.

2. **T1258 dependency status self-contradictory within one document.** Three mutually exclusive claims: "No dependencies" (line 107), "direct continuation of T1257" (line 240), "clean up T1255 before E1 starts" (line 195). Roadmap table line 158 is a dash.

3. **Roadmap framed as spanning 6 systems and 5 databases but roadmap table doesn't name them.** Forward table drops the TASKS/LOOM/BRAIN/NEXUS/CANT/CONDUIT taxonomy the rest of the document uses. LOOM especially is never mentioned in the forward plan.

4. **"SDK-complete ≠ wired" presented as general lesson but applied to only one surface.** T1260 addresses spawn for Waves 1-4. Document doesn't show the grep was performed for Wave 9 CONDUIT, NEXUS profile ops, or the 22 A2A tests' runtime consumers.

**Verdict from this lens:** A thoughtful stranger would read this as a handoff note written during a working session rather than after one — the TL;DR and appendices describe different ship states, and the forward roadmap's confidence ("No dependencies," "parallel-safe," "v2026.5.0 consolidation") is not reconciled against the same document's unresolved items (T1255 stale, T1249 active crash risk, T1250 META-and-unscheduled, E1 scope in flux). The plan may be correct; the artifact does not let a stranger verify that from the artifact alone.

**Single sharpest point:** The file is titled `v2026.4.125 SHIPPED` and the body still walks the reader through `v2026.4.121` as if it were today's release — the clearest signal a stranger has that this document is being used as a running log, not as the forward-plan artifact the roadmap section asks it to be.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. Give me exactly one action I can start in the next hour.

**Evidence anchored:**
- `spawn.ts:360` (0 `buildRetrievalBundle` matches) vs `briefing.ts:215` (1 match, awaited) — the asymmetry underlying the entire E3/T1260 epic.
- Existing Vitest harness under `packages/core/src/orchestration/__tests__/` — confirms a new test is writable today with no new infrastructure.

**The action (one):** First: `grep -n "buildRetrievalBundle\|composeSpawnPayload" packages/core/src/sessions/briefing.ts packages/core/src/orchestration/spawn.ts` to resolve symbol names. Then author `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` with one `describe('composeSpawnPayload memory parity')` containing one `it('includes a retrievalBundle for the same task that briefing resolves')` that (a) seeds a minimal in-memory task + one BRAIN observation via existing test helpers, (b) calls `composeSpawnPayload({ taskId })` and the briefing-path retrieval on the same store, (c) asserts `spawnResult.retrievalBundle` is defined AND structurally equal on `items[].id` + `items[].type`. Run `pnpm --filter @cleocode/core test -- spawn-retrieval-parity`. Do NOT modify spawn.ts — the test must fail red.

**Expected outcome (60 minutes from now):** A named, committed, red test pinning T1260's scope — `pnpm --filter @cleocode/core test -- spawn-retrieval-parity` exits non-zero with an assertion failure on `retrievalBundle`.

**What this unblocks:** T1260 (E3 memory-spawn wiring) gains a machine-checked acceptance gate and a reproducible red→green target. The next worker is spawned against a concrete artifact instead of a prose claim. Simultaneously validates the handoff's E3 sequencing premise is real before the orchestrator commits T1258→T1259→T1260→T1261 ordering.

**Verdict from this lens:** The roadmap's load-bearing assumption ("spawn lacks memory wiring") is currently only narrated; action-only frame says convert it to a red test in the next hour so the sequencing decision rests on a committed artifact, not a handoff paragraph.

**Single sharpest point:** Write and commit a failing `spawn-retrieval-parity.test.ts` that asserts `composeSpawnPayload` emits the same retrievalBundle as the briefing retrieval path for an identical taskId — pinning T1260 to a red gate before any further sequencing.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**

- G1 Rigor: FAIL — strongest atom (atom 1, "ship surface must be generic by construction") is well-specified, but atom 4 ("capability installed ≠ capability wired on the hot path") is an artifact-derived heuristic, not a world-constraint; First Principles persona requires atoms to hold "even if the codebase vanished tomorrow" and atom 4 fails that test.
- G2 Evidence grounding: PASS — cited items (ADR-055 D032/D034; commit 4f4426ad9; spawn.ts:360 vs briefing.ts:215; hierarchy.ts:25-80 + classify.ts:126-132; init.ts:842-868) all appear in the pack; divergences are pinned to T-IDs that correspond to plan content.
- G3 Frame integrity: FAIL — divergence "T1250 creates a second renaming wavefront" uses runtime-race framing ("wavefront" is concurrency/ordering/races), which is Contrarian lane per persona; should have been classified as an atom-3 violation (reference-direction ordering), not a runtime wavefront.
- G4 Actionability: PASS — "hot-path wiring must be enforced uniformly across E3 AND E4" cashes out to a concrete acceptance criterion the owner can add before signing off.

**Strongest finding (from reviewee):** No explicit cross-system acceptance matrix for 6 systems × 5 DBs — a plan claiming 6 systems without a 6×5 matrix has 30 uncovered cells where substrate gaps hide, and the absence is provable from the plan text itself.

**Gap from Contrarian's frame:** First Principles validated E1→E2→E3→E4 as atom-forced but never asked what fails *during* the sequence. E1 renaming `cleo-prime` in hierarchy.ts while T1008 sentient Tier-2 proposals are live (per memory: shipped v2026.4.98) → Tier-2 proposals generated mid-E1 reference the old `cleo-prime` string in persisted rows; post-rename `sentient propose accept <id>` fails to resolve the parent agent, silently dropping the proposal or wedging the ingester. Atom 3 holds in static analysis but is blind to this live-data migration hazard.

**What I would add:** E1 must ship with a dual-read/dual-write shim for the 2-week window where persisted rows in sentient proposals, conduit messages, and tasks.db parent pointers still carry the old identity string — without it, the plan's atom-forced ordering creates a silent-correctness failure mode at exactly the substrate layer it claims to protect.

**Disposition:** Modify — the four-epic sequence is well-reconstructed but atom 4 is artifact-derived (G1 breach) and the T1250 divergence is Contrarian-lane (G3 breach); fix by removing atom 4 or reframing as external constraint and reclassifying T1250 as an atom-3 violation rather than a "wavefront."

### First Principles reviewing Expansionist

**Gate results:**

- G1 Rigor: PASS — each finding has named subject, predicate, and quantified asymmetry (Finding 1: "hours not weeks, 1 task cost"; Finding 2: "~2 hours, `pnpm pack`/publish"; Finding 3: "four divergent paths replaced permanently by one refactor").
- G2 Evidence grounding: PASS — all four findings trace to pack items (init.ts:842-868 for Finding 1 meta-agent-never-invoked; agent-architect.cant for Finding 1 meta-agent-declared; spawn.ts:360 vs briefing.ts:215 for Finding 3 injection-bus; ADR-055 D032 + commit 4f4426ad9 for Finding 2 clean-forward-dogfood-free-templates).
- G3 Frame integrity: PASS — Finding 1 names latent asset (meta-agent → public verb); Finding 2 names platform effect (distribution moat); Finding 3 names asymmetric extensibility (one callsite → N callsites). None describe risks, correctness errors, or prescribed actions.
- G4 Actionability: PASS — "Treat E1→E2 output as `@cleocode/agents-starter` and agent-architect wiring as public `cleo agent mint`" cashes out to two concrete scope additions measurable against the existing E1-E4 plan.

**Strongest finding (from reviewee):** E3's memory-spawn wiring is secretly a universal context-injection bus — `buildRetrievalBundle` is already the right shape for ANY injection point (spawn, hooks, CANT runtime, CONDUIT enrichment, sentient proposer), and the four "competing injection paths" from system audit memory can converge on a single BRAIN-backed pipeline.

**Gap from First Principles' frame:** The Expansionist treats `cleo agent mint` as automatically valuable because the `.cantz` vision has been in memory 15 days. From atoms, that's not load-bearing. The atomic truth is narrower: a system instantiating agents from declarative specs needs exactly ONE code path to do so. T1259 already requires that code path; exposing it as a verb is a packaging choice, not an atomic requirement. Finding 2 (starter package) is pure distribution strategy — no atom forces it. Only Finding 3 survives atomic reduction, because injection-point unification follows from the atom "identity-scoped context resolution is one function, not four."

**What I would add:** From atoms: only Finding 3 is a *correctness* win (reduces four paths to one) — Findings 1 and 2 add surface area without reducing what can be wrong, while Finding 3 strengthens the plan rather than decorating it.

**Disposition:** Modify — Accept Finding 3 into the roadmap as an E3 scope sharpener (converge injection paths on the retrieval bundle primitive); treat Findings 1 and 2 as separate product bets that should not ride on the T1258-T1261 substrate epics.

### Expansionist reviewing Outsider

**Gate results:**

- G1 Rigor: PASS — every finding names subject (specific lines/claims in handoff), predicate (the contradiction), and anchor (quoted text vs quoted text); e.g., "File titled v2026.4.125 SHIPPED; body walks reader through v2026.4.121" is fully specified.
- G2 Evidence grounding: PASS — all cited items anchor to artifact text (lines 1, 6, 41-74, 104, 107, 109, 114, 120, 151-154, 156-166, 170-187, 195, 199, 203-228, 240) plus cross-reference to spawn.ts/briefing.ts (pack item 3).
- G3 Frame integrity: PASS — all four findings stay in claim-vs-reality-gap lane; no opportunity-naming, no atomic-truth reasoning, no runtime prediction, no action prescription.
- G4 Actionability: PASS — verdict cashes out to a concrete line of inquiry: "rewrite the artifact so forward-plan and ship-log are separable, or don't ship the roadmap off this document."

**Strongest finding (from reviewee):** The file is titled `v2026.4.125 SHIPPED` and the body still walks the reader through `v2026.4.121` as if it were today's release — the clearest signal that insiders have stopped noticing the four-version gap is that the document is being used as a running log, not as the forward-plan artifact the roadmap section asks it to be.

**Gap from Expansionist's frame:** Outsider correctly identifies the handoff as running log masquerading as forward-plan, but stops at diagnosis. The asymmetric opportunity hiding: the handoff's "flaw" is a latent asset — a timestamped, append-only, per-session narrative of how T1258's scope discovered itself across three patch releases in one day. That's exhaust data of how CLEO's own orchestration substrate reveals gaps. Captured as a first-class artifact type (`.cleo/session-journals/*.jsonl` auto-promoted from handoff drafts), every future session produces a teaching corpus for the meta-agent referenced in ADR-055 D034.

**What I would add:** The contradiction between TL;DR and appendices isn't a hygiene problem to fix — it's the first-draft form of a session-journal substrate that, formalized, becomes the 7th system (journaling the other 6) and the richest training corpus for the meta-agent architect.

**Disposition:** Accept — the cold-read is clean, grounded, and frame-pure; the stranger's diagnosis stands on its own and the opportunity I surfaced is additive, not corrective.

### Outsider reviewing Executor

**Gate results:**

- G1 Rigor: PASS — action names specific file path (`packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts`), specific describe/it pair, three labeled assertion steps (a/b/c), concrete runnable command, and named expected failure.
- G2 Evidence grounding: FAIL — action cites `spawn.test.ts` as "existing Vitest harness" but that file is NOT in the shared evidence pack (items 1-7 list hierarchy.ts, classify.ts, spawn.ts:360, briefing.ts:215, init.ts, agent-architect.cant, ADR-055, commit 4f4426ad9); the action also invokes `buildBriefing` — the pack names `buildRetrievalBundle` at briefing.ts:215, not `buildBriefing`.
- G3 Frame integrity: PASS — output stays in Executor lane: one action, startable now, single expected outcome, one "unblocks" sentence; does not enumerate risks, debate roadmap correctness, spot upside, or merely observe.
- G4 Actionability: PASS — a reader can begin typing within 60 seconds; success criterion is a named red test.

**Strongest finding (from reviewee):** The roadmap's load-bearing assumption ("spawn lacks memory wiring") is currently only narrated; action-only frame says convert it to a red test in the next hour so sequencing rests on a committed artifact, not a handoff paragraph.

**Gap from Outsider's frame:** A cold-read stranger has three ambiguities they cannot resolve from the artifact alone. (1) "Existing test helpers used by spawn.test.ts" — a stranger cannot know whether those helpers can seed a minimal task + BRAIN observation without wiring up two databases, which is not a 60-minute task if it turns out they can't. (2) The action asserts structural equality against `briefingResult.retrievalBundle`, but the pack names `buildRetrievalBundle` at briefing.ts:215, not `buildBriefing`. A stranger reading literally would import a symbol that may not exist under that name and stall at a TypeScript error. (3) The expected failure message is presented as a prediction of Vitest output, but `toEqual` on `undefined` prints a diff, not the narrated sentence.

**What I would add:** The action conflates "convert narrated claim into red test" (cheap, decisive) with "red test using right symbol names and existing helpers" (requires 5 minutes of verification the Executor skipped) — before writing the file, `grep -n "buildRetrievalBundle\|buildBriefing" packages/core/src/sessions/briefing.ts` resolves the symbol-name ambiguity that otherwise burns the hour.

**Disposition:** Modify — the shape (one red test pinning T1260) is exactly right and frame-clean, but the action names a symbol (`buildBriefing`) and a helper surface (`spawn.test.ts` seed utilities) asserted rather than verified against the pack.

### Executor reviewing Contrarian

**Gate results:**

- G1 Rigor: PASS — Finding 2 is the strongest, with named subject (meta-agents minted between E2 and E3), trigger condition (E2 ships before E3), concrete failure mode (missing retrieval bundle), and detection path ("silently; no one, until someone diffs briefing vs spawn outputs"); all three findings name specific trigger conditions.
- G2 Evidence grounding: PASS — Finding 1 cites hierarchy.ts:25-80 + classify.ts:126-132 + commit 4f4426ad9; Finding 2 cites spawn.ts:360 vs briefing.ts:215 + init.ts:842-868; Finding 3 references tier-0 overflow + T5158 data-loss class; all anchors trace to pack items 1-7.
- G3 Frame integrity: PASS — all three findings describe runtime-level failure modes with trigger conditions and detection paths ("fails by E_PERSONA_NOT_FOUND at first cleo orchestrate spawn"; "corruption surfaces 3-5 sessions later"); no atomic-truth framing, no opportunity-spotting, no action-prescribing, no cold-reading.
- G4 Actionability: FAIL — verdict ends at "wrong in ordering and in what it declared non-blocking" and the sharpest point is pure doom ("those agents cannot be silently upgraded by E3 later; they will need to be re-minted, which the handoff does not plan for"); names the fatal flaw but leaves zero concrete lever (no "reject unless E3 ships before E2", no "gate E2 on spawn-payload parity test", no "add re-mint task before Wave 5") — exactly the pattern the Executor→Contrarian rotation exists to catch.

**Strongest finding (from reviewee):** E2 (T1259 meta-agent install wiring) shipping before E3 (T1260 spawn-memory wiring) will mint agents into the ship surface whose spawn contract lacks `buildRetrievalBundle` — and because clean-forward policy forbids back-compat shims, those agents' recorded provenance cannot be silently upgraded by E3 later; they will need to be re-minted.

**Gap from Executor's frame:** The Contrarian named three failure modes with trigger conditions but provided zero mitigations — no test to gate E2 on, no sequencing swap, no re-mint task to file. The single 60-minute mitigation that cashes out Finding 2 is trivial and was not proposed: swap the epic order to E1→E3→E2→E4, OR add an AcceptanceGate on T1259 that asserts `composeSpawnPayload` emits a retrieval key equivalent to `buildRetrievalBundle` before T1259 is allowed to close. Either collapses the "mint broken agents" window to zero.

**What I would add:** Add a failing parity test `spawn-retrieval-parity.test.ts` that invokes both `composeSpawnPayload(taskId)` and the briefing-path retrieval for the same task and asserts structural equality of the retrieval-context keys — this test FAILS on current main, becomes the gate that blocks T1259 (E2) from closing until T1260 (E3) lands, and collapses the "mint broken agents" window to zero.

**Disposition:** Modify — findings are sound and well-grounded, but the Contrarian must append a one-line mitigation trigger (reject sequencing unless E3 ships before or alongside E2, enforced by spawn-briefing parity test) before the Chairman can carry the finding forward; otherwise this is pure doom the Executor row exists to reject.

## Phase 2.5 — Convergence check

Single sharpest points, one sentence each:

1. **Contrarian**: E2-before-E3 ordering will mint broken-spawn agents that clean-forward policy cannot patch retroactively.
2. **First Principles**: Generic ship surface must precede any wiring; the hot-path invariant must apply to E4 not just E3.
3. **Expansionist**: Reframe E1-E2 output as `@cleocode/agents-starter` + `cleo agent mint` CLI verb to ship the first piece of the CleoOS Agent Platform.
4. **Outsider**: Handoff file is a running log masquerading as a forward-plan artifact; title and body describe different ship states.
5. **Executor**: Write a failing `spawn-retrieval-parity.test.ts` in the next hour to pin T1260 to a red gate.

**Pairwise analysis:** Contrarian + First Principles + Executor all centered on the **spawn-retrieval gap** (spawn.ts:360 does not call buildRetrievalBundle) but with distinct predicates — risk/ordering (C), invariant/symmetry (FP), action/test (E). Subject overlaps but predicates differ meaningfully; per peer-review.md convergence test, these three findings are NOT the same finding with different words because the conclusions drawn (reorder vs extend-to-E4 vs write-red-test) are categorically different decisions. Expansionist (opportunity reframe) and Outsider (doc consistency) are frame-pure and distinct from all others.

**Convergence flag: NOT RAISED.** Proceed to Chairman synthesis.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | FAIL | high |
| First Principles | FAIL | PASS | FAIL | PASS | moderate |
| Expansionist     | PASS | PASS | PASS | PASS | full |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | PASS | FAIL | PASS | PASS | high |

### Recommendation

**Ship the E1→E2→E3→E4 → (W5+W6) → W7 → (W8+Sentient v1) roadmap targeting v2026.4.133 as the April terminus, with five binding modifications (M1-M5 below) applied before the first epic commit; start with the Executor's corrected 60-minute parity-test action to pin T1260.**

### Why this, not the alternatives

Three alternatives were contested. First, Contrarian's implicit "swap to E1→E3→E2→E4" would reorder to mitigate the mint-broken-agents window, but First Principles validates the current spine as atom-forced (E2 install-time composition must precede E3 hot-path wiring under atom 3 reference-direction ordering); reordering to satisfy a runtime hazard breaks an atomic dependency. The reconciliation: preserve the order but add a machine-checked gate (spawn-retrieval parity test as AcceptanceGate on T1259) that collapses the hazard window to zero without reordering. Second, Expansionist's `cleo agent mint` + `@cleocode/agents-starter` ambitions were validated by First Principles as product strategy (Findings 1, 2) rather than atom-forced substrate work; carry Finding 3 (universal context-injection bus) into E3 scope because it rests on a genuine atomic truth, and defer Findings 1-2 as independent product bets. Third, the v2026.4.133 April terminus was tested against 8 release slots for 8 bodies of work — tight but feasible with (E2, E3) and (W5-research, E4-DSL) parallelism as slack; the alternative "push to v2026.5.0" is the rational fallback on scope overrun but not on schedule.

### What each advisor got right (carried forward)

- **Contrarian's fatal flaw to mitigate:** Meta-agents minted between E2 ship and E3 ship carry a spawn contract missing `buildRetrievalBundle` — clean-forward policy forbids retroactive alias, so without a gate they need re-minting which the handoff does not plan for.
- **First Principles' atomic truth worth protecting:** A generic ship surface must precede any wiring, because every wire laid against a project-specific surface becomes a future migration — and the hot-path invariant (wired, not just declared) must apply uniformly to both E3 and E4.
- **Expansionist's upside to pursue (or defer):** Pursue Finding 3 inside E3 scope — register `buildRetrievalBundle` as a named injection primitive to converge four competing injection paths onto one BRAIN-backed pipeline; defer Findings 1-2 (`cleo agent mint`, agents-starter package) as independent product bets not on the critical path.
- **Outsider's pattern flag:** The handoff artifact itself is a running log masquerading as a forward-plan — the title/body version disagreement is the strongest signal; before the next orchestrator opens to this document, its TL;DR and "What shipped" sections must describe v2026.4.125 consistently.
- **Executor's action (validated or modified):** Write and commit `spawn-retrieval-parity.test.ts` in the next hour — after first running `grep -n "buildRetrievalBundle\|composeSpawnPayload" packages/core/src/sessions/briefing.ts packages/core/src/orchestration/spawn.ts` to resolve the symbol-name ambiguity Outsider flagged under G2.

### Conditions on the recommendation

Yes, conditional on these five binding modifications before the first epic commit:

- **M1** — Add `spawn-retrieval-parity` AcceptanceGate on T1259 (E2) that blocks close until T1260 (E3) satisfies it. Collapses Contrarian's mint-broken-agents window to zero without breaking First Principles' atom-forced ordering.
- **M2** — Rewrite NEXT-SESSION-HANDOFF.md TL;DR + "What shipped" to describe v2026.4.125 as current; collapse .121→.124 narrative into a "release lineage" appendix. Per Outsider, the document must be a forward-plan artifact readable by a cold-read stranger.
- **M3** — Reclassify T1249/T1250/T1255 out of "cross-cutting" into concrete positions: T1255 closes in E1 cleanup; T1249 becomes a sub-task inside E2 with fresh-install acceptance criterion; T1250 sequenced after E1 to prevent a second renaming wavefront.
- **M4** — Scope E3 to include Expansionist Finding 3: register `buildRetrievalBundle` as a named injection primitive reusable by spawn, hooks, CANT runtime, CONDUIT enrichment, sentient proposer. Marginal cost during E3; eliminates three future migrations.
- **M5** — Extend "SDK-complete ≠ wired" acceptance criterion from E3 to E4: for every exported validator in E4 (requires/ensures, error_handlers, thin-agent boundary), at least one runtime hot-path call site must exist before T1261 closes. Per First Principles' atom-3 symmetry.

Substrate completeness side-note: Outsider flagged LOOM as absent from the forward plan. Confirmed — the E1-E4 spine touches TASKS/BRAIN/NEXUS/CANT/CONDUIT but not LOOM. Add an E4 sub-acceptance that `cleo orchestrate start <epic>` continues to work after T1261 schema changes, or file a LOOM-coverage sub-task. This is not a Reject condition.

### Next 60-minute action

Run `grep -n "buildRetrievalBundle\|composeSpawnPayload" packages/core/src/sessions/briefing.ts packages/core/src/orchestration/spawn.ts packages/core/src/orchestration/__tests__/` to resolve Outsider's G2 ambiguity, then author `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` with one describe + one it asserting `composeSpawnPayload({ taskId }).retrievalBundle` is defined and structurally matches the briefing-path retrieval for the same task; run `pnpm --filter @cleocode/core test -- spawn-retrieval-parity` and commit the red test without modifying spawn.ts. This pins T1260 to a machine-checked gate and simultaneously becomes the AcceptanceGate on T1259 per M1.

### Confidence

**High** on the revised roadmap spine (E1→E2→E3→E4 → W5+W6 → W7 → W8+Sentient v1) with M1-M5 applied; **medium** on the v2026.4.133 terminus holding across 8 bodies of work in 8 calendar days. Confidence would rise to high on the terminus if E2 and E3 can be parallelized after E1 lands; it would fall to low if the M1 parity test cannot actually be written against existing test helpers (Outsider's G2 concern — verify within the first hour before committing to the M1 gate).

### Open questions for the owner

- Epic decomposition: file each of T1258-T1261 as a single epic commit or decompose into child tasks for incremental acceptance tracking? Recommendation: decompose — aligns with rescue-commit pattern validated 3× last session.
- Epic 4 contract cutover: strict cutover (all existing .cantbooks migrate at E4 ship) vs opt-in `strict_contracts: true` flag with migration window? Per ADR-053 state-machine invariants, strict is recommended but owner decision required.
- hierarchy.ts disposition: grep first to confirm whether it is consumed at runtime; if only legacy/test-fixture, deletion is cleanest during E1.
