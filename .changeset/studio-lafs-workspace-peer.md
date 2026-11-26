---
id: studio-lafs-workspace-peer
tasks: [T14649]
kind: fix
summary: "@cleocode/studio depends on the workspace @cleocode/lafs, so llmtxt's optional lafs peer stops resolving from the registry"
---
- `packages/studio` now declares `@cleocode/lafs: workspace:*`, like `core` and
  `cleo`. llmtxt's optional peer `@cleocode/lafs >=2026.3` resolves to the
  workspace package for studio instead of a registry copy (2026.9.18) that moved
  on every lockfile re-resolve.
