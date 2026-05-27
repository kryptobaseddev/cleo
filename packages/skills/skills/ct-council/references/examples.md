# Worked Example — What a Good Council Run Looks Like

This is a compact reference run. It shows the full 3-phase shape end-to-end so future runs can pattern-match against "does my output look like this?". The topic is illustrative, not from any real project.

**Question to the Council:** *"Should we add a retry-on-timeout wrapper around all outbound HTTP calls in `packages/core/src/http.ts`?"*

---

# The Council — Should we add a retry-on-timeout wrapper to outbound HTTP calls in packages/core/src/http.ts?

## Evidence pack

1. `packages/core/src/http.ts:L12-L58` — the current `httpGet` / `httpPost` implementation; no retry logic, 10s default timeout.
2. `packages/core/test/http.test.ts::handles timeout` — existing test asserts a single-attempt timeout throws `TimeoutError`.
3. commit `a1b2c3d "drop retries from http client"` — retries were *removed* 18 months ago citing "retry storms in prod".
4. `docs/adr/ADR-021-http-client.md` — ADR captures the no-retry decision; names retry storms as the reason; explicitly flags "revisit when circuit-breaker lands".
5. `packages/core/src/circuit-breaker.ts` — circuit breaker shipped 2 months ago, currently used nowhere.
6. `MEMORY.md "flaky integration tests"` — ops team has cited HTTP flakiness as #2 source of page alerts this quarter.

---

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- commit `a1b2c3d` — retries were pulled for a documented reason; that reason has not been shown to be resolved.
- `packages/core/src/http.ts` has zero per-caller rate limits; a naïve retry wrapper multiplies call volume under stress.

**Findings:**
1. Adding retries without a circuit breaker in front of them will reproduce the exact retry-storm incident that motivated their removal (`ADR-021`).
2. The wrapper is at the wrong layer — some callers are idempotent GETs, others are state-mutating POSTs. One-size-fits-all retries will duplicate writes.
3. "10s timeout + 3 retries" silently becomes "40s tail latency" for users, which no caller's SLO is budgeted for.

**Verdict from this lens:** The plan as stated will re-introduce a known incident class. It is not safe to ship without circuit-breaker wiring and per-method retry eligibility.

**Single sharpest point:** A global retry wrapper without a circuit breaker in front of it is the exact shape of the bug we removed 18 months ago.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- `packages/core/src/http.ts:L12-L58` — the code actually distinguishes GET from POST but applies identical error handling.
- `packages/core/src/circuit-breaker.ts` — a circuit breaker exists and is unused.

**Atomic truths:**
1. Some network errors are transient (timeout, DNS, connection-reset); some are not (4xx, 5xx with body).
2. Idempotent requests can be safely retried; non-idempotent ones cannot without deduplication.
3. Unbounded retries are always wrong.
4. A circuit breaker and a retry policy are complementary, not substitutable.

**Reconstructed solution (from atoms, without the plan):**
An HTTP client should classify errors as retryable vs non-retryable, apply bounded retries *only* to retryable errors on *idempotent* methods, gate all retries through a circuit breaker, and emit metrics that let ops tune the policy.

**Reconstruction vs. the proposed plan:**
- Convergences: plan proposes retry on timeout (a retryable error) — correct.
- Divergences: plan doesn't distinguish idempotent vs non-idempotent (genuine error); doesn't wire the existing circuit breaker (path-dependent cruft — the breaker exists, just isn't hooked up); doesn't address metrics (omission).

**Verdict from this lens:** The plan covers one-third of the correct design. The atomic truths call for idempotency classification and circuit-breaker gating, which the plan omits.

**Single sharpest point:** The atomic truth the plan violates is "non-idempotent requests cannot be blindly retried"; that's the correctness error.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts` — an unused asset the project already paid to build.
- `MEMORY.md "flaky integration tests"` — the pain isn't just in prod; it's daily in CI.

**Findings:**
1. The real opportunity is wiring the dormant circuit breaker to *every* external dependency, not just HTTP. The retry question is a wedge into a broader resilience layer worth 10x the scope.
2. If retries emit a metric ("retry-saved" events), ops gets the first quantitative view of transient-error cost — previously invisible.
3. A retry-aware HTTP client unlocks aggressive timeout tightening (2s instead of 10s) because transient failures self-heal, making the whole system feel faster end-to-end.

**Verdict from this lens:** The owner is asking about a defensive patch; the frame should be "we have a shippable resilience layer hiding behind this change."

**Single sharpest point:** Wire the already-built circuit breaker to HTTP as part of this change — it's ~200 lines of work for a system-wide resilience asset.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts` exists with zero callers.
- `docs/adr/ADR-021-http-client.md` explicitly says "revisit when circuit-breaker lands".

**Findings:**
1. A stranger reading the repo would ask: "There's a `circuit-breaker.ts` with no callers. Did someone forget to use it?" The ADR literally says it's the precondition for this exact change.
2. The test suite asserts single-attempt behavior. Adding retries means changing existing tests, not just adding new ones — the plan doesn't mention which tests break.
3. `http.ts` exports `httpGet` and `httpPost` but the naming suggests these are meant to be the only public entry points; a "wrapper" implies something external, which is an odd choice if the goal is universal retry.

**What the artifact claims vs. shows:**
The ADR *claims* the design is awaiting the circuit breaker; the code *shows* the circuit breaker has been ready for two months. The claim is not aligned with the current state of the world.

**Verdict from this lens:** A stranger would conclude the project has done the preparation work (circuit breaker) but hasn't closed the loop (wiring it). The proposed plan skips the wiring, which is exactly what the ADR said must come first.

**Single sharpest point:** The ADR says "do this when the circuit breaker lands"; the circuit breaker has landed; the plan doesn't reference either fact.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `packages/core/test/http.test.ts::handles timeout` — baseline behavior is captured in test.
- `packages/core/src/circuit-breaker.ts` has an `execute()` method that takes a function and applies the breaker policy.

**The action (one):**
Write one new test file `packages/core/test/http-retry.test.ts` containing a single failing test: `httpGet` retries exactly once on `TimeoutError` for idempotent methods, and does NOT retry on POST. Do not implement retries yet. This pins the design choice before writing code.

**Expected outcome (60 minutes from now):**
One new test file, one failing test with an explicit error message like "retries not implemented". The test file also documents the design decision (GET = retry, POST = no retry) in its describe block.

**What this unblocks:**
Implementation can now proceed test-first; peer review of the design decision happens on a concrete test rather than a plan doc; the circuit-breaker integration question gets forced because the test will require injecting a retry policy.

**Verdict from this lens:** Don't argue about the design in prose — pin it in a failing test and implementation follows.

**Single sharpest point:** Write `packages/core/test/http-retry.test.ts` with one failing test that asserts retry-on-GET, no-retry-on-POST.

---

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Scores:**
- Rigor: 5/5 — atoms are sharp and the reconstruction is traceable.
- Evidence grounding: 4/5 — good file citations, could have cited ADR-021 for the idempotency atom.
- Frame integrity: 5/5 — stripped context cleanly; didn't invoke history.
- Actionability: 4/5 — identifies the correctness gap but doesn't ground the fix in a failure mode.

**Strongest finding:** The idempotency atom. It's the plan's real flaw, stated at the right level of abstraction.

**Gap from Contrarian's frame:** First Principles doesn't name the *incident class* the missing idempotency enables — duplicate writes aren't just "incorrect", they create downstream poisoning (double-charging, double-notifying) that's expensive to reverse.

**What I would add:** The idempotency omission isn't only a correctness bug; it's a data-integrity hazard whose blast radius is whatever the non-idempotent endpoints touch.

**Would I act on their verdict?** Yes-with-modification — accept the correctness framing, but escalate the severity when POSTs touch user-visible state.

### First Principles reviewing Expansionist

**Scores:**
- Rigor: 3/5 — ambitious but light on the mechanism for "2s timeouts feel faster".
- Evidence grounding: 4/5 — correctly identifies the unused circuit breaker; the MEMORY.md reference is load-bearing.
- Frame integrity: 5/5 — stayed on upside; did not drift into risk.
- Actionability: 3/5 — names the opportunity but doesn't scope it tightly.

**Strongest finding:** The dormant-asset observation. A built-and-unused circuit breaker is a cheap-to-activate resilience layer.

**Gap from First Principles' frame:** The "tighten timeouts to 2s" claim doesn't derive from atomic truth — it depends on the specific distribution of call latencies, which the frame didn't verify.

**What I would add:** The atomic version of the upside is narrower: "the circuit breaker is a correctness tool, not a performance tool; use it for what it is."

**Would I act on their verdict?** Yes-with-modification — do the wiring, skip the timeout-tightening until measured.

### Expansionist reviewing Outsider

**Scores:**
- Rigor: 4/5 — the claim/reality gap is crisp and load-bearing.
- Evidence grounding: 5/5 — cited the exact ADR sentence that closes the argument.
- Frame integrity: 5/5 — no backstory smuggled in.
- Actionability: 2/5 — cold read but no prescription (correct for frame, but worth noting).

**Strongest finding:** "The ADR said do this when the breaker lands; the breaker has landed; the plan doesn't reference either fact." That's the whole argument.

**Gap from Expansionist's frame:** The stranger didn't notice the *upside* of the unused breaker — only the gap. Opportunity sits next to the gap.

**What I would add:** The stranger's gap isn't just a claim/reality mismatch; it's a shovel-ready upgrade with a signed-off design.

**Would I act on their verdict?** Yes — the observation alone justifies rewriting the plan to include breaker wiring.

### Outsider reviewing Executor

**Scores:**
- Rigor: 5/5 — the action is precise and the expected outcome is unambiguous.
- Evidence grounding: 4/5 — test file anchor is good; could have cited the circuit-breaker `execute()` signature.
- Frame integrity: 5/5 — one action, no analysis creep.
- Actionability: 5/5 — this is the frame.

**Strongest finding:** Pin the design (GET retries, POST doesn't) in a failing test before any prose or implementation.

**Gap from Outsider's frame:** To a stranger, "write a test first" is obvious test-driven development — not a novel insight. But the sharpness comes from *which* behavior to pin, and the Executor picked the right one.

**What I would add:** Nothing from the Outsider's frame — the action is recognizable good practice to any engineer, which is what validates it.

**Would I act on their verdict?** Yes — the action is startable immediately and unblocks everything downstream.

### Executor reviewing Contrarian

**Scores:**
- Rigor: 5/5 — named a specific reproducible incident class.
- Evidence grounding: 5/5 — cited the exact historical commit that removed retries and the ADR that captures the reason.
- Frame integrity: 5/5 — pure risk analysis; no upside creep.
- Actionability: 4/5 — names the failure but doesn't specify the mitigating action.

**Strongest finding:** The retry-storm claim — it's the most load-bearing risk, grounded in a real prior incident.

**Gap from Executor's frame:** The Contrarian says "this is dangerous" but doesn't cash out to "so the one action to take is X". That's the Executor's job, but noting it.

**What I would add:** The action that discharges this risk is: wire the circuit breaker before (or as part of) wiring retries. Concrete, one-file scope.

**Would I act on their verdict?** Yes — the risk is real and the mitigation is a bounded change.

---

## Phase 3 — Chairman's Verdict

### Recommendation
**Do not ship retries alone.** Wire the existing circuit breaker to the HTTP client *first*, then add retries scoped to idempotent methods (GET) only, with metrics, driven by a failing test. The owner's framing underscopes the change.

### Why this, not the alternatives
Four of five frames (Contrarian, First Principles, Outsider, Executor) converged on the same structural point from different angles: (1) Contrarian flagged retry storms as a re-incident risk, (2) First Principles derived idempotency as an atomic truth the plan violated, (3) Outsider identified the explicit ADR-021 precondition ("revisit when circuit-breaker lands") as already met and unreferenced by the plan, (4) Executor chose an action that forces the idempotency decision into a test. The Expansionist's framing (dormant asset → system-wide resilience layer) was sharp but scoped beyond this PR; defer that to a follow-up. On the *one* contested point (timeout-tightening from 2s), First Principles punctured Expansionist: depends on unmeasured latency distribution, not an atomic truth. Tiebreaker: evidence grounding. First Principles wins.

### What each advisor got right (carried forward)
- **Contrarian's fatal flaw to mitigate:** A global retry wrapper without a circuit breaker in front is the exact shape of the bug retries were removed to fix 18 months ago.
- **First Principles' atomic truth worth protecting:** Non-idempotent requests cannot be blindly retried — idempotency classification is mandatory, not optional.
- **Expansionist's upside to pursue (or defer):** The unused circuit breaker is a system-wide resilience asset; pursue in-scope for this change by wiring it to HTTP; defer the cross-system expansion.
- **Outsider's pattern flag:** ADR-021 named this exact sequencing — "circuit breaker first, then retries" — and the plan ignores it despite the precondition being met.
- **Executor's action (validated):** Write `packages/core/test/http-retry.test.ts` with one failing test asserting retry-on-GET, no-retry-on-POST.

### Conditions on the recommendation
Conditional on: (1) the failing test being written and reviewed before implementation, (2) the circuit breaker wiring happening in the same PR as retries, not a follow-up.

### Next 60-minute action
Write `packages/core/test/http-retry.test.ts` with one failing test: `httpGet` retries once on `TimeoutError`, `httpPost` does not retry. Document the idempotency decision in the describe block. Do not implement retries yet.

### Confidence
**High** — four independent frames converged; the dissenting point (timeout-tightening) is out-of-scope. Confidence would drop if the call-site audit found non-GET methods that are actually idempotent (e.g., PUT with natural idempotency keys) — then the policy needs a classification beyond HTTP method.

### Open questions for the owner
- Do we want to ship circuit-breaker wiring in the same PR as retries, or sequence them (PR 1: wire breaker, PR 2: add retries)?
