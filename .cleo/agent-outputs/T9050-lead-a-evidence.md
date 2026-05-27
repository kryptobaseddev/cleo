# T9050 Lead A evidence

Commit evidence:
- 31c3bce6b80e06f3e91ae150cfeb5395221abd52: shipped openCleoDb substrate
- 265db2a2e4886b0eec17b0ece6f8f0f321795399: release/tag v2026.5.49 with formatted substrate
- 99cbc6a8c61a38b30da17c0c4c568010552682da: fix openCleoDb to expose native node:sqlite handle and align busy_timeout assertion with node:sqlite result shape

Files:
- packages/core/src/store/open-cleo-db.ts
- packages/core/src/store/__tests__/open-cleo-db.test.ts

Commands run after fix:
- pnpm --filter @cleocode/core exec vitest run src/store/__tests__/open-cleo-db.test.ts => PASS, 1 file, 6 tests
- pnpm --filter @cleocode/core run typecheck => PASS
- pnpm exec biome check packages/core/src/store/open-cleo-db.ts packages/core/src/store/__tests__/open-cleo-db.test.ts => PASS
