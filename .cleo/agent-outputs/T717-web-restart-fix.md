# T717 — cleo web restart TypeError Fix

**Date**: 2026-04-15
**Commit**: 9775ed0a
**Status**: complete

## Root Cause

`cleo web restart` threw:

```
TypeError: Cannot set properties of undefined (setting '_action')
    at action (file:///...index.js:133004:18)
    at _ShimCommand._action (...:145945:15)
```

The restart handler contained this pattern:

```ts
const startCmd = webCmd.commands.find((c) => c.name() === 'start');
const startAction = startCmd?.action as (opts: ...) => void | Promise<void> | undefined;
if (startAction) {
  await startAction(startOpts);
}
```

`ShimCommand` has no `action` getter — only an `action(fn)` **setter method** that sets
`this._action` and returns `this`. So `startCmd?.action` resolved to the setter method itself.
Calling it as `startAction(startOpts)` invoked `action(startOpts)` with `startOpts` as the `fn`
parameter, attempting `this._action = startOpts`. In strict ESM the call was unbound, so `this`
was `undefined`, causing the TypeError.

## Fix

Extracted `startWebServer(port: number, host: string): Promise<void>` as a standalone
module-level function. Both the `start` and `restart` subcommands call it directly.
The runtime command-lookup indirection is completely eliminated.

**Files changed**:
- `packages/cleo/src/cli/commands/web.ts` — extracted `startWebServer`, simplified
  `start` action, fixed `restart` action
- `packages/cleo/src/cli/__tests__/web.test.ts` — added `restart` to subcommand listing
  test; added regression guard asserting `restartCmd._action` is a function; added options
  default value test for restart

## Verification

- `node packages/cleo/dist/cli/index.js web restart` — runs without TypeError, starts server
- `node packages/cleo/dist/cli/index.js web --help` — lists `restart` subcommand
- `pnpm --filter @cleocode/cleo run test` — 73 test files, 1250 passed, 0 new failures

## Release

Pending v2026.4.61 via GitHub Actions (ORC-011). Fix is on main as commit 9775ed0a.
