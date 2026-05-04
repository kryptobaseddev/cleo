# The Council — Should we add a retry-on-timeout wrapper to outbound HTTP calls?

## Evidence pack

1. `packages/core/src/http.ts:L12-L58` — current httpGet/httpPost.
2. `packages/core/src/circuit-breaker.ts` — exists with zero callers.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong.

**Evidence anchored:**
- commit `a1b2c3d`.
- `packages/core/src/http.ts`.

**Verdict from this lens:** Risk.

**Single sharpest point:** Retry wrapper reproduces old bug.

### Advisor: First Principles

**Frame:** Atoms.

**Evidence anchored:**
- RFC 7231.
- `http.ts`.

**Verdict from this lens:** Incomplete.

**Single sharpest point:** Idempotency required.

### Advisor: Expansionist

**Frame:** Upside.

**Evidence anchored:**
- `circuit-breaker.ts`.
- `MEMORY.md`.

**Verdict from this lens:** Upside missed.

**Single sharpest point:** Wire the breaker.

### Advisor: Outsider

**Frame:** Stranger.

**Evidence anchored:**
- `circuit-breaker.ts`.
- `ADR-021`.

**Verdict from this lens:** Preparation unfinished.

**Single sharpest point:** ADR precondition already met.

### Advisor: Executor

**Frame:** Action.

**Evidence anchored:**
- `http.test.ts`.
- `circuit-breaker.ts`.

**The action (one):**
Write failing test.

**Expected outcome (60 minutes from now):**
Test exists.

**What this unblocks:**
Implementation.

**Verdict from this lens:** Pin first.

**Single sharpest point:** Write the test.

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

**Strongest finding (from reviewee):** Asset.

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
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Test.

**Gap from Outsider's frame:** None.

**What I would add:** Nothing.

**Disposition:** Accept — holds.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — specific.
- G2 Evidence grounding: PASS — cited.
- G3 Frame integrity: PASS — in lane.
- G4 Actionability: PASS — decidable.

**Strongest finding (from reviewee):** Retry storm.

**Gap from Executor's frame:** No mitigation.

**What I would add:** Wire breaker first.

**Disposition:** Accept — real.

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
| Executor         | PASS | PASS | PASS | PASS | full |

### Recommendation
Ship with conditions.

### Why this, not the alternatives
Thin evidence pack limits confidence.

### What each advisor got right
Various.

### Conditions on the recommendation
Expand the evidence pack.

### Next 60-minute action
Run git log -20 in packages/core/ to expand the evidence pack before re-running.

### Confidence
Low — evidence pack underspecified.
