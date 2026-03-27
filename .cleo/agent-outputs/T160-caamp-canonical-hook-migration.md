# T160 - Migrate CLEO hook types.ts to CAAMP 16-event canonical taxonomy

**Status**: complete
**Date**: 2026-03-24
**Epic**: T158 (CAAMP 1.9.1 Hook Normalizer Integration)

## Summary

Migrated CLEO's hook system from 8 `on`-prefix provider events to CAAMP 1.9.1's 16-event canonical taxonomy. All handler registrations and dispatch sites updated. Backward compatibility preserved via automatic legacy name remapping in HookRegistry.

## Files Modified

### Core Types (`packages/core/src/hooks/types.ts`)
- Replaced `HookEvent as CAAMPHookEvent` import with `CanonicalHookEvent` from CAAMP
- Added re-exports: `CANONICAL_HOOK_EVENTS`, `HOOK_CATEGORIES`, `toNative`, `toCanonical`, `supportsHook`, `buildHookMatrix`
- `ProviderHookEvent` now aliases `CanonicalHookEvent` (was deprecated `string` type)
- Updated `CLEO_TO_CAAMP_HOOK_MAP` values to canonical names
- Renamed payload types to canonical names, kept old names as `@deprecated` aliases:
  - `OnSessionStartPayload` -> `SessionStartPayload`
  - `OnSessionEndPayload` -> `SessionEndPayload`
  - `OnToolStartPayload` -> `PreToolUsePayload` (+ new `toolName`, `toolInput` fields)
  - `OnToolCompletePayload` -> `PostToolUsePayload` (+ new `toolResult` field)
  - `OnFileChangePayload` -> `NotificationPayload` (generalized for non-file notifications)
  - `OnErrorPayload` -> `PostToolUseFailurePayload`
  - `OnPromptSubmitPayload` -> `PromptSubmitPayload`
  - `OnResponseCompletePayload` -> `ResponseCompletePayload`
- Added new payload types for previously unmapped canonical events:
  - `SubagentStartPayload`, `SubagentStopPayload`
  - `PreCompactPayload`, `PostCompactPayload`
  - `ConfigChangePayload`

### Hook Registry (`packages/core/src/hooks/registry.ts`)
- `DEFAULT_HOOK_CONFIG` now includes all 16 canonical events + 5 internal events
- Added `LEGACY_EVENT_MAP` to remap old `on`-prefix names to canonical equivalents
- `resolveEvent()` private method applies legacy remapping with deprecation warning
- `register()`, `dispatch()`, `isEnabled()`, `listHandlers()` all use `resolveEvent()` for backward compat

### Handler Registrations
All handlers updated to use canonical event names:
- `session-hooks.ts`: `'onSessionStart'` -> `'SessionStart'`, `'onSessionEnd'` -> `'SessionEnd'`
- `task-hooks.ts`: `'onToolStart'` -> `'PreToolUse'`, `'onToolComplete'` -> `'PostToolUse'`
- `file-hooks.ts`: `'onFileChange'` -> `'Notification'`
- `mcp-hooks.ts`: `'onPromptSubmit'` -> `'PromptSubmit'`, `'onResponseComplete'` -> `'ResponseComplete'`
- `error-hooks.ts`: `'onError'` -> `'PostToolUseFailure'`
- `work-capture-hooks.ts`: `'onPromptSubmit'` -> `'PromptSubmit'`, `'onResponseComplete'` -> `'ResponseComplete'`

Handler payload types updated to use canonical names (with backward compat via type aliases).

### Dispatch Sites
- `sessions/index.ts`: `'onSessionStart'` -> `'SessionStart'`, `'onSessionEnd'` -> `'SessionEnd'`
- `sessions/snapshot.ts`: `'onSessionStart'` -> `'SessionStart'`
- `task-work/index.ts`: `'onToolStart'` -> `'PreToolUse'`, `'onToolComplete'` -> `'PostToolUse'`
- `store/json.ts`: `'onFileChange'` -> `'Notification'`
- `cleo/dispatch/adapters/cli.ts`: `'onPromptSubmit'` -> `'PromptSubmit'`, `'onResponseComplete'` -> `'ResponseComplete'`
- `cleo/src/mcp/index.ts`: All three dispatch calls updated to canonical names

### Payload Schemas (`packages/core/src/hooks/payload-schemas.ts`)
- Renamed schemas to canonical names with `@deprecated` aliases for old names
- Added schemas for: `SubagentStartPayloadSchema`, `SubagentStopPayloadSchema`, `PreCompactPayloadSchema`, `PostCompactPayloadSchema`, `ConfigChangePayloadSchema`
- `EVENT_SCHEMA_MAP` updated to use canonical event name keys

### Provider Hooks (`packages/core/src/hooks/provider-hooks.ts`)
- Updated to use `CanonicalHookEvent` type
- Added `toNativeHookEvent()`, `toCanonicalHookEvent()`, `providerSupportsHookEvent()` wrappers
- Re-exports CAAMP normalizer functions

### Adapter Files
- `adapters/src/providers/claude-code/adapter.ts`: `supportedHookEvents` updated to canonical names
- `adapters/src/providers/opencode/adapter.ts`: `supportedHookEvents` updated to canonical names
- `adapters/src/providers/claude-code/hooks.ts`: `CLAUDE_CODE_EVENT_MAP` maps to canonical names
- `adapters/src/providers/opencode/hooks.ts`: `OPENCODE_EVENT_MAP` maps to canonical names

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| HookEvent type uses CAAMP CanonicalHookEvent | PASS - `ProviderHookEvent = CanonicalHookEvent` |
| All 16 events dispatchable | PASS - DEFAULT_HOOK_CONFIG has all 16 |
| Existing handlers still work (backward compat) | PASS - LEGACY_EVENT_MAP auto-remaps old names |
| New events: PreToolUse, PostToolUse, SubagentStart/Stop, PreCompact, Notification | PASS - all registered in config + payload types added |
| Hook dispatch uses toNative for adapter bridging | PASS - provider-hooks.ts re-exports + uses toNative/toCanonical |
| Build passes | PASS |
| Tests pass (0 regressions) | PASS - 37 hook tests, 171 adapter tests, 147 session tests, 420 store/task-work tests |

## Quality Gates

- biome check: PASS (fixed 2 files)
- pnpm run build: PASS
- pnpm exec vitest run packages/core/src/hooks/: 37/37 tests pass
- pnpm exec vitest run packages/adapters/src/: 171/171 tests pass
- pnpm exec vitest run packages/core/src/sessions/: 147/147 tests pass
- pnpm exec vitest run packages/core/src/store/ packages/core/src/task-work/: 420 pass, 5 skipped (pre-existing)
