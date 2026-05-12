# T1205 — Add --with-deps flag to tree command

**Task**: T1205 (Wave 5 of T1192 epic)
**Status**: done
**Commit**: 4975f8c342d0b1758a2071220af1ab818b6fd27e
**Branch**: task/T1192

## Summary

Implemented `--with-deps` flag for `cleo tree` command. When set, each task in the
tree output has its direct dependency chain inlined below it.

## Files Changed

- `packages/core/src/formatters/tree.ts` — FormatOpts.withDeps option, FlatTreeNode.depends field, rich/markdown dep rendering, buildRichDepLine helper
- `packages/cleo/src/cli/commands/deps.ts` — `--with-deps` flag on treeCommand, setTreeContext call
- `packages/cleo/src/cli/tree-context.ts` — new singleton context file (pattern: format-context.ts)
- `packages/cleo/src/cli/renderers/system.ts` — renderTree reads withDeps from getTreeContext()
- `packages/core/src/formatters/__tests__/formatters.test.ts` — 17 new tests (66 total, all pass)

## Behavior per Mode

| Mode     | --with-deps behavior |
|----------|---------------------|
| rich     | dim `← depends on: T100, T102` line below each task that has deps |
| markdown | `  - depends on: [T100](#T100), [T102](#T102)` nested list item |
| json     | `depends` array already embedded in nodes — identical output |
| quiet    | omitted (IDs-only contract preserved for scripts) |

## Architecture Notes

- `withDeps` is a rendering flag only — no new DB queries in the hot path
- `FlatTreeNode.depends` (added to formatter type) holds raw dep IDs from Wave 2 enrichment
- citty auto-generates `--with-deps` as kebab alias for `withDeps` arg name
- `tree-context.ts` singleton matches the format-context/field-context pattern

## Test Results

- 66 tests pass (49 original T1203 + 17 new T1205)
- biome ci: no issues on all 5 changed files
- tsc --noEmit: zero errors in src/formatters/
