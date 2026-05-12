# T893 — AGENTS.md Deduplication: CLEO_HARNESS_LOADS_AGENTS_MD env var

**Status**: complete
**Date**: 2026-04-20

## Summary

Added `CLEO_HARNESS_LOADS_AGENTS_MD=1` env var support to `harness-hint.ts`. When this env var is set to `1`, the harness cascade resolves to `claude-code` (triggering the tier-1 CLEO-INJECTION.md dedup). This is used by harnesses that auto-inject `AGENTS.md` into subagent context.

The existing `buildTier1InjectionPointer()` and `skipCleoInjectionEmbed` machinery was already in place from T889 Wave 3. This task adds the env var signal.

## Files Changed

- `packages/core/src/orchestration/harness-hint.ts` — Added CLEO_HARNESS_LOADS_AGENTS_MD=1 check in cascade step 2b
- `packages/core/src/orchestration/__tests__/harness-hint.test.ts` — Added 3 new T893 tests

## Cascade Position

```
1. explicit option wins
2. CLEO_HARNESS env var
2b. CLEO_HARNESS_LOADS_AGENTS_MD=1 → claude-code  (NEW)
3. persisted harness-profile.json
4. auto-detect (CLAUDECODE=1 + CLAUDE_CODE_ENTRYPOINT)
5. default: generic
```

## Tests Added

- CLEO_HARNESS_LOADS_AGENTS_MD=1 → resolves to claude-code (source='env')
- CLEO_HARNESS takes precedence over CLEO_HARNESS_LOADS_AGENTS_MD
- CLEO_HARNESS_LOADS_AGENTS_MD=0 → does not trigger (must be exactly "1")

Total harness-hint tests: 17 (14 original + 3 new T893 tests).
