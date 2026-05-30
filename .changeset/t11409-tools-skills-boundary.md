---
id: t11409-tools-skills-boundary
tasks: [T11409, T11390]
kind: feat
summary: Add TOOLS-vs-SKILLS boundary (ATOMIC_TOOL_BOUNDARY in boundary.ts) + Gate 11 baseline lint
---

E3 T11409. Encodes ATOMIC_TOOL_BOUNDARY in contracts/boundary.ts (primitives in core/src/tools + contracts/src/tools; skills in packages/skills; mcp-adapter/caamp/cleo-os consume never redefine) + scripts/lint-tools-vs-skills-boundary.mjs (Gate 11, baseline mode, modeled on lint-paths-ssot). Caps the atomic-tool layer (T11403/05/06/07). Baseline=1 pre-existing (core/store/json.ts readJson, a T11410 migration target); fails on net-new out-of-home primitive definitions. 7 unit tests.
