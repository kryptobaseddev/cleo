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

# Manifest alignment check: bundled into validate.py Tier 4. Use:
#   python validate.py <skill-dir> --manifest <manifest.json> --dispatch-config <dispatch-config.json>

# Progressive-disclosure depth check (T9684 — CI gate):
python ${CLAUDE_SKILL_DIR}/scripts/check_depth.py <skill-dir>

# Repo-wide depth sweep:
python ${CLAUDE_SKILL_DIR}/scripts/check_depth.py <repo-root> --all

# Allowlist audit (CI / cron — exit 1 on findings):
python ${CLAUDE_SKILL_DIR}/scripts/check_depth.py <skill-dir> --audit-allowlist
python ${CLAUDE_SKILL_DIR}/scripts/check_depth.py <skill-dir> --audit-allowlist --json
```

**Depth rule (T9684):** A skill PASSES when ANY of:

- SKILL.md body has ≥ 100 content lines, OR
- `references/` subdir has ≥ 3 markdown files, OR
- `manifest.json` `references[]` array enumerates ≥ 3 files (all on disk)

Pre-existing stubs are allowlisted with follow-up task IDs in
`scripts/check_depth.py::ALLOWLIST`. Gold-standard skills:
`ct-orchestrator` (9 refs) and `ct-skill-creator` (7 refs).

**Allowlist hygiene:** every entry carries `last_reviewed: YYYY-MM-DD HH:MM:SS`.
`check_depth.py` runs a silent background audit on every invocation and emits
WARNs to stderr for malformed or stale (> 30 days) entries. Use
`--audit-allowlist` for an explicit pass that exits 1 on any finding —
suitable for a CI cron job. The threshold is tunable via
`ALLOWLIST_STALE_DAYS` at the top of `check_depth.py`.

The depth check runs on every PR touching `packages/skills/skills/**`
via `.github/workflows/skills-depth-check.yml`.

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
2. **CLI Operation Syntax** — Are CLEO operations referenced with valid `cleo <command>` or `domain.operation` format?
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
Phase 3 is **delegated** — `ct-skill-validator` does static analysis; runtime
quality evals live in a dedicated skill (`skill-evaluator` preferred,
`ct-skill-creator` as legacy fallback).

> **Scope boundary:** `ct-skill-validator` is *static* — it checks structure,
> frontmatter, body, manifest, depth, ecosystem fit. For deep runtime A/B
> benchmarking, regression detection, and auto-improvement, the dispatcher
> below routes to `skill-evaluator`, which owns that workflow end-to-end.

The two eval files in `evals/` serve different purposes:
- `evals/trigger_queries.json` — trigger queries (does the description activate correctly?)
- `evals/quality_evals.json`   — output-quality scenarios (does the validator produce the right report?)

### Dispatch (no hardcoded cross-skill paths)

`scripts/run_quality_eval.py` uses `_skill_finder.py` to dynamically locate
the eval skill at runtime. It searches:

1. `$SKILL_FINDER_PATH` (colon-separated override)
2. Direct sibling of this skill
3. `<this-skill>/../../skills/<name>/` (CLEO / awesome-skills layouts)
4. Walk-up ancestors + their project-shaped children (cross-project)
5. `~/.claude/skills/<name>/`

Show what would be used (without running anything):
```bash
python ${CLAUDE_SKILL_DIR}/scripts/run_quality_eval.py --list
```

**Trigger accuracy** — does the skill description trigger correctly?
```bash
python ${CLAUDE_SKILL_DIR}/scripts/run_quality_eval.py <skill-dir> \
  --trigger --evals ${CLAUDE_SKILL_DIR}/evals/trigger_queries.json
```

**Quality eval** (with/without skill A/B + grading + blind comparison):
```bash
python ${CLAUDE_SKILL_DIR}/scripts/run_quality_eval.py <skill-dir> \
  --runs 3 --executor api \
  --evals ${CLAUDE_SKILL_DIR}/evals/quality_evals.json
```

When `skill-evaluator` is the resolved target, the wrapper drives its full
loop: generate → run → grade → aggregate → analyze → detect-regression →
propose. See `skill-evaluator/SKILL.md` for the workflow it actually
executes.

When `ct-skill-creator` is the resolved fallback, the wrapper invokes its
`run_eval.py` with the same arguments translated to its CLI shape.

### Manual A/B (if you want to drive runs yourself)

If you need direct control of how runs are spawned (e.g. inside a real
Claude Code session with subagent isolation), invoke the resolved eval
skill's scripts directly — locate them with:

```bash
EVAL_SKILL=$(python ${CLAUDE_SKILL_DIR}/scripts/_skill_finder.py skill-evaluator)
```

then drive that skill's documented workflow without any further hardcoded
paths in this file.

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
