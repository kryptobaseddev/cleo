---
name: ct-spec-writer
description: Technical specification writing using RFC 2119 language for clear, unambiguous requirements. Creates protocol specifications, technical requirements, API specifications, and architecture documents with testable requirements and compliance criteria. Use when writing specifications, defining protocols, documenting requirements, or creating API contracts. Triggers on specification tasks, protocol definition needs, or requirement documentation.
version: 2.1.0
tier: 2
core: false
category: recommended
protocol: specification
loomStage: specification
adrRefs:
  - ADR-014
  - ADR-023
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Specification Writer Context Injection

**Protocol**: @src/protocols/specification.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for specification writing tasks spawned via cleo-subagent. Provides domain expertise for creating clear, unambiguous technical specifications using RFC 2119 language.

---

## Capabilities

1. **Protocol Specifications** - Define behavior rules with RFC 2119 keywords
2. **Technical Requirements** - Document system requirements with constraints
3. **API Specifications** - Define interfaces, schemas, and contracts
4. **Architecture Documents** - Document system design decisions

---

## RFC 2119 Keywords (MANDATORY)

Use these keywords with their precise meanings:

| Keyword | Meaning | Compliance |
|---------|---------|------------|
| **MUST** | Absolute requirement | 95-98% |
| **MUST NOT** | Absolute prohibition | 93-97% |
| **SHOULD** | Recommended unless good reason exists | 75-85% |
| **SHOULD NOT** | Discouraged unless good reason exists | 75-85% |
| **MAY** | Truly optional | 40-60% |

---

## Specification Structure

### Standard Layout

```markdown
# {Specification Title} v{X.Y.Z}

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document
are to be interpreted as described in RFC 2119.

---

## Overview

{2-3 sentence summary of what this spec defines}

---

## Definitions

| Term | Definition |
|------|------------|
| {term} | {definition} |

---

## Requirements

### {Category 1}

**REQ-001**: {Requirement description}
- Rationale: {Why this requirement exists}
- Verification: {How to verify compliance}

### {Category 2}

**REQ-002**: {Requirement description}
...

---

## Constraints

| ID | Constraint | Enforcement |
|----|------------|-------------|
| CON-001 | {constraint} | {how enforced} |

---

## Compliance

A system is compliant if:
1. {condition 1}
2. {condition 2}
3. {condition 3}

Non-compliant implementations SHOULD {remediation}.
```

---

## Writing Guidelines

### Be Precise
- Every requirement MUST be testable
- Avoid ambiguous terms ("appropriate", "reasonable", "adequate")
- Use specific values, not ranges when possible

### Be Complete
- Define all terms that might be misunderstood
- Cover error cases and edge conditions
- Specify what happens when requirements conflict

### Be Organized
- Group related requirements
- Use consistent numbering (REQ-XXX, CON-XXX)
- Cross-reference related sections

---

## Through SDK (preferred)

Specifications are first-class docs SSoT records — created via
`cleo docs add --type spec`, auto-attached to the parent task, and
addressable by a stable slug. This is the canonical write path; the
legacy "write to `docs/specs/<NAME>.md` and commit" pattern is
deprecated below.

### Write the spec attached to its parent task

```bash
cleo docs add T1234 docs/specs/auth-protocol.md \
  --type spec \
  --slug auth-protocol-v2 \
  --desc "Auth protocol v2 — RFC 2119 requirements"
```

- `--type spec` is the canonical taxonomy value for a specification.
  Other allowed values: `adr | research | handoff | note | llm-readme`.
- `--slug` is the kebab-case retrieval handle. Use the spec topic +
  version (e.g. `auth-protocol-v2`, `release-pipeline-v3`). The CLI
  returns `E_SLUG_RESERVED` with 3 alternatives on collision (legacy
  `E_SLUG_TAKEN` aliased under `details.aliases` for one release —
  T10386) — pick one rather than silently overwriting.
- Near-duplicate slugs (e.g. `auth-protocol-v2` vs an existing
  `auth-protocol`) surface a `W_SLUG_SIMILAR` warning with the top
  match (T10361). Pass `--allow-similar` to proceed when the new spec
  intentionally forks; every bypass is audited to
  `.cleo/audit/similar-bypass.jsonl`.
- Unknown flags fail fast with `E_UNKNOWN_FLAG` + did-you-mean
  suggestions (T10359) — `--titel`/`--lables` become "did you mean
  --type/--labels?". Run `cleo docs add --help` for the canonical surface.
- The owner ID (`T1234`) auto-attaches the spec to its parent task so
  downstream stages (`ct-validator`, decomposition, implementation)
  can discover the spec via `cleo docs list --task T1234 --type spec`.

### Publish the spec to a git-tracked path (when the spec must ship on disk)

```bash
cleo docs publish --for T1234 --to docs/specs/auth-protocol.md
```

Atomic tmp-then-rename. The published file lands in the next commit;
the SSoT blob remains canonical and continues to track future versions.

### Fetch the spec back by slug

```bash
cleo docs fetch auth-protocol-v2          # latest version
cleo docs versions --for T1234            # every SHA version
```

### Discover sibling specs in this project

```bash
cleo docs list --type spec --project      # every spec in the project
cleo docs list --task T1234 --type spec   # specs attached to T1234
```

## Deprecated: Direct filesystem write

The legacy "write to `docs/specs/{{SPEC_NAME}}.md` and commit" pattern
is deprecated. The on-disk file drifts from the SSoT, the spec has no
slug for downstream skills to retrieve it by, and the task↔spec
linkage exists only as a path convention. Migrate to
`cleo docs add --type spec --slug <name>` for every new spec — and use
`cleo docs sync --from docs/specs/<name>.md --for <taskId>` to
back-fill existing on-disk specs into the SSoT.

## Output Location

Spec blobs live in the docs SSoT; published copies on disk go in
`docs/specs/{{SPEC_NAME}}.md`.

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Start task: `{{TASK_START_CMD}} {{TASK_ID}}` (if not already started by orchestrator)
3. Write specification to `docs/specs/{{SPEC_NAME}}.md`
4. Append manifest entry to `{{MANIFEST_PATH}}`
5. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
6. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write specification to: `docs/specs/{{SPEC_NAME}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Specification complete. Manifest appended to pipeline_manifest."
4. MUST NOT return specification content in response

### Manifest Entry Format

```json
{"id":"spec-{{SPEC_NAME}}-{{DATE}}","file":"{{DATE}}_spec-{{SPEC_NAME}}.md","title":"Specification: {{TITLE}}","date":"{{DATE}}","status":"complete","agent_type":"specification","topics":["specification","{{DOMAIN}}"],"key_findings":["Defined N requirements in M categories","Established X constraints with enforcement rules","Compliance criteria: summary"],"actionable":true,"needs_followup":["{{IMPLEMENTATION_TASK_IDS}}"],"linked_tasks":["{{TASK_ID}}"]}
```

---

## Completion Checklist

- [ ] Task started via `{{TASK_START_CMD}}` (if not already started)
- [ ] RFC 2119 header included
- [ ] All requirements numbered (REQ-XXX)
- [ ] All constraints numbered (CON-XXX)
- [ ] Compliance section defines pass/fail
- [ ] Specification written to docs/specs/
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only

---

## See also / References

This skill binds to the **specification** LOOM lifecycle stage. Governing ADRs:

- [ADR-014 — RCASD rename and protocol validation](../../../../.cleo/adrs/ADR-014-rcasd-rename-and-protocol-validation.md) — defines the specification stage's role inside the RCASD-IVTR+C lifecycle.
- [ADR-023 — protocol validation dispatch](../../../../.cleo/adrs/ADR-023-protocol-validation-dispatch.md) — defines how specifications are validated before decomposition.

LOOM coverage matrix: [docs/skills/loom-coverage-matrix.md](../../../../docs/skills/loom-coverage-matrix.md).

## See references/

Progressive disclosure — load on demand only:

- `references/rfc2119-language.md` — keyword semantics, positive/negative examples, decision rubric
- `references/spec-templates.md` — protocol, API, architecture, requirements scaffolds + naming + versioning
- `references/traceability-matrix.md` — three-way trace from source to REQ to test, drift detection
- `references/anti-patterns.md` — ten failure modes seen in past spec drafts
