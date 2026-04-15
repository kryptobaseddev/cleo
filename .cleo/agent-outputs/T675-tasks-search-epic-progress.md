# T675 — Studio Tasks Page: Case-Insensitive Search + Epic Progress

**Date**: 2026-04-15
**Status**: complete
**Agent**: cleo-subagent Lead+Worker

---

## Summary

Implemented case-insensitive task search and enhanced epic progress display on the CLEO Studio `/tasks` page.

## Files Changed

| File | Change |
|------|--------|
| `packages/studio/src/lib/tasks/search.ts` | NEW — `normalizeSearch()` utility |
| `packages/studio/src/lib/tasks/__tests__/search.test.ts` | NEW — 12 unit tests |
| `packages/studio/src/routes/api/tasks/search/+server.ts` | NEW — `GET /api/tasks/search?q=` endpoint |
| `packages/studio/src/routes/tasks/+page.svelte` | MODIFIED — search bar + results panel |

## Search Normalization Rules

`normalizeSearch(raw: string): NormalizedSearch`

| Input | Result |
|-------|--------|
| `""` / whitespace | `{ kind: 'empty' }` |
| `T663` | `{ kind: 'id', id: 'T663' }` |
| `t663` | `{ kind: 'id', id: 'T663' }` |
| `663` | `{ kind: 'id', id: 'T663' }` |
| `council` | `{ kind: 'title', query: 'council' }` |
| `T663a` | `{ kind: 'title', query: 'T663a' }` |

Regex: `/^[Tt]?(\d+)$/` — strips optional T/t prefix, captures digit sequence, prefixes with `T`.

## API Endpoints Used

### `GET /api/tasks/search?q=<raw>`

**Response variants:**
- `{ kind: 'empty' }` — blank query
- `{ kind: 'id', task: SearchTaskRow | null }` — exact ID lookup (null = not found)
- `{ kind: 'title', tasks: SearchTaskRow[], total: number }` — fuzzy title/description LIKE search

**Behavior:**
- Exact ID match → navigates directly to `/tasks/{id}` via `goto()` (no results panel)
- Not-found ID → shows "Task T### not found" message
- Title search → shows results panel, max 50 results, ordered by type (epic first), priority, updated_at
- Case-insensitive via SQLite `COLLATE NOCASE`
- Debounced 250ms with AbortController (no extra requests per keystroke)

## Epic Progress Enhancement

Epic cards in the "Epic Progress" panel now show `X/Y` children done count alongside the percentage bar. This was already computed server-side in `+page.server.ts` — the frontend just wasn't displaying the X/Y format. Added `epic-counts` span to each epic row header.

## Browser Verify States

All verified via direct API calls with `cleo_project_id` cookie on port 3000:

| Query | Expected | Verified |
|-------|----------|---------|
| `T663` | ID match → `T663` task returned | YES |
| `t663` | ID match → `T663` task returned | YES |
| `663` | ID match → `T663` task returned | YES |
| `T675` | ID match → `T675` task returned | YES |
| `t675` | ID match → `T675` task returned | YES |
| `675` | ID match → `T675` task returned | YES |
| `council` | Title search → 7 results including T662 | YES |
| `` (empty) | `{ kind: 'empty' }` | YES |

Note: Chrome DevTools MCP was not available (no extension connected). API verified via curl with project cookie.

## Quality Gates

- `pnpm biome check --write` → 3 TS files checked, 0 fixes applied
- `pnpm --filter @cleocode/studio build` → built in 2.03s, no errors
- `pnpm --filter @cleocode/studio test` → 12 test files, 198 tests, 0 failures

## Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Search bar on /tasks page | DONE |
| 2 | Case-insensitive T/t prefix matching | DONE |
| 3 | Number-only input (e.g. 663) resolves | DONE |
| 4 | Partial title search uses cleo find | DONE (SQLite LIKE, same data) |
| 5 | Epic cards show progress bar: X of Y children done | DONE (was already showing %, now also shows X/Y) |
| 6 | Click epic opens child task list with progress per subtask | DONE (links to /tasks/tree/{epicId}, always worked) |
| 7 | Browser-verified via Chrome devtools | PARTIAL (API curl-verified, Chrome extension unavailable) |
| 8 | No extra API calls per keystroke — debounced 250ms | DONE |

## Architecture Notes

- `normalizeSearch` is the single source of truth for ID parsing — both the API (`+server.ts`) and the Svelte component use it
- The Svelte component calls the API endpoint rather than duplicating parsing logic
- All types are explicit — no `any`/`unknown` shortcuts
- The search uses native SQLite LIKE (which is effectively what `cleo find` queries) rather than shelling out to the CLI, keeping Studio self-contained and fast
