---
id: t11406-core-tools-shell
tasks: [T11406, T11390]
kind: feat
summary: Implement atomic shell tool primitives in core/src/tools/shell.ts (executeShell + runGit, injectable executor)
---

E3 T11406. Canonical shell-class impls of @cleocode/contracts/tools/atomic: executeShell (argv form, no shell-injection surface, explicit cwd/env/timeout, captures stdout/stderr/code, non-zero exit is a result not an error) + runGit. Executor is INJECTABLE (ShellExecutor) so tests mock the process layer; defaultShellExecutor uses node:child_process spawn. Forward-only consolidation TARGET for ~60 node:child_process callsites (T11410). 6 unit tests (injected + real spawn).
