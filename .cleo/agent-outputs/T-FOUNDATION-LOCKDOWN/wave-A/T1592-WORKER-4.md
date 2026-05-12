# T1592 — Per-Parent Dedup Gate (Foundation Lockdown · Wave A · Worker 4)

## Mission
Add per-parent dedup gate to sentient proposer. Prevents T1555-style dup bursts
(predecessor's sentient ran twice on the same audit output → 4 dup pairs
T1544/T1550, T1545/T1551, T1546/T1552, T1547/T1553).

## Files Touched

| File | Status | LOC |
|------|--------|-----|
| `packages/core/src/sentient/proposal-dedup.ts` | NEW | 300 |
| `packages/core/src/sentient/__tests__/dedup.test.ts` | NEW | 433 |
| `packages/core/src/sentient/propose-tick.ts` | EDIT (~60 LOC added) | 506 (was ~466) |
| `packages/core/src/sentient/index.ts` | EDIT (1 line) | 26 |
| `packages/core/src/sentient/__tests__/propose-tick.test.ts` | EDIT (1 column) | unchanged net |

Net additions: ~735 LOC across 5 files.

## Migration Needed
**No.** The dedup hash is embedded in the existing `tasks.notes_json` column
inside the `proposal-meta` envelope (alongside `proposedBy`, `source`,
`sourceId`, `weight`, `proposedAt`). Pattern matches the existing convention
documented at `propose-tick.ts:355` ("This avoids needing a new column on the
tasks table"). Future ticks query via
`notes_json LIKE '%dedupHash%<hex>%'` — sha-256 hex (64 chars `[0-9a-f]`)
cannot collide with any other JSON value.

No drizzle migration was required. No file was added under
`packages/core/src/tasks/migrations/`.

## Implementation Summary

1. **`proposal-dedup.ts`** — three pure functions + audit writer:
   - `normalizeForDedup(raw)` — lowercase + strip non-`[a-z0-9\s]` + collapse whitespace + trim
   - `computeDedupHash({parentId, title, acceptance})` — sha-256 over
     `parentKey  normalizedTitle  normalizedAcceptance` (`<root>` sentinel
     for null parent, ASCII-SOH separator)
   - `checkDedupCollision({tasksDb, candidate, windowHours?})` — scoped query:
     `labels_json LIKE '%sentient-tier2%'` AND `notes_json LIKE '%dedupHash%<hex>%'`
     AND parent matches AND `created_at >= datetime('now', '-24 hours')`
   - `recordDedupRejection({...})` — appends NDJSON to
     `<projectRoot>/.cleo/audit/sentient-dedup.jsonl`
2. **`propose-tick.ts`** — gate inserted between candidate-slice loop and
   `transactionalInsertProposal`. Dups are skipped (not counted as written),
   audited, and the candidate is dropped. Successful inserts embed `dedupHash`
   in the proposal-meta JSON.
3. **`index.ts`** — re-exports `proposal-dedup.js` from
   `@cleocode/core/sentient` barrel.

## Tests

| Test | Result |
|------|--------|
| `normalizeForDedup` (4 cases) | passed |
| `computeDedupHash` (5 cases — determinism, null/empty parent, parent-changes, title-changes, punctuation-equivalence) | passed |
| `checkDedupCollision > returns isDuplicate=false when DB is null` | passed |
| `checkDedupCollision > returns isDuplicate=false when no existing rows` | passed |
| `checkDedupCollision > detects same-hash + same-parent collision (root)` | passed |
| `checkDedupCollision > does NOT collide when parent differs` | passed |
| `checkDedupCollision > does NOT collide when older than window (>24h)` | passed |
| `checkDedupCollision > DOES collide when within window (<24h)` | passed |
| **`checkDedupCollision > reproduces T1555 burst (4 distinct dups all rejected on second run)`** | **passed (T1555 reproduction)** |
| `recordDedupRejection > appends NDJSON line` | passed |
| `recordDedupRejection > creates audit dir if missing` | passed |
| `recordDedupRejection > appends rather than overwrites` | passed |

**dedup.test.ts: 19 passed / 0 failed.**

Regression run on existing sentient suite:
- `propose-tick.test.ts`: 8 passed | 1 todo (preexisting)
- `proposal-rate-limiter.test.ts`: 14 passed
- `daemon.test.ts`: 21 passed
- **Full sentient suite: 267 passed | 1 todo (preexisting) — zero new failures.**

Typecheck (`tsc --noEmit`) on changed files: clean.
Biome (`pnpm biome check --write` on the 4 changed files): clean.

## Audit Log Path
`<projectRoot>/.cleo/audit/sentient-dedup.jsonl`

Each rejection appends one NDJSON record:

```json
{
  "timestamp": "2026-04-29T...",
  "reason": "per-parent-dedup",
  "dedupHash": "<sha256-hex>",
  "parentId": null,
  "title": "[T2-BRAIN] auth failures",
  "source": "brain",
  "sourceId": "O-001",
  "existingTaskId": "T1544",
  "windowHours": 24
}
```

Constant exported as `SENTIENT_DEDUP_AUDIT_FILE`.

## Constraints Respected
- All logic in `packages/core/src/sentient/` (project-agnostic).
- TypeScript strict — no `any`, no `unknown` casts, no `as unknown as X`.
- Used existing contracts (`ProposalCandidate`) — no inline types.
- Existing ProposedTaskMeta envelope extended with `dedupHash`; new types live in `proposal-dedup.ts` and are re-exported.
- Existing sentient tests untouched except for one schema column add (`parent_id TEXT`) on the in-memory test fixture.
