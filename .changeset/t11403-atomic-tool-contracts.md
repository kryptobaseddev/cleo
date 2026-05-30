---
id: t11403-atomic-tool-contracts
tasks: [T11403, T11390]
kind: feat
summary: Add atomic-tool primitive contracts at @cleocode/contracts/tools/atomic (E3 CORE-SDK tool taxonomy)
---

E3 T11403. New types-only submodule (separate from the squatted contracts/src/tools/index.ts): ToolPrimitiveDescriptor + ToolClass (fs|shell|search|net|notebook) + per-class I/O contracts (ReadFile/WriteFile/PathExists/ExecuteShell/RunGit/Search/Fetch/NotebookEdit) + ATOMIC_TOOL_PRIMITIVES registry (9 primitives). Zero any/unknown, full TSDoc, Gate-10 contracts-purity clean. Unblocks T11405-T11407 (core/src/tools impls) + T11411 (MCP catalog).
