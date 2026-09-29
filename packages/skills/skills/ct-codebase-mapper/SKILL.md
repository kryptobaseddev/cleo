---
name: ct-codebase-mapper
version: 2.0.0
description: Orient in an unfamiliar or large codebase with CLEO's code-intelligence graph (cleo nexus) and project map (cleo map). Use before planning or editing unfamiliar code, for brownfield onboarding, to find what a change would break, or to map a project's structure, communities and execution flows. Triggers on "map the codebase", "understand this project", "what calls X", "what would break", "brownfield analysis", "project structure".
protocol: null
dependencies: []
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
triggers:
  - codebase map
  - analyze codebase
  - understand project
  - brownfield analysis
  - project structure
  - blast radius
metadata:
  version: 2.0.0
  tier: on-demand
  install: harness
  lastReviewed: 2026-09-28
  stability: stable
---

# Codebase Mapper

Two instruments, used together:

- **`cleo nexus`** is the symbol graph: callers, callees, blast radius,
  communities and execution flows, parsed from source. Use it for any question
  about how code connects.
- **`cleo map`** is the project survey: stack, architecture, structure,
  conventions, testing, integrations and concerns. Use it for the one-page
  overview, and `--store` to keep the findings in BRAIN.

## 1. Check the index before trusting it

```bash
cleo nexus status
```

Read `nodeCount`, `lastIndexedAt` and `staleFileCount` against `fileCount`.
Queries auto-refresh up to 25 stale files; beyond that they warn
`W_NEXUS_INDEX_STALE`. Refresh with `cleo nexus analyze` (incremental; `--full`
rebuilds). An empty or stale index gives confident-looking but incomplete
answers — say which you relied on.

## 2. Survey the project

```bash
cleo map                      # full survey
cleo map --focus concerns     # one area: stack | architecture | structure |
                              #   conventions | testing | integrations | concerns
cleo map --store              # same survey, findings stored to BRAIN
                              #   (tagged source: 'codebase-map')
```

## 3. Find the structure

```bash
cleo nexus clusters               # detected communities (modules that change together)
cleo nexus flows                  # detected execution flows (entry point → callees)
cleo nexus search-code "<text>"   # locate a symbol by name, file pattern or keyword
```

## 4. Before editing a symbol

```bash
cleo nexus impact <symbol>        # blast radius: direct, indirect, transitive callers
cleo nexus context <symbol>       # callers, callees, community, flows
cleo nexus full-context <symbol>  # plus BRAIN memories, tasks and conduit threads
```

`HIGH`/`CRITICAL` impact means review the affected callers before editing.
`UNKNOWN` means the assessment is incomplete, and `NONE` means nothing was
detected in the assessed graph — static analysis cannot prove every runtime
caller, so an empty footprint alone never establishes that a change is safe.
When a symbol name is ambiguous, pass the qualified candidate the command
returns and confirm against the source.

## When to use

| Situation | Start with |
|-----------|------------|
| New or brownfield project | `cleo nexus status`, then `cleo map --store` |
| Planning an epic in unfamiliar code | `cleo map --focus architecture`, `cleo nexus clusters` |
| About to change a function or type | `cleo nexus impact <symbol>` |
| "Who calls this / what does this call?" | `cleo nexus context <symbol>` |
| Tech-debt review | `cleo map --focus concerns` |

## `cleo map` output

```typescript
{
  projectContext: ProjectContext,     // From detectProjectType()
  stack: StackAnalysis,               // Languages, frameworks, deps
  architecture: ArchAnalysis,         // Layers, entry points, patterns
  structure: StructureAnalysis,       // Directory tree with annotations
  conventions: ConventionAnalysis,    // Naming, linting, formatting
  testing: TestingAnalysis,           // Framework, patterns, coverage
  integrations: IntegrationAnalysis,  // APIs, DBs, CI/CD
  concerns: ConcernAnalysis,          // TODOs, large files, complexity
  analyzedAt: string
}
```
