# Cursor Adapter -- Task #7 Output

## Deliverables

### Package: `packages/adapters/cursor/`

**Files created:**
- `src/adapter.ts` -- `CursorAdapter` implementing `CLEOProviderAdapter` (no spawn provider)
- `src/hooks.ts` -- `CursorHookProvider` (stub: returns null for all events)
- `src/install.ts` -- `CursorInstallProvider` managing .cursor/mcp.json and rule files
- `src/index.ts` -- Barrel exports + default export + factory function

**Pre-existing files (from scaffolding):**
- `manifest.json` -- Adapter manifest with detection patterns
- `package.json` -- `@cleocode/adapter-cursor` v1.0.0
- `tsconfig.json` -- Standalone strict TypeScript config

### Tests: `src/core/adapters/__tests__/cursor-adapter.test.ts`

22 tests covering:
- Adapter identity, capabilities (no hooks, no spawn), lifecycle
- Health check with .cursor/ directory detection
- Hook provider returns null for all events (stub)
- Install: .cursor/rules/cleo.mdc creation with MDC frontmatter
- Install: Legacy .cursorrules append (only if exists), dedup
- Install: .cursor/mcp.json MCP server registration
- Install: Uninstall removes MCP server
- Factory function

## Architecture

```
CursorAdapter (CLEOProviderAdapter)
  |-- hooks: CursorHookProvider (stub -- Cursor has no hook events)
  |-- install: CursorInstallProvider
  |   |-- .cursor/mcp.json -- MCP server registration
  |   |-- .cursor/rules/cleo.mdc -- Modern MDC format rules (always created)
  |   +-- .cursorrules -- Legacy rules (only appended if exists)
  +-- spawn: undefined (not supported)
```

## Key Design Decisions

1. **No spawn support** -- Cursor has no CLI for subagent spawning
2. **No hooks** -- Cursor lacks lifecycle event system; hook provider is a stub
3. **Dual instruction file format** -- Supports both modern (.cursor/rules/cleo.mdc) and legacy (.cursorrules)
4. **MDC frontmatter** -- Uses `alwaysApply: true` and `globs: "**/*"` for universal rule application
5. **Legacy .cursorrules not created** -- Only appended to if it already exists (avoids creating deprecated format)
6. **Health detection** -- Based on .cursor/ directory existence or CURSOR_EDITOR env var (no CLI check needed)

## Verification

- `npx tsc --noEmit` clean in adapter package
- `npx tsc` builds to dist/ successfully
- ESM import verified: `import { CursorAdapter } from '@cleocode/adapter-cursor'`
- 22/22 adapter tests passing
- All 106 adapter tests pass (discovery:7 + manager:28 + claude-code:23 + opencode:26 + cursor:22)
- `npm run build` clean at root
