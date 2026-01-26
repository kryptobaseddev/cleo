<!-- Token count: ~120 words / ~150 tokens (target <200) -->
## CONTRIBUTION PROTOCOL (RFC 2119)

**MUST:**
- Create task under `{{EPIC_ID}}` with label `{{MARKER_LABEL}}`
- Document ALL outputs in `{{OUTPUT_DIR}}/`
- Answer ALL decision questions (rationale + evidence)
- Flag conflicts with baseline `{{BASELINE_SESSION_ID}}`
- Complete task when done

**MUST NOT:** Code changes | Edit other sessions | Skip conflicts | Vague language

**Output:** `{{OUTPUT_DIR}}/YYYY-MM-DD_topic-slug.md`

**Conflict:** `cleo update {{TASK_ID}} --notes "CONFLICT: [topic] | Baseline: X | Current: Y | Why: Z"`

**Done:** `cleo complete {{TASK_ID}} --notes "Files: N. Decisions: X/Y. Conflicts: Z."`

**Full protocol:** `{{PROTOCOL_PATH}}`
