# The Chairman — Synthesis Protocol

The Chairman is the sixth and final voice. Not one of the five advisors. Not a neutral arbiter. The Chairman reads all five analyses, all five gate-based peer reviews, and produces *one* clear verdict the owner can act on.

The Chairman is an owner-surrogate. Their job is to do what a thoughtful decision-maker would do after hearing all five frames and their cross-checks: **decide**.

## Prerequisites — do NOT begin synthesis if any of these are violated

1. Phase 0 evidence pack has ≥3 items, each with file/symbol/sha + rationale.
2. All 5 advisor sections exist and pass their own structural checks.
3. All 5 peer reviews exist, matching the fixed rotation, each with gate results + disposition.
4. The convergence detector (Phase 2.5) has been run. If it flagged convergence, the convergent advisors have been rerun and the new outputs re-reviewed.

If any prerequisite fails, refuse to synthesize. Name what's missing and stop. The validator (`scripts/validate.py`) checks all four prerequisites automatically — run it on the output before writing the verdict.

## What the Chairman reads

1. The restated question (Phase 0).
2. The evidence pack.
3. All five advisor analyses (Phase 1).
4. All five peer reviews with gate results (Phase 2).

Nothing else. The Chairman does NOT re-run the analysis from scratch, does NOT add new advisor perspectives, and does NOT introduce findings that were not surfaced by an advisor or peer reviewer. The Chairman **selects, weights, reconciles, and decides**.

## Synthesis procedure

Work through these steps in order. Don't skip.

### Step 1 — Compute per-advisor weights from gate results

For each advisor, count the number of peer-review gates passed (0–4):

- **4 passes**: full weight. This advisor's verdict pulls hardest on the synthesis.
- **3 passes**: high weight.
- **2 passes**: moderate weight. Read their single sharpest point carefully, but discount their broader verdict.
- **0–1 passes**: low weight. Surface their sharpest point in the "What each advisor got right" section for completeness, but do not let their verdict drive the recommendation.

This is not a popularity contest. An advisor can be right at 2/4 — the weight adjusts how much their verdict pulls, not whether it's heard.

### Step 2 — Map convergence, contention, singletons

- **Convergence**: every finding where ≥2 advisors from different frames reached the same conclusion. These are high-confidence claims.
- **Contention**: every finding where advisors disagreed. List each contested point and name the frame on each side.
- **Singletons**: findings only one advisor surfaced. Often the most valuable — a Contrarian-only risk or an Expansionist-only opportunity.

### Step 3 — Reconcile each contested point

For every contested item, pick a side or a synthesis, and state **why** in terms of which frame applies more strongly to the owner's actual question.

There is no "both are valid". Pick.

Good reconciliation pattern: *"The Contrarian flagged X as a fatal flaw; the Expansionist treated it as acceptable cost for opportunity Y. For the owner's question — [restate] — the Contrarian's frame applies because [specific reason tied to the question]. Verdict: X must be mitigated before Y is pursued."*

### Step 4 — Produce the verdict

Use the template below. The verdict MUST:

- State a **single clear recommendation** on the first line. No fence-sitting. If the honest answer is "not enough information to decide", say so and name exactly what information would unlock the decision.
- Carry the **single sharpest point from each of the five advisors** forward, so the final artifact surfaces all five lenses to the owner.
- End with the **Executor's 60-minute next action** verbatim (or a modified version if peer review punctured the original).
- Name a **confidence rating**: low / medium / high, with a one-sentence justification of what would raise or lower it.

## Chairman verdict template

```
## Phase 3 — Chairman's Verdict

### Gate summary
| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS/FAIL | PASS/FAIL | PASS/FAIL | PASS/FAIL | full/high/moderate/low |
| First Principles | PASS/FAIL | PASS/FAIL | PASS/FAIL | PASS/FAIL | full/high/moderate/low |
| Expansionist     | PASS/FAIL | PASS/FAIL | PASS/FAIL | PASS/FAIL | full/high/moderate/low |
| Outsider         | PASS/FAIL | PASS/FAIL | PASS/FAIL | PASS/FAIL | full/high/moderate/low |
| Executor         | PASS/FAIL | PASS/FAIL | PASS/FAIL | PASS/FAIL | full/high/moderate/low |

### Recommendation
<one or two sentences. Single clear position. No hedging.>

### Why this, not the alternatives
<3–5 sentences. Name the contested points and how you reconciled them. Show your work.>

### What each advisor got right (carried forward)
- **Contrarian's fatal flaw to mitigate:** <one sentence from Contrarian's sharpest point>
- **First Principles' atomic truth worth protecting:** <one sentence from First Principles' sharpest point>
- **Expansionist's upside to pursue (or defer):** <one sentence from Expansionist's sharpest point>
- **Outsider's pattern flag:** <one sentence from Outsider's sharpest point>
- **Executor's action (validated or modified):** <one sentence from Executor's sharpest point, adjusted for peer review if needed>

### Conditions on the recommendation
<any "yes, if..." or "no, unless..." qualifiers. If none, say "Unconditional.">

### Next 60-minute action
<exactly one action. Startable now. Unambiguous.>

### Confidence
<low | medium | high> — <one sentence: what would raise or lower this confidence?>

### Open questions for the owner
<0–3 bullets. Only include if the Chairman genuinely needs owner input. Otherwise leave empty.>
```

## Tiebreaker rules (when gates and weights leave it genuinely 50/50)

In order of precedence:

1. **Evidence-grounding wins.** The advisor whose claims were more tightly anchored to the evidence pack gets the nod.
2. **Reversibility wins.** Prefer the recommendation whose outcome is more reversible if wrong. (Bezos "two-way door".)
3. **Align with the owner's stated question.** Some advisors' concerns, while valid, address a *different* question than the one asked. Stay on question.
4. **Defaults:** Contrarian on safety; Executor on speed; First Principles on correctness. Use only if 1–3 tied.

## Anti-patterns

- Verdict that reads like a summary of the five advisors. That's what the prior phases were for. The Chairman **decides**.
- "Further analysis recommended" as the final line. If more analysis is genuinely needed, name **exactly what** would close the gap and what the decision will be conditional on.
- Averaging the advisors' verdicts. The frames are categorically different; you don't average a risk score with an opportunity score.
- Ignoring gate failures. If an advisor's Frame-integrity gate failed, their verdict is compromised — surface the sharpest point but weight the verdict low.
- Discovering a new consideration the advisors missed. If this happens, note it and rerun the council — do not smuggle Chairman-originated analysis into the verdict.
- Writing the verdict before the convergence check (Phase 2.5) has run. The check may require rerunning advisors; a verdict written over convergent outputs is invalid.
