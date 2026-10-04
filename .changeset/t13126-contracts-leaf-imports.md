---
id: t13126-contracts-leaf-imports
tasks: [T13126]
kind: fix
summary: Runtime code imports contracts values from their leaf modules, so a store open no longer loads every contracts zod schema
---

The `@cleocode/contracts` barrel re-exports every contracts module, and loading it evaluates every
contracts zod schema: about 40 MB of heap. Many runtime modules imported a single value from it
(`ExitCode`, `OPERATIONS`, one schema) and paid for all of it. Core's store layer
(`store/dual-scope-db`) was one of them, so every command that opened a store loaded the whole barrel.

A mechanical, typechecked codemod moves each value import in the runtime source of core, cleo,
runtime, caamp, nexus, git-shim and worktree to the module that declares the value
(`@cleocode/contracts/<path>.js`). Type-only imports stay on the barrel; they are erased at compile
time.

New arch gate 40 (`scripts/lint-no-contracts-barrel-value-imports.mjs`) keeps it that way. It allows
type-only imports and core's own public barrels. Six files covered by skills keep a shrink-only
baseline, because touching them needs a skill version bump.

Together with the lazy dispatch change, `cleo show`/`find`/`list`/`current` stop loading the
contracts barrel and peak about 197 MB instead of about 219 MB. Output is unchanged.
