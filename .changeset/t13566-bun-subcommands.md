---
id: t13566-bun-subcommands
tasks: [T13566]
kind: fix
summary: "A typed gate's input snapshot recognises bun's subcommands: bun test a.ts b.ts captures both files, not ./test"
---

The typed-gate input snapshot took the first non-option argument of an interpreter as its script. So `bun test test/a.test.ts test/b.test.ts` captured `./test`, refused it as not a regular file, and the gate failed before running. When bun's first argument is a subcommand (`test`, `run`, `x`, `exec`, `build`), there is no implicit script now; the named files are captured as file arguments, and `bun run build` captures nothing. The package that `bun x <pkg>` or `bunx <pkg>` runs is never taken as a project file, and `bunx` is recognised so the files it names are captured. A bare `bun file.ts` still captures its script.
