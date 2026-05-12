# T1917 — injection-chain.test.ts Isolation Fix

## Summary

Fixed the root cause of `~/.agents/AGENTS.md` pollution from test runs.

## Root Cause

`packages/core/src/__tests__/injection-chain.test.ts` `beforeEach` overrode `CLEO_HOME` and `CLEO_DIR` to a temp sandbox but did NOT override `AGENTS_HOME`. As a result, `getAgentsHome()` in `injection.ts` Step 4 (line 217) resolved to the real `~/.agents` directory. The buggy `inject()` mock always prepended a new CAAMP block without consolidation, so every test run leaked one block into the user's actual `~/.agents/AGENTS.md`.

## Fix #1 — Test Isolation (AGENTS_HOME override)

In `beforeEach`, after setting `CLEO_HOME` and `CLEO_DIR`:

```typescript
origAgentsHome = process.env['AGENTS_HOME'];
process.env['AGENTS_HOME'] = join(testDir, '.agents');
```

In `afterEach`, restored:

```typescript
if (origAgentsHome !== undefined) {
  process.env['AGENTS_HOME'] = origAgentsHome;
} else {
  delete process.env['AGENTS_HOME'];
}
```

`getAgentsHome()` in `packages/core/src/paths.ts` reads `process.env['AGENTS_HOME'] ?? join(homedir(), '.agents')` — the override ensures every write from `ensureInjection()` Step 4 lands in `testDir/.agents/AGENTS.md`, not the real user directory.

## Fix #2 — Mock Fidelity (real inject())

The previous `inject()` mock was:

```typescript
inject: vi.fn(async (filePath, content) => {
  // ... always prepends new CAAMP block, no consolidation
  const newContent = `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->\n${existing}`;
  await wf(filePath, newContent);
  return 'injected';
}),
```

Replaced with the real implementation via `vi.importActual`:

```typescript
vi.mock('@cleocode/caamp', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cleocode/caamp')>();
  return {
    ...real,
    // ... other mocks ...
    inject: real.inject,  // idempotent: consolidate-and-replace
  };
});
```

The real `inject()` from `packages/caamp/src/core/instructions/injector.ts` is idempotent — it consolidates duplicate blocks instead of blindly prepending.

## Verification

sha256 of `~/.agents/AGENTS.md` unchanged across 5 consecutive runs:

```
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (before)
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (after run 1)
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (after run 2)
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (after run 3)
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (after run 4)
5e2bd6a70d65b78973c07c7bcba27b88c58b64d0f65c97f1cbb35f1921b1f287 (after run 5)
```

All 9 tests pass. Biome CI clean (0 errors).

## Files Changed

- `packages/core/src/__tests__/injection-chain.test.ts` — AGENTS_HOME override + real inject()

## Commit

`f3bb0f6b35ccf0f3e5cd9786bd67b71ad9bbe997` on branch `task/T1917`
