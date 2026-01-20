# Epic Output File Format

Template for epic creation output files.

---

## Output File Location

Write to `{{OUTPUT_DIR}}/{{DATE}}_epic-{{FEATURE_SLUG}}.md`

---

## Template

```markdown
# Epic: {{EPIC_TITLE}}

## Overview

| Field | Value |
|-------|-------|
| Epic ID | {{EPIC_ID}} |
| Parent | {{PARENT_ID or "None (root)"}} |
| Phase | {{PHASE}} |
| Size | large |
| Priority | {{PRIORITY}} |
| Labels | {{LABELS}} |

## Description

{{EPIC_DESCRIPTION}}

## Task Breakdown

| ID | Title | Type | Size | Phase | Depends | Ready |
|----|-------|------|------|-------|---------|-------|
| {{EPIC_ID}} | {{EPIC_TITLE}} | epic | large | {{PHASE}} | - | - |
| {{T1_ID}} | {{T1_TITLE}} | task | {{SIZE}} | {{PHASE}} | - | Yes |
| {{T2_ID}} | {{T2_TITLE}} | task | {{SIZE}} | {{PHASE}} | {{T1_ID}} | No |
| {{T3_ID}} | {{T3_TITLE}} | task | {{SIZE}} | {{PHASE}} | {{T1_ID}} | No |
| {{T4_ID}} | {{T4_TITLE}} | task | {{SIZE}} | {{PHASE}} | {{T2_ID}},{{T3_ID}} | No |
| {{T5_ID}} | {{T5_TITLE}} | task | {{SIZE}} | {{PHASE}} | {{T4_ID}} | No |

## Dependency Graph

```
{{T1_ID}}
├──> {{T2_ID}}
│    └──> {{T4_ID}}
└──> {{T3_ID}}
     └──> {{T4_ID}}
          └──> {{T5_ID}}
```

## Critical Path

{{T1_ID}} → {{T2_ID}} → {{T4_ID}} → {{T5_ID}}

(T3 runs parallel to T2, both converge at T4)

## Parallel Opportunities (Wave Analysis)

| Wave | Tasks | Can Parallelize |
|------|-------|-----------------|
| 0 | {{T1_ID}} | - |
| 1 | {{T2_ID}}, {{T3_ID}} | Yes (independent) |
| 2 | {{T4_ID}} | No (convergence) |
| 3 | {{T5_ID}} | No (final) |

## Session Started

- Session ID: {{SESSION_ID}}
- Scope: `epic:{{EPIC_ID}}`
- First Ready Task: {{T1_ID}}

## Acceptance Criteria

1. All child tasks completed
2. Integration tests pass
3. Documentation updated
4. Code reviewed and merged
```

---

## Manifest Entry Format

Append ONE line (no pretty-printing) to `{{MANIFEST_PATH}}`:

```json
{"id":"epic-{{FEATURE_SLUG}}-{{DATE}}","file":"{{DATE}}_epic-{{FEATURE_SLUG}}.md","title":"Epic Created: {{FEATURE_NAME}}","date":"{{DATE}}","status":"complete","topics":["epic","planning","{{DOMAIN}}"],"key_findings":["Created Epic {{EPIC_ID}} with {{N}} child tasks","Dependency chain: {{T1}} -> {{T2}}/{{T3}} -> {{T4}} -> {{T5}}","Wave 0 (parallel start): [{{T1_ID}}]","Wave 1 (parallel): [{{T2_ID}}, {{T3_ID}}]","Critical path: {{T1}} -> {{T2}} -> {{T4}} -> {{T5}}","Session started: {{SESSION_ID}}"],"actionable":true,"needs_followup":["{{FIRST_READY_TASK_ID}}"],"linked_tasks":["{{EPIC_ID}}","{{ALL_TASK_IDS}}"]}
```
