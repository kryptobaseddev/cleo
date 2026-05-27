# T474 Session Domain Audit

**Date**: 2026-04-10
**Task**: T474 — W3: session domain lead (15 ops)
**Status**: complete

## Audit Summary

All 15 session domain operations verified against the registry (`cleo ops --domain session --tier 2`). Four operations were missing CLI subcommands; all four have been added to `packages/cleo/src/cli/commands/session.ts`.

## Operation Coverage Map

| # | Operation | Gateway | CLI Subcommand | Status |
|---|-----------|---------|----------------|--------|
| 1 | `session.status` | query | `session status` | COVERED (pre-existing) |
| 2 | `session.list` | query | `session list` | COVERED (pre-existing) |
| 3 | `session.show` | query | `session show <sessionId>` | ADDED |
| 4 | `session.decision.log` | query | `session decision-log` | COVERED (pre-existing) |
| 5 | `session.context.drift` | query | `session context-drift` | ADDED |
| 6 | `session.handoff.show` | query | `session handoff` | COVERED (pre-existing) |
| 7 | `session.briefing.show` | query | `briefing` (top-level cmd) | COVERED (separate file) |
| 8 | `session.find` | query | `session find` | COVERED (pre-existing) |
| 9 | `session.start` | mutate | `session start` | COVERED (pre-existing) |
| 10 | `session.end` | mutate | `session stop` / `session end` | COVERED (pre-existing) |
| 11 | `session.resume` | mutate | `session resume <sessionId>` | COVERED (pre-existing) |
| 12 | `session.suspend` | mutate | `session suspend <sessionId>` | ADDED |
| 13 | `session.gc` | mutate | `session gc` | COVERED (pre-existing) |
| 14 | `session.record.decision` | mutate | `session record-decision` | COVERED (pre-existing) |
| 15 | `session.record.assumption` | mutate | `session record-assumption` | ADDED |

## Added Subcommands

### `session show <sessionId>`
- Gateway: query
- Registry op: `session.show`
- Params: `sessionId` (required positional), `--include <include>` (optional, accepts `debrief` to invoke debrief path)
- Description: "Show full details for a session (absorbs debrief.show via --include debrief)"

### `session context-drift`
- Gateway: query
- Registry op: `session.context.drift`
- Params: `--session-id <sessionId>` (optional, defaults to active session)
- Description: "Detect context drift in the current or specified session"

### `session suspend <sessionId>`
- Gateway: mutate
- Registry op: `session.suspend`
- Params: `sessionId` (required positional), `--reason <reason>` (optional)
- Description: "Suspend an active session (pause without ending)"

### `session record-assumption`
- Gateway: mutate
- Registry op: `session.record.assumption`
- Params: `--assumption <assumption>` (required), `--confidence <confidence>` (required, high|medium|low), `--session-id <sessionId>` (optional), `--task-id <taskId>` (optional)
- Description: "Record an assumption made during the current session"

## Classification Notes

All four missing operations were classified as `needs-cli`:
- `session.show` — symmetrical with `tasks show`, standard user-facing query
- `session.context.drift` — diagnostic operation useful from CLI for agent safeguard workflows
- `session.suspend` — lifecycle operation (pause without end), parallel to resume
- `session.record.assumption` — agent workflow capture, mirrors record-decision pattern

No operations required `agent-only` classification. All are appropriate for direct CLI access.

## Dispatch Verification

All existing CLI handlers verified to target valid registry operations:

| CLI subcommand | Dispatch target | Registry check |
|---------------|-----------------|----------------|
| `session start` | `mutate session start` | valid |
| `session stop/end` | `mutate session end` | valid |
| `session handoff` | `query session handoff.show` | valid |
| `session status` | `query session status` | valid |
| `session resume` | `mutate session resume` | valid |
| `session find` | `query session find` | valid |
| `session list` | `query session list` | valid |
| `session gc` | `mutate session gc` | valid |
| `session record-decision` | `mutate session record.decision` | valid |
| `session decision-log` | `query session decision.log` | valid |

## Quality Gates

- biome check: 0 errors, 1 pre-existing warning (line 82, `useOptionalChain` in handoff handler, unsafe fix, not touched)
- Build: pre-existing failures in `@cleocode/caamp` and `@cleocode/lafs` type declarations — unrelated to session.ts changes
- No new TypeScript errors introduced

## File Modified

`packages/cleo/src/cli/commands/session.ts` — added 4 subcommands between `session gc` and `session record-decision`
