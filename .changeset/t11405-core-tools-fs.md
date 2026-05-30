---
id: t11405-core-tools-fs
tasks: [T11405, T11390]
kind: feat
summary: Implement atomic fs tool primitives in core/src/tools/fs.ts (readFileText/readJson/writeFileAtomic/pathExists)
---

E3 T11405. Canonical fs-class implementations of the @cleocode/contracts/tools/atomic contracts (T11403) as PURE async functions — no state coupling, identical across transports. writeFileAtomic uses tmp-then-rename (AGENTS.md Runtime Data Safety doctrine). The forward-only consolidation TARGET for ~290 ad-hoc node:fs callsites (migrated under T11410). Exported via @cleocode/core/tools/fs. 12 unit tests + standalone verification.
