# Shuffled Peer Review — Gate-Based Protocol

The peer review is where frames collide productively. An advisor reviewing another advisor's output does NOT play neutral judge — they evaluate from their own locked frame, which is exactly what makes the shuffle informative. The Contrarian reviewing First Principles means: "Zero-based analysis sounds clean, but here's the failure mode you introduced by stripping context."

This protocol replaces numeric scoring with **gate-based evaluation**. Each gate is pass/fail with required evidence. The reviewer must produce a quote or concrete citation to justify each gate decision. Theater ("4/5 — good") is structurally impossible.

## The rotation (fixed, do not deviate)

```
Contrarian       → reviews → First Principles
First Principles → reviews → Expansionist
Expansionist     → reviews → Outsider
Outsider         → reviews → Executor
Executor         → reviews → Contrarian
```

**Properties:**
- No self-review.
- Every advisor reviews exactly once and is reviewed exactly once.
- Single 5-cycle, not pairs — information flows around the full ring.

**Why this specific rotation:**
- *Contrarian → First Principles*: stress-tests whether atomic truths survive adversarial conditions.
- *First Principles → Expansionist*: grounds ambitious upside against what's actually true.
- *Expansionist → Outsider*: checks whether the cold-read missed an opportunity hiding in plain sight.
- *Outsider → Executor*: the stranger asks "why *that* action?" — if it only makes sense with backstory, the Executor picked wrong.
- *Executor → Contrarian*: forces risk analysis to cash out. Pure doom with no actionable mitigation is cheap.

## The four gates

Each gate is **strictly PASS or FAIL** — no middle states. The reviewer MUST provide the evidence the gate requires. A gate with no cited evidence is itself a validation failure.

**No PARTIAL / MIXED / CONDITIONAL / "PARTIAL PASS" / hedged values are allowed.** The validator rejects any gate line not matching `- G<N> <dimension>: PASS — <evidence>` or `- G<N> <dimension>: FAIL — <evidence>`.

If your judgment feels genuinely mixed — "the shape is right but the target is wrong", "it passes in spirit but not in letter", "mostly good except for one thing" — **pick FAIL** and express the nuance in the `Gap from <reviewer>'s frame` and `What I would add` fields. Those are exactly the fields the Chairman reads for texture. A FAIL with a rich gap note is more informative than a PARTIAL with thin justification, and it forces the reviewer to actually decide.

The test: would you act on this advisor's verdict as-written, unconditionally? If yes → PASS. If no, no matter why → FAIL, then explain the condition in the gap note.

### G1 — Rigor gate

**PASS** if every finding in the reviewee's "Findings" list has a named subject, predicate, and (where the frame requires it) trigger condition. The reviewer MUST quote the strongest-rigor finding and, if any finding fails, the weakest.

**FAIL** if any finding is hedged ("might", "could", "may" without concrete anchor), vague ("there are scalability concerns"), or missing the frame's required specifics (Contrarian without trigger condition; Executor without expected outcome; First Principles without atoms; Expansionist without asymmetry; Outsider without artifact citation).

### G2 — Evidence-grounding gate

**PASS** if every finding cites at least one item from the shared evidence pack, and every cited item actually exists in the pack. The reviewer MUST list all cited items.

**FAIL** if any finding is free-floating (no citation), cites an item not in the pack, or cites something that does not support the finding. The reviewer MUST list ungrounded or misgrounded findings.

### G3 — Frame-integrity gate

**PASS** if no finding belongs to another advisor's lane. The reviewer MUST read the reviewee's persona file's "Your lane vs. other advisors' lanes" section and confirm.

**FAIL** if any finding is something a different advisor would produce. The reviewer MUST name which frame the violating finding belongs to and quote the violating line.

### G4 — Actionability gate

**PASS** if the reviewee's verdict cashes out to a decision, a test, a change, or a concrete line of inquiry. The reviewer MUST quote the actionable part.

**FAIL** if the verdict is "interesting" but leaves the owner nowhere to go. "Further analysis is warranted" fails. "Reject the plan unless X is added" passes.

## Peer review output template

**Destination:** when invoked as a Phase 2 subagent, save your full peer-review output below to `<run-dir>/peer-<reviewer-slug>-on-<reviewee-slug>.md` via the `Write` tool, then return only a one-line confirmation including the gate-pass count and disposition (e.g. `Wrote peer-contrarian-on-first-principles.md — 4/4 PASS, Disposition: Accept`). Do not include the full peer-review text in your reply — the orchestrator reads it back from the file.

The gate-line format is **load-bearing** — `scripts/validate.py` parses these lines with a regex anchored to the canonical names below. Use them VERBATIM.

| Gate | Canonical line prefix | Common mistakes (rejected) |
|---|---|---|
| G1 | `- G1 Rigor: PASS \| FAIL — ...` | `G1 Rigor gate:`, `G1: Rigor:`, `G1 - Rigor:` |
| G2 | `- G2 Evidence grounding: PASS \| FAIL — ...` | `G2 Evidence-grounding gate:`, `G2: Evidence:` |
| G3 | `- G3 Frame integrity: PASS \| FAIL — ...` | `G3 Frame-integrity gate:`, `G3: Frame:` |
| G4 | `- G4 Actionability: PASS \| FAIL — ...` | `G4 Actionability gate:`, `G4: Actionability:` |

The section headers below ("G1 — Rigor gate") use "gate" as a label *for the section*; the *gate verdict line* never does. The validator rejects gate verdict lines with the "gate" suffix because they break the canonical regex.

```
### <reviewer> reviewing <reviewee>

**Gate results:**
- G1 Rigor: PASS | FAIL — <quote of strongest finding; if FAIL, quote weakest and explain>
- G2 Evidence grounding: PASS | FAIL — <list cited items; if FAIL, list ungrounded/misgrounded findings>
- G3 Frame integrity: PASS | FAIL — <confirm lane; if FAIL, name the violating frame and quote the violating line>
- G4 Actionability: PASS | FAIL — <quote the actionable part; if FAIL, explain what's missing>

**Strongest finding (from reviewee):**
<quote or close paraphrase of the one finding the reviewer thinks lands hardest, even from an opposing frame>

**Gap from <reviewer>'s frame:**
<the specific thing the reviewee missed that the reviewer's frame would have caught. Concrete — no "could have gone deeper".>

**What I would add:**
<one sentence from the reviewer's frame that sharpens or corrects the reviewee's analysis. Single value-add.>

**Disposition:** Accept | Modify | Reject — <one sentence why>
```

## Hard rules

- Reviewer MUST stay in their own frame. A Contrarian reviewing First Principles still looks for what breaks.
- Reviewer MUST NOT produce a second copy of their own analysis. They evaluate the reviewee *through* their lens; they do not redo the work.
- Agreement with the reviewee is allowed if it adds a cross-frame dimension ("the Contrarian confirms the atomic truth holds under adversarial pressure"). Pure agreement with no added dimension is a Frame-integrity violation — the reviewer did not do their job.
- Every gate must have its required evidence. A naked "PASS" with no quote is itself a protocol violation caught by the validator.
- **Disposition** forces a call: Accept, Modify, or Reject. No fence-sitting.

## Convergence check (Phase 2.5, before the Chairman)

After all five peer reviews complete, run the **convergence detector** before Phase 3:

1. Extract the "Single sharpest point" from each of the 5 advisors.
2. Pairwise-compare them. Are 3 or more semantically the same finding (same subject, same predicate)?
3. If yes → **convergence flag**. The advisor(s) with the lowest gate-pass count are suspected of frame drift. Rerun those advisors with explicit frame-reinforcement (re-read persona file, emphasize the "Your lane vs. other advisors' lanes" section) before proceeding to Chairman.
4. If no → proceed to Chairman.

**Why this exists:** in single-Claude mode, the same model produces all 5 advisor outputs in one response and they tend to rhyme. The convergence detector is the structural antibody.

**What "semantically the same" means:** if you can describe two findings with the same sentence and lose no essential content, they are convergent. "Retry storms are dangerous" and "the retry wrapper will cascade under load" are convergent. "Retry storms are dangerous" and "the plan omits idempotency classification" are not.

## What the Chairman extracts from peer reviews

- **Gate-pass count per advisor** (0–4). Advisors with 4/4 pass carry full weight. Advisors with gate failures are weighted proportionally down.
- **Disposition distribution**: how many Accept / Modify / Reject across the 5 reviews. A review ring that's all Accept signals either genuinely strong work or insufficient friction (check G3 Frame-integrity results).
- **Cross-frame additions**: the "What I would add" sentences — these often contain the material that makes the final verdict sharper than any single advisor.
- **Convergence flag** (if raised): triggers a rerun; do not synthesize until resolved.
