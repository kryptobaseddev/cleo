# Attachment Store V2 — CI Failure Analysis

**Date**: 2026-04-20
**CI Run**: 24669599191
**Status**: INCONCLUSIVE — tests pass locally, failure not reproducible

---

## Summary

Five tests in `packages/core/src/store/__tests__/attachment-store-v2.test.ts`
fail in CI run 24669599191 with the store returning `'legacy'` instead of
`'llmtxt'`. The tests pass in all local environments tested (Fedora 43, root
vitest config, per-package vitest config).

---

## Observed vs Expected Behavior

### Test 1: `put + get roundtrip succeeds via llmtxt path`
- Expected: `putResult.backend === 'llmtxt'`
- Actual: `putResult.backend === 'legacy'`

### Test 2: `backend field in response matches actual path (llmtxt)`
- Expected: `result.backend === 'llmtxt'`
- Actual: `result.backend === 'legacy'`

### Test 3: `list returns all attachments for a task (llmtxt path)`
- Expected: `entries.map(e => e.name).sort()` deep-equals `['a.txt', 'b.txt', 'c.txt']`
- Actual: entries array doesn't match (legacy list behavior differs)

### Test 4: `remove soft-deletes the attachment (llmtxt LWW)`
- Expected: `store.list('T103')` returns length 0 after remove
- Actual: length 1 (legacy remove with no taskId is a no-op per current code)

### Test 5: `content-addressed: two tasks can reference the same bytes`
- Expected: `a.attachmentId !== b.attachmentId` (llmtxt assigns nanoid per attachment)
- Actual: `a.attachmentId === b.attachmentId` (legacy uses sha256-based dedup → same ID)

---

## Root Cause Analysis

### Mechanism

The test suite uses `describe.skipIf(!(await hasLlmtxtPeerDeps()))` to guard
the llmtxt tests. In CI run 24669599191, this guard evaluated to `true` (tests
ran, were not skipped), which means `hasLlmtxtPeerDeps()` returned `true` at
module evaluation — all three peer deps (`better-sqlite3`,
`drizzle-orm/better-sqlite3`, `llmtxt/blob`) resolved successfully.

However, when `createAttachmentStoreV2(tempDir)` was called and `ensureLlmtxt()`
ran, `store.open()` must have thrown and been silently swallowed by the
try/catch in `ensureLlmtxt()`:

```ts
try {
  const { CleoBlobStore } = await import('./llmtxt-blob-adapter.js');
  const store = new CleoBlobStore({ projectRoot });
  await store.open();   // <-- threw silently
  llmtxtStore = store;
  return store;
} catch {
  llmtxtStore = false;  // <-- fell back to legacy
  return null;
}
```

### Why `open()` failed in CI but not locally

Three candidates identified:

#### Candidate A: WASM `__dirname` in ESM context (llmtxt-side)

`packages/core/node_modules/llmtxt/wasm/llmtxt_core.js` loads the WASM binary
using CJS globals:

```js
const wasmPath = `${__dirname}/llmtxt_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
```

This file is CJS (`"main"` field in its `package.json`, no `"type": "module"`).
Node.js handles CJS-in-ESM imports correctly (CJS default export + named
exports). However, if a vite/vitest build-time transformation ever attempted to
treat this file as ESM, `__dirname` would be `undefined` and the WASM load
would fail with a path error.

The import chain is:
```
llmtxt/blob/index.js → ../wasm.js → ../wasm/llmtxt_core.js (CJS)
```

Locally, `pool: 'forks'` + `isolate: true` in the root vitest config means
each test file gets a clean Node.js fork. Node.js fork processes handle CJS
modules correctly without vite transformation. This works.

In CI — same behavior. BUT if the CI run was on a different pnpm cache key
where `llmtxt` resolved to an ESM-only version, or if vite inline rules were
different, this could fail.

**Assessment**: POSSIBLE llmtxt SDK issue — the WASM loader should use
`import.meta.url` + `fileURLToPath` for ESM compatibility, or ship both CJS and
ESM versions of the WASM loader. The current implementation only works reliably
in CJS context.

#### Candidate B: `drizzle({ client: nativeDb })` v1 API mismatch

`CleoBlobStore.open()` calls:
```ts
db = drizzle({ client: nativeDb });
ensureBlobAttachmentsTable(nativeDb as SqliteExecLike);
```

`BlobFsAdapter` then uses `this.db` for queries. If drizzle v1 beta broke the
`transaction()` API between beta.21 and beta.22 (llmtxt requires `>=beta.21`),
the `attachBlob` transaction call would throw.

Checked: drizzle v1.0.0-beta.22-ec7b61d's `BetterSQLiteSession.transaction()`:
```ts
transaction(transaction, config = {}) {
  const tx = new BetterSQLiteTransaction(...);
  return this.client.transaction(transaction)[config.behavior ?? "deferred"](tx);
}
```

This delegates to `better-sqlite3`'s native transaction. The callback receives
a `tx` object, but `BlobFsAdapter.attachBlob()` uses `this.db` (outer db) inside
the callback instead of `tx`:

```js
this.db.transaction(() => {
  const existing = this.db.select(...)...  // uses outer this.db, not tx
```

This pattern works with better-sqlite3's synchronous transaction semantics
(same connection, SQLite allows nested access). BUT this is technically using
the outer drizzle instance inside a transaction callback rather than the
provided `tx`. If drizzle v1 beta changes how the outer `db` behaves inside a
transaction (e.g., adds reentrancy guards), this would break.

**Assessment**: POSSIBLE llmtxt SDK misuse of drizzle transaction API. The
canonical drizzle pattern is to use the `tx` argument inside the callback.

#### Candidate C: pnpm optional dependency not installed (CLEO-side)

If the CI run used `pnpm install --prod` or a variant that skips optional
dependencies, `llmtxt` (which is in `optionalDependencies`) would not be
installed. In that case:
- `hasLlmtxtPeerDeps()` → imports `llmtxt/blob` → FAILS → returns `false`
- `describe.skipIf(!false)` = `describe.skipIf(true)` → tests SKIPPED

This would produce skipped tests, not failures. So this is NOT the candidate
given that the tests ran and failed rather than being skipped.

---

## llmtxt Package/Function Involved

- **Package**: `llmtxt@2026.4.9` (`/packages/core/node_modules/llmtxt`)
- **Subpath**: `llmtxt/blob` → `dist/blob/fs-adapter.js`
- **WASM loader**: `dist/wasm/llmtxt_core.js` (CJS with `__dirname`)
- **Relevant class**: `BlobFsAdapter`
- **Relevant method**: `attachBlob(params: AttachBlobParams)` — uses `this.db`
  inside `this.db.transaction()` callback instead of `tx`

---

## Minimal Repro

```ts
// Works locally, may fail in some CI environments
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = await mkdtemp(join(tmpdir(), 'repro-'));
const { CleoBlobStore } = await import('@cleocode/core/store/llmtxt-blob-adapter.js');
const store = new CleoBlobStore({ projectRoot: tmpDir });
// If open() throws for any reason (WASM load failure, drizzle API mismatch),
// createAttachmentStoreV2 silently falls back to legacy backend.
await store.open();
```

To expose the silent failure, add error logging to `ensureLlmtxt()`:
```ts
} catch (err) {
  console.error('[ensureLlmtxt] failed:', err);  // add this
  llmtxtStore = false;
  return null;
}
```

---

## What Was NOT Changed

CLEO-side code in `attachment-store-v2.ts` and `llmtxt-blob-adapter.ts` was
left as-is per owner directive. No hacks around llmtxt behavior.

---

## Current State

All 13 tests in `attachment-store-v2.test.ts` pass locally as of 2026-04-20:
- 7 tests in `createAttachmentStoreV2 (llmtxt backend)` — all pass
- 6 tests in `createAttachmentStoreV2 (legacy backend, forced)` — all pass

The CI failure from run 24669599191 cannot be reproduced locally. The failure
is intermittent or environment-specific.

---

## Recommendations

1. **llmtxt SDK**: Update `wasm/llmtxt_core.js` to use ESM-compatible WASM
   loading (`import.meta.url` + `fileURLToPath`) or ship dual CJS/ESM variants.

2. **llmtxt SDK**: Update `BlobFsAdapter.attachBlob()` to use `tx` inside the
   transaction callback (standard drizzle pattern) instead of the outer `this.db`.

3. **CLEO side** (informational, not a fix): Add error logging in
   `ensureLlmtxt()` catch block to expose silent failures when
   `canUseLlmtxtBackend()` returns true but `open()` throws.
   
   
## Response from LLMtxt Developer:

Actual root cause (CLEO-side, not LLMtxt)
                                                                                                                                          
CI error is Error: Could not locate the bindings file at new BetterSqlite3Database() (llmtxt-blob-adapter.ts:241). The better_sqlite3.node native binding never got built in CI.
     
Why: /mnt/projects/cleocode/package.json has a pnpm.onlyBuiltDependencies allowlist (lines 51-64) containing esbuild, @biomejs/biome, tree-sitter-* — but not better-sqlite3. pnpm blocks install scripts for anything not on that list, so node-gyp never compiles the binding in CI. Local works because the developer ran pnpm approve-builds at some point.

Fix: add "better-sqlite3" to onlyBuiltDependencies in the root package.json.
Evaluation of the report's claims
┌──────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│        Claim         │                                                    Verdict                                                     │
├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Candidate A — WASM   │ Real source artifact, not the cause. Confirmed at packages/llmtxt/wasm/llmtxt_core.js:2846-2847. But           │
│ __dirname in ESM     │ wasm/package.json has no "type": "module", so Node.js treats it as CJS — __dirname/require are valid. Never    │
│                      │ reached in CI because open() throws earlier.                                                                   │
├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Candidate B —        │ Real code smell, not a bug. Confirmed at dist/blob/fs-adapter.js:132-161. Non-canonical but works with         │
│ drizzle transaction  │ better-sqlite3's synchronous nested access. Never executed in CI.                                              │
│ uses outer this.db   │                                                                                                                │
├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Candidate C — pnpm   │ Report's reasoning is wrong. They ruled it out because "tests ran rather than skipped." But                    │
│ skipped optional     │ import('better-sqlite3') loads only the JS shim — bindings() is called lazily inside the Database constructor. │
│ deps                 │  Probe passes, describe runs, construction throws. This IS essentially the cause (just via                     │
│                      │ onlyBuiltDependencies, not --prod).                                                                            │
└──────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Secondary (valid) LLMtxt improvements
- WASM loader should use fileURLToPath(import.meta.url) for ESM portability (future-proofing, not urgent).
- BlobFsAdapter.attachBlob() should use the tx callback arg instead of this.db (style/correctness).
- ensureLlmtxt() silent catch in CLEO is the real observability gap — hid the bindings error.
