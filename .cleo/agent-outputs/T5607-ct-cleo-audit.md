# T5607 — ct-cleo Skill Audit

**Task**: T5607
**Epic**: T5613
**Date**: 2026-03-07
**Status**: complete

---

## Summary

The ct-cleo SKILL.md (v2.0.0) contains four categories of defects: two defunct domain references (`research`, `system`) that will cause immediate E_INVALID_DOMAIN errors at runtime, a missing `skills` domain reference that maps incorrectly to a non-existent domain, several critical agent-support operations that are entirely absent from the skill's operation tables, and one mild anti-pattern (unrestricted `tasks.list` recommendation in the write table). No stale CLI command formats were found; the CLI examples appear current. The reference file `session-protocol.md` also uses a stale `TASK_LINK_CMD` token pointing at `cleo research link`, which no longer exists.

---

## A. Defunct Domain References

### 1. `research` domain — Line 36-37 (query table)

```
| `research` | `list` | Research manifest entries |
| `research` | `show` | Research entry details (`params: { entryId }`) |
```

**Impact**: Runtime E_INVALID_DOMAIN error. The `research` domain does not exist in the registry.
**Correct routes**:
- `research.list` → `pipeline.manifest.list` (query)
- `research.show` → `pipeline.manifest.show` (query, params: `{ entryId }`)

### 2. `system` domain — Lines 39-40 (query table)

```
| `system` | `dash` | Project overview dashboard |
| `system` | `context` | Context window usage |
```

**Impact**: Runtime E_INVALID_DOMAIN error. The `system` domain does not exist in the registry.
**Correct routes**:
- `system.dash` → `admin.dash` (query)
- `system.context` → `admin.context` (query)

### 3. `research` domain — Line 59 (mutate table)

```
| `research` | `link` | Link research to task (`params: { taskId, entryId }`) |
```

**Impact**: Runtime E_INVALID_DOMAIN error.
**Correct route**: `research.link` → `memory.link` (mutate, params: `{ taskId, entryId }`)

### 4. `skills` domain — Lines 41-42 (query table)

```
| `skills` | `list` | Available skills |
| `skills` | `show` | Skill details (`params: { name }`) |
```

**Impact**: Runtime E_INVALID_DOMAIN error. The `skills` domain does not exist in the registry. Skills operations live under the `tools` domain.
**Correct routes**:
- `skills.list` → `tools.skill.list` (query)
- `skills.show` → `tools.skill.show` (query, params: `{ name }`)

### 5. `session-protocol.md` reference file — TASK_LINK_CMD token (line 116)

```
| `{{TASK_LINK_CMD}}` | `cleo research link` |
```

**Impact**: The `cleo research link` CLI command does not exist. The correct operation is `memory.link` via MCP or `cleo memory link` via CLI.

---

## B. Missing Critical Operations

The following operations are needed by agents and are entirely absent from the SKILL.md operation tables.

### B1. `memory.find` (query) — PRIMARY memory search

- **Registry entry**: `{ domain: 'memory', operation: 'find', tier: 1, requiredParams: ['query'] }`
- **Why needed**: The CLEO-INJECTION.md mandates `memory brain.search` as step 1 of the 3-layer retrieval pattern. The canonical op is now `memory.find`. Agents that follow the skill but not CLEO-INJECTION will not know this op exists.

### B2. `memory.observe` (mutate) — save to brain.db

- **Registry entry**: `{ domain: 'memory', operation: 'observe', tier: 1, requiredParams: ['text'] }`
- **Why needed**: Agents need this to persist observations across sessions. Without it in the skill, agents cannot save cognitive memory.

### B3. `memory.timeline` (query) — context around anchor

- **Registry entry**: `{ domain: 'memory', operation: 'timeline', tier: 1, requiredParams: ['anchor'] }`
- **Why needed**: Second step of the 3-layer retrieval pattern per CLEO-INJECTION.md.

### B4. `memory.fetch` (query) — batch fetch brain entries

- **Registry entry**: `{ domain: 'memory', operation: 'fetch', tier: 1, requiredParams: ['ids'] }`
- **Why needed**: Third step of the 3-layer retrieval pattern per CLEO-INJECTION.md.

### B5. `pipeline.manifest.show` (query) — read manifest entry

- **Registry entry**: `{ domain: 'pipeline', operation: 'manifest.show', tier: 1, requiredParams: ['entryId'] }`
- **Why needed**: Replaces the defunct `research.show` operation. Subagents and orchestrators need this to read research outputs.

### B6. `pipeline.manifest.append` (mutate) — write manifest entry

- **Registry entry**: `{ domain: 'pipeline', operation: 'manifest.append', tier: 1, requiredParams: ['entry'] }`
- **Why needed**: The base protocol (CLEO-INJECTION.md) requires all subagents to append to MANIFEST.jsonl. This is the canonical MCP operation for doing so, yet it is not listed anywhere in the skill.

### B7. `session.handoff.show` (query) — resume context from last session

- **Registry entry**: `{ domain: 'session', operation: 'handoff.show', tier: 0, requiredParams: [] }`
- **Why needed**: CLEO-INJECTION.md lists this as step 2 of the mandatory efficiency sequence (`query session handoff.show`). The skill documents `session.status` and `session.list` but omits `handoff.show`, so agents will miss the resume-context step.

### B8. `session.briefing.show` (query) — composite session-start context

- **Registry entry**: `{ domain: 'session', operation: 'briefing.show', tier: 0, requiredParams: [] }`
- **Why needed**: Higher-value alternative to `session.status` for orientation; single call returns all context needed to resume work.

### B9. `admin.dash` — correctly routed but absent from MCP table

The Work Selection Decision Tree at line 105 correctly references `admin dash`:
```
└─ NO → `admin dash` → identify priority → `tasks next`
```
However, the MCP operation tables (lines 26-65) do not list `admin.dash` at all. The system domain version (`system.dash`) listed in the query table is defunct. The missing entry should be:
- **Correct**: `admin` | `dash` | Project overview dashboard (query)

### B10. `pipeline.manifest.list` (query) — list manifest entries

- **Registry entry**: `{ domain: 'pipeline', operation: 'manifest.list', tier: 1, requiredParams: [] }`
- **Why needed**: Replacement for defunct `research.list`. Orchestrators need to enumerate existing research before spawning.

---

## C. Anti-Patterns Found

### C1. `tasks.list` included in query table without discouraging note — Line 30

```
| `tasks` | `list` | List tasks (`params: { parent?, status? }`) |
```

The Context Bloat Anti-Patterns table on line 114 correctly calls out `tasks list` (no filters) as a 2000-5000 token anti-pattern. However, the primary query table on line 30 lists `tasks.list` without any filter guidance or warning alongside it. Agents scanning the table may use it unfiltered.

**Recommended fix**: Add a note in the table cell: `(use filters: parent/status; prefer tasks.find for discovery)` or remove it from tier-0 table and move to a "use with caution" section.

### C2. Decision tree references `session list` implicitly on line 101

```
└─ NO → `session list` → resume or start new
```

`session list` has a high context cost (500-2000 tokens per CLEO-INJECTION.md). The skill's own anti-patterns table (line 118) lists "Repeated `session list`" as a pattern costing `300 x N`. The decision tree should instead direct agents to `session.find` (which now exists in the registry at tier 0) or `session.status` first.

### C3. `session list` reference in Session Protocol Quick Start — Line 149

```
ct session list
ct session status
```

The session protocol quick start block leads with `ct session list` before `ct session status`. This encourages agents to run the more expensive operation first. Order should be reversed: status first, then list only if needed.

### C4. Wrong operation name for skills in `session-protocol.md` — Line 124-125

```
query({ domain: "skills", operation: "list" })
query({ domain: "skills", operation: "show", params: { name: "ct-orchestrator" }})
```

Uses the defunct `skills` domain (same issue as B in main SKILL.md). Should be `tools` domain with `skill.list` and `skill.show` operations.

---

## D. Stale CLI Examples

### D1. `session-protocol.md` — `cleo research link` token (line 116)

```
| `{{TASK_LINK_CMD}}` | `cleo research link` |
```

The `cleo research link` CLI command no longer exists. The equivalent MCP operation is `memory.link`. There is no direct `cleo research link` CLI analog; the replacement is `mutate memory link`.

### D2. No stale CLI examples found in the main SKILL.md

The CLI fallback section (lines 69-83) was reviewed. All commands (`ct find`, `ct show`, `ct add`, `ct complete`, `ct start`, `ct dash`, `ct sticky *`) are consistent with current CLI command structure. No issues found here.

---

## E. Recommended Fixes (for T5613)

Prioritized by severity (runtime breakage first, then missing capability, then optimization):

### Priority 1 — Fix defunct domain references (BREAKING)

1. Replace `research.list` → `pipeline.manifest.list` in query table
2. Replace `research.show` → `pipeline.manifest.show` in query table
3. Replace `research.link` → `memory.link` in mutate table
4. Replace `system.dash` → `admin.dash` in query table
5. Replace `system.context` → `admin.context` in query table
6. Replace `skills.list` → `tools.skill.list` in query table
7. Replace `skills.show` → `tools.skill.show` in query table
8. Fix `session-protocol.md` TASK_LINK_CMD token from `cleo research link` to `cleo memory link` (or remove)
9. Fix `session-protocol.md` skills discovery block from `domain: "skills"` to `domain: "tools"`

### Priority 2 — Add missing critical operations

10. Add `memory.find` to query table (tier 1, params: `{ query }`)
11. Add `memory.timeline` to query table (tier 1, params: `{ anchor }`)
12. Add `memory.fetch` to query table (tier 1, params: `{ ids }`)
13. Add `memory.observe` to mutate table (tier 1, params: `{ text, title? }`)
14. Add `pipeline.manifest.append` to mutate table (tier 1, params: `{ entry }`)
15. Add `session.handoff.show` to query table (tier 0, no params)
16. Add `admin.dash` to query table (replacing defunct `system.dash`)
17. Add a memory domain section covering the 3-layer retrieval pattern (find → timeline → fetch → observe)

### Priority 3 — Fix anti-patterns and ordering

18. Add filter guidance note to `tasks.list` row or move to "use with caution" section
19. Update Work Selection Decision Tree to use `session.status` → `session.find` instead of `session list`
20. Update Session Protocol Quick Start to lead with `ct session status`, not `ct session list`

### Priority 4 — Tier escalation clarity

21. Annotate the query and mutate tables with tier column (0/1/2) so agents know what requires tier escalation before calling `admin.help`
22. The Progressive Disclosure section (lines 130-139) mentions "Working with memory or check domains" at Tier 1 — this is correct but should explicitly list the memory ops now that they are absent from the table

---

## References

- Registry source of truth: `src/dispatch/registry.ts`
- Defunct domain mapping confirmed by task description and registry scan
- CLEO-INJECTION.md mandates `memory.find`, `memory.timeline`, `memory.fetch`, `memory.observe` in its 3-layer retrieval table
- Operation constitution: `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
- Related tasks: T5607 (this audit), T5613 (ct-cleo skill rewrite)
