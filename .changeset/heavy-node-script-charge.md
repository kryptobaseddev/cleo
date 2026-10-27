---
id: heavy-node-script-charge
tasks: [T14050]
kind: fix
summary: "cleo run no longer charges a node script that hosts a compiler or test runner as a light 1 GiB run; it is charged its plan, then its measured peak, and the charge is printed with its derivation"
---

`cleo run --class build -- node scripts/typecheck/full-program.cjs` was
charged one light process (1 GiB, "runs no heavy tool") while the TypeScript
compiler it ran in-process used about 3.8 GiB, so the ledger's budget was
wrong for everyone waiting.

- A `node` script is not light when its path names a heavy job (`typecheck`,
  `tsc`, `build`, `test`, `vitest`, `esbuild`, …) or it loads a compiler or
  test runner (`typescript`, `vitest`, `jest`, `esbuild`, `webpack`, `rollup`,
  `@swc/core`, `@babel/core`, or calls `createProgram`).
- Such a script is charged the scoped-build plan until three runs are
  measured, then its measured peak plus 25% (capped at the plan). Peaks are
  recorded the same way as git hooks, keyed by the script's path and content.
- `cleo run` prints the bytes it asks for and how they were derived:
  `charged footprint: 4.8 GiB: scoped-build plan: node scripts/typecheck/full-program.cjs hosts a heavy tool (its path names typecheck), measured peak 3.8 GiB + 25%`.
