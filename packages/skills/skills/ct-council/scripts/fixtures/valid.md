# The Council — Should we add a retry-on-timeout wrapper to outbound HTTP calls?

## Evidence pack

1. `packages/core/src/http.ts:L12-L58` — current httpGet/httpPost; no retry logic.
2. `packages/core/src/circuit-breaker.ts` — exists with zero callers.
3. commit `a1b2c3d "drop retries from http client"` — retries removed 18 months ago citing retry storms.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked? Why is this a worse idea than it looks?

**Evidence anchored:**
- commit `a1b2c3d` — retries were pulled for a documented reason.
- `packages/core/src/http.ts` — zero per-caller rate limits.

**Findings (failure modes):**
1. **Retry storm** — triggers when upstream latency spikes. Fails by multiplying load. Detected silently until breaker trips.

**Verdict from this lens:** Plan re-introduces a known incident class.

**Single sharpest point:** A global retry wrapper without a circuit breaker reproduces the exact bug retries were removed to fix.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- RFC 7231 — HTTP POST semantics.
- `packages/core/src/http.ts:L12-L58` — current implementation.

**Atomic truths:**
1. Some errors are transient; some are not.
2. Idempotent requests can be retried; non-idempotent cannot.
3. Unbounded retries are always wrong.

**Reconstructed solution:** classify errors, retry only idempotent methods on retryable errors, gate through circuit breaker.

**Reconstruction vs. plan:**
- Convergences: retry on timeout.
- Divergences: no idempotency classification — genuine error.

**Verdict from this lens:** Plan covers one-third of correct design.

**Single sharpest point:** Non-idempotent requests cannot be blindly retried.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts` — dormant asset.
- `MEMORY.md` — flaky CI is #2 pain source.

**Findings (opportunities):**
1. **Wire breaker** — captures system-wide resilience. Asymmetry: 200 lines for permanent optionality.

**Verdict from this lens:** Owner is thinking too small; there's a platform layer hiding here.

**Single sharpest point:** Wire the circuit breaker as part of this change for asymmetric upside.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts` — zero callers.
- `docs/adr/ADR-021-http-client.md` — "revisit when circuit-breaker lands".

**Findings (stranger's eyes):**
1. Unused module whose ADR says it's the precondition for this exact change.

**What the artifact claims vs. shows:** ADR claims design awaits the breaker; code shows breaker has landed.

**Verdict from this lens:** Project prepared but didn't close the loop.

**Single sharpest point:** ADR-021 says do this when the breaker lands; the breaker has landed; plan ignores both.

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `packages/core/test/http.test.ts::handles timeout` — baseline test.
- `packages/core/src/circuit-breaker.ts` — has `execute()` method.

**The action (one):**
Write `packages/core/test/http-retry.test.ts` with one failing test: httpGet retries once on TimeoutError, httpPost does not.

**Expected outcome (60 minutes from now):**
New test file, one failing test with message "retries not implemented".

**What this unblocks:**
Test-first implementation; forces idempotency decision.

**Verdict from this lens:** Pin the design in a failing test before prose.

**Single sharpest point:** Write packages/core/test/http-retry.test.ts with retry-on-GET / no-retry-on-POST assertion.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — "Non-idempotent requests cannot be blindly retried" is specific.
- G2 Evidence grounding: PASS — cited RFC 7231 and http.ts.
- G3 Frame integrity: PASS — stayed in atomic-truth lane.
- G4 Actionability: PASS — "idempotency classification is mandatory" is decidable.

**Strongest finding (from reviewee):** The idempotency atom.

**Gap from Contrarian's frame:** Didn't name the incident class duplicate writes enable.

**What I would add:** Idempotency omission is not just correctness — it's data-integrity hazard.

**Disposition:** Accept — correctness framing holds.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — names specific opportunity (wire the breaker).
- G2 Evidence grounding: PASS — cites circuit-breaker.ts.
- G3 Frame integrity: PASS — stayed on upside.
- G4 Actionability: PASS — "wire the breaker as part of this change".

**Strongest finding (from reviewee):** Dormant-asset observation.

**Gap from First Principles' frame:** 2s timeout claim not derived from atoms.

**What I would add:** Breaker is a correctness tool, not a performance tool.

**Disposition:** Accept — core upside is valid.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — crisp claim/reality gap.
- G2 Evidence grounding: PASS — cited exact ADR sentence.
- G3 Frame integrity: PASS — no backstory smuggled.
- G4 Actionability: PASS — observation directly decides plan revision.

**Strongest finding (from reviewee):** ADR says do this when breaker lands; breaker has landed.

**Gap from Expansionist's frame:** Didn't notice the upside of the unused breaker.

**What I would add:** Gap isn't just mismatch; it's shovel-ready upgrade.

**Disposition:** Accept — observation is decisive.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — action is precise, outcome unambiguous.
- G2 Evidence grounding: PASS — test file anchor.
- G3 Frame integrity: PASS — one action, no analysis creep.
- G4 Actionability: PASS — test-writing.

**Strongest finding (from reviewee):** Pin design in failing test before code.

**Gap from Outsider's frame:** Action is standard TDD, not novel.

**What I would add:** Nothing — recognizable good practice validates it.

**Disposition:** Accept — start now.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — names specific incident class with trigger.
- G2 Evidence grounding: PASS — cites historical commit and ADR.
- G3 Frame integrity: PASS — pure risk, no upside creep.
- G4 Actionability: PASS — failure is mitigable by wiring the breaker first.

**Strongest finding (from reviewee):** Retry-storm claim.

**Gap from Executor's frame:** Says dangerous but doesn't name the action that discharges the risk.

**What I would add:** The action is: wire the breaker before retries.

**Disposition:** Accept — risk is real, mitigation is bounded.

## Phase 2.5 — Convergence check

Compared the five "single sharpest point" statements. Distinct subjects: retry storms, idempotency, breaker wiring, ADR-precondition gap, test-first action. No convergence flag raised. Proceeding to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | PASS | full |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist     | PASS | PASS | PASS | PASS | full |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | PASS | PASS | PASS | PASS | full |

### Recommendation

Do not ship retries alone. Wire the circuit breaker first, then add retries scoped to idempotent methods (GET) only, driven by a failing test.

### Why this, not the alternatives

Four of five frames converged on the same structural point from different angles: Contrarian flagged retry storms as re-incident risk; First Principles derived idempotency as an atomic truth the plan violated; Outsider identified ADR-021's explicit precondition as already met; Executor chose an action that forces the idempotency decision into a test. The Expansionist's broader frame (system-wide resilience layer) was sharp but out of scope; defer that to follow-up. No unresolved contention.

### What each advisor got right (carried forward)

- **Contrarian's fatal flaw to mitigate:** A retry wrapper without a circuit breaker reproduces the 18-month-old retry-storm incident.
- **First Principles' atomic truth worth protecting:** Non-idempotent requests cannot be blindly retried.
- **Expansionist's upside to pursue (or defer):** The dormant circuit breaker is a system-wide resilience asset; wire it in-scope for this change.
- **Outsider's pattern flag:** ADR-021 said this exact precondition must be met; it has been; the plan ignores both facts.
- **Executor's action (validated):** Write `packages/core/test/http-retry.test.ts` asserting retry-on-GET, no-retry-on-POST.

### Conditions on the recommendation

Conditional on: (1) the failing test being written first, (2) the circuit breaker wired in the same PR as retries, not a follow-up.

### Next 60-minute action

Write `packages/core/test/http-retry.test.ts` with one failing test: httpGet retries once on TimeoutError, httpPost does not retry. Document the idempotency decision in the describe block.

### Confidence

High — four independent frames converged; no unresolved contention; action is startable immediately.
