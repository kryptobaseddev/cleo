# Acceptance Criteria Mapping

Every CLEO task ships with explicit acceptance criteria (ACs) — usually
3-6 pipe-separated entries on the task's `acceptance` field. The executor's
job is to map each AC to a verifiable deliverable, exercise it, and report
the mapping in the manifest. This reference defines the mapping discipline.

## Read the Whole AC Set First

Before touching code, run `cleo show <TASK_ID>` and copy the full `acceptance`
array into your scratch notes. Do not start with a partial reading — ACs
interact, and some only make sense in light of others.

Example AC set (from T9660):

```text
1. packages/skills/skills/ct-research-agent/references/ created with 4 files (...)
2. each reference doc is >=50 lines of genuine multi-source research guidance (...)
3. SKILL.md updated to link references via standard 'See references/' resolution pattern
4. packages/skills/skills/manifest.json references array updated to enumerate all reference files
5. skill body >=10K bytes per gold standard; load-time token budget verified <=8000
6. Code placed in packages/skills/ per Package-Boundary Check - verified against AGENTS.md
```

This task has six ACs — three structural (1, 4, 6), two content-quality
(2, 5), and one cross-link (3). The implementation must touch all of them.

## Build a Mapping Table

For each AC, identify the deliverable and the verification mechanism.
Write the table to your scratch first — do not start implementing until
every AC has a row.

| AC | Deliverable | Verification |
|----|-------------|--------------|
| AC1 | 4 .md files under references/ | `ls` + filename match |
| AC2 | ≥50 lines each, genuine content | `wc -l` + manual review |
| AC3 | SKILL.md footer with "See references/" | grep for footer block |
| AC4 | manifest.json `references` array populated | `jq` extract + length |
| AC5 | Skill body ≥10K bytes | `wc -c packages/.../SKILL.md` |
| AC6 | Files placed in packages/skills/ | path inspection |

The verification column MUST yield a yes/no answer — not "looks good".
If an AC cannot be reduced to a mechanical check, push back to the
orchestrator: "AC-N is not testable; please clarify the success
condition."

## AC Categories and Standard Verifications

| Category | Signal phrases | Standard verification |
|----------|----------------|----------------------|
| Existence | "created", "added", "exists" | `ls`, `stat`, `[ -f path ]` |
| Count | "with N files", "≥3 entries" | `find -type f | wc -l` |
| Length/size | "≥50 lines", "≥10K bytes" | `wc -l`, `wc -c` |
| Linkage | "linked from", "referenced in" | `grep -F` |
| Tests pass | "all tests pass", "no regressions" | `pnpm run test` |
| Lint clean | "biome check passes" | `pnpm biome check .` |
| Build clean | "compiles", "type-checks" | `pnpm run build && pnpm run typecheck` |
| Spec match | "satisfies REQ-NNN" | manual trace + test |
| Boundary | "placed in packages/X per Package-Boundary Check" | path inspection |
| Provenance | "commit message includes task ID" | `git log --grep=<TID>` |

When an AC mentions "Package-Boundary Check", you MUST cite the AGENTS.md
section by name in the manifest's `key_findings` — the orchestrator
greps for that compliance phrase.

## Acceptance Criteria Anti-Patterns

These shapes signal that the AC needs refinement before execution.

| Anti-pattern AC | Why it fails | What to ask the orchestrator |
|-----------------|--------------|------------------------------|
| "Implementation works as expected" | Not testable | What is the expected behavior? |
| "User experience improved" | Subjective | Which metric should improve and by how much? |
| "Performance is good" | No baseline | What's the target latency / throughput? |
| "Documentation updated" | Which docs? | Specific file paths or section names? |
| "No regressions" | Whole-suite test or focused? | Which test files must pass? |

When an AC is fuzzy, push back BEFORE starting. The orchestrator can
refine the AC; rework caused by guessing the AC is much more expensive.

## Pre-Flight: AC → Test Mapping

Before writing implementation code, for each AC that mentions testable
behavior, identify or create the test that exercises it.

```bash
# AC-7: "the new release-plan verb errors with E_VALIDATION on missing --epic"

# Find existing test file
find packages/cleo -path '*/release-plan*' -name '*.test.ts'

# If no test exists yet, create the skeleton
cat > packages/cleo/__tests__/release-plan.test.ts <<'EOF'
import { describe, it, expect } from "vitest";
describe("release-plan", () => {
  it("errors with E_VALIDATION on missing --epic", () => {
    // RED — test fails until handler exists
  });
});
EOF
```

Run the test now — it should fail (the implementation is not there yet).
This confirms your mapping: the test exercises the right AC.

## During Implementation

Keep the mapping table open in your scratch. After each significant edit,
re-run the verification for the AC you just touched. Do not let mappings
drift — if you discover an AC requires a different deliverable than you
planned, update the table BEFORE making the change.

## Post-Implementation: AC Verification Walkthrough

Before calling `cleo verify` or `cleo complete`, execute every verification
in the table.

```bash
# AC1: 4 files exist
ls packages/skills/skills/ct-research-agent/references/ | wc -l
# expect: 4

# AC2: each ≥50 lines
wc -l packages/skills/skills/ct-research-agent/references/*.md
# expect: each line count >= 50

# AC3: SKILL.md has footer
grep -q "## See references/" packages/skills/skills/ct-research-agent/SKILL.md
# expect: exit 0

# AC4: manifest.json references array populated
jq '.skills[] | select(.name=="ct-research-agent") | .references | length' \
  packages/skills/skills/manifest.json
# expect: 4

# AC5: skill body ≥10K bytes
wc -c packages/skills/skills/ct-research-agent/SKILL.md
# expect: byte count >= 10000

# AC6: path inspection
echo "All files under packages/skills/ — confirms Package-Boundary Check"
```

## Manifest Reporting

The pipeline_manifest entry's `key_findings` MUST report AC outcomes
concisely. Use this shape:

```json
{
  "key_findings": [
    "AC1-4 met: 4 reference files created (triggers, source, citation, anti-patterns)",
    "AC2 met: line counts 116/93/140/154 (all >=50)",
    "AC3-4 met: SKILL.md footer added; manifest references[] populated",
    "AC5 verified: skill body 11.2KB",
    "AC6 verified: all files under packages/skills/ per AGENTS.md"
  ]
}
```

If any AC failed or was partial, surface it. Silent partial completion
breaks the orchestrator's rollup logic.
