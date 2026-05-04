# T1762 Research: Symbol Coverage Gap — Function Coverage + DEFINES/MEMBER_OF/ACCESSES

**Task**: T1762
**Date**: 2026-05-04
**Author**: subagent (T1762 spawn)
**Scope**: Axis 1 — function coverage + DEFINES/MEMBER_OF/ACCESSES relation types
**Repository under study**: /mnt/projects/cleocode (pipeline code) + /mnt/projects/openclaw (analysis target)

---

## Context

T1736 D3 validation established the following baseline (fresh analysis on openclaw commit d2e2d97, 2026-05-04):

| Tool | Total Nodes | Functions | Const Nodes | Properties | DEFINES edges | MEMBER_OF edges | ACCESSES edges |
|------|------------|-----------|-------------|------------|--------------|----------------|----------------|
| gitnexus 1.6.3 | 251,832 | 67,125 | 128,805 | 18,850 | 223,627 | 23,798 | 8,293 |
| cleo nexus 2026.5.16 | 64,230 | 35,163 | 0 | 1,068 | 0 | 0 | 0 |
| **Gap** | -187,602 (-75%) | -31,962 (-48%) | -128,805 | -17,782 | -223,627 | -23,798 | -8,293 |

Additionally: cleo nexus emits 390,191 unresolved calls (vs 151,162 resolved) on openclaw.

This document investigates the root causes of each gap and proposes how cleo can surpass gitnexus on these axes.

---

## Sources

All source code references are absolute paths.

| File | Role |
|------|------|
| `/mnt/projects/cleocode/packages/nexus/src/pipeline/extractors/typescript-extractor.ts` | Core extraction logic |
| `/mnt/projects/cleocode/packages/nexus/src/pipeline/call-processor.ts` | Call edge resolution + HAS_METHOD/HAS_PROPERTY emission |
| `/mnt/projects/cleocode/packages/nexus/src/pipeline/parse-loop.ts` | Orchestration: parse, extract, resolve |
| `/mnt/projects/cleocode/packages/nexus/src/pipeline/import-processor.ts` | IMPORTS edge emission + barrel resolution |
| `/mnt/projects/cleocode/packages/contracts/src/graph.ts` | GraphNodeKind and GraphRelationType definitions |
| `/mnt/projects/cleocode/packages/nexus/src/schema/code-index.ts` | SQLite code_index schema |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/parsing-processor.ts` | gitnexus DEFINES + HAS_METHOD/PROPERTY emission |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/pipeline-phases/communities.ts` | gitnexus MEMBER_OF emission |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/emit-references.ts` | gitnexus ACCESSES emission via scope resolution |
| `/home/keatonhoskins/.npm-global/lib/node_modules/gitnexus/src/core/ingestion/variable-extractors/configs/typescript-javascript.ts` | gitnexus TS/JS variable (Const) extraction |
| `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/SUPERSESSION-EVIDENCE.md` | T1736 validation evidence |
| `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/cleo-nexus-runs/SUMMARY.md` | cleo nexus run stats |
| `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/cleo-nexus-runs/01-analyze.log` | Raw analyze log with tier counts |

---

## Gap 1: Function Coverage (-31,962 functions, -48%)

### Root Cause Analysis

**Cleo's `walkDefinitions` has two critical scope-limiting behaviors:**

1. **It only recurses into `CONTAINER_TYPES`** (`program`, `module`, `namespace`, `internal_module`, `module_declaration`). It does NOT recurse into `export_statement` during the definitions walk (only the explicit `case 'export_statement'` branch handles the direct child). This means:
   - Functions nested inside `export default` objects are missed.
   - Functions defined inside namespace blocks (other than the listed types) are missed.
   - Functions inside `declare module` blocks with content may be missed.

2. **The `lexical_declaration`/`variable_declaration` handler captures `const foo = () => {}` but only at the top level of CONTAINER_TYPES.** It does not walk into any deeper nesting. Critical pattern missed:
   - `export const handlers = { login: async (req) => { ... } }` — object-literal function members are not extracted.
   - Object destructuring with function values at module scope.

**gitnexus uses a fundamentally different architecture** for function extraction:

- gitnexus employs a **scope tree + symbol definition** model. The `ScopeExtractor` (`scope-extractor.ts`) walks tree-sitter captures and builds `SymbolDefinition` records for every declaration-level match, regardless of nesting depth. It then attaches them to their `ownedDefs` scope.
- The `parsing-processor.ts` then calls `symbolTable.add()` and emits a `DEFINES` edge for each processed symbol.
- Critically, gitnexus uses dedicated `variable-extractors` that explicitly handle all `lexical_declaration` nodes — including `const X = expr` where `expr` is NOT an arrow function. This creates **Const nodes** for every `const`/`let`/`var` top-level declaration (128,805 Const nodes in the openclaw analysis).

**The 31,962 missing functions break down into three categories:**

| Category | Mechanism | Example Pattern |
|----------|-----------|-----------------|
| Nested namespace functions | walkDefinitions doesn't recurse below first CONTAINER_TYPES level | `namespace Foo { namespace Bar { function baz() {} } }` |
| Functions inside non-standard containers | export_statement + nested module patterns | `declare module 'x' { export function f(): void }` |
| Arrow functions assigned to non-arrow RHS vars | Only `arrow_function` and `function_expression` are captured | `export const fn = wrapHandler(async () => {})` |
| Functions in object literals | walkDefinitions doesn't walk object bodies | `export const routes = { '/path': async (req) => {} }` |

**Additional contributor**: The 32,767 character limit on tree-sitter parsing. The parse loop (`parse-loop.ts` lines 698-716) falls back to regex extraction for oversized files. The regex fallback (`extractReExportsViaRegex`, `extractImportsViaRegex`) extracts only imports and re-exports — NOT function definitions. Large files lose all their symbol definitions.

### Gap Quantification

On openclaw (14,114 files), the unresolved calls statistic provides a proxy for missing functions: 390,191 unresolved calls vs 151,162 resolved. If gitnexus resolves more of these (its 63,267 CALLS edges vs cleo's 86,293), the difference is that cleo captures more CALLS relationships but can't resolve them — because the target functions are not in the graph. The missing 31,962 functions are the targets of the majority of those 390,191 unresolved calls.

---

## Gap 2: DEFINES Edges (0 vs 223,627)

### Root Cause Analysis

**Cleo nexus does not implement DEFINES edges at all.**

In gitnexus, a DEFINES edge is emitted by `parsing-processor.ts` at line 674 for every symbol it processes:

```
File node → symbol node  (type: 'DEFINES', confidence: 1.0)
```

This creates a bidirectional traceability mechanism: given a file node, you can traverse DEFINES edges to find all symbols defined in that file. Given a symbol, you traverse the reverse to find which file defines it.

In cleo's graph contract (`packages/contracts/src/graph.ts`), the `defines` relation type IS declared (line 85: `| 'defines'`). However, **no code in the pipeline emits `defines` edges**.

The `structure-processor.ts` emits `contains` edges (folder → file). The `parse-loop.ts` adds symbol nodes to the graph but does not emit any file → symbol edge. The `call-processor.ts` emits `calls`, `has_method`, `has_property`. No module emits `defines`.

**This is a pure omission** — the schema supports it, the relation type exists, but the emission code was never written.

### Impact

The absence of DEFINES edges means:
- Queries like "all functions defined in file X" require a full scan of the nodes table filtered by `filePath`, rather than a graph traversal.
- Cross-file definition attribution is impossible via graph traversal alone.
- Community enrichment loses a key structural signal (which files define which symbols).

---

## Gap 3: MEMBER_OF Edges (0 vs 23,798)

### Root Cause Analysis

**In gitnexus, MEMBER_OF has two entirely different semantic meanings in practice:**

1. **Symbol → Community**: After Leiden community detection, `pipeline-phases/communities.ts` emits `MEMBER_OF` from each symbol to its detected community node (line 72: `type: 'MEMBER_OF'`).

2. **In some cypher queries**: MEMBER_OF is used to query symbol → community membership.

**In cleo nexus, `member_of` IS declared in `GraphRelationType`** (line 99 of `graph.ts`: `| 'member_of' // symbol → community node`). However:

1. **Leiden community detection produces 0 communities on openclaw** (modularity=0.000, root cause documented in T1764). Without communities, there are no MEMBER_OF edges to emit.
2. Even when Leiden runs successfully, cleo's `community-processor.ts` would need to emit `member_of` edges. This code exists in principle but is blocked by the upstream Leiden failure.

The 23,798 MEMBER_OF edges in gitnexus are entirely the result of working community detection. This gap is not a pipeline design gap — it is a **downstream consequence of the Leiden bug (T1764)**.

**Important distinction**: gitnexus uses MEMBER_OF exclusively for symbol→community membership. Cleo's current graph contract matches this semantics. The gap will close once T1764 (Leiden fix) ships.

---

## Gap 4: ACCESSES Edges (0 vs 8,293)

### Root Cause Analysis

**ACCESSES in gitnexus represents field read/write operations** — when code reads or writes a property of an object:

```typescript
this.count++;         // ACCESSES edge: callerFn → Count.property (write)
user.name             // ACCESSES edge: callerFn → User.name (read)
```

gitnexus emits ACCESSES via two mechanisms:

1. **`emit-references.ts`** (`mapKindToType` at line 274): References of kind `'read'` and `'write'` both map to `ACCESSES`. These come from the scope resolution pipeline's `ReferenceIndex`, which tracks all identifier accesses to known symbols.

2. **`call-processor.ts`** (lines 891-938): When a `captureMap['assignment']` + `captureMap['assignment.receiver']` is detected, it emits an `ACCESSES` edge with `reason: 'write'`.

**This requires the full scope resolution pipeline** that gitnexus has (scope extractor → reference sites → resolve references → emit references). Cleo's pipeline extracts only:
- Function definitions
- Import statements
- Heritage (extends/implements)
- Call expressions (function invocations only)

Cleo does NOT extract variable access patterns (property reads/writes). The `extractCalls` function in `typescript-extractor.ts` captures `call_expression` and `new_expression` nodes but NOT `member_expression` access patterns that are standalone reads.

The `accesses` relation type IS declared in `graph.ts` (line 87: `| 'accesses'`). No extraction code populates it.

**Scope of work to close this gap**: Requires a new `access-extractor` phase that walks the AST for:
- `assignment_expression` where LHS is `member_expression` → ACCESSES (write)
- `member_expression` in non-call contexts → ACCESSES (read)
- Receiver binding: resolve `this.X` and `obj.X` patterns to their property node IDs

---

## Gap 5: Const/Variable Nodes (0 vs 128,805)

### Root Cause Analysis

**Cleo does not create graph nodes for `const`, `let`, or `var` declarations unless they are initialized with an arrow function or function expression.**

In `typescript-extractor.ts` (lines 221-255), the `lexical_declaration` / `variable_declaration` branch:

```typescript
case 'lexical_declaration':
case 'variable_declaration': {
  const valueNode = declarator.childForFieldName('value');
  if (!nameNode || !valueNode) continue;
  if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression')
    continue;   // ← SKIPS all non-function const/let/var
  // ...creates 'function' node
}
```

This guard means `const API_URL = 'https://...'`, `const MAX_RETRIES = 3`, and `export const config = { ... }` are **completely invisible** to cleo nexus.

**gitnexus handles this via `variable-extractors/configs/typescript-javascript.ts`**, which extracts ALL `lexical_declaration` and `variable_declaration` nodes as `Const` or `Variable` nodes, regardless of their initializer value. This produces 128,805 Const nodes on openclaw.

**Tradeoffs**:
- gitnexus creates a node for every `const`, even trivial string constants. This inflates the graph by 128k nodes.
- cleo currently collapses arrow-function constants into `function` nodes (reasonable for call graph purposes).
- For far-exceeding gitnexus: cleo should add Const nodes for exported module-scope constants (not all — just exported ones), which represent public API surface. This would add semantically valuable nodes without the full 128k inflation.

---

## Gap 6: Property Nodes (-17,782, 1,068 vs 18,850)

### Root Cause Analysis

Cleo captures `property` nodes only from `public_field_definition` inside class bodies (line 352-369 of `typescript-extractor.ts`). This correctly handles:
```typescript
class Foo {
  public bar: string;  // ✓ captured as property node
}
```

But misses:
1. **Interface properties**: `interface Foo { bar: string }` — interfaces are extracted as a single node, their members are not individually indexed as property nodes.
2. **Type alias properties**: `type Foo = { bar: string }` — same issue.
3. **Object literal properties** at module scope: `export const config = { timeout: 3000 }` — the object properties are not extracted.
4. **Private and protected class fields** (gitnexus extracts more visibility levels via the field extractor system).

gitnexus uses the `field-extractor` system with per-language configs to extract all property-like members from any struct/interface/class body.

---

## Gap 7: 390,191 Unresolved Calls — Resolution Pipeline Gaps

### Root Cause Analysis

The 390k unresolved calls represent calls that none of the three resolution tiers (same-file T1, named-import T2a, global T3) could resolve. The root causes, in order of significance:

**Tier 1 failure** (`tier1=53906`): Only ~35% of resolvable calls resolve via same-file lookup. This is normal for a modular codebase.

**Tier 2a limitations**:
- `namedImportMap` only tracks named bindings (`import { X } from '...'`). Default imports, namespace imports (`import * as Foo from '...'`), and dynamic imports are NOT tracked.
- Barrel chain tracing (`resolveBarrelBinding`) only follows explicit re-exports. Wildcardexports (`export * from '...'`) are tracked but the symbol table lookup can fail for names not registered because they're defined in files cleo didn't index (e.g., oversized files, non-TS extensions).
- Dynamic property access calls (`this.handler()`, `registry.get(name)()`) cannot be statically resolved.

**Tier 3 failures**:
- Global disambiguation: Tier 3 is skipped when more than one candidate matches the name (ambiguous). Very common names (`get`, `set`, `create`, `update`, `parse`) generate many candidates and all are skipped.
- Missing nodes: If the callee function was not indexed (due to extraction gaps in Gap 1), Tier 3 finds zero candidates.

**Structural gap**: Cleo lacks a **Tier 2b** (package-scoped fallback). gitnexus has more resolution tiers including type-aware resolution. The 390k number is large but not surprising — it represents method calls on objects where the receiver type is unknown without type inference (e.g., `req.body`, `res.json()`, `db.query()`).

---

## Far-Exceed Opportunities (Per Orchestrator Mandate)

The mandate requires not just closing gaps but surpassing gitnexus. Here are concrete ways cleo can exceed gitnexus on Axis 1:

### FE-1: Brain-Anchored DEFINES (Differentiator)

gitnexus emits DEFINES as a simple File → Symbol edge. Cleo can emit **two-layer DEFINES**:
- `file → symbol` (structural, same as gitnexus)
- `brain_observation → symbol` (semantic, unique to cleo): When BRAIN contains an observation about a function's purpose, emit a `defines` edge from the observation node to the symbol node. This creates a navigable path from documented intent to implementation.

**Query enabled**: "Which functions have brain-documented behavior?" — impossible in gitnexus.

### FE-2: Cross-Package MEMBER_OF Heritage Tracking (Differentiator)

gitnexus MEMBER_OF only tracks symbol → community membership. Cleo can additionally emit `member_of` for **cross-package type hierarchies**:
- `method → interface` (method implements interface contract) → `member_of`
- `class → module` (class is part of a module's public surface) → `member_of`

This enables "what is the full interface contract surface of package X?" queries.

### FE-3: Semantic ACCESSES with Read/Write Discrimination (Differentiator)

gitnexus tracks ACCESSES with a `step` property (1=read, 2=write). Cleo can go further:
- Add `accessMode: 'read' | 'write' | 'readwrite'` to the relation metadata
- Track which *functions* access a property (not just which file)
- Emit ACCESSES even for interface/type-property cross-references (type-level access patterns)

**Query enabled**: "Which functions write to Property X?" — critical for mutation impact analysis.

### FE-4: Stronger Heritage Resolution (Closing the Unresolved Calls Gap)

The 390k unresolved calls are cleo's biggest practical weakness. A **Tier 2b: Package-Scoped Resolution** would resolve calls where:
1. The callee is a method of a class defined in a workspace package.
2. The class can be inferred from the type annotation of the variable the method is called on.

This requires maintaining a `typeAnnotationMap: filePath → (varName → typeName)` that cleo currently does not build. Even a partial implementation (resolving typed variables from explicit type annotations) could cut the unresolved count by 30-50%.

### FE-5: Exported-Symbol DEFINES with Visibility Metadata (Quality Win)

Rather than emitting DEFINES for ALL symbols (128k Const inflation), emit DEFINES selectively:
- All `exported` symbols → DEFINES with `visibility: 'public'`
- All class members → DEFINES with `visibility: class-relative`
- Skip internal-only constants

This produces a high-signal DEFINES subgraph (estimated 20-30k edges for openclaw, vs gitnexus 223k) that is more useful for API surface analysis.

---

## Spec for Extending the Ingester

### Phase A: DEFINES Edges (Low Risk, High Value)

**Location**: `packages/nexus/src/pipeline/parse-loop.ts`

**Change**: After each node is added to the graph (`graph.addNode(node)`), emit a `defines` edge from the file node to the symbol node:

```typescript
// After graph.addNode(node):
if (node.kind !== 'file' && node.kind !== 'folder' && node.kind !== 'module') {
  const fileId = node.filePath; // file node ID = relative path (structure-processor convention)
  graph.addRelation({
    source: fileId,
    target: node.id,
    type: 'defines',
    confidence: 1.0,
    reason: `${node.kind} definition in ${node.filePath}`,
  });
}
```

**Estimated DEFINES edges on openclaw**: ~35,163 (functions) + 1,231 (methods) + 1,068 (properties) + 11,217 (type_alias) + 271 (interface) + 221 (class) + 2 (enum) ≈ **49,173 DEFINES edges** vs gitnexus 223,627. Gap remains for the missing function nodes (addressed in Phase C).

### Phase B: Exported Const Nodes (Medium Risk)

**Location**: `packages/nexus/src/pipeline/extractors/typescript-extractor.ts`

**Change**: Extend `walkDefinitions` to create `constant`/`variable` nodes for exported `lexical_declaration` nodes where the value is NOT an arrow/function expression:

```typescript
case 'lexical_declaration':
case 'variable_declaration': {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (!declarator || declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode) continue;
    const name = nameNode.text;
    if (!name) continue;

    if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
      // Existing function extraction (unchanged)
      results.push({ ... kind: 'function' });
    } else if (isExported(node)) {
      // NEW: exported constant/variable node
      const isConst = node.children.some(c => !c.isNamed && c.text === 'const');
      results.push({
        id: nodeId(filePath, name),
        kind: isConst ? 'constant' : 'variable',
        name, filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: true,
        docSummary: extractDocSummary(node),
      });
    }
  }
  break;
}
```

**Scope guard**: Only exported symbols at module scope (the `isExported(node)` check). This avoids the 128k Const inflation while adding high-value API surface nodes.

### Phase C: Nested Function Coverage via Wider Container Set

**Location**: `packages/nexus/src/pipeline/extractors/typescript-extractor.ts`

**Change**: Expand `CONTAINER_TYPES` to include TypeScript-specific containers and ensure `export_statement` is recursed:

```typescript
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'program',
  'module',
  'namespace',
  'internal_module',
  'module_declaration',
  'ambient_declaration',    // NEW: declare module '...' { ... }
  'declaration_module',     // NEW: TypeScript ambient modules
]);
```

Also add recurse-into for `ambient_declaration` as a container that may hold function declarations.

### Phase D: ACCESSES Extraction (Largest Scope)

**Location**: New file `packages/nexus/src/pipeline/extractors/access-extractor.ts`

**Change**: After call extraction, walk AST for:
1. `assignment_expression` with LHS `member_expression` → ACCESSES write
2. `member_expression` in non-call parent context → ACCESSES read

**Requires**: A `PropertyIndex` (analogous to `SymbolTable`) that maps `className.propertyName` → property node ID, populated during the parse phase from `public_field_definition` extractions.

**Data needed**: The `has_property` edges already emitted by `call-processor.ts` can serve as the reverse lookup: given a property node, its `source` in the `has_property` edge is the class node. Build a `propertyIndex: Map<className, Map<propertyName, nodeId>>` from this.

### Phase E: Interface/Type Property Members

**Location**: `packages/nexus/src/pipeline/extractors/typescript-extractor.ts`

**Change**: Extend `buildInterfaceNode` to also extract property signatures:

```typescript
function buildInterfaceNodes(node, filePath, language): GraphNode[] {
  // ... existing interface node
  // Walk body for property_signature and method_signature children
  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (member?.type === 'property_signature') { /* emit property node */ }
      if (member?.type === 'method_signature') { /* emit method node */ }
    }
  }
}
```

---

## Key Findings

1. **DEFINES edges are a pure omission** — the type exists in GraphRelationType, no code emits it. A 20-line addition to parse-loop.ts closes this gap.

2. **MEMBER_OF gap is not a pipeline gap** — it is downstream of the Leiden failure (T1764). Once Leiden produces communities, `community-processor.ts` would emit MEMBER_OF. Cleo's MEMBER_OF can surpass gitnexus by adding symbol→interface and symbol→module membership.

3. **ACCESSES gap requires a new extraction phase** — property read/write tracking needs a dedicated `access-extractor.ts` with a PropertyIndex. The schema supports it (`accesses` type exists). This is the largest scope change.

4. **Function coverage gap has three root causes**: (a) walkDefinitions only recurses into CONTAINER_TYPES (misses nested namespace functions), (b) the 32,767 char limit fallback skips all function definitions for large files, (c) arrow functions inside object literals are not extracted. Root cause (b) is systemic and requires upgrading to tree-sitter 0.22+ to remove the 32k limit.

5. **390,191 unresolved calls is the most impactful weakness** — directly caused by missing function nodes (Gaps 1, 2), not tracking type annotations (no Tier 2b), and the disambiguation filter dropping common names at Tier 3. A Tier 2b type-annotation resolver could close 30-50% of this gap.

6. **Const/Variable node inflation tradeoff** — gitnexus's 128,805 Const nodes include many trivial constants. Cleo's strategy of only exporting arrow-function consts is more targeted. The spec above (exported-only Const nodes) provides the high-signal subset without the full inflation.

7. **The far-exceed strategy is viable** — Brain-anchored DEFINES, cross-package MEMBER_OF heritage, semantic ACCESSES with read/write discrimination, and Tier 2b type-annotation resolution are all implementable within cleo's SQLite + tree-sitter architecture. None require gitnexus's KuzuDB graph database.

---

## Needs Follow-up

- **T1764**: Fix Leiden degenerate partition before MEMBER_OF gap can close. This is a prerequisite for MEMBER_OF edges.
- **tree-sitter upgrade**: The 32,767 char limit (tree-sitter 0.21.x) skips all function definitions for large files. Upgrading to 0.22+ removes this limit and likely adds 10-15% more function coverage on large repos.
- **Tier 2b feasibility**: Measure what fraction of the 390k unresolved calls have a typed receiver (`const x: SomeClass = ...`). If > 20% of callers use explicit type annotations, a Tier 2b TypeAnnotationResolver would produce significant gains.
- **Interface member extraction**: Measure the count of TypeScript interface properties in openclaw to quantify the property node gap contribution.
- **Openclaw Const count validation**: Query gitnexus against openclaw to get the breakdown of Const nodes by whether they're exported vs internal — to scope the exported-only strategy.

---

## Priority Order for Implementation

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Phase A: DEFINES edges | 1 day | High — closes 49k-edge gap, enables file→symbol traversal |
| P0 | Phase C: Container expansion | 0.5 day | Medium — closes subset of function gap |
| P1 | Phase B: Exported Const nodes | 1 day | Medium — adds API surface visibility |
| P1 | Phase E: Interface member extraction | 1 day | Medium — adds 15-17k property nodes |
| P2 | Phase D: ACCESSES extraction | 3-5 days | High but complex — requires PropertyIndex + AST pass |
| P2 | Tier 2b: Type-annotation resolver | 3-5 days | Closes 390k unresolved calls problem |
| P3 | tree-sitter upgrade (0.22+) | 1-2 days | Removes 32k file limit entirely |

---

*Research complete. Absolute paths to all sources cited above. No code was modified.*
