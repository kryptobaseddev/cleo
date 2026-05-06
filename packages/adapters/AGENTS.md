# @cleocode/adapters — Agent Notes

## Package Purpose

Thin runtime adapters for each supported AI coding-assistant provider.
Each adapter implements the `ProviderAdapter` interface and handles only
provider-specific concerns: spawn hooks, statusline sync, context
monitoring, plugin wiring.

## Ownership Boundary (MANDATORY)

This package is a **runtime adapter layer only**. The following concerns
are NOT owned here:

| Concern | Owner | Do NOT reimplement |
|---------|-------|--------------------|
| XDG / platform paths | `@cleocode/paths` | Import `resolveXdgPath` etc. from `@cleocode/paths` |
| Provider registry (instructFile, references, mcpConfigKey) | `@cleocode/caamp` | Call `getProviderInstructionReferences()` — never copy arrays |
| Instruction-file injection (markers, idempotency) | `@cleocode/caamp` | Call `inject()` / `ensureProviderInstructionFile()` — never write directly |

See [ADR-064: CAAMP↔Adapters Boundary](../../docs/adr/ADR-064-caamp-adapters-boundary.md)
for the full ownership matrix and invariants.

## Anti-Patterns (Instant Rejection)

- Defining an `INSTRUCTION_REFERENCES` constant in any adapter folder
- Calling `writeFileSync` / `fs.writeFile` where the destination is a
  known instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)
- Reimplementing XDG path resolution instead of importing from
  `@cleocode/paths`

## Adding a New Provider

1. Add the provider entry to `packages/caamp/providers/registry.json`
   (name, instructFile, instructionReferences, mcpConfigKey, capabilities).
2. Create `src/providers/<provider>/` implementing `ProviderAdapter`.
3. Use `getProviderInstructionReferences(name)` and `inject(...)` from
   `@cleocode/caamp` for any instruction-file work.
4. Register the adapter in `src/registry.ts`.
5. Add tests under `src/__tests__/`.

## Supported Providers

| Provider | Folder |
|----------|--------|
| Claude Code | `src/providers/claude-code/` |
| Claude SDK | `src/providers/claude-sdk/` |
| Codex | `src/providers/codex/` |
| Cursor | `src/providers/cursor/` |
| Gemini CLI | `src/providers/gemini-cli/` |
| Kimi | `src/providers/kimi/` |
| OpenAI SDK | `src/providers/openai-sdk/` |
| OpenCode | `src/providers/opencode/` |
| Pi | `src/providers/pi/` |

## Build & Test

```bash
pnpm run build     # esbuild / tsup compile
pnpm run test      # vitest
pnpm run typecheck # tsc --noEmit
```
