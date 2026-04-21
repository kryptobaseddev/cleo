# T1095 — Drift Map: Manifest Operations Reference Audit

**Date**: 2026-04-21
**Task**: T1095
**Epic**: T1093 — MANIFEST/RCASD Architecture Unification
**Status**: complete
**Auditor**: cleo-historian (specification protocol)

---

## Executive Summary

ADR-027 (Manifest SQLite Migration) retired `MANIFEST.jsonl` in favour of the
`pipeline_manifest` table in `tasks.db`, accessible via `pipeline.manifest.*`
operations. The correct CLI surface is `query pipeline manifest.show <id>` /
`mutate pipeline manifest.append ...` (MCP dispatch form), or equivalently
`cleo research show <id>` / `cleo research add ...` at the top-level CLI.

`cleo manifest` as a top-level command **does not exist** — `cleo manifest show`
exits with "Unknown command manifest". The correct CLI aliases are under
`cleo research`.

This audit catalogues every file that:
1. Still references the retired `MANIFEST.jsonl` path as the append target
2. Uses `cleo manifest` as a top-level CLI reference (invalid)
3. Uses `echo ... >> MANIFEST.jsonl` as the append mechanism (should be
   `mutate pipeline.manifest.append`)
4. Has a BASE-001 rule still pointing at `MANIFEST.jsonl` rather than
   `pipeline.manifest.append`

Each entry follows the format: `file:line:current-text:should-be-text`.
Entries are classified by **Severity**:
- **P0** — Injected into active agent prompts; causes agent failures
- **P1** — Protocol/skill doc drift; causes agent mis-instruction
- **P2** — Historical/spec context; informational, not urgent

---

## Drift Category 1 — BASE-001 Rule Pointing at MANIFEST.jsonl

The compiled BASE protocol (injected into every subagent spawn) still names
`MANIFEST.jsonl` as the append target instead of `pipeline.manifest.append`.

### `/home/keatonhoskins/.claude/agents/cleo-subagent.md` (compiled, injected)

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 47 | `BASE-001 \| MUST append ONE line to MANIFEST.jsonl \| Required` | `BASE-001 \| MUST call pipeline.manifest.append before cleo complete \| Required` |
| 89 | `echo '{"id":"{{TASK_ID}}-slug",...}' >> {{MANIFEST_PATH}}` | `mutate pipeline.manifest.append {entry: {id: "{{TASK_ID}}-slug", ...}}` |
| 98 | `"[Type] complete. See MANIFEST.jsonl for summary."` | `"[Type] complete. See MANIFEST.jsonl for summary."` _(return message wording acceptable per current spec; do not change)_ |
| 99 | `"[Type] partial. See MANIFEST.jsonl for details."` | _(return message acceptable)_ |
| 100 | `"[Type] blocked. See MANIFEST.jsonl for blocker details."` | _(return message acceptable)_ |
| 120 | `\| \`{{MANIFEST_PATH}}\` \| \`{{OUTPUT_DIR}}/MANIFEST.jsonl\` \| Manifest location \|` | Remove token — `MANIFEST_PATH` is deprecated; use `pipeline.manifest.append` MCP op directly |

**Severity**: P0 — this file is the live compiled agent prompt injected into every
subagent spawn. BASE-001 and the Phase 3 `echo >> MANIFEST.jsonl` instruction
actively conflict with ADR-027.

---

## Drift Category 2 — `cleo manifest` as Invalid Top-Level CLI

`cleo manifest` does not exist as a top-level CLI command. The CLEO CLI
provides `cleo research show/list/add` for CLI access to manifest entries.
The MCP dispatch form is `query pipeline manifest.show` /
`mutate pipeline manifest.append`.

### `.claude/commands/orchestrator.md` (same file as adapters copy)

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 92 | `4. cleo manifest show <id>                 → Read key_findings from manifest` | `4. query pipeline manifest.show {entryId: "<id>"}  → Read key_findings from manifest` |
| 117 | `Read MANIFEST.jsonl via \`cleo manifest show\`` | `Read manifest via \`query pipeline manifest.show {entryId: "<id>"}\`` |
| 128 | `` `cleo manifest show <id>` over reading source `` | `` `query pipeline manifest.show {entryId: "<id>"}` over reading source `` |

**Severity**: P0 — orchestrator.md is injected via the `/orchestrator` slash command. Every
orchestrator session receives invalid CLI instructions.

### `packages/adapters/src/providers/claude-code/commands/orchestrator.md`

Identical file content to `.claude/commands/orchestrator.md` (diff confirmed empty).
Same three lines require the same fix.

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 92 | `4. cleo manifest show <id>                 → Read key_findings from manifest` | `4. query pipeline manifest.show {entryId: "<id>"}  → Read key_findings from manifest` |
| 117 | `Read MANIFEST.jsonl via \`cleo manifest show\`` | `Read manifest via \`query pipeline manifest.show {entryId: "<id>"}\`` |
| 128 | `` `cleo manifest show <id>` over reading source `` | `` `query pipeline manifest.show {entryId: "<id>"}` over reading source `` |

**Severity**: P0 — source file for the compiled orchestrator command.

### `packages/skills/skills/ct-orchestrator/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 210 | `\| \`cleo manifest list --filter pending\` \| Followup items \|` | `\| \`query pipeline manifest.list {filter: "pending"}\` \| Followup items \|` |

**Severity**: P1 — skill doc drift.

### `packages/skills/skills/ct-skill-validator/references/cleo-ecosystem-rules.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 49 | `- \`cleo pipeline stage.status\`, \`cleo manifest append\`` | `- \`query pipeline stage.status\`, \`mutate pipeline manifest.append {entry: {...}}\`` |

**Severity**: P1 — validator reference used to grade agent behaviour.

---

## Drift Category 3 — `echo ... >> MANIFEST.jsonl` Direct-Write Pattern

Direct file appends to MANIFEST.jsonl are superseded by `pipeline.manifest.append`.

### `/home/keatonhoskins/.claude/agents/cleo-subagent.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 89 | `echo '{"id":"{{TASK_ID}}-slug",...}' >> {{MANIFEST_PATH}}` | `mutate pipeline.manifest.append {entry: {id: "{{TASK_ID}}-slug", type: "...", content: "...", taskId: "{{TASK_ID}}"}}` |

**Severity**: P0 (already listed above in Category 1, included here for cross-reference).

### `packages/agents/README.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 45 | `- **Manifest Integration**: Automatically appends to MANIFEST.jsonl` | `- **Manifest Integration**: Appends to pipeline_manifest table via pipeline.manifest.append` |
| 51 | `BASE-001 \| MUST append ONE line to MANIFEST.jsonl \| Required` | `BASE-001 \| MUST call pipeline.manifest.append before cleo complete \| Required` |
| 93 | `echo '{"id":"{{TASK_ID}}-slug",...}' >> {{MANIFEST_PATH}}` | `mutate pipeline.manifest.append {entry: {id: "{{TASK_ID}}-slug", ...}}` |
| 102 | `"[Type] complete. See MANIFEST.jsonl for summary."` | _(return message wording acceptable; no change)_ |
| 103 | `"[Type] partial. See MANIFEST.jsonl for details."` | _(return message wording acceptable; no change)_ |
| 104 | `"[Type] blocked. See MANIFEST.jsonl for blocker details."` | _(return message wording acceptable; no change)_ |
| 122 | `` `{{MANIFEST_PATH}}` \| `{{OUTPUT_DIR}}/MANIFEST.jsonl` \| Manifest location `` | Remove `{{MANIFEST_PATH}}` token row — deprecated; direct to `pipeline.manifest.append` |

**Severity**: P1 — README ships with the agents package.

---

## Drift Category 4 — Skill Docs Referencing Legacy MANIFEST.jsonl

These files instruct agents to write to `MANIFEST.jsonl` rather than call
`pipeline.manifest.append`.

### `packages/skills/skills/ct-cleo/references/loom-lifecycle.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 110 | `BASE-001 \| MUST append ONE line to MANIFEST.jsonl \| Required` | `BASE-001 \| MUST call pipeline.manifest.append before cleo complete \| Required` |
| 134 | `` `[Type] complete. See MANIFEST.jsonl for summary.` `` | _(return message wording acceptable; no change)_ |
| 135 | `` `[Type] partial. See MANIFEST.jsonl for details.` `` | _(return message wording acceptable; no change)_ |
| 136 | `` `[Type] blocked. See MANIFEST.jsonl for blocker details.` `` | _(return message wording acceptable; no change)_ |

**Severity**: P1.

### `packages/skills/skills/ct-cleo/references/session-protocol.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 67 | `### Manifest Entry (MANIFEST.jsonl)` | `### Manifest Entry (pipeline_manifest table)` |

**Severity**: P1.

### `packages/skills/skills/ct-cleo/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 247 | `` On return: cleo manifest show <id>  → read key_findings `` | `` On return: query pipeline manifest.show {entryId: "<id>"}  → read key_findings `` |
| 258 | `` Read failure in manifest (cleo manifest show <id>) `` | `` Read failure in manifest (query pipeline manifest.show {entryId: "<id>"}) `` |

**Note**: Lines 354–356 and 408 in ct-cleo/SKILL.md reference `pipeline.manifest.*`
operations correctly via MCP dispatch (`query`/`mutate pipeline` domain). Those
lines are **correct** and require no change.

**Severity**: P1.

### `packages/skills/skills/ct-dev-workflow/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 331 | `3. MUST return ONLY: "Workflow complete. See MANIFEST.jsonl for summary."` | _(return message wording acceptable; no change)_ |

**Severity**: informational — return message is correct per current spec.

### `packages/skills/skills/ct-documentor/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 175 | `3. MUST return ONLY: "Documentation complete. See MANIFEST.jsonl for summary."` | _(return message wording acceptable; no change)_ |

**Severity**: informational.

### `packages/skills/skills/ct-epic-architect/references/commands.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 201 | `` \| `{{MANIFEST_PATH}}` \| `{{OUTPUT_DIR}}/MANIFEST.jsonl` \| `` | Remove `{{MANIFEST_PATH}}` token row — deprecated |

**Severity**: P1.

### `packages/skills/skills/ct-epic-architect/references/skill-aware-execution.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 122 | `3. **Return summary only**: "Epic created. See MANIFEST.jsonl for summary."` | _(return message wording acceptable; no change)_ |

### `packages/skills/skills/ct-epic-architect/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 252 | `3. MUST return ONLY: "Decomposition complete. See MANIFEST.jsonl for summary."` | _(return message wording acceptable; no change)_ |

### `packages/skills/skills/ct-orchestrator/references/orchestrator-compliance.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 23 | `Complete \| "Research complete. See MANIFEST.jsonl for summary." \|` | _(return message acceptable; no change)_ |
| 24 | `Partial \| "Research partial. See MANIFEST.jsonl for details." \|` | _(return message acceptable; no change)_ |
| 25 | `Blocked \| "Research blocked. See MANIFEST.jsonl for blocker details." \|` | _(return message acceptable; no change)_ |
| 244 | `- [ ] MANIFEST.jsonl entry appended with all required fields` | `- [ ] pipeline.manifest.append called with all required fields` |
| 245 | `- [ ] Return message is EXACTLY: 'Research complete. See MANIFEST.jsonl for summary.'` | _(return message acceptable; no change)_ |

**Severity**: P1 for line 244 (checklist item instructs checking the JSONL file directly).

### `packages/skills/skills/ct-orchestrator/references/orchestrator-handoffs.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 18 | `├─ Reads MANIFEST.jsonl → extracts key_findings (3-7 items)` | `├─ Reads pipeline_manifest (via query pipeline manifest.show) → extracts key_findings (3-7 items)` |

**Severity**: P1.

### `packages/skills/skills/ct-orchestrator/references/orchestrator-patterns.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 101 | `# Returns: "Implementation complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |

### `packages/skills/skills/ct-orchestrator/references/orchestrator-spawning.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 53 | `Results flow back through MANIFEST.jsonl.` | `Results flow back through pipeline_manifest table (pipeline.manifest.append).` |

**Severity**: P1.

### `packages/skills/skills/ct-orchestrator/references/orchestrator-tokens.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 74 | `` \| `{{MANIFEST_PATH}}` \| `.cleo/agent-outputs/MANIFEST.jsonl` \| `` | Remove `{{MANIFEST_PATH}}` token row — deprecated |
| 86 | `` \| `{{MANIFEST_SUMMARIES}}` \| MANIFEST.jsonl \| Key findings from previous agents \| `` | `\| \`{{MANIFEST_SUMMARIES}}\` \| pipeline_manifest \| Key findings from previous agents \|` |
| 118 | `\| **Manifest Context** \| \`{{MANIFEST_SUMMARIES}}\` \| From recent MANIFEST.jsonl entries \|` | `From recent pipeline_manifest entries` |
| 159 | `` `{{MANIFEST_PATH}}` -> `.cleo/agent-outputs/MANIFEST.jsonl` `` | Remove — `{{MANIFEST_PATH}}` is deprecated |
| 169 | `3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |

**Severity**: P1.

### `packages/skills/skills/ct-orchestrator/references/SUBAGENT-PROTOCOL-BLOCK.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 12 | `2. MUST append ONE line to: {{OUTPUT_DIR}}/MANIFEST.jsonl` | `2. MUST call pipeline.manifest.append before cleo complete` |
| 13 | `3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |
| 37 | `2. MUST append ONE line to: {{OUTPUT_DIR}}/MANIFEST.jsonl` | `2. MUST call pipeline.manifest.append before cleo complete` |
| 38 | `3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |

**Severity**: P1 — SUBAGENT-PROTOCOL-BLOCK.md is injected into spawned agent prompts.

### `packages/skills/skills/ct-orchestrator/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 29 | `ORC-009 \| Manifest-mediated handoffs \| Read only \`key_findings\` from MANIFEST.jsonl; subagents read full files` | `Read only \`key_findings\` from pipeline_manifest (via query pipeline manifest.show); subagents read full files` |
| 113 | `Results flow back through MANIFEST.jsonl — the universal handoff medium.` | `Results flow back through pipeline_manifest table — the universal handoff medium.` |
| 118 | `"[Type] complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |
| 119 | `"[Type] partial. See MANIFEST.jsonl for details."` | _(return message acceptable; no change)_ |
| 120 | `"[Type] blocked. See MANIFEST.jsonl for blocker details."` | _(return message acceptable; no change)_ |
| 171 | `Agent A completes → writes output file + MANIFEST.jsonl entry` | `Agent A completes → writes output file + pipeline.manifest.append entry` |

**Severity**: P1.

### `packages/skills/skills/ct-orchestrator/INSTALL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 60 | `- Agent manifest system (\`.cleo/agent-outputs/MANIFEST.jsonl\`)` | `- Agent manifest system (pipeline_manifest table in tasks.db, via pipeline.manifest.*)` |

**Severity**: P1.

### `packages/skills/skills/ct-orchestrator/orchestrator-prompt.txt`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 20 | `to MANIFEST.jsonl; you read key_findings from manifest entries.` | `to pipeline_manifest table (via pipeline.manifest.append); you read key_findings via query pipeline manifest.show` |

**Severity**: P0 — orchestrator-prompt.txt is the resolved base prompt for orchestrator spawns.

### `packages/skills/skills/ct-research-agent/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 110 | `3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |
| 198 | `6. Return: "Research partial. See MANIFEST.jsonl for details."` | _(return message acceptable; no change)_ |
| 208 | `5. Return: "Research blocked. See MANIFEST.jsonl for blocker details."` | _(return message acceptable; no change)_ |

### `packages/skills/skills/ct-spec-writer/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 168 | `3. MUST return ONLY: "Specification complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |

### `packages/skills/skills/ct-task-executor/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 113 | `3. MUST return ONLY: "Implementation complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |
| 208 | `6. Return: "Implementation partial. See MANIFEST.jsonl for details."` | _(return message acceptable; no change)_ |
| 218 | `5. Return: "Implementation blocked. See MANIFEST.jsonl for blocker details."` | _(return message acceptable; no change)_ |

### `packages/skills/skills/ct-validator/SKILL.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 128 | `3. MUST return ONLY: "Validation complete. See MANIFEST.jsonl for summary."` | _(return message acceptable; no change)_ |

---

## Drift Category 5 — _shared/ Protocol Files

### `packages/skills/skills/_shared/subagent-protocol-base.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 24 | `MANIFEST_PATH: path = "${OUTPUT_DIR}/MANIFEST.jsonl"` | Remove `MANIFEST_PATH` token — deprecated; use `pipeline.manifest.append` op |
| 92 | `solution: "Use cleo manifest append CLI command"` | `solution: "Use mutate pipeline manifest.append MCP op"` |
| 105 | `- pattern: "Appending to MANIFEST.jsonl directly"` | _(anti-pattern label acceptable; describes the prohibited behaviour)_ |

**Note**: Lines 33, 58, 74, 107 in subagent-protocol-base.cant already reference
`pipeline.manifest.append` **correctly**. Those lines require no change.

**Severity**: P1 — the `.cant` file is the source for injected subagent protocol rules.

### `packages/skills/skills/_shared/subagent-protocol-base.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 20 | `OUT-003 \| MUST return ONLY: "[Type] complete. See MANIFEST.jsonl for summary." \| Required` | _(return message wording acceptable; no change)_ |
| 24 | `"[Type] complete. See MANIFEST.jsonl for summary."` | _(acceptable; no change)_ |
| 25 | `"[Type] partial. See MANIFEST.jsonl for details."` | _(acceptable; no change)_ |
| 26 | `"[Type] blocked. See MANIFEST.jsonl for blocker details."` | _(acceptable; no change)_ |
| 113 | `7. Return:       "[Type] complete. See MANIFEST.jsonl for summary."` | _(acceptable; no change)_ |
| 181 | `` \| `{{MANIFEST_PATH}}` \| `{{OUTPUT_DIR}}/MANIFEST.jsonl` \| Manifest location \| `` | Remove `{{MANIFEST_PATH}}` token row — deprecated |
| 204 | `5. Return: "[Type] partial. See MANIFEST.jsonl for details."` | _(acceptable; no change)_ |
| 214 | `5. Return: "[Type] blocked. See MANIFEST.jsonl for blocker details."` | _(acceptable; no change)_ |

**Severity**: P1 for line 181.

### `packages/skills/skills/_shared/manifest-operations.md`

This file is the canonical reference for legacy MANIFEST.jsonl operations. Its
MANIFEST.jsonl references are **descriptive** (documenting the deprecated system)
and are acceptable as historical context. However, its CLI examples need updating:

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 7 | `for managing the agent outputs manifest (\`MANIFEST.jsonl\`). Skills and protocols SHOULD reference this file instead of duplicating JSONL instructions.` | Update to note this doc is deprecated; point to `pipeline.manifest.*` ops |
| 17 | `- Manifest file: \`MANIFEST.jsonl\`` | `- Manifest table: \`pipeline_manifest\` (in tasks.db)` |
| 18 | `- Full path: \`{{OUTPUT_DIR}}/MANIFEST.jsonl\`` | `- Append via: \`mutate pipeline manifest.append {entry: {...}}\`` |
| 525 | `}' >> MANIFEST.jsonl` | Replace with: `mutate pipeline manifest.append {entry: {...}}` |
| 532 | `jq -nc '{id: "test", title: "Test"}' >> MANIFEST.jsonl` | Replace with: `mutate pipeline manifest.append {entry: {id: "test", ...}}` |
| 541 | `echo "$json" >> .cleo/agent-outputs/MANIFEST.jsonl` | Replace with: `mutate pipeline manifest.append {entry: $json}` |

**Severity**: P1 — this is the shared reference doc that skill authors consult.

### `packages/skills/skills/_shared/skill-chaining-patterns.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 167 | `// Subagent appends ONE line to MANIFEST.jsonl` | `// Subagent calls pipeline.manifest.append` |
| 176 | `Subagent MUST return ONLY: "[Type] complete/partial/blocked. See MANIFEST.jsonl for summary/details/blocker details."` | _(return message wording acceptable; no change)_ |
| 184 | `- Summary only → \`MANIFEST.jsonl\` key_findings array` | `- Summary only → pipeline_manifest entry key_findings (from metadata_json)` |

**Severity**: P1.

### `packages/skills/skills/_shared/task-system-integration.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 172 | `` \| `{{MANIFEST_PATH}}` \| `{{OUTPUT_DIR}}/MANIFEST.jsonl` \| `` | Remove `{{MANIFEST_PATH}}` token row — deprecated |

**Severity**: P1.

### `packages/skills/skills/_shared/placeholders.json`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 74 | `"example": ".cleo/agent-outputs/MANIFEST.jsonl"` | `"example": "pipeline_manifest"` |
| 75 | `"description": "Path to MANIFEST.jsonl file"` | `"description": "Deprecated — use pipeline.manifest.append op instead"` |
| 76 | `"default": ".cleo/agent-outputs/MANIFEST.jsonl"` | Remove or deprecate `MANIFEST_PATH` token |
| 185 | `"_comment": "Tokens used when constructing MANIFEST.jsonl entries"` | `"_comment": "Tokens used when constructing pipeline manifest entries"` |

**Severity**: P1 — placeholder values drive token substitution in injected prompts.

---

## Drift Category 6 — ct-master-tac Protocol CANT Files

The protocol files define output schemas for CANT agent workflows.

### `packages/skills/skills/ct-master-tac/bundled/protocols/implementation.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 22 | `manifest_entry: "object — implementation summary for MANIFEST.jsonl"` | `manifest_entry: "object — implementation summary for pipeline_manifest (pipeline.manifest.append)"` |

**Severity**: P1.

### `packages/skills/skills/ct-master-tac/bundled/protocols/release.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 23 | `release_manifest: "object — release summary for MANIFEST.jsonl"` | `release_manifest: "object — release summary for pipeline_manifest (pipeline.manifest.append)"` |

**Severity**: P1.

### `packages/skills/skills/ct-master-tac/bundled/protocols/research.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 21 | `manifest_entry: "object — 3–7 key findings for MANIFEST.jsonl"` | `manifest_entry: "object — 3–7 key findings for pipeline_manifest (pipeline.manifest.append)"` |
| 48 | `#   RSCH-004: MUST append entry to MANIFEST.jsonl` | `#   RSCH-004: MUST call pipeline.manifest.append` |

**Severity**: P1.

### `packages/skills/skills/ct-master-tac/bundled/protocols/testing.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 23 | `manifest_entry: "object — convergence metrics for MANIFEST.jsonl"` | `manifest_entry: "object — convergence metrics for pipeline_manifest (pipeline.manifest.append)"` |

**Severity**: P1.

---

## Drift Category 7 — Agent CANT Files

### `packages/agents/cleo-subagent/cleo-subagent.cant`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 105 | `OUT-002: MUST call pipeline.manifest.append before return` | _(already correct; no change)_ |
| 135 | `solution: "Use pipeline.manifest.append MCP op"` | _(already correct; no change)_ |

**Note**: This file is already using the correct `pipeline.manifest.append`
references. No drift to fix.

### `packages/agents/seed-agents/cleo-subagent.cant`

Same as above — already correct at lines 105 and 135.

### `packages/agents/cleo-subagent/AGENT.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 79 | `absolute paths to agent-outputs dir, MANIFEST.jsonl, rcasd workspace, test-runs dir` | `absolute paths to agent-outputs dir, rcasd workspace, test-runs dir` (remove MANIFEST.jsonl reference) |
| 356 | `\| Appending to \`MANIFEST.jsonl\` directly \| Legacy file — migrated to SQLite (ADR-027) \| Use \`pipeline.manifest.append\` \|` | _(anti-pattern table entry is correct; no change)_ |

**Note**: Lines 242 and 351 in AGENT.md are already correct (`pipeline.manifest.append`).

**Severity**: P1 for line 79.

### `packages/agents/README.md`

Already covered in Category 3 above.

---

## Drift Category 8 — Skills README

### `packages/skills/README.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 403 | `- \`manifest-operations.md\` - Working with MANIFEST.jsonl` | `- \`manifest-operations.md\` - Legacy MANIFEST.jsonl reference (see pipeline.manifest.* ops for current usage)` |

**Severity**: P2.

---

## Drift Category 9 — Docs / Specs

### `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 484 | `  cleo manifest append --type research --content "..."` | `  mutate pipeline manifest.append {entry: {type: "research", content: "..."}}` |

**Note**: Lines 366, 419, 478, 489, 492 correctly reference `pipeline.manifest.append`
as the operation name. Line 484 shows the CLI form as `cleo manifest append`
which is non-functional; the correct CLI form is `mutate pipeline manifest.append`
(MCP dispatch) or `cleo research add` (high-level alias).

**Severity**: P1.

### `docs/specs/cleo-scaffolding-ssot-spec.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 84 | `The agent output manifest MUST be at \`.cleo/agent-outputs/MANIFEST.jsonl\`.` | `Agent output artifacts MUST be stored in the pipeline_manifest table in tasks.db via pipeline.manifest.append.` |
| 92 | `- \`MANIFEST_PATH\` → \`.cleo/agent-outputs/MANIFEST.jsonl\`` | Remove `MANIFEST_PATH` token — deprecated per ADR-027 |

**Severity**: P1.

### `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 201 | `│   └── MANIFEST.jsonl    # Agent output manifest (append-only)` | `│   └── MANIFEST.jsonl.migrated  # Retired; data now in tasks.db pipeline_manifest table` |

**Severity**: P2 — historical architecture diagram.

---

## Drift Category 10 — ADRs

### `.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 102 | `│   │   ├── manifest.ts       # MANIFEST.jsonl operations` | `│   │   ├── manifest.ts       # MANIFEST.jsonl operations (SUPERSEDED by pipeline_manifest-sqlite.ts per ADR-027)` |
| 720 | `\| memory \| manifest.append \| memory/manifest.ts \| Append to manifest \|` | `SUPERSEDED — moved to pipeline domain (pipeline.manifest.append) per ADR-021/ADR-027` |
| 721 | `\| memory \| manifest.archive \| memory/manifest.ts \| Archive manifest \|` | `SUPERSEDED — moved to pipeline domain (pipeline.manifest.archive) per ADR-021/ADR-027` |

**Severity**: P2 — historical ADR; annotation preferred over rewrite.

### `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 131 | `\| Research Artifacts \| MANIFEST.jsonl (existing) \| JSONL (native) \| Append-only, agent-output format \|` | Add note: `SUPERSEDED by pipeline_manifest table per ADR-027` |

**Severity**: P2 — historical ADR.

### `.cleo/adrs/ADR-017-verb-and-naming-standards.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 263 | `### §5.5 DB vs MANIFEST.jsonl — Two-Tier Storage (per ADR-009 §3.1)` | `### §5.5 DB vs pipeline_manifest — Storage (per ADR-027)` |
| 267 | `\| \| \`architecture_decisions\` (DB) \| \`.cleo/adrs/MANIFEST.jsonl\` \|` | `\| \| \`architecture_decisions\` (DB) \| _(no separate MANIFEST.jsonl — retired)_ \|` |
| 276 | `**Rule**: \`ct adr sync\` updates both in one pass — DB first, then MANIFEST.jsonl.` | `**Rule**: \`ct adr sync\` updates the DB only (MANIFEST.jsonl is retired per ADR-027).` |
| 333 | `2. \`npm run adr:manifest\` → \`.cleo/adrs/MANIFEST.jsonl\` with 15+ entries` | Note: `npm run adr:manifest` now writes to pipeline_manifest table |

**Severity**: P2 — ADR drift.

### `.cleo/adrs/ADR-021-memory-domain-refactor.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 78 | `\| mutate \| manifest.append \| Append to MANIFEST.jsonl \| entry \|` | `\| mutate \| manifest.append \| Append to pipeline_manifest table \| entry \|` |

**Note**: Lines 73–77 and 97–103 in ADR-021 correctly document the historical state
and the migration. The description at line 78 should say "pipeline_manifest table"
not "MANIFEST.jsonl" since this ADR post-dates ADR-027.

**Severity**: P2 — ADR correction.

### `.cleo/adrs/ADR-045-cleo-scaffolding-ssot.md`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 54 | `\| Agent manifest \| \`.cleo/agent-outputs/MANIFEST.jsonl\` \| \`manifest_entries\` (future) \|` | `\| Agent manifest \| pipeline_manifest table (tasks.db) \| \`pipeline_manifest\` (shipped, ADR-027) \|` |

**Severity**: P1 — scaffolding spec is used to generate project structure.

---

## Drift Category 11 — Core Templates

### `packages/core/templates/config.template.json`

| Line | Current Text | Should Be |
|------|-------------|-----------|
| 104 | `"manifestFile": "MANIFEST.jsonl"` | Consider deprecating `agentOutputs.manifestFile` key; retain for backwards-compat during migration cycle but document as deprecated |

**Note**: This config key drives `MANIFEST_PATH` token substitution. It should be
deprecated but not removed until all agent prompts no longer reference
`{{MANIFEST_PATH}}`.

**Severity**: P1.

---

## Summary — Count by Severity

| Severity | Count (distinct actionable lines) | Notes |
|----------|----------------------------------|-------|
| P0 | 8 | BASE-001 in compiled agent, `cleo manifest show/list` in orchestrator.md (2 files), orchestrator-prompt.txt |
| P1 | ~45 | Skill docs, protocol files, shared references, manifests-operations.md, ct-master-tac .cant files |
| P2 | ~10 | Historical ADRs, portable-brain spec |
| No change | ~30 | Return message strings ("See MANIFEST.jsonl for summary") — wording is accepted per current spec |

---

## Key Decision: Return Messages

The return-message strings of the form `"[Type] complete. See MANIFEST.jsonl for summary."`
are **intentionally preserved** in the current spec. They are agent-visible
summary strings that do not instruct the agent to perform a file operation.
Renaming them to reference `pipeline_manifest` would require a coordinated
update of all grading expectations. These strings are marked "no change" in
this audit.

The `CLEO-MANIFEST-SCHEMA-SPEC.md` (§7, §8) and
`CLEO-OPERATION-CONSTITUTION.md` (§pipeline) are **authoritative** and
contain no drift — they correctly define the 14 `pipeline.manifest.*` ops.

---

## Highest-Priority Fixes (P0 — Block Agent Execution)

1. `/home/keatonhoskins/.claude/agents/cleo-subagent.md` — BASE-001 text +
   Phase 3 `echo >> MANIFEST.jsonl` instruction (compiled agent prompt)
2. `.claude/commands/orchestrator.md` — three `cleo manifest show` references
3. `packages/adapters/src/providers/claude-code/commands/orchestrator.md` — same three references
4. `packages/skills/skills/ct-orchestrator/orchestrator-prompt.txt:20` — base orchestrator prompt

---

## References

- ADR-027: Manifest SQLite Migration (normative retirement of MANIFEST.jsonl)
- ADR-021: Memory Domain Refactor (moved manifest ops from memory to pipeline domain)
- `docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md` (14 canonical ops)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` (pipeline domain table — correct)
