---
id: t11404-reclaim-sdk
tasks: [T11404, T11390]
kind: refactor
summary: Reclaim core/src/tools — relocate the sdk dir to core/src/sdk, completing the T11404 reclaim
---

E3 T11404 FINAL piece. Moves core/src/tools/sdk to core/src/sdk (decremented 23 escaping imports; repointed 4 external importers spawn-ops/spawn-prompt/validate-ops/validator-integration-test + the mirror test + tools/index.ts barrel; updated contracts/sdk-tool.ts comment). core/src/tools now holds ONLY the atomic primitives (fs/shell/guard) + the barrel. ALL 8 squatters reclaimed (5 files + 3 dirs). Public API unchanged. Verified core+cleo build, arch 5/5, deprecations + tools-boundary clean, mirror-test imports resolve.
