# T686 Worker Report: Fix /brain Direct URL SSR 500 Error

## Summary

Fixed HTTP 500 errors on direct navigation to `/brain` and `/brain/3d` by disabling server-side rendering (SSR) for both routes. Root cause: sigma.js and THREE.js import WebGL2RenderingContext at module load, which is unavailable in Node.js SSR environment.

## Changes Applied

### 1. `/packages/studio/src/routes/brain/+page.server.ts`
- Added `export const ssr = false;` with comprehensive comment
- Rationale: Brain canvas is pure WebGL, SSR provides no content value
- Server load function still executes, initial graph data sent to browser

### 2. `/packages/studio/src/routes/brain/3d/+page.server.ts`
- Added `export const ssr = false;` with comprehensive comment
- Rationale: 3D renderer (THREE.js + 3d-force-graph) depends on WebGL
- Server load function still executes, initial graph data sent to browser

## Acceptance Criteria Met

✅ **Direct navigation to http://localhost:PORT/brain returns 200 not 500**
- Verified: `curl http://localhost:3456/brain` → HTTP 200 (was 500)

✅ **Add ssr=false export to brain route OR guard sigma import with browser check**
- Implementation: Added `export const ssr = false;` to both `/brain` and `/brain/3d`
- Chosen approach: Option A (disable SSR entirely) — faster, cleaner, no quality loss

✅ **Build green**
- `pnpm --filter @cleocode/studio build` — success in 2.45s
- All 198 tests pass

## Verification

### HTTP Status Tests
- `GET /brain` → HTTP 200 ✓
- `GET /brain/3d` → HTTP 200 ✓
- `GET /brain/overview` → HTTP 200 ✓ (no changes, already working)

### Quality Gates
- `pnpm biome check --write packages/studio` — no fixes needed ✓
- `pnpm --filter @cleocode/studio build` — green ✓
- `pnpm --filter @cleocode/studio test` — 198/198 pass ✓

## Rationale: Option A Selected

Both routes are pure graphics/visualization with no SSR-friendly content:
- `/brain`: Sigma.js WebGL canvas with dynamic SSE event stream
- `/brain/3d`: THREE.js + 3d-force-graph 3D visualization
- `/brain/overview`: Traditional server-rendered HTML table (no changes needed)

Disabling SSR for canvas routes is standard SvelteKit practice. Initial graph data is still loaded server-side via the `load` function and serialized to the browser, so no functionality is lost — only the unnecessary HTML rendering on the server is skipped.

## Files Modified

- `/mnt/projects/cleocode/packages/studio/src/routes/brain/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/3d/+page.server.ts`

## No Regressions

Verified T674 (`/projects` admin UI) and T675 (`/tasks` search) remain unaffected:
- Both routes return HTTP 200
- Build and test suite all pass
