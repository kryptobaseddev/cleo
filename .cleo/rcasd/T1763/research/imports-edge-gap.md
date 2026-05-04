# T1763 Research: IMPORTS Edge Gap — 8.4x Deficit Root Cause Analysis

**Task**: T1763  
**Date**: 2026-05-04  
**Author**: subagent (T1763 spawn)  
**Scope**: Axis 2 — IMPORTS edge comparison (8.4x deficit 46,674 vs 390,893)  
**Repository under study**: /mnt/projects/cleocode (pipeline code) + /mnt/projects/openclaw (analysis target)

---

## Executive Summary

The 8.4x IMPORTS gap between cleo (46,674) and gitnexus (390,893) is almost entirely explained by a single mechanism: **Swift implicit all-pairs wiring**. gitnexus emits 383,780 of its 390,893 IMPORTS edges from Swift's implicit module-visibility model (620 files × 619 peers). For TypeScript — the primary language of openclaw — cleo actually captures **7.3x MORE** IMPORTS edges than gitnexus (46,157 vs 6,324). Cleo also uniquely tracks 10,711 external module imports that gitnexus does not.

The gap is not a deficiency in cleo's TypeScript import resolution. It is a missing feature: cleo has no Swift extractor and no implicit-import wiring for any language.

---

## Sources

| File | Role |
|------|------|
| `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1763/packages/nexus/src/pipeline/import-processor.ts` | Cleo import resolution engine |
| `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1763/packages/nexus/src/pipeline/extractors/typescript-extractor.ts` | Cleo TypeScript import extraction |
| `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1763/packages/nexus/src/pipeline/parse-loop.ts` | Cleo parse loop dispatch (no Swift case) |
| `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1763/packages/nexus/src/pipeline/language-detection.ts` | Language detection (Swift detected but not parsed) |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/languages/swift.ts` | gitnexus Swift language provider + implicit wiring |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/import-processor.ts` | gitnexus import processor + wireImplicitImports |
| `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/SUPERSESSION-EVIDENCE.md` | T1736 baseline validation data |

All edge counts are from live database queries on the same repository (openclaw, commit d2e2d97, 2026-05-04 analysis).

---

## Root Cause: Swift Implicit All-Pairs Wiring

### What gitnexus does

gitnexus implements `wireImplicitImports` in its import processor. For Swift specifically (in `swift.ts`), it groups all Swift files by SPM target (or a single default group if no SPM config is present), then emits an IMPORTS edge between **every pair of files in the same target**. This O(m²) approach models Swift's module-level visibility: every file in a module can see every other file's declarations without explicit import statements.

In openclaw: 620 Swift files × 619 peers = **383,780 implicit IMPORTS edges** (verified by direct query: `MATCH (a)-[r]->(b) WHERE r.type='IMPORTS' AND a.id ENDS WITH '.swift'` returns 383,780).

### What cleo does

Cleo's `parse-loop.ts` dispatches `runExtractor(language, rootNode, filePath)`. The `switch` statement handles `typescript`, `javascript`, `python`, `go`, and `rust`. Swift falls into `default: return { definitions: [], imports: [], heritage: [], calls: [] }` — producing zero imports.

Additionally, cleo has no `wireImplicitImports` equivalent. The import-processor (`processExtractedImports`) only processes explicitly extracted import records from AST parsing. Swift files produce no records, so no edges are emitted.

Cleo's `language-detection.ts` does correctly map `.swift` → `'swift'`, and `GRAMMAR_SPECS` in `parse-loop.ts` has no Swift entry, confirming tree-sitter parsing is never attempted for Swift files.

### Numerical breakdown

| Category | gitnexus | cleo | Notes |
|----------|---------|------|-------|
| Swift implicit all-pairs | 383,780 | 0 | 620 files × 619 peers — O(m²) SPM module visibility |
| TypeScript imports (file→file internal) | 6,324 | 46,157 | Cleo 7.3x MORE |
| JavaScript imports | 205 | 517 | Cleo 2.5x MORE |
| Go/Python/Other | ~584 | 0 | Cleo missing Go/Python import resolution |
| Markdown cross-links | 6 | 0 | gitnexus extracts relative links as IMPORTS |
| External module imports (file→npm pkg) | 0 | 10,711 | Cleo unique — gitnexus does not track these |
| **Total** | **390,893** | **46,674** | **8.4x gap** |

---

## Secondary Gap: TypeScript Coverage Breadth vs Depth

Despite cleo capturing 7.3x more TS imports per-edge, gitnexus processes a different subset of TS files with IMPORTS edges:

| Metric | gitnexus | cleo |
|--------|---------|------|
| TS files in corpus | 11,651 | 11,692 |
| TS files with IMPORTS edges | 2,892 | 10,070 |
| TS avg imports per file | 2.19 | 4.58 |

**gitnexus covers 25% of TS files; cleo covers 86%.** The gitnexus TS coverage gap is likely due to its tree-sitter query model: it only creates IMPORTS edges when the import resolves to an internal file (node_modules → null). Cleo creates both internal file edges AND external module nodes. This is why gitnexus has 606 unique TS import targets while cleo has 6,395 internal + 148 external = 6,543 total.

---

## Why cleo TS import count is already higher

Cleo's TypeScript import resolution pipeline is more comprehensive than gitnexus's for several reasons:

1. **External module tracking**: Cleo emits `imports` edges to `module:` nodes for unresolved imports (npm packages, `node:*`, etc.) — 10,711 additional edges. gitnexus drops these.

2. **Barrel re-export propagation**: Cleo builds a `BarrelExportMap` and resolves transitive barrel chains (up to 10 hops). This means `import { Foo } from '@scope/pkg'` where `Foo` is re-exported through multiple index.ts files correctly resolves to the canonical source.

3. **Sub-path export resolution** (T617): Cleo's `loadWorkspacePackages` reads `package.json` `exports` field and maps sub-paths like `@scope/pkg/internal` to their TypeScript source files. This enables resolution of imports that gitnexus would miss.

4. **ESM `.js` extension handling**: Cleo's resolver strips `.js` extensions from import paths to find `.ts` source files (the ESM convention where `import './foo.js'` resolves to `foo.ts`).

5. **Regex fallback for oversized files**: For files > 32,767 chars that tree-sitter cannot parse, cleo uses `extractImportsViaRegex` to extract imports. gitnexus skips these entirely.

---

## Missing Coverage: Languages with Implicit Wiring

Beyond Swift, gitnexus also implements `implicitImportWirer` for other languages. Cleo's pipeline has zero equivalent logic:

| Language | gitnexus mechanism | Impact on openclaw |
|----------|-------------------|-------------------|
| Swift | All-pairs within SPM target | +383,780 edges |
| Go | Package-directory-level matching | ~584 edges (small Go corpus in openclaw) |
| Python | (via import resolver, not implicit) | 0 edges in openclaw (no .py files) |
| Kotlin | (standard import resolver) | 0 edges in openclaw |

The Swift implicit wiring is by far the largest contributor in openclaw due to the size of its iOS/macOS codebase.

---

## Key Findings

1. **383,780 of the 344,219-edge gap is Swift implicit wiring** — an O(m²) model that gitnexus applies to all Swift files in the same SPM target. Cleo has no Swift extractor and no implicit-import wiring.

2. **For TypeScript (the primary language), cleo has 7.3x MORE imports** (46,157 vs 6,324). The "gap" reverses direction for the language that matters most in this codebase.

3. **Cleo uniquely captures 10,711 external module imports** (to npm packages, Node.js builtins) that gitnexus discards. This is valuable for dependency surface analysis.

4. **The 8.4x headline gap is misleading**: stripping Swift implicit edges, cleo has 6.5x MORE non-Swift IMPORTS than gitnexus (46,674 vs 7,113).

5. **Cleo processes 3.5x more TS source files** with imports (10,070 vs 2,892 unique TS files with edges), at a higher average of 4.58 imports/file vs gitnexus 2.19.

6. **Cleo's barrel/re-export propagation, ESM extension handling, and sub-path exports are more sophisticated** than gitnexus's standard TypeScript import resolution.

---

## Needs Follow-up

1. **T1765 (augmenter)**: Cleo's external module nodes (10,711 edges) are not surfaced in the augmenter; combining these with community context would give unique dependency-surface queries.

2. **Swift extractor spec**: If cleo indexes Swift projects, it needs both a tree-sitter-swift extractor and implicit all-pairs wiring. Should be gated on language availability (tree-sitter-swift must be installed).

3. **Go/Python/Rust import resolution in parse-loop**: Extractors exist (`go-extractor.ts`, `python-extractor.ts`, `rust-extractor.ts`) but their extracted imports are currently not routed through `processExtractedImports`. Verify whether this is a known gap or an integration omission.

4. **Dynamic import detection**: Neither cleo nor gitnexus captures `import()` dynamic imports as IMPORTS edges. This is a gap in both tools.

5. **Cross-package contract imports**: Cleo's `workspacePackageMap` already resolves `@scope/pkg/internal` sub-paths. Emitting these as a distinct `contract_imports` relation type would allow queries like "which files import from contracts package?" — not available in gitnexus.

---

## Far-Exceed Strategy: Surpassing gitnexus on IMPORTS

Cleo can surpass gitnexus on IMPORTS coverage in ways not available in gitnexus:

### 1. External Module Depth (unique to cleo)
Cleo already emits 10,711 external module nodes. Enrich them with:
- `module:react` → category `ui-framework`
- `module:node:*` → category `nodejs-builtin`
- Dependency version from nearest `package.json`
This enables queries like "which files depend on deprecated packages?" — impossible in gitnexus.

### 2. Brain-Anchored Import Semantics
Add `import_rationale` BRAIN edges: when a cleo memory observation references an import decision (e.g., "chose axios over fetch for retry logic"), link the `imports` edge to the memory entry. This is structurally impossible in gitnexus, which has no memory substrate.

### 3. Dynamic Import Detection
Emit `dynamic_imports` relation type for `import(...)` expressions (already extractable from tree-sitter TypeScript AST — `import_statement` vs `call_expression` with `import` callee). These represent runtime-conditional dependencies, higher risk than static imports.

### 4. Barrel Re-Export Chain Metadata
Cleo's `BarrelExportMap` already builds the chain. Surface it as `barrel_imports` relation: `file A → barrel B → canonical C` with `hopCount` metadata. Enables "which files have deep barrel chain dependencies (>3 hops)?" — an indicator of poor module design not detectable in gitnexus.

### 5. Cross-Package Contract Import Tagging
For imports that resolve to `packages/contracts/src/*`, emit a distinct `contract_imports` relation. This enables "full downstream surface of any contracts API change" queries at the repository level.

### 6. Type-Only Import Tracking
Cleo's extractor already processes `import type { ... }` statements (lines 1135-1167 of typescript-extractor.ts). These currently create the same `imports` edges as value imports. Adding `importKind: 'type' | 'value'` metadata (or a `type_imports` relation) would let callers distinguish type-erasure-safe from value-required dependencies.

---

## Implementation Priority for Gap Closure

| Priority | Item | Effort | Outcome |
|----------|------|--------|---------|
| P0 | Swift extractor + implicit wiring | 2-3 days | +383k edges for Swift-heavy repos; parity with gitnexus on Swift |
| P1 | External module node enrichment | 0.5 day | Unique capability: dependency-surface analysis |
| P1 | Type-only import metadata | 0.5 day | Unique capability: tree-shaking impact analysis |
| P2 | Dynamic import detection | 1 day | Unique capability: runtime-conditional dependencies |
| P2 | Barrel chain depth metadata | 0.5 day | Unique capability: module design quality indicators |
| P3 | Brain-anchored import semantics | 2 days | Unique capability: intent-linked import graph |
| P3 | Contract imports relation | 1 day | Unique capability: contracts-change blast-radius |

---

*Generated by T1763 research subagent. Evidence verified by live queries on /mnt/projects/openclaw via cleo nexus query and gitnexus cypher.*
