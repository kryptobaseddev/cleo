# T166: Wire Brain Automation Handlers to CAAMP Canonical Hook Events

## Status: complete

## Summary

All existing handlers verified to use canonical event names. Three new handler
files created. `index.ts` updated. All quality gates pass.

## Existing Handlers Verified

| File | Events | Status |
|------|--------|--------|
| session-hooks.ts | SessionStart, SessionEnd | canonical — no change needed |
| task-hooks.ts | PreToolUse, PostToolUse | canonical — no change needed |
| work-capture-hooks.ts | PromptSubmit, ResponseComplete | canonical — no change needed |
| file-hooks.ts | Notification | canonical — config-first already correct |
| mcp-hooks.ts | PromptSubmit, ResponseComplete | canonical — config-first already correct |
| error-hooks.ts | PostToolUseFailure | canonical — no change needed |

## New Handler Files

### packages/core/src/hooks/handlers/agent-hooks.ts
- `handleSubagentStart` — registers on `SubagentStart`, gated behind `brain.autoCapture`
- `handleSubagentStop` — registers on `SubagentStop`, gated behind `brain.autoCapture`
- Both capture agent ID, role, task assignment, and session ID

### packages/core/src/hooks/handlers/context-hooks.ts
- `handlePreCompact` — registers on `PreCompact`, gated behind `brain.autoCapture`
- `handlePostCompact` — registers on `PostCompact`, gated behind `brain.autoCapture`
- PreCompact captures token count and reason; PostCompact captures before/after counts

### mcp-hooks.ts (extended)
- `handleSystemNotification` — registers on `Notification` at priority 90
- Skips file-change payloads (delegated to file-hooks.ts at priority 100)
- Only fires for message-bearing system notifications
- Gated behind `brain.autoCapture`

## Config Gating

All new handlers follow the config-first pattern:
- `loadConfig()` cascade (not raw env vars)
- `brain.autoCapture` controls SubagentStart/Stop, PreCompact/PostCompact, Notification
- Existing env var gates on file-hooks.ts and mcp-hooks.ts preserved for backward compat

## index.ts Changes

Added side-effect imports for `agent-hooks.js` and `context-hooks.js` to trigger
auto-registration. Added exports for all 5 new handler functions.

## Quality Gates

- biome check: pass (0 errors)
- pnpm run build: pass (Build complete)
- pnpm run test: pass (277 files, 4942 tests, 0 failures)
