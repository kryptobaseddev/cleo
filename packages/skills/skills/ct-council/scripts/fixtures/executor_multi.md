# The Council — Should we add a retry-on-timeout wrapper to outbound HTTP calls?

## Evidence pack

1. `packages/core/src/http.ts:L12-L58` — current httpGet/httpPost.
2. `packages/core/src/circuit-breaker.ts` — exists with zero callers.
3. commit `a1b2c3d "drop retries from http client"` — retries removed 18 months ago.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong.

**Evidence anchored:**
- commit `a1b2c3d` — retries were pulled for a documented reason.
- `packages/core/src/http.ts` — zero per-caller rate limits.

**Verdict from this lens:** Plan re-introduces known incident class.

**Single sharpest point:** Retry wrapper without breaker reproduces old bug.

### Advisor: First Principles

**Frame:** Ignore everything.

**Evidence anchored:**
- RFC 7231.
- `packages/core/src/http.ts:L12-L58`.

**Verdict from this lens:** Plan incomplete.

**Single sharpest point:** Non-idempotent requests cannot be blindly retried.

### Advisor: Expansionist

**Frame:** Forget the constraints.

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts`.
- `MEMORY.md`.

**Verdict from this lens:** Owner thinking too small.

**Single sharpest point:** Wire the circuit breaker.

### Advisor: Outsider

**Frame:** You have no context.

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts` — zero callers.
- `docs/adr/ADR-021-http-client.md`.

**What the artifact claims vs. shows:** Claims await breaker; shows breaker has landed.

**Verdict from this lens:** Project prepared but didn't close the loop.

**Single sharpest point:** ADR says do this when breaker lands; it has landed.

### Advisor: Executor

**Frame:** Don't analyze.

**Evidence anchored:**
- `packages/core/test/http.test.ts`.
- `packages/core/src/circuit-breaker.ts`.

**The action (one):**
1. Write a failing test.
2. Implement the retry wrapper.
3. Add circuit breaker wiring.

**Expected outcome (60 minutes from now):**
Many things happen.

**What this unblocks:**
All subsequent work.

**Verdict from this lens:** Lots to do.

**Single sharpest point:** Do three things simultaneously.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Idempotency.

**Gap from Contrarian's frame:** None.

**What I would add:** Nothing.

**Disposition:** Accept — holds.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Asset wiring.

**Gap from First Principles' frame:** None.

**What I would add:** Nothing.

**Disposition:** Accept — holds.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** ADR gap.

**Gap from Expansionist's frame:** None.

**What I would add:** Nothing.

**Disposition:** Accept — holds.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: FAIL — three actions listed, not one.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: FAIL — multiple actions violates Executor frame.
- G4 Actionability: FAIL — action is ambiguous.

**Strongest finding (from reviewee):** Writing the test is still valid.

**Gap from Outsider's frame:** Executor frame requires exactly one action.

**What I would add:** Nothing.

**Disposition:** Reject — frame violation.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Retry storm.

**Gap from Executor's frame:** No mitigation named.

**What I would add:** Wire breaker first.

**Disposition:** Accept — risk real.

## Phase 2.5 — Convergence check

No convergence.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 | G2 | G3 | G4 | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | PASS | full |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist     | PASS | PASS | PASS | PASS | full |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | FAIL | PASS | FAIL | FAIL | low |

### Recommendation
Rerun Executor.

### Why this, not the alternatives
Executor violated frame.

### What each advisor got right
See above.

### Conditions on the recommendation
Rerun required.

### Next 60-minute action
Rerun the Executor pass with explicit one-action constraint.

### Confidence
Medium — four frames solid, one rerun needed.
