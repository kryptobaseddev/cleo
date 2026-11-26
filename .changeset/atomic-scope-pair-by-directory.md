---
id: atomic-scope-pair-by-directory
tasks: [T14636]
kind: fix
summary: "The 3-file worker limit pairs a test with a source only in the same directory, and never with a non-code file"
---

- A test file no longer escapes the worker file count because some declared
  file elsewhere shares its name stem. It pairs only with a code file of that
  stem in the directory it tests: a sibling (`src/foo.test.ts`) or the parent of
  its `__tests__/` (`src/__tests__/foo.test.ts`). Several `index.test.ts` files
  across directories now each count unless each has its own `index.ts`.
- A declared data or config file such as `foo.json` never absorbs a test.
