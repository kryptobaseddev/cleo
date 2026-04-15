# T541: Python + Go + Rust Language Providers

**Status**: complete
**Task**: Wave I-1 — Python, Go, and Rust language providers for CLEO Nexus
**Date**: 2026-04-12

## What Was Built

Three new tree-sitter-based AST extractors for the code intelligence pipeline, plus integration into the parse loop.

### New Files

| File | Purpose |
|------|---------|
| `packages/nexus/src/pipeline/extractors/python-extractor.ts` | Python extractor |
| `packages/nexus/src/pipeline/extractors/go-extractor.ts` | Go extractor |
| `packages/nexus/src/pipeline/extractors/rust-extractor.ts` | Rust extractor |
| `packages/nexus/src/__tests__/language-extractors.test.ts` | Tests for all three |

### Modified Files

| File | Change |
|------|--------|
| `packages/nexus/src/pipeline/parse-loop.ts` | Added grammar specs + language dispatch for Python/Go/Rust |

## Extraction Capabilities

### Python (`python-extractor.ts`)

- **Definitions**: `function_definition` (top-level functions), `class_definition` (classes + methods + `__init__` as constructor)
- **Imports**: `import X`, `import X as Y`, `from X import Y`, `from . import Z` (relative), wildcard `*`
- **Heritage**: `class Foo(Bar, Baz)` → two `extends` records per base class
- **Calls**: free calls `foo()`, method/attribute calls `obj.method()`
- Exported = name does not start with `_`
- Self/cls parameters stripped from method parameter lists

### Go (`go-extractor.ts`)

- **Definitions**: `function_declaration`, `method_declaration` (with receiver type as parent), `type_declaration` (struct → `struct`, interface → `interface`, other → `type_alias`), struct fields as `property` nodes
- **Imports**: single `import "fmt"`, grouped `import ("fmt"; "os")`, aliased `import f "os"`, blank `import _ "pkg"` (blank discarded)
- **Heritage**: struct embedding (anonymous fields) → `extends` records
- **Calls**: free `foo()`, selector `obj.Method()`, struct literal `User{}` as constructor
- Exported = uppercase first character

### Rust (`rust-extractor.ts`)

- **Definitions**: `function_item`, `struct_item` (+ fields), `enum_item`, `trait_item`, `impl_item` (+ methods), `type_item`, `const_item`, `static_item`, `mod_item` (inline recursion), `macro_definition`
- **Imports**: `use` declarations with full tree-sitter recursion — simple paths, grouped `{A, B}`, wildcard `*`, aliased `as`, `crate::`/`super::`/`self::` preserved
- **Heritage**: `impl Trait for Struct` → `implements` record; plain `impl Struct` → no heritage
- **Calls**: free `foo()`, method `.do_something()`, associated `Foo::new()`, generic `foo::<T>()`, struct literal `User {}` as constructor
- `impl` methods qualified as `TypeName.method` for parent linking
- Exported = has `pub` visibility modifier

## Parse Loop Integration

`parse-loop.ts` changes:

1. Added grammar specs for `python`, `go`, `rust` in `GRAMMAR_SPECS`
2. Extended `grammarKeyForLanguage()` to include the three new languages
3. Updated `PARSEABLE_LANGUAGES` filter to include `python | go | rust`
4. Added `runExtractor()` dispatch function that routes to the correct extractor by language
5. Imported `extractPython`, `extractGo`, `extractRust` from their respective modules

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | PASS — no errors or warnings |
| `pnpm run build` | PASS — full monorepo build succeeds |
| `pnpm run test` (nexus) | PASS — 89/89 tests pass (4 test files) |

## Tree-sitter Grammar Packages

All three grammars were already installed in `packages/nexus/package.json`:
- `tree-sitter-python@^0.23.4`
- `tree-sitter-go@^0.23.0`
- `tree-sitter-rust@^0.23.1`

No new package installations were needed.

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| Python provider extracts functions, classes, methods, imports | DONE |
| Go provider extracts functions, structs, interfaces, imports | DONE |
| Rust provider extracts functions, structs, traits, impls, imports | DONE |
| All providers produce GraphNode and GraphRelation output | DONE (via parse-loop integration) |
| Tree-sitter grammars bundled as npm dependencies | DONE (pre-existing) |
| `cleo nexus analyze` handles mixed-language projects | DONE (parse-loop dispatch) |
| `pnpm run build` passes | DONE |
| `pnpm run test` passes | DONE |
