# Pi Hook Templates — Not Shell

Pi (CAAMP's primary harness, ADR-035) does **not** use shell hooks natively.
Its hook system is TypeScript-based extensions loaded from:

- Global: `~/.pi/agent/extensions/*.ts`
- Project: `<projectDir>/.pi/extensions/*.ts`

## How PreCompact fires on Pi

Pi's native event catalog (`piEventCatalog` in
`packages/caamp/providers/hook-mappings.json`) maps the canonical
`PreCompact` CAAMP event to the native `context` event (Pi's context-assembly
lifecycle stage is the closest proxy for pre-compaction).

## Why there is no bash shim here

The `packages/adapters/src/providers/{claude-code,cursor,opencode,gemini-cli}/templates/hooks/`
directories ship bash templates because those providers expose `command`-type
handlers. Pi exposes only `extension` handlers, so its pre-compact hook is a
TypeScript module, not a shell script.

## Where the Pi implementation lives

The Pi PreCompact handler is implemented in TypeScript inside CLEO core and is
loaded into the Pi extension runtime via `packages/core/src/hooks/handlers/precompact.ts`.
That handler invokes the same universal sequence as the bash helpers:

1. `cleo memory precompact-flush` — drain in-flight observations + WAL checkpoint (T1004)
2. `cleo safestop --reason precompact-emergency --commit --handoff <file>`

Both execution paths terminate in the same CLI, so the universal CLEO
surface remains the single source of truth. Provider adapters never reach
into core internals.

## See also

- `packages/adapters/src/providers/README.md` — Hook Template Architecture
- `packages/adapters/src/providers/pi/hooks.ts` — `PiHookProvider.mapProviderEvent`
- `packages/caamp/providers/hook-mappings.json` — canonical event → provider map
