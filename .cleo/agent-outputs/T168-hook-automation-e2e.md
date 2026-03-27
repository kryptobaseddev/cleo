# T168: E2E Integration Tests — Hook Automation Fires Across Providers

## Status: complete

## Test File

`packages/core/src/hooks/handlers/__tests__/hook-automation-e2e.test.ts`

29 tests, 0 failures.

## Test Coverage

| # | Test | Handler | Event |
|---|------|---------|-------|
| 1 | SessionStart fires brain observation | handleSessionStart | SessionStart |
| 2 | SessionStart triggers memory bridge refresh | handleSessionStart | SessionStart |
| 3 | SessionEnd fires brain observation | handleSessionEnd | SessionEnd |
| 4 | SessionEnd includes task list in text | handleSessionEnd | SessionEnd |
| 5 | SessionEnd triggers memory bridge refresh | handleSessionEnd | SessionEnd |
| 6 | PreToolUse fires observation when tool starts | handleToolStart | PreToolUse |
| 7 | PostToolUse fires observation when tool completes | handleToolComplete | PostToolUse |
| 8 | PostToolUse triggers bridge refresh | handleToolComplete | PostToolUse |
| 9 | PromptSubmit captures mutate ops in CAPTURE_OPERATIONS | handleWorkPromptSubmit | PromptSubmit |
| 10 | PromptSubmit skips query gateway ops | handleWorkPromptSubmit | PromptSubmit |
| 11 | PromptSubmit skips ops NOT in CAPTURE_OPERATIONS | handleWorkPromptSubmit | PromptSubmit |
| 12 | ResponseComplete captures successful mutate ops | handleWorkResponseComplete | ResponseComplete |
| 13 | ResponseComplete skips failed ops | handleWorkResponseComplete | ResponseComplete |
| 14 | SubagentStart creates brain observation with role+task | handleSubagentStart | SubagentStart |
| 15 | SubagentStart works with minimal payload | handleSubagentStart | SubagentStart |
| 16 | SubagentStop creates observation with status+summary | handleSubagentStop | SubagentStop |
| 17 | PreCompact creates context snapshot observation | handlePreCompact | PreCompact |
| 18 | PostCompact records compaction result | handlePostCompact | PostCompact |
| 19 | SubagentStart skips when brain.autoCapture=false | handleSubagentStart | SubagentStart |
| 20 | PreCompact skips when brain.autoCapture=false | handlePreCompact | PreCompact |
| 21 | PostCompact skips when brain.autoCapture=false | handlePostCompact | PostCompact |
| 22 | SubagentStop skips when brain.autoCapture=false | handleSubagentStop | SubagentStop |
| 23 | work-capture skips when captureWork=false and no env | handleWorkPromptSubmit | PromptSubmit |
| 24 | PostToolUse + SessionEnd no double-capture | both | dedup |
| 25 | work-capture and mcp-hooks use different config keys | both | dedup |
| 26 | Notification captures message-bearing system notifications | handleSystemNotification | Notification |
| 27 | Notification skips file-change payloads | handleSystemNotification | Notification |
| 28 | Notification skips payloads with no message or filePath | handleSystemNotification | Notification |
| 29 | Notification skips when brain.autoCapture=false | handleSystemNotification | Notification |

## Mocking Strategy

Direct handler invocation with:
- `vi.mock` factories for brain-retrieval, config, memory-bridge-refresh
- `vi.mocked()` after imports for typed mock refs
- `makeConfig()` factory to control config gating per test

## Quality Gates

- biome check: pass
- pnpm run test: pass (277 files, 4942 tests, 0 failures)
