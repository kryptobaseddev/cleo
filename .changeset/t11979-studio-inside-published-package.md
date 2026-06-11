---
id: t11979-studio-inside-published-package
tasks: [T11979]
kind: feat
summary: Ship CLEO Web Studio inside the published @cleocode/cleo package (gateway-served at /studio)
---

Implements the "batteries-included Studio" contract (T11979, Epic T11261): the Studio SvelteKit build ships INSIDE the `@cleocode/cleo` npm tarball and is served by the HTTP gateway at `/studio`.

**Copy script (`packages/cleo/scripts/copy-studio-dist.mjs`)**

Postbuild step that copies `packages/studio/build/` → `packages/cleo/studio-dist/` so the published tarball contains the adapter-node Studio bundle. CI must build Studio before building `@cleocode/cleo` (wave order). In dev checkouts without a Studio build, the script exits 0 with a warning (non-fatal).

**Gateway static handler (`packages/runtime/src/gateway/http/studio-static.ts`)**

Pure `node:http` static file responder with:
- `/studio` → `302` redirect to `/studio/` (keep SvelteKit asset refs consistent)
- `/studio/<static-asset>` → serve from `studio-dist/client/` with correct MIME type
- `/studio/<spa-route>` (no matching file) → `index.html` with `Cache-Control: no-cache` (SPA fallback)
- Fingerprinted assets (`/_app/immutable/...`) → `Cache-Control: public, max-age=31536000, immutable`
- Absent bundle → `503 E_STUDIO_BUNDLE_ABSENT` JSON envelope (not a stack trace)
- Non-GET method → `405 E_METHOD_NOT_ALLOWED` JSON envelope
- Path-traversal guard via `resolve()` comparison

No dependency on `@cleocode/cleo`, `@cleocode/core`, or drizzle — the handler can be embedded in any `node:http` server.

**Gateway wiring**

- `HttpServerOptions.studioStaticDir` added to `startHttpServer`
- `ServeGatewayOptions.studioStaticDir` threaded through `serveGateway`
- `cleo daemon serve` resolves the bundled path via `resolveStudioStaticDir()` and injects it; logs `studioUrl` when the bundle is present

**Path resolution (`packages/cleo/src/cli/web-subsystem.ts`)**

Priority-ordered resolver: `CLEO_STUDIO_DIR` env override → `<cleo-package-root>/studio-dist/` (bundled path, works from `npm install -g @cleocode/cleo`) → dev-checkout fallback (`packages/studio/build`). Returns `undefined` gracefully when no build exists.

**package.json**

`studio-dist` added to `files[]` so the directory ships in the tarball; `copy-studio-dist.mjs` appended to the `postbuild` script.
