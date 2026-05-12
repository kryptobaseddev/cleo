# T1911 — Adapter Paths SSoT Migration

**Status**: complete
**Commit**: 728098a4a0054ebc4d772ce1a42a18c8d5061938
**Branch**: task/T1911

## Summary

Replaced hardcoded `'@~/.cleo/templates/CLEO-INJECTION.md'` string in three adapter
install providers with a template literal calling `getCleoTemplatesTildePath()` imported
from `'../shared/paths.js'` (which re-exports from `@cleocode/paths` SSoT). Pattern
matches `claude-code/install.ts:37-38`.

## Files Changed

- `packages/adapters/src/providers/gemini-cli/install.ts` — added import, changed constant
- `packages/adapters/src/providers/kimi/install.ts` — added import, changed constant
- `packages/adapters/src/providers/openai-sdk/install.ts` — added import, changed constant, updated JSDoc
- `packages/adapters/src/providers/openai-sdk/__tests__/openai-sdk-spawn.test.ts` — updated test to use `getCleoTemplatesTildePath()` for dynamic path matching

## Acceptance Criteria Verified

- grep returns 0 hits for hardcoded path in adapters/src/ (CLEAN)
- 3 adapter installers import `getCleoTemplatesTildePath` (confirmed)
- tests pass for each adapter install flow (278/278 in scope)
- biome ci clean (6 pre-existing warnings, no errors)

## Gates

- implemented: commit 728098a4a + 3 files
- testsPassed: 278/278 (adapters suite, claude-code-adapter integration timeouts pre-existing)
- qaPassed: biome exit 0 + tsc exit 0
- cleanupDone: note
