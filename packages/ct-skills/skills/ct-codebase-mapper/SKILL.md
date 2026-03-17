---
name: ct-codebase-mapper
version: 1.0.0
description: Codebase analysis and mapping for autonomous agent understanding. Builds structured maps of project stack, architecture, conventions, testing, integrations, and concerns.
category: recommended
tier: 1
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
---

# Codebase Mapper

Structured codebase analysis for autonomous agent understanding.

## Quick Start

| Goal | Command | Cost |
|------|---------|------|
| Quick analysis | `query admin map` | ~500 tokens |
| Deep analysis + store | `mutate admin map` | ~800 tokens |
| Focus on one area | `query admin map {focus: "concerns"}` | ~300 tokens |
| CLI | `cleo map` / `cleo map --store` | — |

## Progressive Disclosure

### Tier 0: Quick Analysis

```
query admin map
```

Returns structured `CodebaseMapResult` with stack, architecture, structure, conventions, testing, integrations, and concerns.

### Tier 1: Store to Brain

```
mutate admin map
```

Same analysis, but stores patterns, learnings, and observations to brain.db. Tagged with `source: 'codebase-map'` for filtering.

### Tier 2: Focused Analysis

```
query admin map {focus: "concerns"}
```

Focus areas: `stack`, `architecture`, `structure`, `conventions`, `testing`, `integrations`, `concerns`.

## When to Use

- **New project onboarding**: Run `mutate admin map` to build brain.db context
- **Brownfield init**: `cleo init --map-codebase` runs analysis during initialization
- **Before epic planning**: Understand project structure before decomposing work
- **Tech debt assessment**: `query admin map {focus: "concerns"}` for TODOs and large files

## Output Structure

```typescript
{
  projectContext: ProjectContext,  // From detectProjectType()
  stack: StackAnalysis,           // Languages, frameworks, deps
  architecture: ArchAnalysis,     // Layers, entry points, patterns
  structure: StructureAnalysis,   // Directory tree with annotations
  conventions: ConventionAnalysis,// Naming, linting, formatting
  testing: TestingAnalysis,       // Framework, patterns, coverage
  integrations: IntegrationAnalysis, // APIs, DBs, CI/CD
  concerns: ConcernAnalysis,      // TODOs, large files, complexity
  analyzedAt: string
}
```
