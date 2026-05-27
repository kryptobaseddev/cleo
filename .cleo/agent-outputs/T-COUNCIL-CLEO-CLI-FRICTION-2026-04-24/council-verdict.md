# The Council — Do CLEO orchestration rough edges warrant one epic or multiple tasks, and what is the load-bearing fix?

## Evidence pack

1. **`cleo orchestrate spawn --json` emits resolver warning on stdout** — line 1: `[agent-resolver] WARN: agent 'project-dev-lead' not found in project/global/packaged/fallback tiers — falling back to universal base 'cleo-subagent' at '/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/agents/cleo-subagent.cant'`. Line 2: `{"success":true,...}`. Every `--json` consumer must `sed -n '2p'` or `grep '^{"success"'` to parse. Protocol bug.

2. **E_ATOMICITY_VIOLATION fix-hint references `--role` switch that doesn't exist at CLI layer** — error: `{"code":"E_ATOMICITY_VIOLATION","message":"Worker role for task T1222 declares 4 files (max 3). Split into subtasks or promote to lead.","fixHint":"Split task T1222 into 2 subtasks with cleo add --parent T1222"}`. But `cleo update --role` means `work|research|experiment|bug|spike|release` (orthogonal to --type T944), NOT the worker/lead atomicity axis.

3. **Classifier over-indexes on title keywords** — observed: `{"agentId":"project-docs-worker","role":"worker","confidence":0.95,"reason":"Structural heuristic matched project-docs-worker (confidence 0.95)"}` for task "Fix CLEO engine — tasks.complete must reject verification_json NULL". Code-fix task classified as docs-worker at 95% confidence.

4. **`cleo create` does not exist — correct verb is `cleo add`** — observed `cleo create --type epic ...` → `Unknown command create`. No did-you-mean suggestion.

5. **Strict-mode requires `--parent` on every task creation, no default** — `{"code":"E_VALIDATION","message":"Tasks must have a parent (epic or task) in strict mode. Use --parent <epicId>, --type epic for a root-level epic, or set lifecycle.mode to \"advisory\".","fix":"cleo add \"Task title\" --parent T### --acceptance \"AC1|AC2|AC3\""}`.

6. **File scope (`--files`) discovered only at spawn time, not creation** — forces round-trip: `cleo add` → `cleo orchestrate spawn` → `E_ATOMICITY_NO_SCOPE: Worker role for task T1222 lacks file scope` → `cleo update --files ...` → re-spawn.

7. **Agents `project-dev-lead` / `project-docs-worker` classifier-chosen but registry-missing** — classifier selects them at high confidence; resolver WARNs not found in any tier; falls back to universal base `cleo-subagent`. Classifier's output space ⊄ registry's input space.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Lane acknowledgment:** I find failure modes — concrete things that break at runtime, under load, over time, or under human pressure. I do NOT adjudicate correctness (First Principles), claim/reality gaps (Outsider), upside (Expansionist), or prescribe actions (Executor).

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- Evidence #1 (`--json` stdout carries `[agent-resolver] WARN` before JSON) — "consolidated fix-epic" that treats this as stdout-hygiene nit ships a fix that still fails silently at the place where autonomy lives.
- Evidence #3 (classifier 95% confidence on wrong classification) — high-confidence wrong is the single most dangerous failure class for autonomous dispatch; patching does not change failure mode, only frequency.
- Evidence #7 (classifier selects registry-absent agents, triggers #1 warning) — #1 and #7 are same root cause (classifier output space ⊄ registry output space); two separate fixes will race.
- Evidence #2 (E_ATOMICITY_VIOLATION fix-hint points at orthogonal `--role`) — error envelope itself is silent-failure source; agents executing the hint mutate task state wrongly.

**Findings (failure modes):**

1. **"Consolidate into one epic" fails by compounding silent-failure surface area** — triggers when v2026.4.134 ships a single fix-epic bundling classifier + `--json` + atomicity + UX gaps, and any one component regresses. Rolling back "warning on stdout" requires also rolling back classifier; team rolls back neither, accepts regression. Detected silently — envelope still says `success:true` while dispatched-to-wrong-agent rate rises. Trigger: first post-release hotfix request.

2. **"Patch the classifier" fails by preserving confidence-calibration pathology** — tuning keyword weights without constraining classifier output to registry input still returns ≥0.9 confidence for agents that don't exist; resolver fallback silently invoked on happy path. Detected by operators: dashboards show specialized agents dispatched while tasks run under universal base — two views never reconcile. Trigger: any classifier input whose title keywords match a registry-absent agent name (already observed in the evidence pack).

3. **"Tolerant parsers" on subagent side fails one-person-risk test** — every future spawn call site (CI harness, HITL approver, `@cleocode/mcp-adapter`) must remember prefix-skipping contract. One maintainer adds a structured-log line between WARN and JSON; tolerant parsers return `undefined` on the happy path. Detected silently — spawn returns "no prompt" and orchestrator dispatches agent with empty prompt. Trigger: any future addition of a second stdout-diagnostic line.

**Verdict from this lens:** "One epic vs. multiple" is the wrong axis — it misses that evidence #1, #3, #7 form a single coupled failure (classifier output ⊄ registry ∪ `--json` impurity), while #2 is a separate silent-failure class. Bundling all = rollback impossible; splitting into 6 = coupled pair ships half-fixed.

**Single sharpest point:** Classifier + resolver + `--json` channel form a silent-failure triangle (classifier returns registry-absent agent at 0.95 → resolver emits WARN to stdout → consumer either parses past and dispatches to fallback, or chokes and dispatches nothing), triangle fails silently the first time a subagent receives a spawn prompt whose classified agent doesn't exist — evidence #1 and #7 prove this is happening today.

### Advisor: First Principles

**Lane acknowledgment:** I find correctness errors against atomic truth — truths that hold even if the codebase vanished. I do NOT predict runtime cascades (Contrarian), spot opportunities (Expansionist), claim/reality-gap the artifact (Outsider), or prescribe the 60-min action (Executor).

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- POSIX stream separation convention (stdout = data, stderr = diagnostics) — atomic: any program claiming `--json` must emit pure JSON on stdout. Evidence #1 violates this.
- Gricean manner + Nielsen error-message heuristic: an error's fix-hint must reference a lever the user can actually pull. Evidence #2 violates atomically.
- Bayesian decision theory: classifier routing work to non-existent targets (items 3 + 7) is a categorical failure of the registry/classifier contract — output space must be a subset of input space.
- Principle of least surprise + discoverability (Norman): required inputs (`--parent`, `--files`) only discovered at failure time (items 5, 6) are information-asymmetry bugs.

**Atomic truths:**

1. A typed channel must emit only its declared type. `--json` is a contract; diagnostics belong on stderr.
2. An error message's fix-hint is a promise. A hint referencing a non-existent lever is worse than no hint.
3. A classifier's output space must be a subset of the dispatcher's input space. Otherwise two independent sources of truth for "what agents exist."
4. Required inputs must be discoverable before commitment, not after.
5. Consolidation vs. decomposition is decided by shared root causes, not shared symptoms.
6. Autonomous orchestration has a single hard prerequisite: the dispatcher must reliably produce a runnable agent.

**Reconstructed solution (from atoms):** Group the 7 items by causal structure, not code area. Atom 3 says items {1, 7} are the same bug at different layers (classifier emits label → resolver can't find it → falls back → warning fires → dirties stdout). Same fix: close the classifier↔registry loop. Atom 1 makes item #1's stdout/stderr split a trivially-correct fix that should not wait on registry work. Atom 2 makes item #2 a standalone correctness bug — hint-string simply wrong. Items {4, 5, 6} are independent UX/discoverability defects (atom 4) sharing no root cause. Load-bearing fix for *autonomous orchestration* is the classifier↔registry contract (atom 6).

**Divergences from proposed framing:**
- Treating the 7 items as one "orchestration-layer" bucket — **path-dependent cruft**. Shared surface area ≠ shared root cause. Atom 5 rejects this.
- Framing items {1, 7} as separate — **genuine error**. These are one bug at two layers.
- Framing item 3 as calibration issue — **genuine error**. Per atom 3, it's a contract violation first.
- Framing atomicity fix-hint as "role lock" — **genuine error in locus**. Atomic defect is hint-string references non-existent lever.

**Verdict from this lens:** One small epic covering items {1, 3, 7} as single classifier↔registry contract fix, plus four independent targeted tasks for {2, 4, 5, 6}.

**Single sharpest point:** The load-bearing fix is the classifier↔registry contract (items 1 + 3 + 7 are one bug, not three) — until the dispatcher's output space is provably a subset of the registry's input space, every "autonomous" spawn is gambling against an unresolved name, and no amount of polish on the other four items changes that.

### Advisor: Expansionist

**Lane acknowledgment:** I find opportunities and latent assets the plan is NOT attempting. I do not enumerate risks (Contrarian), debate correctness (First Principles), surface stranger observations (Outsider), or prescribe actions (Executor).

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- Evidence #3 + #7 — orchestrator already produces a labeled training corpus of (task → intended specialist) mappings. Every miscalibrated dispatch is a free, structured supervision signal thrown away.
- Evidence #1 — resolver already narrates its decisions on every spawn. The stream is a free dispatch-decision telemetry feed treated as a bug to silence.
- Evidence #2 + #4 — error envelopes carry `fix`/`codeName`/`alternatives`/`meta` per ADR-039 (LAFS). Scaffolding for machine-repairable errors is fully built; orchestrator isn't feeding itself back.
- Evidence #6 — GitNexus has 26,606 symbols + 50,335 relationships + 300 execution flows indexed. File-scope inference is one `gitnexus_impact` call from being automatic.

**Findings (opportunities):**

1. **Classifier becomes a self-improving dispatch model, not a bug to fix.** Every classification today is a labeled datapoint: `(task, predicted agent, confidence, registry hit, fallback success, gates green)`. Log to BRAIN as `dispatch-trace` memory type and within one campaign: thousands of training rows. Asymmetry: ~1 day to add `cleo memory observe --type dispatch-trace` on every spawn vs. permanent compounding dataset.

2. **The rough edges ARE the MCP adapter product.** Every gap — dirty `--json`, phantom `--role` hint, missing `did-you-mean`, required `--parent`, late-bound `--files` — is the surface external MCP clients hit first. Reframe as "MCP adapter conformance: every orchestrate/create/update command is a first-class MCP tool with structured errors, inferred defaults, machine-repairable fix hints". Same diff; different framing = v1.0 external-integration contract.

3. **GitNexus + classifier = automatic wave planner with file-scope pre-resolution.** Pipe task text through `gitnexus_query` at classify-time → files that will be touched, execution flows involved, conflict sets for parallel waves — all without asking for `--files` and without keyword-guessing the agent. Dispatch should be graph-grounded, not keyword-grounded.

**Verdict from this lens:** Plan is too small. Three missing loops turn CLEO from working orchestrator into self-improving, externally-integrable, graph-grounded agent substrate.

**Single sharpest point:** Before fixing the dirty `--json` stream, TAP it — every resolver decision is a free labeled training row; same diff that cleans stdout can also write that row to BRAIN. That one extra line turns an orchestration-polish epic into the seed of CLEO's dispatch-intelligence flywheel.

### Advisor: Outsider

**Lane acknowledgment:** I find claim/reality gaps visible from the artifact alone. I do not predict runtime failures (Contrarian), reason from external truths (First Principles), spot opportunities (Expansionist), or prescribe actions (Executor).

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- Evidence #1 — `cleo orchestrate spawn --json` emits `[agent-resolver] WARN: ...` on stdout line 1, JSON on line 2. The `--json` flag does not gate the warning.
- Evidence #2 — E_ATOMICITY_VIOLATION `fixHint` says "Split into 2 subtasks"; message says "Split OR promote to lead"; `cleo update --role` accepts `work|research|experiment|bug|spike|release` — none of which is `lead` or `worker`.
- Evidence #3 — Classifier returns `confidence:0.95` for `project-docs-worker` on engine/DB work.
- Evidence #4 — `cleo create` returns `Unknown command create`; working verb is `cleo add`.
- Evidence #7 — Classifier picks `project-dev-lead`; resolver in the same spawn warns "not found in project/global/packaged/fallback tiers."

**Findings (claim/reality gaps):**

1. **The `--json` contract is broken on its face.** A flag whose entire purpose is machine-parseable output emits a human-readable WARN line before JSON. Piping into `jq` gets parse error on line 1. The artifact demonstrates the flag does not do what its name claims.

2. **The atomicity error hints at a vocabulary the CLI does not expose.** The error's `message` enumerates two remedies; the `fixHint` documents only one. `cleo update --role` accepts values that don't include the words in the error. The role axis referenced by enforcement is not the same axis `update` edits.

3. **Two subsystems in the same binary contradict each other on the same identifier.** Classifier returns `project-dev-lead` at 0.95 confidence; resolver invoked moments later in the same spawn says not found in any tier. Nothing explains why one half treats the ID as canonical while the other treats it as absent.

4. **The CLI's own verbs are inconsistent with the pattern its errors assume.** `cleo create` doesn't exist; `cleo add` is the verb. Errors use `add` correctly but stranger coming from `cleo session start` / `cleo backup add` / `cleo orchestrate start` might reach for `create`. No did-you-mean on `Unknown command`.

**Verdict from this lens:** Not six independent rough edges. The thread linking evidence #1, #2, #3, #7 is a shared-vocabulary failure: "role," "agent id," "worker/lead" mean different things to classifier, resolver, atomicity enforcer, and `update` command. Orchestration layer has no single source of truth for names it is reasoning about.

**Single sharpest point:** The classifier emits `project-dev-lead` at 0.95 confidence and the resolver, in the same spawn, logs that `project-dev-lead` is not registered anywhere — a stranger reads that as one half of the system confidently naming something the other half cannot find, and everything else on the list looks like downstream fallout from that.

### Advisor: Executor

**Lane acknowledgment:** One action, startable now. Not a list, not risks, not reframes, not opportunities. Just the next sixty minutes.

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `packages/core/src/store/agent-resolver.ts:553` — raw `console.warn(...)` fires during every unresolved-agent spawn, the exact `[agent-resolver] WARN: ...` string the evidence pack shows corrupting `--json` output. Physical source of the bug.
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts:1777` — the orchestrate envelope already carries `warnings: PlanWarning[]`. Structured pipe exists; resolver just isn't using it. Fix is plumbing, not design.
- Evidence pack item 1 vs. items 2–7: only item 1 breaks machine consumers silently and invisibly. Dirty stdout makes every downstream `JSON.parse` throw mid-orchestration with no recovery path — that is the load-bearing unblocker.

**The action (one):** Open `packages/core/src/store/agent-resolver.ts` at line 553, replace the `console.warn(...)` with a pushed entry onto a resolver-warnings array returned as `ResolvedAgent.resolverWarning?: string`. Then in `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` around line 1962 where `warnings: PlanWarning[]` is constructed, append that `resolverWarning` into the plan's `warnings` array with `code: 'agent_fallback_universal_base'`. No stderr, no stdout — structured envelope only. Write one vitest in `packages/core/src/store/__tests__/agent-resolver.test.ts` asserting `tryResolveUniversalBase(...)` returns a `resolverWarning` string and emits nothing to `console.warn` (spy: `expect(warnSpy).not.toHaveBeenCalled()`). Run `pnpm --filter @cleocode/core test agent-resolver`.

**Expected outcome (60 minutes):** New test `agent-resolver › tryResolveUniversalBase returns structured warning without stderr emission` passes; `cleo orchestrate spawn <any-unknown-agent> --json | jq .` exits 0 (previously broke with parse error).

**What this unblocks:** Every subagent-orchestrated JSON-dispatch path — which is the whole autonomous orchestration loop — becomes machine-parseable again, making it safe to ship the remaining six UX gaps as separate targeted tasks.

**Verdict from this lens:** APPROVE with amendments — ship the patch first, then triage the other six as individual tasks.

**Single sharpest point:** Replace the `console.warn` at `agent-resolver.ts:553` with a `resolverWarning` field propagated into `PlanWarning[]`, add the vitest, and `cleo orchestrate spawn --json` is parseable again within the hour.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — Strongest: "A classifier's output space must be a subset of the dispatcher's input space." Each atom has named subject, predicate, no hedging.
- G2 Evidence grounding: PASS — Cited items: #1 + #7 consolidated via atom 3; #3 mapped to atom 3 as contract violation; #2 mapped to atom 2; #4 mapped to atom 2; #5 + #6 mapped to atom 4. All 7 pack items referenced.
- G3 Frame integrity: PASS — FP's atoms are world-level contracts. None predict runtime cascade. The "gambling against an unresolved name" phrase brushes my lane but is framed as contract unsoundness not runtime failure.
- G4 Actionability: PASS — Verdict cashes out to concrete decomposition: "One small epic for {1, 3, 7} + four independent tasks for {2, 4, 5, 6}."

**Strongest finding forwarded:** Framing items 1 and 7 as separate = genuine error; they are one bug at two layers (classifier emits labels outside registry's input space).

**Gap from Contrarian's frame:** FP names the contract as load-bearing but doesn't name the runtime trigger that realizes the violation. From my lane: the dispatcher silently falls back to `cleo-subagent` (evidence #1) while the envelope still reports `success:true` — a silent-failure mode (operators see success, agents run with wrong identity, no page fires). FP stays in lane correctly.

**What I would add:** The fix-hint contract (atom 2) has a second-order failure FP did not surface: when agents trust a fix-hint that references a non-existent lever, the retry loop burns tokens and converges on dead-ends — the hint doesn't just mislead humans, it poisons autonomous remediation.

**Disposition:** Accept — FP produced a clean zero-based reconstruction, grounded every divergence in the evidence pack, correctly identified items {1, 3, 7} as one bug, and handed the owner a decomposable plan.

**Single sharpest finding forwarded to Chairman:** The classifier↔registry contract is the load-bearing fix — items 1, 3, 7 are one bug at two layers (classifier emits names outside the registry's input space); items 2, 4, 5, 6 are independent targeted tasks.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — Strongest finding names concrete mechanism (`cleo memory observe --type dispatch-trace` on every spawn) with quantified asymmetry (~1 day cost vs. permanent dataset).
- G2 Evidence grounding: PASS — Finding 1 cites #3 + #7; Finding 2 cites #1, #2, #5, #6; Finding 3 cites #3 + #6. All cited items exist in pack.
- G3 Frame integrity: PASS — All three findings name opportunities the plan is NOT attempting. "Add one extra line" is borderline actionable but framed as "opportunity that changes the value" not "execute this sequence" — stays in lane.
- G4 Actionability: PASS — Cashes out to testable decision: add one log line before shipping the `--json` fix.

**Strongest finding forwarded:** Resolver's classification exhaust is a latent training dataset — `(task, predicted, confidence, registry hit, fallback success, gates green)`.

**Gap from First Principles' frame:** Expansionist assumes the dispatch signal is clean enough to train on. A classifier that emits 0.95 confidence on wrong classification is producing **miscalibrated** training data. The atomic truth of supervised learning is that labels must be recoverable from ground truth; the current system has no ground-truth signal distinct from the classifier's own prediction. Training on this exhaust without a separate truth channel bakes the 0.95-miscalibration into the model that replaces the heuristic.

**What I would add:** The dispatch-trace log is valuable only if paired with a correction channel (e.g., post-completion "right classification" memory observation) — otherwise the classifier learns to reproduce its own 0.95-wrong confidence.

**Disposition:** Accept — three distinct opportunities, all evidence-anchored, all in-lane; training-data insight is genuinely non-obvious.

**Single sharpest finding forwarded to Chairman:** The resolver's classification exhaust is a latent training dataset — one log line at the decision point turns the `--json` polish fix into a self-improving dispatch model, but only if a separate ground-truth channel is added alongside it, otherwise the flywheel compounds the 0.95-miscalibration.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — Strongest finding is concrete: "Classifier returns `project-dev-lead` at 0.95 confidence; resolver invoked moments later in same spawn says not found in any tier." Named subjects, predicate, artifact condition.
- G2 Evidence grounding: PASS — Item 1 cites pack #1; Item 2 cites pack #2; Item 3 cites pack #3 + #7; Item 4 cites pack #4. All cited items exist.
- G3 Frame integrity: PASS — Every finding is a claim/reality or artifact-internal-contradiction observation. No runtime prediction, no external-truth appeal, no opportunity-naming, no action prescriptions.
- G4 Actionability: PASS — Verdict names a specific investigable shared-vocabulary audit. Sharpest point pinpoints the binary-contradiction, directly testable.

**Strongest finding forwarded:** Classifier returns `project-dev-lead` at 0.95 confidence; resolver in same spawn says not registered. Nothing explains why one half treats the ID as canonical while the other treats it as absent.

**Gap from Expansionist's frame:** The shared-vocabulary failure is itself a latent asset the stranger view misses — if classifier, resolver, atomicity enforcer, and `update --role` enumeration were reconciled around a single agent-identity registry, that registry becomes a reusable substrate for every future subsystem that needs to name an agent (spawn templates, audit log, policy engine).

**What I would add:** The same 0.95-vs-not-registered contradiction Outsider names as a bug is the inflection point at which an agent-ID registry stops being implicit scaffolding and becomes a first-class addressable asset.

**Disposition:** Accept — Outsider stayed inside the stranger's lane, cited pack on every finding, identified cross-subsystem contradiction without predicting runtime behavior.

**Single sharpest finding forwarded to Chairman:** Classifier emits `project-dev-lead` at 0.95 and resolver in the same spawn logs not-registered — one half names something the other can't find; everything else is downstream fallout.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — Named file, named line, named symbol, named corruption vector. Expected outcome concrete: `cleo orchestrate spawn <any-unknown-agent> --json | jq . exits 0`.
- G2 Evidence grounding: PASS — Cites pack #1 directly. Agent-resolver.ts:553 and orchestrate-engine.ts:1777/1962 are mechanical sources of pack #1.
- G3 Frame integrity: FAIL — Executor persona requires "MUST NOT debate whether the plan is right." The verdict line "Owner's question is false dichotomy. Load-bearing fix is item 1 alone... No epic needed" is a plan-amendment call, not an action statement. That's First Principles' lane bleeding into Executor frame.
- G4 Actionability: PASS — Quoted actionable part unambiguous: file, line, command, test path.

**Strongest finding forwarded:** `packages/core/src/store/agent-resolver.ts:553` — raw `console.warn(...)` fires during every unresolved-agent spawn, exact source of the `[agent-resolver] WARN: ...` string corrupting `--json`.

**Gap from Outsider's frame:** The Executor claims surgical precision but the artifact shows only asserted line numbers — `packages/core/src/store/agent-resolver.ts:553`, `orchestrate-engine.ts:1777` and `:1962` are three cited line numbers without quotes proving the symbol `tryResolveUniversalBase` exists at that site or that `ResolvedAgent` is the return type. The persona's "Pre-action verification" mandate is the missing citation. Second pattern-break: the verdict paragraph is the longest semantic payload — a stranger reads the Executor's actual answer as plan-restructuring with the one-action shell serving as cover.

**What I would add:** The artifact claims one thing (a 60-minute patch) and shows another (a proposal to dissolve the epic) — the Executor would be sharper to strike the verdict paragraph entirely and let the action carry the weight the frame demands.

**Disposition:** Modify — action itself is tight and startable; the verdict paragraph is G3 drift and should be removed before the Chairman carries the sharpest point forward.

**Single sharpest finding forwarded to Chairman:** The Executor's action is sound and 60-minute-sized, but the attached verdict declaring the owner's question a "false dichotomy" is plan-amendment territory belonging to First Principles — Chairman should accept the action and discard the verdict framing.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — Strongest finding names trigger concretely: "triggers when patch tunes keyword weights without fixing that classifier's output set isn't constrained to registry's agent set." All three findings have named trigger + failure mechanism + detection path. No "might"/"could" hedging.
- G2 Evidence grounding: PASS — Anchors to pack items #1, #3, #7 for the triangle; verdict explicitly maps "#1, #3, #7 = single coupled failure. #2 = separate silent-failure class."
- G3 Frame integrity: PASS — All three findings name runtime/over-time failure with trigger, not static correctness. The "silent-failure triangle" framing reads architectural but remains anchored to trigger + runtime failure mode.
- G4 Actionability: PASS — Verdict cashes out to concrete decision: rejects both framings the owner presumably asked about, names the coupled triple that must be fixed together.

**Strongest finding forwarded:** Classifier + resolver + `--json` channel form a silent-failure triangle, fires first time subagent receives spawn prompt whose classified agent doesn't exist — evidence #1 and #7 prove this is happening today.

**Gap from Executor's frame:** Contrarian names the triangle but doesn't surface which leg fails first under adversarial load. From my frame: can one Bash call (`cleo orchestrate spawn --json <task> | jq .` against a task whose classified agent is registry-absent) prove the triangle is live today in under sixty seconds? Contrarian asserts "evidence #1 and #7 prove this is happening today" but doesn't name the single command that converts the assertion into a failing artifact.

**What I would add:** The triangle is disprovable in one shell line (`cleo orchestrate spawn --json <taskId-with-registry-absent-classification> 2>/dev/null | jq . ; echo exit=$?`) — exit code plus jq parse result collapse all three findings into a single decisive artifact.

**Disposition:** Accept — findings are rigorous, trigger-anchored, in-lane, verdict rejects the owner's framing in a way that forces a structural decision.

**Single sharpest finding forwarded to Chairman:** Classifier output set is not constrained to registry's agent set, and the resolver's fallback is emitted as a WARN on stdout rather than stderr — forming a silent-failure triangle that fires the first time a classified-agent lookup misses the registry (evidence #1, #3, #7 show this is happening today).

## Phase 2.5 — Convergence check

**Sharpest points (subject + predicate):**

1. Contrarian: silent-failure triangle (classifier+resolver+--json) — subject=triangle; predicate=runtime silent-failure with trigger.
2. First Principles: classifier↔registry contract — subject=contract; predicate=atomic violation.
3. Expansionist: dispatch-trace flywheel — subject=training-data exhaust; predicate=opportunity.
4. Outsider: one half names what other can't find — subject=classifier/resolver ID space; predicate=artifact-visible contradiction.
5. Executor (G3-stripped): `agent-resolver.ts:553` patch — subject=emission site; predicate=60-min action.

**Pairwise analysis:** Contrarian (#1) ↔ First Principles (#2) ↔ Outsider (#4) all name the classifier↔registry mismatch as load-bearing. SAME SUBJECT (classifier-registry contract). Different FRAME-APPROPRIATE PREDICATES: runtime trigger (Contrarian) vs. atomic contract (FP) vs. artifact contradiction (Outsider).

**Convergence threshold (≥3 same finding): MET on subject level, NOT on predicate level.** Each advisor produced lane-correct frame-appropriate output; the convergence reflects that the load-bearing issue is visible from multiple frames (a strength, not frame bleed). The skill's antibody purpose (catch frame smearing) does NOT apply — frames held.

**Decision: proceed to Phase 3 with consensus weighting.** Chairman weights this 3-frame convergence heavily without collapsing it as redundancy. Executor's G3 failure is a separate issue (verdict-paragraph plan-amendment drift); action content sound. No rerun — rerunning the 3/4 advisor (Executor) doesn't address the convergence.

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
**Hybrid — ship a small focused epic "T-ORCH-COHERENCE-v1" containing ONLY items {1, 3, 7} (classifier↔registry↔`--json` contract), riding alongside (not blocking) v2026.4.134; file items {2, 4, 5, 6} as four independent targeted tasks.** The 60-minute Executor action against `agent-resolver.ts:553` opens the epic as its first commit. Dispatch-trace hook (Expansionist) lands in commit 2 of the same epic.

### Why this, not the alternatives
Three frames (Contrarian, First Principles, Outsider) independently converged on {1, 3, 7} as one coupled bug — the classifier emits names outside the resolver's registry input-space and the `--json` channel swallows the only signal that would expose the mismatch. That causal coupling is the definition of an epic-sized unit, not independent tasks; splitting them ships half-fixes. Executor's verdict-paragraph claim that "no epic is needed, one patch suffices" failed G3 (drifted into plan-amendment) and is discarded — the patch is necessary but not sufficient, because evidence #7 proves the registry itself is missing entries the classifier references, which is a second commit beyond the resolver file. Expansionist's dispatch-trace flywheel is adopted same-commit-as-fix because the structured `resolverWarning` channel Executor is building is literally the event schema Expansionist needs; deferring would waste free leverage, and the FP peer-note ground-truth guardrail is honored by marking traces as `unverified` until a gate-green signal arrives. Items {2, 4, 5, 6} show no causal coupling to each other or to the load-bearing bug — bundling them hides independent surface areas under one rollback boundary, violating the Contrarian's own atomicity argument.

### What each advisor got right
- **Contrarian's fatal flaw to mitigate:** The silent-failure triangle (classifier + resolver + `--json` channel) is already firing in production every time a subagent spawn classifies to a registry-absent agent — this is a live bug, not theoretical.
- **First Principles' atomic truth worth protecting:** Decomposition must follow the causal graph, not the symptom surface — {1, 3, 7} is one bug at three layers; {2, 4, 5, 6} are four independent UX gaps.
- **Expansionist's upside to pursue (or defer):** Every resolver decision is a labeled training tuple — emit it as `cleo memory observe --type dispatch-trace` in the same commit that adds the structured warning. Mark traces `unverified` until ground-truth signal per FP peer note.
- **Outsider's pattern flag:** "Role," "agent id," and "worker/lead" mean different things to classifier, resolver, atomicity enforcer, and `update` command — the orchestration layer has no single source of truth for the names it reasons about, which is why evidence #2's enumeration mismatch exists at all.
- **Executor's action (validated or modified):** Open `packages/core/src/store/agent-resolver.ts:553`, replace `console.warn` with `resolverWarning?: string` on `ResolvedAgent`, propagate into `orchestrate-engine.ts:1962` `PlanWarning[]`, add vitest asserting structured warning + `console.warn` spy never called.

### Conditions on the recommendation
Yes, if:
1. The epic does NOT block v2026.4.134 — release ships on current main; the epic lands in v2026.4.135 within 48 hours. A stdout-warning bug in an orchestration subcommand is not a release blocker; it's a patch-grade fix.
2. The classifier-registry contract is fixed TODAY in commit 1 of the epic (Executor's patch) — do not wait for T1216 REFACTOR. T1216 inherits the `resolverWarning` channel as a stable contract; that coupling is additive, not blocking.
3. The dispatch-trace hook ships in commit 2 of the same epic (not deferred) — marked `unverified` until a separate gate-green signal verifies it, per FP's ground-truth note.
4. Items {2, 4, 5, 6} become four tasks (not one bundle): T-ORCH-ATOMICITY-HINT (item 2), T-CLI-DIDYOUMEAN (item 4), T-STRICT-PARENT-DEFAULT (item 5), T-FILES-EAGER-SCOPE (item 6). Each gets independent `cleo verify` evidence.
5. A follow-up task inside the epic registers `project-dev-lead` and `project-docs-worker` in the agent registry OR removes them from the classifier's output vocabulary — evidence #7 proves today the classifier emits names the registry does not know, so the structured warning fix alone leaves the underlying contract broken.

### Next 60-minute action
Open `packages/core/src/store/agent-resolver.ts:553`, replace the `console.warn(...)` call with a `resolverWarning?: string` field on `ResolvedAgent`, propagate that field through `orchestrate-engine.ts:1962` into the existing `PlanWarning[]` channel, add a Vitest at `packages/core/src/store/__tests__/agent-resolver.test.ts` asserting `tryResolveUniversalBase` returns a structured warning and that a `console.warn` spy is never called during resolution, then verify `cleo orchestrate spawn --json | jq .` exits 0 on a task that triggers universal-base fallback. Commit as the first commit of epic T-ORCH-COHERENCE-v1.

### Confidence
**High** — three independent frames (Contrarian, First Principles, Outsider) converged on the same load-bearing bug with direct evidence (#1, #3, #7), all four non-discounted advisors passed 4/4 gates, and the fix surface is a single file path with an existing warning-propagation channel to plug into. Confidence would drop to medium if the agent registry proves harder to update than the resolver (owner signal needed on whether `project-dev-lead` / `project-docs-worker` are intended canonical names or classifier hallucinations). Confidence rises to near-certain after the Vitest lands green and `jq .` parses the stdout cleanly.

### Open questions for the owner
- Are `project-dev-lead` and `project-docs-worker` intended agents that need registry entries, or classifier output-vocabulary that should be narrowed to the real registry? (Determines commit 2 direction.)
- Should v2026.4.134 ship today with the current dirty state and the epic backfills into v2026.4.135, or do you want the epic commits folded into v2026.4.134 before tag? (Chairman recommends the former; owner call.)
