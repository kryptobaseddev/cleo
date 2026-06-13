---
id: t12012-packaged-import-guard
tasks: [T12012]
kind: fix
summary: derive Wave 7.5 utils-inline list from source scan + dist assert + packed-install smoke (v2026.6.17 dead-on-import)
---

Fixes the `v2026.6.17` packaged-install regression where every `cleo` invocation died with `ERR_MODULE_NOT_FOUND: Cannot find package '@cleocode/utils' imported from @cleocode/core/dist/selfimprove/fix-gen.js`. This is DHQ-099, the third packaged-only failure in 24h.

Root cause: `build.mjs` Wave 7.5 surgically re-emits `@cleocode/utils`-consuming core source files via esbuild (inlining utils) to repair the bare import left by the playbooks `tsc -b` reference build. The list of files to re-emit was hardcoded. `T11989` (#1093) added a fourth consumer — `packages/core/src/selfimprove/fix-gen.ts` — and the hardcoded list was not updated. The workspace resolves `@cleocode/utils` via symlinks so all CI gates passed; only a packed `npm install` exposed the bare import.

**Changes (T12012):**

- **Derived list (kill the rot class)**: Wave 7.5 now scans `packages/core/src/**/*.ts` (excluding `__tests__/` and `*.test.ts`) at build time for files containing import specifiers that reference `@cleocode/utils`. The derived list is logged in build output. The hardcoded three-entry list is gone.

- **Verify-after-emit**: after Wave 7.5 runs, a new build-time assertion scans ALL `packages/core/dist/**/*.js` files for surviving bare `@cleocode/utils` import specifiers and hard-fails the build with the offending file list. This converts the latent class into a build error that fires before any tarball is created.

- **Bundle-budget AC1 gate extended**: `packages/core/scripts/check-core-bundle-budget.mjs` AC1 check now runs two passes — Pass A (original: exported submodule entry points) and Pass B (new: full dist tree sweep covering ALL `.js` files under `dist/`). Pass B is the canonical fallback guard for deep-linked files not in the exports map (e.g. `dist/selfimprove/fix-gen.js`). This is why the original AC1 missed the regression: it only probed the declared `package.json` exports.

- **Packed-install smoke script**: new `scripts/packed-install-smoke.mjs` — `npm pack`s all 18 published `@cleocode/*` packages into a temp dir, `npm install`s `@cleocode/cleo` into an isolated app with `package.json` `overrides` mapping every `@cleocode/*` to its local tarball (no registry traffic), then runs `cleo --version` and asserts exit 0 + non-empty version string. Locally runnable; also wired as a hard gate in `release.yml`.

- **Release pipeline gate**: new `release.yml` step "Packed-install smoke test (T12012)" runs `scripts/packed-install-smoke.mjs` after the existing tarball verification steps and before `pnpm publish`. Any `ERR_MODULE_NOT_FOUND` for an undeclared workspace-private package will surface here as a hard failure.

- **DHQ ledger**: appended DHQ-099 (this regression), flipped DHQ-097 to `FIXED #1096` (T12010 merged).
