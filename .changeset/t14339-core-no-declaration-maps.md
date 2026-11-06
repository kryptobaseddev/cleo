---
id: t14339-core-no-declaration-maps
tasks: [T14339]
kind: perf
summary: "@cleocode/core no longer ships declaration maps; its dist budget is back to 46 MB"
---

Every `dist/*.d.ts.map` in `@cleocode/core` pointed at `../src/*.ts`, which
the package does not publish, so the maps resolved nothing for an npm
consumer. Core now builds with `declarationMap: false`, which removes about
2.8 MB from the dist tree, and the build-time budget returns from the 47 MB
stopgap to 46 MB. The `.js` source maps stay, so stack traces still map to
file and line. Inside the monorepo, go-to-definition from packages that
reference core (`cleo`, `adapters`, `runtime`) still reaches the sources;
from `studio` and `cleo-os`, which have no project reference to core, it now
lands on the `.d.ts` files.
