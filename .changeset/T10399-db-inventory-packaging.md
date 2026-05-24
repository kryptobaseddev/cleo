---
id: t10399-db-inventory-packaging
tasks: [T10399, T10305]
kind: fix
summary: "HOTFIX: co-locate db-inventory.json in @cleocode/contracts to fix v2026.5.109 install regression"
prs: []
---

v2026.5.109 shipped broken — global installs failed at module-load time with:

```
ERR_MODULE_NOT_FOUND: @cleocode/core/src/store/db-inventory.json
```

**Root cause (T10305, Saga T10281 SG-BRAIN-DB-RESILIENCE):** the JSON SSoT was
placed at `packages/core/src/store/db-inventory.json` while
`packages/contracts/src/db-inventory.ts` imported it via a sibling-package
`src/` path (`'../../core/src/store/db-inventory.json'`). Published npm
tarballs only ship `dist/`, never sibling-package `src/`, so the relative
import resolved to a path that does not exist on consumer machines.

**Fix:** move the JSON into the consuming package and make the import a
self-reference. The contracts package becomes the SSoT for both the typed
shape AND the runtime data — no cross-package src reach.

Changes:
- `packages/contracts/src/db-inventory.json` — new canonical location
- `packages/contracts/src/db-inventory.ts` imports `./db-inventory.json`
  (relative — works in both `src/` dev and `dist/` published)
- `packages/contracts/scripts/copy-assets.mjs` — new build step copying
  `src/db-inventory.json` → `dist/db-inventory.json` (tsc does not
  propagate `.json` assets to outDir)
- `packages/contracts/package.json` `build` script chains the copy step
- `packages/contracts/tsconfig.json` `include` widened so tsc accepts
  the JSON reference

Verification:
- `tar -tzf cleocode-contracts-2026.5.109.tgz | grep db-inventory.json`
  shows `package/dist/db-inventory.json` is bundled
- Scratch-install smoke test
  (`npm i cleocode-contracts-*.tgz && node -e "import('@cleocode/contracts').then(c => console.log(c.DB_INVENTORY.length))"`)
  prints `12`
- All 379 contracts tests pass
- All other consumers (`packages/core/src/doctor/db-substrate.ts`,
  `packages/cleo/...`) import via `@cleocode/contracts` — unchanged
  surface, no other updates needed

Closes T10399. Saga: T10281.
