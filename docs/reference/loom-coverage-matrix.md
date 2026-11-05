# LOOM Lifecycle × Skills Coverage Matrix

**Task:** T9661 (epic T9568 — E-SKILLS-LOOM-COVERAGE-AUDIT)
**Last updated:** 2026-05-19
**Source of truth (stage names):** `cleo lifecycle --help` → `research|consensus|architecture_decision|specification|decomposition|implementation|validation|testing|release|contribution`
**Source of truth (skill bindings):** [packages/skills/skills/manifest.json](../../packages/skills/skills/manifest.json) → `dispatch_matrix.by_protocol`

---

## Summary

| Metric | Count | Notes |
|---|---|---|
| Total LOOM stages | 10 | research, consensus, architecture_decision, specification, decomposition, implementation, validation, testing, release, contribution |
| Stages with bound skill | 10 | full coverage after T9670 (contribution binding) |
| Stages without skill | 0 | (was 1 — contribution — closed by T9670) |
| Skills without `loomStage` frontmatter | 0 | enforced by T9664 schema gate |
| Skills without `adrRefs` frontmatter | 0 | enforced by T9665 schema gate |
| Cross-cutting protocols (non-stage) | 3 | `artifact-publish`, `provenance`, `agent-protocol` — excluded from the 10-stage gate |
| Naming drift findings | 1 | `architecture_decision` (lifecycle CLI, underscored) vs historical `architecture-decision` (manifest protocol, dashed) — reconciled in T9672 to underscored form |

---

## Stage × Skill × ADR Coverage

The 10 rows below are the canonical LOOM stages emitted by `cleo lifecycle start|complete|skip|gate` (see `packages/core/src/lifecycle/`). Skill names match `dispatch_matrix.by_protocol` in `packages/skills/skills/manifest.json`. ADR references are the **governing** ADRs each skill MUST cite in its SKILL.md per T9665.

| # | LOOM stage | Bound skill | `manifest.json` protocol key | Depth status | Governing ADRs |
|---|---|---|---|---|---|
| 1 | `research` | `ct-research-agent` | `research` | full | ADR-023 (protocol-validation-dispatch), ADR-070 (three-tier-orchestration) |
| 2 | `consensus` | `ct-consensus-voter` | `consensus` | full | ADR-015 (multi-contributor-architecture), ADR-023 (protocol-validation-dispatch) |
| 3 | `architecture_decision` | `ct-adr-recorder` | `architecture_decision` *(was `architecture-decision` pre-T9672)* | full | ADR-053 (playbook-runtime), ADR-070 (three-tier-orchestration) |
| 4 | `specification` | `ct-spec-writer` | `specification` | full | ADR-014 (rcasd-rename-and-protocol-validation), ADR-023 (protocol-validation-dispatch) |
| 5 | `decomposition` | `ct-epic-architect` | `decomposition` | full | ADR-066 (task-taxonomy-consolidation), ADR-073 (above-epic-naming) |
| 6 | `implementation` | `ct-task-executor` | `implementation` | full | ADR-070 (three-tier-orchestration), ADR-062 (worktree-merge-not-cherry-pick) |
| 7 | `validation` | `ct-validator` | `validation` | full | ADR-051 (programmatic-gate-integrity), ADR-023 (protocol-validation-dispatch) |
| 8 | `testing` | `ct-ivt-looper` | `testing` | full | ADR-051 (programmatic-gate-integrity), ADR-061 (project-agnostic-verify-tools) |
| 9 | `release` | `ct-release-orchestrator` | `release` | full | ADR-053 (project-agnostic-release-pipeline), ADR-063 (release-pipeline), ADR-065 (pr-required-release-flow) |
| 10 | `contribution` | `ct-contribution` *(bound by T9670)* | `contribution` | full | ADR-015 (multi-contributor-architecture), ADR-053 (playbook-runtime) |

**Depth status legend:**

- **full** — SKILL.md > 100 LOC, frontmatter present, body covers protocol invariants + integration + anti-patterns.
- **stub** — SKILL.md present but skeletal (≤ 100 LOC or missing required sections).
- **missing** — no SKILL.md at all (zero stages today).

---

## ADR Bindings Section (governs T9665)

This section is the canonical mapping the `ct-skill-validator` build gate consults when checking the `adrRefs` frontmatter array on every LOOM-stage skill.

| Stage | Skill | Required `adrRefs` entries (minimum) | Optional / stage-specific |
|---|---|---|---|
| research | ct-research-agent | `ADR-023`, `ADR-070` | ADR-048 (memory-extraction-pipeline) |
| consensus | ct-consensus-voter | `ADR-015`, `ADR-023` | ADR-070 |
| architecture_decision | ct-adr-recorder | `ADR-053`, `ADR-070` | ADR-014, ADR-023 |
| specification | ct-spec-writer | `ADR-014`, `ADR-023` | — |
| decomposition | ct-epic-architect | `ADR-066`, `ADR-073` | ADR-070 |
| implementation | ct-task-executor | `ADR-070`, `ADR-062` | ADR-051 |
| validation | ct-validator | `ADR-051`, `ADR-023` | — |
| testing | ct-ivt-looper | `ADR-051`, `ADR-061` | — |
| release | ct-release-orchestrator | `ADR-053`, `ADR-063`, `ADR-065` | ADR-026 (release-system-consolidation) |
| contribution | ct-contribution | `ADR-015`, `ADR-053` | ADR-073 |

The validator MUST verify (a) each referenced ADR file exists under `.cleo/adrs/` and (b) the `adrRefs` frontmatter array on each canonical LOOM-stage skill is a superset of the **Required** column above.

---

## Boundary Clarifications (governs T9675)

The validation and testing stages are adjacent but **not interchangeable**. T9675 codifies the boundary in both SKILL.md files; this section is the matrix-level authoritative summary.

| Aspect | `ct-validator` (validation stage) | `ct-ivt-looper` (testing stage) |
|---|---|---|
| Stage in LOOM lifecycle | `validation` (stage 7) | `testing` (stage 8) |
| What it does | Schema, compliance, and audit verification of **static artifacts** (specs, manifests, JSON Schema, ADR markdown structure, RFC 2119 keyword usage). | Autonomous **dynamic** Implement→Validate→Test loop on a git worktree; framework-detect; iterate until convergence. |
| Input | A specification, schema, or document. | A worktree containing implementation + spec + test framework config. |
| Output | Pass/fail compliance report. | Convergence report (`ivtLoopConverged`, `framework`, `testsRun`, `testsPassed`, `testsFailed`, iterations). |
| Out of scope | Does NOT execute test loops. Chains to `ct-ivt-looper` when dynamic verification is required. | Does NOT do schema/RFC-2119/spec-document audit. Chains to `ct-validator` for post-test compliance checks. |
| Chain direction | `ct-validator` → `ct-ivt-looper` (validation finds spec gaps; ivt-looper iterates on them). | `ct-ivt-looper` → `ct-validator` (after a green loop, validator audits the resulting artifacts). |
| Governing ADR | ADR-051 (programmatic-gate-integrity), ADR-023 (protocol-validation-dispatch) | ADR-051 (programmatic-gate-integrity), ADR-061 (project-agnostic-verify-tools) |

**Rule of thumb:** If the artifact under inspection is **text on disk** (spec, JSON, ADR markdown), use `ct-validator`. If the artifact is **code that runs** (and the framework is auto-detectable), use `ct-ivt-looper`.

---

## Naming Drift Findings (governs T9672)

The lifecycle CLI source of truth (`packages/core/src/lifecycle/`) emits stage names with **underscores**:

```
research|consensus|architecture_decision|specification|decomposition|implementation|validation|testing|release|contribution
```

Historically `packages/skills/skills/manifest.json` `dispatch_matrix.by_protocol` used the **dashed** form `architecture-decision` for stage 3. Every other stage already matched the underscore-or-single-word form because no other stage name contains a separator.

**Decision (T9672):** Underscored form is authoritative since the lifecycle CLI is the runtime source of truth. The manifest is now aligned. The dashed form `architecture-decision` is retained as a soft alias in `dispatch_matrix.by_keyword` only, so legacy keyword-routed dispatch continues to resolve correctly.

A Vitest case under `packages/skills/skills/_shared/__tests__/` (added in T9672) asserts:

```
SET( cleo lifecycle stages )
==
SET( manifest.dispatch_matrix.by_protocol keys )
  − { "artifact-publish", "provenance", "agent-protocol" }   # non-stage cross-cutting protocols
```

Drift after this point is a CI-fail.

---

## Cross-link to Manifest

Every row in the **Stage × Skill × ADR** table above maps 1:1 to a key in [`packages/skills/skills/manifest.json` → `dispatch_matrix.by_protocol`](../../packages/skills/skills/manifest.json). To regenerate this matrix mechanically:

```bash
# Extract the protocol → skill map:
jq -r '.dispatch_matrix.by_protocol | to_entries[] | "\(.key)\t\(.value)"' \
  packages/skills/skills/manifest.json

# Extract LOOM lifecycle stages:
cleo lifecycle --help | grep -oE 'research[^"]*contribution'
```

Any divergence between those two outputs (after subtracting the three cross-cutting protocol keys) is a coverage gap and MUST be filed as a new T-LOOM-GAP-* task under epic T9568 or its successor.

---

## See also

- `.cleo/adrs/ADR-070-three-tier-orchestration.md` — three-tier orchestration; LOOM stages map to the wave model
- `.cleo/adrs/ADR-073-above-epic-naming.md` — Saga/Epic/Task/Subtask hierarchy; LOOM stages run inside an Epic
- `.cleo/adrs/ADR-053-playbook-runtime.md` — `.cantbook` playbook state machine; LOOM stages are its nodes
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` — evidence atoms that satisfy each stage's completion gate
- `packages/skills/skills/manifest.json` — bindings (`dispatch_matrix.by_protocol`)
- `packages/skills/skills/_shared/` — shared task-system integration that all skills reuse
