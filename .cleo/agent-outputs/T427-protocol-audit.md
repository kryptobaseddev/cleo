# T427 Protocol Audit — CANT Files

**Task**: T427 | **Epic**: T382 | **Umbrella**: T377
**Audited**: 2026-04-08 | **Auditor**: wave-hygiene-worker

---

## Summary

| Metric | Count |
|--------|-------|
| Total protocol files | 12 |
| TS validators present | 12/12 |
| Missing `consult-when` | 12 (all — patched in T428) |
| Missing `stage:` binding | 12 (all — patched in T428) |
| Missing `@task` tag | 2 (`artifact-publish`, `provenance`) |
| Missing `input:` schema | 12 (all — patched in T428) |
| Missing `output:` contract | 12 (all — patched in T428) |
| Fully compliant before T428 | 0 |
| Fully compliant after T428 | 12 |

---

## Protocol-by-Protocol Status

### architecture-decision.cant

- **ID**: ADR | **Stage**: architecture-decision | **Skill**: ct-adr-recorder
- **TS Validator**: architecture-decision.ts ✅
- **@task provenance**: T4798 ✅ (T428 added)
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### artifact-publish.cant

- **ID**: ART | **Stage**: release | **Skill**: ct-artifact-publisher
- **TS Validator**: artifact-publish.ts ✅
- **@task provenance**: ❌ → T428 added `@task T428`
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`, `@task`

### consensus.cant

- **ID**: CONS | **Stage**: consensus | **Skill**: ct-consensus-voter
- **TS Validator**: consensus.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### contribution.cant

- **ID**: CONT | **Stage**: cross-cutting | **Skill**: ct-contribution
- **TS Validator**: contribution.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### decomposition.cant

- **ID**: DCMP | **Stage**: decomposition | **Skill**: ct-epic-architect
- **TS Validator**: decomposition.ts ✅
- **@task provenance**: T3155 ✅ (provenanceTask field)
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### implementation.cant

- **ID**: IMPL | **Stage**: implementation | **Skill**: ct-task-executor
- **TS Validator**: implementation.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### provenance.cant

- **ID**: PROV | **Stage**: release | **Skill**: ct-provenance-keeper
- **TS Validator**: provenance.ts ✅
- **@task provenance**: ❌ → T428 added `@task T428`
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`, `@task`

### release.cant

- **ID**: REL | **Stage**: release | **Skill**: ct-release-orchestrator
- **TS Validator**: release.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### research.cant

- **ID**: RSCH | **Stage**: research | **Skill**: ct-research-agent
- **TS Validator**: research.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### specification.cant

- **ID**: SPEC | **Stage**: specification | **Skill**: ct-spec-writer
- **TS Validator**: specification.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### testing.cant

- **ID**: TEST | **Stage**: testing | **Skill**: ct-ivt-looper
- **TS Validator**: testing.ts ✅
- **@task provenance**: T260 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

### validation.cant

- **ID**: VALID | **Stage**: validation | **Skill**: ct-validator
- **TS Validator**: validation.ts ✅
- **@task provenance**: T3155 ✅
- **Gaps patched (T428)**: `consult-when`, `stage:`, `input:`, `output:`

---

## T429 Skill Dedupe Findings

- **Orphan skills** (in directory, not in manifest.json): `ct-codebase-mapper`, `ct-grade-v2-1`, `ct-memory`, `ct-skill-validator`, `ct-stickynote`
- **True duplicate**: `ct-grade-v2-1` — same `name: ct-grade` as `ct-grade/`, version 2.1.0 vs 1.0.0, fuller content (235 vs 196 lines)
- **Action**: Merged fuller description/frontmatter from `ct-grade-v2-1` into `ct-grade/SKILL.md` (promoted to v2.1.0). Left `MIGRATION.md` at `ct-grade-v2-1/`.
- **Not merged** (different purposes, not duplicates): `ct-memory` (brain recall), `ct-stickynote` (ephemeral notes), `ct-codebase-mapper` (stack analysis), `ct-skill-validator` (skill QA) — these are distinct capabilities without manifest registration.
