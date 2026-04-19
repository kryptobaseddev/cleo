# T947 — llmtxt v2026.4.9 Build Externalize Changes

**Status**: documentation-only. Do NOT apply in this wave — Wave B picks this up.

## Context

`llmtxt@2026.4.9` declares the following as **optional peer dependencies**:

| Peer dep            | Minimum version | Used by                                      | Native? |
|---------------------|-----------------|----------------------------------------------|---------|
| `better-sqlite3`    | `>=11.0.0`      | `llmtxt/local`, `llmtxt/blob` (BlobFsAdapter)| yes (N-API) |
| `@vlcn.io/crsqlite` | `>=0.16.3`      | `llmtxt/local` cr-sqlite loader              | yes (native `.so`/`.dylib`/`.dll`) |
| `drizzle-orm`       | `>=1.0.0-beta.21` | `llmtxt/blob`, `llmtxt/local` schema       | no (pure JS, but ships multi-dialect entrypoints) |
| `onnxruntime-node`  | `>=1.18.0`      | `llmtxt` embeddings (optional)               | yes (native) |
| `postgres`          | `>=3.4.0`       | `llmtxt/pg` (PostgresBackend)                | no |
| `mssql`             | (transitive via drizzle) | drizzle-orm MSSQL dialect           | no |
| `@opentelemetry/api`| (transitive)    | drizzle-orm tracing                          | no |

Whenever a CLEO package that bundles (esbuild / rollup) consumes `llmtxt`
or `@cleocode/core` (which now pulls `llmtxt/blob`), the bundler MUST
externalize all of the above. Bundling native modules into a single
output file triggers `Cannot find module '<native>.node'` at runtime.

## Canonical `external` list

Packages with a `build.mjs` (esbuild) MUST include exactly:

```ts
external: [
  'better-sqlite3',
  '@vlcn.io/crsqlite',
  'drizzle-orm',
  'drizzle-orm/*',        // covers drizzle-orm/better-sqlite3, /node-sqlite, /pg, etc.
  'postgres',
  'mssql',
  '@opentelemetry/api',
  'onnxruntime-node',
]
```

Notes:

- `drizzle-orm/*` is required because llmtxt imports
  `drizzle-orm/better-sqlite3` and bundlers will refuse to resolve
  subpaths unless wildcarded.
- `mssql` and `@opentelemetry/api` are indirect imports inside
  `drizzle-orm`'s dialect tree; externalizing them avoids dead-code
  resolution errors.
- `onnxruntime-node` is only reachable via `llmtxt`'s semantic search
  path (`llmtxt.indexDocument` / `llmtxt.search`). Externalize even if
  your bundled binary doesn't use embeddings — the type imports pull
  it into the module graph.

## Per-package action items (Wave B)

| Package                         | File                                    | Current state                 | Required change |
|---------------------------------|-----------------------------------------|-------------------------------|-----------------|
| `packages/cleo`                 | `packages/cleo/build.mjs`               | Update `external` list        | Add every entry above if missing. |
| `packages/cleo-os`              | `packages/cleo-os/build.mjs`            | Update `external` list        | Same. |
| `packages/studio`               | `packages/studio/` (SvelteKit)          | No change needed              | SvelteKit's Vite adapter already respects optional peer deps; no bundler-level change required. |
| `packages/core`                 | tsc emit only (no bundler)              | No change needed              | tsc does not bundle — runtime-resolved. Ensure downstream bundlers externalize. |

## Verification after applying

For each updated `build.mjs`:

```bash
pnpm --filter <pkg> run build
# then at runtime, on a fresh npm install (no better-sqlite3 installed):
node dist/bin.js --version   # must NOT crash with Cannot find module '...'
```

Runtime degradation expected when a peer dep is missing:

- `better-sqlite3` absent → `CleoBlobStore.open()` throws with the
  install instruction baked in by `llmtxt-blob-adapter.ts`.
- `@vlcn.io/crsqlite` absent → `llmtxt`'s LocalBackend opens without
  cr-sqlite (DR-P2-01); CLEO's `CleoBlobStore` does not depend on
  cr-sqlite so this has no CLEO-side effect.
- `onnxruntime-node` absent → `llmtxt` embeddings degrade to empty
  results (SearchOps spec §SHOULD).

## Known blocker: drizzle-orm dual-package hazard

**Status**: verified during T947 runtime smoke-exercise. Non-blocking
for this wave (tests skip when peer dep absent; smoke test covers
shape). Wave B MUST resolve before retiring attachment-store.ts.

- `@cleocode/core` pins `drizzle-orm@1.0.0-beta.19-d95b7a4`.
- `llmtxt@2026.4.9` declares `drizzle-orm >=1.0.0-beta.21` as an
  optional peer and pulls its own nested copy via pnpm.
- `BlobFsAdapter` imports its `blob_attachments` schema from llmtxt's
  nested drizzle-orm. When CLEO constructs a Drizzle handle via its
  own drizzle-orm and passes it to `BlobFsAdapter`, the two drizzle
  versions have incompatible schema brand symbols: `attachBlob` fails
  with `SqliteError: no such table: blob_attachments` even though the
  table DDL successfully ran on the same better-sqlite3 handle.

Reproduced via `node --input-type=module` script; error stack alternates
between `llmtxt@2026.4.9/.../fs-adapter.js` and
`drizzle-orm@1.0.0-beta.19.../session.js`.

### Resolution paths (Wave B)

1. **Upgrade drizzle-orm** in `@cleocode/core` to `>=1.0.0-beta.21`
   so both instances share the same module. Preferred — keeps
   CLEO and llmtxt on the same ORM generation.
2. **Pin llmtxt's drizzle-orm** via pnpm `overrides` in the root
   package.json so llmtxt resolves to CLEO's beta.19 copy. Riskier —
   may introduce runtime incompatibilities the llmtxt team has not tested.
3. **Bypass the dual-package hazard** by moving blob manifest storage
   into CLEO's existing `tasks.db` + contracts schema and calling only
   the `hashBlob`/`validateBlobName` WASM primitives from llmtxt/blob
   (skip `BlobFsAdapter`). Smallest blast radius, but duplicates the
   manifest/LWW logic we were trying to delete.

## T947 scope boundary

This file only DOCUMENTS the required changes. Actual edits to
`packages/cleo/build.mjs` and `packages/cleo-os/build.mjs` are Wave B's
responsibility. T947 owns:

1. `packages/core/src/__tests__/llmtxt-subpath-smoke.test.ts`
2. `packages/core/src/store/llmtxt-blob-adapter.ts`
3. `packages/core/src/store/__tests__/llmtxt-blob-adapter.test.ts`
4. this file

`packages/core/src/store/attachment-store.ts` (legacy, 643 LoC) stays
operational. Callers are NOT migrated in this wave.
