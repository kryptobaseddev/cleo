---
id: atomic-scope-pair-by-directory
tasks: [T14636, T14661]
kind: fix
summary: "The 3-file worker limit pairs a test with a source only in a directory it tests (sibling, __tests__ tree, or tests or test tree mirroring src), and never with a non-code file"
---

- A test file no longer escapes the worker file count because some declared
  file elsewhere shares its name stem. It pairs only with a code file of that
  stem in the directory it tests: a sibling (`src/foo.test.ts`) or the parent of
  its `__tests__/` (`src/__tests__/foo.test.ts`). Several `index.test.ts` files
  across directories now each count unless each has its own `index.ts`.
- A declared data or config file such as `foo.json` never absorbs a test.
- A test in a nested `__tests__/` tree pairs with the matching path under the
  `__tests__/` parent (`src/__tests__/sub/foo.test.ts` with `src/sub/foo.ts`),
  and a test in a `tests/` or `test/` tree pairs with the mirrored path under
  `src/` or the tree's root (`pkg/tests/sub/foo.test.ts` with
  `pkg/src/sub/foo.ts` or `pkg/sub/foo.ts`).
- Declared paths are normalised before pairing, so `./src/foo.ts` still pairs
  with `src/foo.test.ts`.
