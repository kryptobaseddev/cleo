# scandir-fix Results

**Task**: T5598
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Applied existsSync guards to all three unguarded readdirSync callsites identified by the auditor across two commits. Build succeeds, type-check is clean, both commits pushed to main.

## Files Fixed

| File | Line | Fix type | Priority | Commit |
|------|------|----------|----------|--------|
| `src/core/lifecycle/rcasd-index.ts` | 202 | `if (!existsSync(taskDir)) continue;` before `readdirSync(taskDir)` | P1 | `ccba9d67` |
| `src/core/nexus/sharing/index.ts` | 79 | `if (!existsSync(cleoDir)) return [];` at top of `collectCleoFiles` | P1 | `8d06de6c` |
| `src/core/adrs/sync.ts` | 40, 43 | try/catch around both `readdirSync` calls in `collectAdrFiles` | P2 | `8d06de6c` |

## Commits

- **ccba9d67** — `fix(cli): add existsSync guards to unguarded readdirSync calls (T5598)` (rcasd-index.ts)
- **8d06de6c** — `fix(cli): add existsSync guards to unguarded readdirSync calls (T5598)` (nexus/sharing, adrs/sync)

## Verification

- `npx tsc --noEmit`: zero errors (both rounds)
- `npm run build`: success (both rounds)
- Pushed: `ccba9d67` and `8d06de6c` to `origin/main`

## Notes

- Fix 1 (`rcasd-index.ts`): `existsSync` already imported; `continue` valid inside `for...of` loop
- Fix 2 (`nexus/sharing`): early return before `walk(cleoDir)` call; `existsSync` already imported
- Fix 3 (`adrs/sync`): try/catch pattern chosen to handle both outer dir scan (line 40) and inner subdir scans (line 43); used `import('node:fs').Dirent[]` type annotation to satisfy TypeScript strict mode

## References

- Audit report: `.cleo/agent-outputs/scandir-audit.md`
