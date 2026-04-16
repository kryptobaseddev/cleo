# T726 Wave 1D — Tier CLI + Studio Chart + Promotion Tests

**Date**: 2026-04-15
**Tasks**: T744, T748, T747
**Epic**: T726 (Memory Architecture Reality Check + Long-Term Tier Wire-Up)
**Status**: complete
**Commit**: 2609fa9f

---

## Summary

Three tasks implemented and committed in a single wave:

### T744 — `cleo memory tier` CLI subcommands

**File**: `packages/cleo/src/cli/commands/memory-brain.ts`

Added `cleo memory tier` parent command with three subcommands:

**`cleo memory tier stats`**
- Per-table tier distribution (short/medium/long counts) for all 4 brain tables
- Top-10 upcoming long-tier promotions: medium entries with citation_count>=5 OR verified=1, sorted by days-until 7d gate elapses
- Human-readable and `--json` modes
- Uses `getBrainDb` + `getBrainNativeDb` directly (same pattern as `consolidate` command)

**`cleo memory tier promote <id> --to <tier> --reason "<text>"`**
- Searches all 4 brain tables for the entry
- Enforces tier ordering (must promote, not demote; use `demote` command for the reverse)
- Bypasses age gate entirely (manual override as designed)
- Updates `memory_tier` and `updated_at` via raw SQL
- LAFS-compliant JSON envelope on `--json`

**`cleo memory tier demote <id> --to <tier> --reason "<text>"`**
- Long-tier entries require `--force` flag (long tier is permanent without explicit override)
- Enforces tier ordering (must demote, not promote)
- Same multi-table search + raw SQL update pattern

All three pass LAFS validation (success/data/meta envelope).

---

### T748 — Studio `/brain/overview` Tier Distribution Chart + Countdown

**Files**:
- `packages/studio/src/routes/brain/overview/+page.server.ts` — extended load function
- `packages/studio/src/routes/brain/overview/+page.svelte` — new chart + countdown panels
- `packages/studio/src/routes/api/brain/tier-stats/+server.ts` — new API endpoint

**Server load** now computes two additional datasets:
- `tierDistribution: TableTierDistribution[]` — per-table short/medium/long counts
- `upcomingPromotions: UpcomingPromotion[]` — top-5 medium entries closest to long-tier eligibility

**Svelte page** (Svelte 5 runes) adds two new panels below the existing ones:

1. **Tier Distribution bar chart** — proportional horizontal bars per table, color-coded (short=slate, medium=blue, long=green), with legend and total counts. Uses inline SVG-like CSS layout, no external chart library.

2. **Upcoming Long-Tier Promotions card** — shows top-5 entries with ID, source table, promotion track (citation count or verified), and countdown in days/hours. Entries eligible now show green. Falls back to a dashed "No entries qualify" notice when list is empty.

**API endpoint** `GET /api/brain/tier-stats` returns:
```typescript
{
  tables: TableTierCounts[];         // all 4 brain tables × 3 tiers
  upcomingLongPromotions: UpcomingPromotion[];  // top-5 soonest
}
```

---

### T747 — Real-SQLite Vitest Tests for `runTierPromotion()`

**File**: `packages/core/src/memory/__tests__/tier-promotion.test.ts`

15 tests covering all promotion tracks and protection rules:

| Test | Track |
|------|-------|
| short→medium with citation_count >= 3 | citation |
| short→medium with citation_count < 3 (negative) | — |
| short→medium with quality_score >= 0.7 (T614 fix verified) | quality |
| short→medium with quality_score < 0.7 (negative) | — |
| short→medium with verified=1 | verified |
| age gate: fresh entry (< 24h) not promoted | age gate |
| medium→long with citation_count >= 5 + age > 7d | citation |
| medium→long age gate not met at 3 days (negative) | — |
| medium→long with verified=1 + age > 7d (decisions table) | verified |
| long-tier entry never evicted despite stale + low quality | protection |
| stale short evicted (age > 7d, quality < 0.5, unverified) | eviction |
| stale short with quality >= 0.5 NOT evicted | eviction gate |
| verified stale short PROMOTED not evicted | precedence |
| all 4 tables processed in one run | multi-table |
| empty DB returns empty result | baseline |

**Test infrastructure**: real `brain.db` via `getBrainDb(tempDir)`, temp dir per test, `resetBrainDbState()` in afterEach to prevent singleton bleed.

---

## Quality Gates

- biome: clean (0 errors, 3 auto-fixes applied)
- build: pre-existing failures unrelated to this work (transcript-scanner.ts not found, llm-backend-resolver.ts type issues) — confirmed identical baseline before and after stash
- tests: 15/15 new tests pass; 24/24 both tier test files pass combined; 0 new failures

---

## Files Changed

| File | Change |
|------|--------|
| `packages/cleo/src/cli/commands/memory-brain.ts` | +722 lines (tier subcommands) |
| `packages/studio/src/routes/brain/overview/+page.server.ts` | +93 lines (tier distribution + promotions) |
| `packages/studio/src/routes/brain/overview/+page.svelte` | +290 lines (chart + countdown UI + CSS) |
| `packages/studio/src/routes/api/brain/tier-stats/+server.ts` | NEW (API endpoint) |
| `packages/core/src/memory/__tests__/tier-promotion.test.ts` | NEW (15 real-SQLite tests) |
