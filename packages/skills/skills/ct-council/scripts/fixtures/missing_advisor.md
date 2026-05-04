# The Council — Should we add a retry-on-timeout wrapper to outbound HTTP calls?

## Evidence pack

1. `packages/core/src/http.ts:L12-L58` — current httpGet/httpPost; no retry logic.
2. `packages/core/src/circuit-breaker.ts` — exists with zero callers.
3. commit `a1b2c3d "drop retries from http client"` — retries removed 18 months ago.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong.

**Evidence anchored:**
- commit `a1b2c3d` — retries were pulled for a documented reason.
- `packages/core/src/http.ts` — zero per-caller rate limits.

**Findings:**
1. Retry storm risk.

**Verdict from this lens:** Plan re-introduces known incident class.

**Single sharpest point:** Retry wrapper without breaker reproduces old bug.

### Advisor: First Principles

**Frame:** Ignore everything that was said.

**Evidence anchored:**
- RFC 7231 — HTTP POST semantics.
- `packages/core/src/http.ts:L12-L58`.

**Verdict from this lens:** Plan is incomplete.

**Single sharpest point:** Non-idempotent requests cannot be blindly retried.

### Advisor: Expansionist

**Frame:** Forget the constraints.

**Evidence anchored:**
- `packages/core/src/circuit-breaker.ts`.
- `MEMORY.md`.

**Verdict from this lens:** Owner thinking too small.

**Single sharpest point:** Wire the circuit breaker for asymmetric upside.

### Advisor: Executor

**Frame:** Don't analyze.

**Evidence anchored:**
- `packages/core/test/http.test.ts`.
- `packages/core/src/circuit-breaker.ts`.

**The action (one):**
Write a failing test.

**Expected outcome (60 minutes from now):**
New test file.

**What this unblocks:**
Test-first implementation.

**Verdict from this lens:** Pin design before prose.

**Single sharpest point:** Write the test.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — finding is specific.
- G2 Evidence grounding: PASS — cites sources.
- G3 Frame integrity: PASS — stayed in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Idempotency atom.

**Gap from Contrarian's frame:** No incident class named.

**What I would add:** Data-integrity hazard.

**Disposition:** Accept — holds up.

## Phase 2.5 — Convergence check

No convergence.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 | G2 | G3 | G4 | Weight |
|---|---|---|---|---|---|
| Contrarian | PASS | PASS | PASS | PASS | full |

### Recommendation
Do not ship.

### Why this, not the alternatives
Incomplete run.

### What each advisor got right
Incomplete.

### Conditions on the recommendation
Unconditional.

### Next 60-minute action
Rerun the council with the Outsider included.

### Confidence
Low — incomplete advisor coverage.
