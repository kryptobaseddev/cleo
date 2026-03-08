# T5534 — session Domain Review

**Task**: T5534
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Current: 19 ops (11q + 8m) | Target: ≤16 | Projected: 15 ops (9q + 6m)

The session domain is the continuity layer for agent work. Most operations are necessary and well-designed. The key waste comes from `chain.show` (pure analytics navigable via `show`) and `history` (overlaps `list` for its primary use case). Merging `debrief.show` into `show` via a `include=debrief` param eliminates one op without losing capability. Demoting `context.inject` to the orchestrate or admin domain removes an architectural oddity. The result is a tighter, more coherent session API.

---

## Current Operation Inventory

### Query (11 ops)

| Operation | Tier | Description |
|-----------|------|-------------|
| `status` | 0 | Active session check + task focus. Cold-start minimum. |
| `list` | 0 | Paginated session list with filter/status params. |
| `find` | 0 | Lightweight session discovery (minimal fields). |
| `show` | 0 | Full session detail by `sessionId`. |
| `history` | 0 | Timeline of focus changes + completed tasks per session. |
| `decision.log` | 0 | All recorded decisions, filterable by session or task. |
| `context.drift` | 0 | Scope drift score + factors for active session. |
| `handoff.show` | 0 | Handoff data from most recent ended session. |
| `briefing.show` | 0 | Composite start-of-session context aggregate. |
| `debrief.show` | 1 | Rich debrief for a specific ended session. Falls back to handoff data. |
| `chain.show` | 1 | Ordered session chain via previousSessionId/nextSessionId links. |

### Mutate (8 ops)

| Operation | Tier | Description |
|-----------|------|-------------|
| `start` | 0 | Begin new session (scope required). Auto-injects briefing + predecessor debrief. |
| `end` | 0 | End active session. Computes debrief, persists handoff, brain memory. |
| `resume` | 0 | Resume ended/suspended session. Enriches with brain memory context. |
| `suspend` | 0 | Suspend active session with optional reason. |
| `gc` | 0 | Garbage collect stale/old sessions (orphan detection + removal). |
| `record.decision` | 0 | Append structured decision to session audit trail. |
| `record.assumption` | 0 | Record an assumption with confidence level. |
| `context.inject` | 1 | Read protocol content from filesystem (protocolType → file lookup). |

---

## Decision Matrix

| Operation | Decision | Reason |
|-----------|----------|--------|
| `status` | **KEEP** | Tier 0 cold-start minimum. `hasActiveSession` + `taskWork` in one call. |
| `find` | **KEEP** | Lightweight discovery, preferred per VERB-STANDARDS. Token-cheap alternative to `list`. |
| `list` | **KEEP** | Paginated filtered list with budget metadata. Distinct from `find` (returns full records). |
| `show` | **KEEP** | Full detail for a known sessionId. Core navigation. |
| `handoff.show` | **KEEP** | Primary resume-context op. Called at every session start. Non-negotiable. |
| `briefing.show` | **KEEP** | Composite cold-start context. Reduces agent round-trips at session open. |
| `decision.log` | **KEEP** | Audit trail read. Required for decision replay and compliance. |
| `context.drift` | **KEEP** | Active session health check. Distinct signal with no substitute. |
| `record.decision` | **KEEP** | Core record-keeping for agent autonomy trace. |
| `record.assumption` | **KEEP** | Complements `record.decision`. Captures confidence-rated assumptions. |
| `start` | **KEEP** | Fundamental lifecycle op. |
| `end` | **KEEP** | Fundamental lifecycle op. Triggers debrief + handoff compute. |
| `resume` | **KEEP** | Fundamental lifecycle op. |
| `suspend` | **KEEP** | Fundamental lifecycle op. |
| `gc` | **KEEP** | Maintenance op. Orphan detection is critical for single-agent environments. |
| `history` | **REMOVE** | Overlaps `list` (which returns full session records) and `show` (which has focus history). Use `list` with a `sessionId` filter or `show` for the same data. Removes 1 op. |
| `debrief.show` | **MERGE into `show`** | `show` with `params.include=debrief` should return `debriefJson` inline. `debrief.show` is a subset of `show`. Avoids a separate MCP call for the same session object. Removes 1 op. |
| `chain.show` | **REMOVE** | Pure analytics navigable from `show` (which exposes `previousSessionId`/`nextSessionId`). No core agent workflow requires the full chain at once. Move to tier 2 plugin or remove entirely. Removes 1 op. |
| `context.inject` | **MOVE** | Reads protocol files from filesystem — not a session state operation. Belongs in `admin.context.inject` or as a `tools` sub-op. Does not mutate session data. Move removes 1 session op. |

---

## Merge / Parameterize Details

### 1. `debrief.show` → merged into `show`

Current: `query session show {sessionId}` returns session record without `debriefJson`.
Proposed: `query session show {sessionId, include: ["debrief"]}` returns session + parsed debrief inline.

Implementation: In `sessionShow`, if `params.include` contains `"debrief"`, parse and attach `session.debriefJson` before returning.

This mirrors the pattern used in `session.start` which auto-embeds `previousDebrief` in the response already. `show` with `include=debrief` is the explicit counterpart.

**Backward compatibility**: `show` without `include` continues to work unchanged.

### 2. `history` removal

`list` already supports `status` and `active` filters. Adding `sessionId` as a filter to `list` covers the primary `history` use case (what happened in session X). The detailed focus-change timeline returned by `history` could also be included in `show` with `include=history` if needed in future.

**Note**: If the focus-change timeline is considered essential for compliance purposes, the alternative is to promote it into `show` via `include=history` rather than full removal. Flag for T5609 synthesis.

---

## Tier Review

### Tier 0 (cold-start minimum) — proposed

| Op | Gateway |
|----|---------|
| `status` | query |
| `handoff.show` | query |
| `briefing.show` | query |
| `find` | query |
| `show` | query |
| `decision.log` | query |
| `context.drift` | query |
| `start` | mutate |
| `end` | mutate |
| `resume` | mutate |
| `suspend` | mutate |
| `gc` | mutate |
| `record.decision` | mutate |
| `record.assumption` | mutate |

### Tier 1 — proposed

| Op | Gateway | Rationale |
|----|---------|-----------|
| `list` | query | Available for direct child iteration; prefer `find` for discovery |

### Moved / Removed

| Op | Action | Target |
|----|--------|--------|
| `history` | REMOVE | — |
| `chain.show` | REMOVE | — |
| `debrief.show` | MERGE INTO `show` | `show` gains `include` param |
| `context.inject` | MOVE | `admin.context.inject` or `tools.protocol.inject` |

---

## Resulting Count

| Change | Delta |
|--------|-------|
| Remove `history` | -1 |
| Remove `chain.show` | -1 |
| Merge `debrief.show` into `show` | -1 |
| Move `context.inject` out | -1 |
| **Total** | **-4** |

**Projected**: 15 ops (9q + 6m). Within the ≤16 target.

---

## CLI Impact

| MCP Operation | CLI Equivalent | Impact |
|---------------|----------------|--------|
| `session history` | `cleo session history` | Remove CLI sub-command or alias to `cleo session list` |
| `session chain.show` | `cleo session chain` | Remove CLI sub-command |
| `session debrief.show` | `cleo session debrief` | Fold into `cleo session show --include debrief` |
| `session context.inject` | `cleo session inject` | Move to `cleo admin inject` or `cleo tools inject` |

---

## LAFS / MVI Alignment

**Tier 0 bloat assessment**: All 9 proposed query tier-0 ops justify their position.
- `status` / `handoff.show` / `briefing.show` are the three-call cold-start sequence every agent needs.
- `find` + `show` are standard discovery/detail navigation.
- `decision.log` + `context.drift` are lightweight safety checks agents call during active work.

**`list` tier-1 demotion**: `list` returns full session records with stats and notes — higher cost than `find`. Tier 1 is appropriate per the token-budget principles in CLEO-INJECTION.md.

**MVI principle**: `session.start` already auto-injects briefing and predecessor debrief, so an agent that calls `start` gets the full session context in one round-trip. The explicit `briefing.show` and `handoff.show` exist for agents that need to re-read context mid-session or recover without a fresh start.

---

## Open Questions for T5609

1. **`history` removal vs `include`**: Is the focus-change timeline (task sequences within a session) needed for compliance auditing? If so, fold into `show` via `include=history` rather than deleting.
2. **`context.inject` destination**: `admin.context.inject` or `tools.protocol.inject`? The operation reads static files and has no session state dependency. Lean toward `admin` since it is a bootstrap utility.
3. **`list` tier**: Demoting to tier 1 reduces visible surface but may break agent cold-start flows that call `list` before `find` exists in their mental model. T5608 tier audit should confirm.

---

## References

- T5517: EPIC: Rationalize CLEO API Operations (268→≤180)
- T5534: This task
- T5535: Inventory session operations and map agent workflows
- T5536: Challenge session operations against LAFS and MVI
- T5537: Decide keep or remove outcomes for session operations
- T5609: C: Synthesize 10 domain reviews → decision matrix
- T5608: R: Audit tier assignments + nexus gate UX
- Session domain handler: `src/dispatch/domains/session.ts`
- Session engine: `src/dispatch/engines/session-engine.ts`
- Context inject: `src/core/sessions/context-inject.ts`
- Registry entries: `src/dispatch/registry.ts` (lines 244–1478, session section)
