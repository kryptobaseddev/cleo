# T1444 Session Dispatch Plan

Task: T1444 (T1435-W1-session)  
Domain: session  
Date: 2026-04-27

## Phase 1 Audit

Mandatory command audit result:

- `grep ... | grep -i "session"` returned no `.command()` matches because this CLI uses `citty` `defineCommand` objects, not commander `.command()` calls.
- Session registration is indirect:
  - `packages/cleo/src/cli/index.ts:165` imports `sessionCommand`
  - `packages/cleo/src/cli/index.ts:209` registers top-level `briefing`
  - `packages/cleo/src/cli/index.ts:292` registers top-level `session`
- Dispatch domain:
  - `packages/cleo/src/dispatch/domains/session.ts`
  - 669 LOC
  - 15 handler operations
- Core/session implementation surface lives under `packages/core/src/sessions/`, not `packages/core/src/session/`.

Dispatch operations found:

| Operation | Gateway | File:line | Current target |
|---|---:|---|---|
| `status` | query | `session.ts:75` | `sessionStatus(projectRoot)` |
| `list` | query | `session.ts:92` | `sessionList(projectRoot, params)` |
| `show` | query | `session.ts:111` | `sessionShow` or `sessionDebriefShow` |
| `find` | query | `session.ts:143` | `sessionFind(projectRoot, params)` |
| `decision.log` | query | `session.ts:161` | `sessionDecisionLog(projectRoot, params)` |
| `context.drift` | query | `session.ts:177` | `sessionContextDrift(projectRoot, params)` |
| `handoff.show` | query | `session.ts:193` | `sessionHandoff(projectRoot, scopeFilter)` |
| `briefing.show` | query | `session.ts:214` | `sessionBriefing(projectRoot, params)` |
| `start` | mutate | `session.ts:237` | `sessionStart(projectRoot, params)` plus owner-auth/context binding |
| `end` | mutate | `session.ts:303` | `sessionEnd(projectRoot, note, opts)` plus debrief/handoff/memory refresh |
| `resume` | mutate | `session.ts:375` | `sessionResume(projectRoot, sessionId)` |
| `suspend` | mutate | `session.ts:394` | `sessionSuspend(projectRoot, sessionId, reason)` |
| `gc` | mutate | `session.ts:413` | `sessionGc(projectRoot, maxAgeDays)` |
| `record.decision` | mutate | `session.ts:427` | `sessionRecordDecision(projectRoot, params)` |
| `record.assumption` | mutate | `session.ts:449` | `sessionRecordAssumption(projectRoot, params)` |

CLI command surface:

| CLI command | File:line | Flags / args accepted | Dispatch op | Action body LOC |
|---|---|---|---|---:|
| `cleo session start` | `commands/session.ts:30` | `--scope` required, `--name` required, `--auto-start`, `--auto-focus`, `--focus`, `--start-task`, `--agent`, `--grade`, `--owner-auth` | `session.start` | 27 |
| `cleo session end` | `commands/session.ts:185` | `--session`, `--note`, `--next-action` | `session.end` | 12 |
| `cleo session stop` | `commands/session.ts:625` | alias of `end` | `session.end` | 12 |
| `cleo session handoff` | `commands/session.ts:216` | `--scope` | `session.handoff.show` | 47 |
| `cleo session status` | `commands/session.ts:274` | none | `session.status` | 16 |
| `cleo session resume <sessionId>` | `commands/session.ts:295` | positional `sessionId` required | `session.resume` | 11 |
| `cleo session find` | `commands/session.ts:318` | `--status`, `--scope`, `--query`, `--limit` | `session.find` | 14 |
| `cleo session list` | `commands/session.ts:358` | `--status`, `--limit`, `--offset` | `session.list` | 13 |
| `cleo session gc` | `commands/session.ts:390` | `--max-age` | `session.gc` | 11 |
| `cleo session show <sessionId>` | `commands/session.ts:412` | positional `sessionId` required, `--include` | `session.show` | 12 |
| `cleo session context-drift` | `commands/session.ts:443` | `--session-id` | `session.context.drift` | 11 |
| `cleo session suspend <sessionId>` | `commands/session.ts:468` | positional `sessionId` required, `--reason` | `session.suspend` | 12 |
| `cleo session record-assumption` | `commands/session.ts:496` | `--assumption` required, `--confidence` required, `--session-id`, `--task-id` | `session.record.assumption` | 14 |
| `cleo session record-decision` | `commands/session.ts:538` | `--session-id`, `--task-id` required, `--decision` required, `--rationale` required, `--alternatives` | `session.record.decision` | 15 |
| `cleo session decision-log` | `commands/session.ts:586` | `--session-id`, `--task-id` | `session.decision.log` | 12 |
| `cleo session` | `commands/session.ts:620` | subcommand group only | usage display, no dispatch | 5 |
| `cleo briefing` | `commands/briefing.ts:29` | `--scope/-s`, `--max-next`, `--max-bugs`, `--max-blocked`, `--max-epics` | `session.briefing.show` | 15 |

Behavior contracts to preserve:

- CLI aliases:
  - `session stop` remains an alias for `session end`.
  - `session start --auto-focus` remains an alias for `--auto-start`.
  - `session start --focus` remains an alias for `--start-task`.
  - `briefing --scope` keeps `-s`.
- Accepted-but-currently-ignored fields must remain accepted:
  - `session start --agent` is declared by the CLI but not passed into dispatch.
  - `session end --session` is declared by the CLI but not passed into dispatch.
- Custom CLI output and exit behavior:
  - `session status` uses `dispatchRaw`, prints `No active session`, then exits `ExitCode.NO_DATA` when no active session exists.
  - `session handoff` uses `dispatchRaw`, formats handoff data, and exits `ExitCode.NO_DATA` with `No handoff data available` when no handoff exists.
  - Other session commands use `dispatchFromCli`, preserving existing JSON/human rendering and dispatch error exit-code mapping.
- Error messages:
  - Missing dispatch `scope` keeps `scope is required`.
  - Missing `sessionId` keeps `sessionId is required` for `show`, `resume`, and `suspend`.
  - Not-found fallbacks keep `Session <id> not found`.
  - Engine errors continue passing through their current `result.error.message`.
- Side effects:
  - `session.start` stores owner-auth token best-effort when provided, adds `sessionId` alias, and binds process-scoped session context.
  - `session.end` computes debrief/handoff best-effort, persists session memory best-effort, unbinds session context, refreshes memory bridge best-effort, and preserves `sessionSummary` ingestion.
  - `session.show --include debrief` preserves the debrief branch semantics.
  - `handoff.show` preserves scope string parsing (`global`, `epic:T###`).

Dispatch-bypass paths:

- `session start --owner-auth` directly prompts in the CLI and calls `deriveOwnerAuthToken` before dispatch.
- `session handoff` and `session status` use `dispatchRaw` plus custom rendering/exit behavior instead of `dispatchFromCli`.
- No session CLI command bypasses dispatch for core business logic; all session data operations route to `session.*` dispatch operations.

## Phase 2 Plan

Per-command migration table:

| Command | Current behavior summary | Target function | Stays in CLI | Moves/changes in dispatch |
|---|---|---|---|---|
| `session start` | Parse flags, owner-auth prompt, alias normalization, dispatch mutate | Existing `sessionStart` D4 engine wrapper | flag parsing, owner-auth prompt, `--auto-focus`/`--focus` alias normalization | infer params via `OpsFromCore`, preserve owner-auth storage/context bind |
| `session end` / `stop` | End active session, note/next action, debrief/memory side effects | Existing `sessionEnd` D4 engine wrapper | flag parsing and alias registration | infer params via `OpsFromCore`, preserve debrief/handoff/memory refresh |
| `session handoff` | Raw dispatch, no-data exit, formatted handoff | Existing `sessionHandoff` D4 engine wrapper | custom no-data output and formatting | infer params via `OpsFromCore`, preserve scope parsing |
| `session status` | Raw dispatch, no-data exit | Existing `sessionStatus` D4 engine wrapper | custom no-active-session output | infer params via `OpsFromCore` |
| `session resume` | Resume by positional ID | Existing `sessionResume` D4 engine wrapper | positional parsing | infer params via `OpsFromCore`, preserve missing/not-found messages |
| `session find` | Lightweight discovery filters | Existing `sessionFind` D4 engine wrapper | flag parsing, numeric limit conversion | infer params via `OpsFromCore` |
| `session list` | Paginated/filter list | Existing `sessionList` D4 engine wrapper | flag parsing, numeric limit/offset conversion | infer params via `OpsFromCore` |
| `session gc` | Max-age cleanup | Existing `sessionGc` D4 engine wrapper | flag parsing, numeric conversion | infer params via `OpsFromCore` |
| `session show` | Full session or debrief include | Existing `sessionShow` / `sessionDebriefShow` D4 engine wrappers | positional parsing | infer params via `OpsFromCore`, preserve debrief include branch |
| `session context-drift` | Drift by active/specified session | Existing `sessionContextDrift` D4 engine wrapper | flag parsing | infer params via `OpsFromCore` |
| `session suspend` | Suspend by ID with optional reason | Existing `sessionSuspend` D4 engine wrapper | positional/flag parsing | infer params via `OpsFromCore`, preserve missing/not-found messages |
| `session record-assumption` | Append assumption audit record | Existing `sessionRecordAssumption` D4 engine wrapper | flag parsing | infer params via `OpsFromCore` |
| `session record-decision` | Append decision audit record | Existing `sessionRecordDecision` D4 engine wrapper | flag parsing | infer params via `OpsFromCore` |
| `session decision-log` | Read/filter decision audit log | Existing `sessionDecisionLog` D4 engine wrapper | flag parsing | infer params via `OpsFromCore` |
| `briefing` | Composite resume context | Existing `sessionBriefing` D4 engine wrapper | top-level command and flag parsing | infer params via `OpsFromCore` |

New contract types needed: none. `packages/contracts/src/operations/session.ts` already contains all session wire operation types and will not be edited.

New Core functions to author: none. T1450 already normalized the session Core functions. Direct Core replacement is intentionally not part of this task because `session-engine.ts` still preserves CLI-visible behavior around focus state, chain links, journals, debrief/handoff, and memory refresh.

Implementation steps:

1. Refactor `packages/cleo/src/dispatch/domains/session.ts` only.
2. Remove direct per-op `Session*Params` imports from `@cleocode/contracts`.
3. Import `OpsFromCore` from `../adapters/typed.js`.
4. Add private Core-shaped wrapper functions for the 15 session ops. The wrappers capture `getProjectRoot()` and preserve current engine calls.
5. Add `coreOps` and `type SessionOps = OpsFromCore<typeof coreOps>`.
6. Change typed handler param annotations to `SessionOps['op'][0]`.
7. Preserve all current success fallback, error fallback, owner-auth, context bind/unbind, debrief/handoff, and memory refresh logic.
8. Add a focused regression test that locks the dispatch source to `OpsFromCore<typeof coreOps>` and no per-op contract imports.

Regression/smoke plan:

- Before code edits, build `@cleocode/cleo` and capture sanitized baseline output in `/tmp/smoke-session-before`.
- After code edits, rebuild and run the same smoke sequence in `/tmp/smoke-session-after`.
- Smoke commands:
  - `session`, `session status`, `session list`, `session find`, `briefing`, `session handoff`
  - `session start`, `session status`, `session show`, `session context-drift`
  - `session record-assumption`, `session record-decision`, `session decision-log`
  - `session suspend`, `session resume`, `session end`, `session show --include debrief`
  - `session gc`, `session start`, `session stop`
- Compare sanitized outputs. Dynamic fields sanitized: session IDs, timestamps, request IDs, durations, generated audit IDs.

Atomic commits:

1. `docs(T1444): record session dispatch migration plan`
2. `refactor(T1444): infer session dispatch ops from core wrappers`
3. `test(T1444): lock session OpsFromCore dispatch shape`

