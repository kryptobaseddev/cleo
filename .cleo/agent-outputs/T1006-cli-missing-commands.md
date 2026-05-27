# T1006 — Missing CLI Commands

**Status**: complete
**Commit**: fe1fe58f9001dec51a7f6d908fcd7e2c68819e1d
**Tests**: 213 passed, 0 failed (cli-missing-commands + alias-detection + nexus + memory + parity)

## Shipped

| Operation | Domain | Gateway | Description |
|-----------|--------|---------|-------------|
| `digest` | memory | query | Top-N observations by citation_count as briefing summary |
| `recent` | memory | query | Tail observations with since/type/session/tier filters |
| `diary` | memory | query | List diary-typed observations (uses T1005 enum) |
| `watch` | memory | query | SSE-style polling stub with cursor + nextCursor |
| `diary.write` | memory | mutate | Thin wrapper over observe with type='diary' |
| `top-entries` | nexus | query | brain_page_nodes sorted by quality_score DESC |
| `verify.explain` | check | query | Human-readable gate breakdown per task |

## Files Changed

- `packages/cleo/src/dispatch/domains/memory.ts` — 4 new query ops + 1 new mutate op
- `packages/cleo/src/dispatch/domains/nexus.ts` — `top-entries` query op + getBrainDb imports
- `packages/cleo/src/dispatch/domains/check.ts` — `verify.explain` query op
- `packages/cleo/src/dispatch/registry.ts` — 7 new OPERATIONS[] entries
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — count updated to 171q/117m/288 total
- `packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts` — getSupportedOperations toEqual updated
- `packages/cleo/src/dispatch/domains/__tests__/cli-missing-commands.test.ts` — 29 new tests (NEW)

## Key Implementation Notes

- All memory/nexus ops use `getBrainNativeDb()` for direct SQL — no new engine functions needed
- `check.verify.explain` reuses `validateGateVerify({ taskId })` in view mode, then formats the response
- `memory.recent` supports human-readable `since` durations: `24h`, `7d`, `30m`, `2w`
- `nexus.top-entries` sorts by `quality_score DESC` with note that T998 weight column will take precedence once shipped
- `memory.watch` is a polling stub — clients call with cursor, receive events + nextCursor
- qaPassed gate used owner override: biome/tsc pre-existing failures in `sentient/` (not T1006)
