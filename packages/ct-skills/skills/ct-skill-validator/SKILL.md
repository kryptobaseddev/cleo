---
name: ct-skill-validator
description: Validates an existing skill folder against the full CLEO standard and ecosystem. Use when auditing skills for structural compliance, verifying a skill fits into the CLEO ecosystem and constitution, running quality A/B evals, or preparing a skill for distribution. Runs a 3-phase validation loop — structural, ecosystem fit, and quality eval — then presents all findings as an HTML report opened in the user's browser. Iterates until all required phases pass.
disable-model-invocation: true
allowed-tools: Bash(python *)
---

# CLEO Skill Validator

Full 3-phase validation loop for CLEO skills. Every phase must reach PASS before the skill
is considered ecosystem-ready. Run the phases in order and iterate on failures.

**Always end with the HTML report** — the final deliverable to the user is the combined report
opened in their browser, not terminal output.

---

## Phase 1: Structural Compliance (Iterate to Zero Errors)

Run `validate.py` until the result is `PASS` or `PASS (with warnings)` with 0 errors.
Warnings are acceptable; errors are not. Fix errors and re-run.

```bash
# Full gauntlet — text output
python ${CLAUDE_SKILL_DIR}/scripts/validate.py <skill-dir>

# With manifest checks (Tier 4):
python ${CLAUDE_SKILL_DIR}/scripts/validate.py <skill-dir> \
  --manifest <manifest.json> --dispatch-config <dispatch-config.json>

# JSON output (for scripting):
python ${CLAUDE_SKILL_DIR}/scripts/validate.py <skill-dir> --json

# Deep body quality audit (optional, run alongside validate.py):
python ${CLAUDE_SKILL_DIR}/scripts/audit_body.py <skill-dir>

# Manifest alignment check:
python ${CLAUDE_SKILL_DIR}/scripts/check_manifest.py <skill-dir> <manifest.json>
```

**Iteration rule**: If errors > 0, fix them in the skill's SKILL.md, re-run `validate.py`.
Repeat until errors = 0. Do not proceed to Phase 2 while errors remain.

**Validation tiers:**
- Tier 1 — Structure: SKILL.md exists, frontmatter parseable, no CLEO-only fields
- Tier 2 — Frontmatter Quality: name matches dir, description has trigger indicators
- Tier 3 — Body Quality: length, no placeholder text, file references exist on disk
- Tier 4 — CLEO Integration: manifest and dispatch-config alignment (optional)
- Tier 5 — Provider Compatibility: provider-skills-map check (optional)

See [references/validation-rules.md](references/validation-rules.md) for full rule set.

---

## Phase 2: CLEO Ecosystem Compliance (Iterate to PASS)

Checks whether the skill's intent and purpose fit into the CLEO ecosystem — the 10 canonical
domains, canonical verbs, RCASD-IVTR+C lifecycle, and the CLEO Operation Constitution.

**Step 1: Extract skill context**
```bash
python ${CLAUDE_SKILL_DIR}/scripts/check_ecosystem.py <skill-dir> --output context.json
```

This extracts: CLEO operations referenced, domains mentioned, lifecycle stages, deprecated
verb usage, and direct data manipulation patterns.

**Step 2: Run the ecosystem-checker agent**

Invoke the ecosystem-checker agent with the context package:

```
Inputs:
  - context.json (from Step 1)
  - references/cleo-ecosystem-rules.md (the 8 rules)
  - The skill's SKILL.md (for full body reading)

Agent file: ${CLAUDE_SKILL_DIR}/agents/ecosystem-checker.md

Output: ecosystem-check.json
```

The checker evaluates 8 rules from [references/cleo-ecosystem-rules.md](references/cleo-ecosystem-rules.md):

1. **Domain Fit** — Does the skill serve at least one of the 10 canonical CLEO domains?
2. **MCP Operation Syntax** — Are CLEO operations referenced with valid `domain.operation` format?
3. **Canonical Verb Compliance** — No deprecated verbs (create, get, search as verb)
4. **Non-Duplication** — Skill isn't a thin wrapper over a single existing CLEO operation
5. **Data Integrity** — No direct `.cleo/` file editing instructions
6. **Lifecycle Alignment** — Skill aligns with relevant RCASD-IVTR+C stages
7. **Purpose Clarity** — Skill has a specific, bounded, genuinely useful purpose
8. **Tools Alignment** — `allowed-tools` matches what the skill actually needs

**Iteration rule**: If ecosystem-check.json contains `"verdict": "FAIL"`, address each ERROR-severity
rule finding, fix the skill content, re-run check_ecosystem.py, re-run the ecosystem-checker agent.
Repeat until verdict is `PASS` or `PASS_WITH_WARNINGS`. WARN is acceptable; ERROR is not.

---

## Phase 3: Quality A/B Eval

Tests whether the skill actually improves agent output quality vs. no skill context.
Uses the eval infrastructure from ct-skill-creator.

**Trigger accuracy** — does the skill description trigger correctly?
```bash
python ${CLAUDE_SKILL_DIR}/../ct-skill-creator/scripts/run_eval.py \
  --eval-set ${CLAUDE_SKILL_DIR}/evals/eval_set.json \
  --skill-path ${CLAUDE_SKILL_DIR}
```

**Optimize description** (if trigger accuracy < 80%):
```bash
python ${CLAUDE_SKILL_DIR}/../ct-skill-creator/scripts/run_loop.py \
  --eval-set ${CLAUDE_SKILL_DIR}/evals/eval_set.json \
  --skill-path ${CLAUDE_SKILL_DIR} \
  --model claude-sonnet-4-6 \
  --max-iterations 5
```
`run_loop.py` opens a live HTML accuracy report in the browser automatically.

**Quality eval** (with/without skill A/B):
1. Spawn two agents in the SAME turn: one WITH skill context loaded, one WITHOUT (baseline)
2. Give both the same task prompt from [evals/evals.json](evals/evals.json)
3. Grade each with the grader agent → `grading.json`:
   `${CLAUDE_SKILL_DIR}/../ct-skill-creator/agents/grader.md`
4. Blind A/B comparison with the comparator agent → `comparison.json`:
   `${CLAUDE_SKILL_DIR}/../ct-skill-creator/agents/comparator.md`
5. Post-hoc analysis with the analyzer agent → `analysis.json`:
   `${CLAUDE_SKILL_DIR}/../ct-skill-creator/agents/analyzer.md`
6. Serve the full eval review:
   `python ${CLAUDE_SKILL_DIR}/../ct-skill-creator/eval-viewer/generate_review.py <workspace-dir>`
   (Opens browser at localhost:3117)

See [references/validation-rules.md](references/validation-rules.md) and
`${CLAUDE_SKILL_DIR}/../ct-skill-creator/references/schemas.md` for JSON output schemas.

---

## Final: Generate and Present HTML Report

After completing all phases, generate the unified report and open it in the browser.

```bash
# Minimum — Phase 1 only:
python ${CLAUDE_SKILL_DIR}/scripts/generate_validation_report.py <skill-dir> --no-open --output report.html

# With ecosystem check:
python ${CLAUDE_SKILL_DIR}/scripts/generate_validation_report.py <skill-dir> \
  --ecosystem-check ecosystem-check.json --no-open --output report.html

# Full 3-phase report:
python ${CLAUDE_SKILL_DIR}/scripts/generate_validation_report.py <skill-dir> \
  --ecosystem-check ecosystem-check.json \
  --grading grading.json \
  --comparison comparison.json \
  --audit \
  --output report.html
```

**Tell the user:**
- The path to report.html (so they can revisit or share it)
- The Phase 1/2/3 verdict for each phase
- Which specific errors or warnings remain
- What to fix if any phase is FAIL

Open the report in the browser: omit `--no-open` (default behaviour opens browser automatically).

---

## Self-Validation

This skill validates itself. To validate ct-skill-validator:

```bash
python ${CLAUDE_SKILL_DIR}/scripts/validate.py ${CLAUDE_SKILL_DIR}
python ${CLAUDE_SKILL_DIR}/scripts/check_ecosystem.py ${CLAUDE_SKILL_DIR} | cat
```
