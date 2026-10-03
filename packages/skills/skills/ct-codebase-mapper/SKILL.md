---
name: ct-codebase-mapper
version: 2.1.1
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
  version: 2.1.1
  tier: on-demand
  install: harness
  covers:
    - packages/cleo/src/cli/commands/nexus.ts
    - packages/cleo/src/cli/commands/map.ts
  lastReviewed: 2026-10-02
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

Project-scoped queries use the declared portable project id. `--project-id`
may name that id or a recorded, unambiguous legacy alias; an alias warns
`W_NEXUS_LEGACY_PROJECT_ID`. A foreign or colliding id is refused: run the
query from the intended checkout. Moving a checkout retains its id and graph;
never derive a replacement id from the new path or re-analyze solely for a move.

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

## 5. Across projects: where each one lives, and its state

```bash
cleo nexus projects status                    # every project, per device: path, branch, dirty, ahead/behind
cleo nexus projects status --dirty --behind   # filters: --missing --dirty --behind --ahead --stale --errored
cleo nexus projects status --device current   # one machine (device id, hostname or current)
cleo nexus projects status --refresh          # re-probe this device first (bounded; --fetch also fetches)
```

The output lists counts first, then one page (`--limit`, `--offset`). It reads
recorded probes. `ahead`/`behind` are as of `remote.fetchedAt`, and `stale`
flags an old or missing probe or fetch. Read `matched` and `hasMore` before
concluding "none".

## When to use

| Situation | Start with |
|-----------|------------|
| New or brownfield project | `cleo nexus status`, then `cleo map --store` |
| Planning an epic in unfamiliar code | `cleo map --focus architecture`, `cleo nexus clusters` |
| About to change a function or type | `cleo nexus impact <symbol>` |
| "Who calls this / what does this call?" | `cleo nexus context <symbol>` |
| Tech-debt review | `cleo map --focus concerns` |
| "Which machines hold this project, and is it pushed?" | `cleo nexus projects status` |

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
