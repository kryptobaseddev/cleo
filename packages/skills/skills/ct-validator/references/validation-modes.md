# Validation Modes

`ct-validator` operates in four distinct modes. Each has different inputs,
different verification mechanics, and different report shape. The mode is
determined by the target type — the spawn prompt or task body MUST make
the mode explicit.

## Mode 1: Schema Validation

**Target.** A data instance (JSON, YAML, TOML, etc.) checked against a
schema (JSON Schema, Zod, drizzle/zod, ajv, JSON-LD).

**Inputs.**
- One or more data files (or stdin)
- A schema (file path or inline)
- Optional: schema dialect (draft-07, draft-2020-12, etc.)

**Mechanics.** Run the schema engine; collect every violation; classify
by JSON Path. Do not short-circuit on first failure — exhaustive
reporting is the whole value-add.

**Tool examples.**

```bash
# AJV (Node)
npx ajv validate -s schema.json -d data.json --spec=draft7

# Zod (Node, via project's contracts)
node -e "
  import { Schema } from '@cleocode/contracts';
  const result = Schema.safeParse(JSON.parse(input));
  if (!result.success) console.log(JSON.stringify(result.error.format()));
"

# jsonschema (Python)
python -m jsonschema -i data.json schema.json
```

**Report shape.** Each violation gets file + JSON Path + violated keyword
+ actual value + expected. Group by file when validating many instances.

## Mode 2: Code Compliance

**Target.** A code change (PR, diff, or working-tree state) checked
against project standards — lint rules, style guide, naming conventions,
import boundaries, type discipline.

**Inputs.**
- A diff (or branch comparison)
- The project's lint/format configs (biome.json, .eslintrc, clippy.toml)
- The relevant AGENTS.md / ADR rules

**Mechanics.** Run each tool; collect findings; classify by severity.
Aggregate the toolchain (biome + tsc + project-specific rules) into a
single report.

**Tool examples.**

```bash
# Biome (lint + format in one)
pnpm biome check . --reporter=json

# TypeScript strict
pnpm exec tsc -b --pretty false

# Custom AGENTS.md rule checks
grep -rn "catch (err: unknown)" packages/ --include='*.ts'
grep -rn ": any\b" packages/ --include='*.ts'

# Package-boundary check
find packages -name "*.ts" -exec grep -l "../../../" {} \;
```

**Report shape.** Each finding gets file + line + rule + severity + fix
suggestion. The AGENTS.md "INSTANT REJECTION" anti-patterns get
`critical` severity; biome warnings get `warning` severity.

## Mode 3: Document Validation

**Target.** A markdown document (spec, ADR, agent-output, skill) checked
against a structural standard — required sections, frontmatter, link
validity, style guide.

**Inputs.**
- The document(s) under validation
- The structural standard (e.g., "every spec MUST have RFC 2119
  boilerplate, REQ-NNN numbered requirements, and a Compliance section")
- The CLEO style guide (`packages/skills/skills/_shared/cleo-style-guide.md`)

**Mechanics.** Parse the document; check section presence; validate
links; scan for placeholder text; verify formatting.

**Tool examples.**

```bash
# Use the ct-skill-validator scripts as a model
python packages/skills/skills/ct-skill-validator/scripts/validate.py <skill-dir>
python packages/skills/skills/ct-skill-validator/scripts/audit_body.py <skill-dir>

# Generic markdown link check
markdown-link-check docs/specs/*.md

# Section presence check (ad-hoc)
for f in docs/specs/*.md; do
  grep -q "^## Compliance" "$f" || echo "FAIL: $f missing Compliance"
  grep -q "RFC 2119" "$f" || echo "FAIL: $f missing RFC 2119 boilerplate"
done
```

**Report shape.** Each finding gets file + section/line + violated rule
+ fix suggestion. Document-mode reports are the most useful when paired
with traceability — see Mode 4.

## Mode 4: Protocol Compliance

**Target.** An implementation checked against its specification — the
spec defines REQ-NNN, the implementation MUST satisfy each.

**Inputs.**
- The specification document (with traceability matrix)
- The implementation source
- The test suite (each REQ should have a verifying test)

**Mechanics.** For each REQ in the matrix, run the verifying test;
record pass/fail; record any REQs that lack a verifying test. Compute
compliance percentage.

**Tool examples.**

```bash
# Run the specific test for each REQ
pnpm vitest run --testNamePattern="REQ-001|REQ-002|REQ-003"

# Extract REQ→test map from the spec's traceability matrix
grep -E "^\| REQ-" docs/specs/foo-spec.md | awk -F'|' '{print $2, "->", $4}'

# Detect REQs without verification
grep -E "^\| REQ-.*\| \(TODO" docs/specs/foo-spec.md
```

**Report shape.** Compliance percentage + per-REQ pass/fail + list of
unverified REQs. This is the input to release-gate decisions.

## Mode Selection Cheat Sheet

| Signal in task description | Mode |
|----------------------------|------|
| "validate this JSON against schema X" | Schema |
| "check the PR for style violations" | Code |
| "review this spec for completeness" | Document |
| "verify the implementation satisfies the spec" | Protocol |
| "audit the release pipeline against ADR-065" | Protocol |
| "lint the changes" | Code |
| "validate the LAFS envelope" | Schema |
| "review the agent-output for style guide compliance" | Document |

## Mode Composition

A single task may chain modes. Example: "validate the new release-plan
implementation."

1. Mode 3 (Document) — does `docs/specs/release-plan-spec.md` have
   RFC 2119 boilerplate, numbered REQs, traceability matrix, compliance
   section?
2. Mode 4 (Protocol) — does the implementation pass each REQ's test?
3. Mode 2 (Code) — does the implementation's diff pass lint + typecheck?
4. Mode 1 (Schema) — do the LAFS envelopes the new code emits validate
   against the contract schema?

When composing, run the modes in this order — document → protocol →
code → schema. Each later mode assumes the earlier modes have passed,
so they bail early on irrelevant failures.

## Output Per Mode

| Mode | Status fields | Key metric |
|------|---------------|------------|
| Schema | `status: PASS|FAIL`, `violations: [...]` | violation count |
| Code | `status: PASS|FAIL`, `findings: [...]` | finding count by severity |
| Document | `status: PASS|FAIL`, `sections_missing: [...]` | missing-section count |
| Protocol | `status: PASS|PARTIAL|FAIL`, `compliance: X%`, `unverified: [...]` | compliance percentage |

All modes share the canonical report scaffold in SKILL.md — `## Summary`,
`## Checklist Results`, `## Issues Found`, `## Remediation`. Only the
content differs.
