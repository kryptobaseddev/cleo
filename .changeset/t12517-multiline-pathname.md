---
id: t12517-multiline-pathname
tasks: [T12517]
kind: test
summary: finish the fileURLToPath alias fix — 126 multi-line URL.pathname aliases the first pass missed
---

PR #1575 only rewrote single-line `new URL(..., import.meta.url).pathname`;
biome had wrapped most aliases across lines, so core/cleo/root configs still
produced `%20` paths under "Application Support" and core tests could not
resolve `@cleocode/contracts` in any macOS worktree. The guard test regex now
tolerates whitespace/newlines and trailing commas (verified: fails on the
pre-fix configs, passes after).
