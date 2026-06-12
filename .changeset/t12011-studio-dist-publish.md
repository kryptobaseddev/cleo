---
id: t12011-studio-dist-publish
tasks: [T12011]
kind: fix
summary: "publish pipeline builds+stages studio-dist before npm publish; tarball gate asserts every files[] entry exists"
---

Root cause: `packages/cleo/package.json` declares `studio-dist` in `files[]` but the release CI
pipeline never built `@cleocode/studio` before `pnpm publish`. npm silently omits files[] entries
that do not exist at publish time, so every `@cleocode/cleo` tarball shipped without `studio-dist`
from v2026.6.13 onward — causing `cleo web` to serve a blank Studio
(`E_STUDIO_BUNDLE_ABSENT` from every npm install).

## What changed

### `.github/workflows/release.yml`

Added "Build Studio bundle and stage into packages/cleo" step (runs after `pnpm run build`, before
any tarball verification or publish):
1. `pnpm --filter @cleocode/brain run build` — brain is a Studio runtime dep not in `build.mjs`.
2. `pnpm --filter @cleocode/studio run build` — SvelteKit adapter-node compilation.
3. `node packages/cleo/scripts/copy-studio-dist.mjs` — invokes the existing staging mechanism
   from T11979 (copies `packages/studio/build/` to `packages/cleo/studio-dist/`).
4. Inline guard: exits non-zero if `packages/cleo/studio-dist/client` is absent after staging.

Added "Verify @cleocode/cleo tarball contents (T12011)" step that runs `node scripts/assert-cleo-tarball.mjs`.

### `scripts/assert-cleo-tarball.mjs` (new)

Loud tarball gate for `@cleocode/cleo`:
- Gate 1: every entry in `packages/cleo/package.json` `files[]` must exist on disk. Missing
  entry = hard fail with `::error::` annotation naming the missing entry.
- Gate 2: `studio-dist/client/` and `studio-dist/client/_app/` must exist (the SvelteKit static
  asset tree the gateway's `resolveStudioStaticDir()` expects).

### `packages/studio/package.json`

Added explicit dependencies so pnpm links them into studio's node_modules for the
SvelteKit adapter-node SSR server to resolve transitive imports at build time:
- `@cleocode/cant` (workspace:*) — transitively imported through `@cleocode/core`
- `@cleocode/caamp` (workspace:*) — transitively imported through `@cleocode/core`
- `jsonc-parser` (^3.3.1) — transitive dep of `@cleocode/caamp`

Full post-publish proof (cleo web serving a non-blank Studio from a fresh install) lands with
the next release after the Studio build resolves remaining runtime dep chain issues.
