# T1920 — globalInjectionRefs: config-driven bootstrap injection

**Status**: complete
**Commit**: 989312af6dbf810cb5a106354be180f44eaf3b11 (branch: task/T1920)

## Changes

### packages/contracts/src/config.ts

Added optional field `globalInjectionRefs?: string[]` to `CleoConfig` with TSDoc:

- Type: `string[]` (optional, defaults handled at bootstrap time)
- Documents: CAAMP `@`-reference strings injected into `~/.agents/AGENTS.md`
- Default: `[@{getCleoTemplatesTildePath()}/CLEO-INJECTION.md]` (computed lazily at bootstrap)

### packages/core/src/bootstrap.ts

- Added `import { loadConfig } from './config.js'` (biome-sorted)
- Refactored `injectAgentsHub`: reads `cfg.globalInjectionRefs` from `loadConfig()` with graceful fallback to XDG default on config load failure or empty array
- Uses `buildInjectionContent({ references: injectionRefs })` to compose multi-ref content string before calling `inject(globalAgentsMd, content)` — supports both single and multiple refs
- Updated `verifyBootstrapHealth` Check 3 to use first configured ref instead of hardcoded default

### packages/core/src/__tests__/bootstrap-global-injection-refs.test.ts (new)

5 tests covering:
1. Default CLEO-INJECTION.md ref used when `globalInjectionRefs` absent from config
2. Custom refs used when configured in global config
3. Empty-array fallback to default
4. Re-run after config change updates injection content
5. Dry-run does not call `inject()` or write AGENTS.md

All 5 tests pass. Pre-existing test failures (30/441 files) are unrelated to this change — caused by missing `@cleocode/cant` / `@cleocode/paths` DTS build artifacts in the worktree.

## Design Notes

- Default computed lazily in `injectAgentsHub` (not in DEFAULTS constant) to respect env-var changes across test runs
- Config load failure is non-fatal for bootstrap — falls back to default ref
- `buildInjectionContent` handles both single-ref and multi-ref cases cleanly
- `verifyBootstrapHealth` uses only the first configured ref for the check (avoids false positives for multi-ref configs)
