# NEXUS Architecture Guide

**Task**: T4574
**Epic**: T4540
**Date**: 2026-02-16
**Status**: complete

---

## Overview

NEXUS is CLEO's **cross-project intelligence system** -- a global coordination layer that enables task discovery, dependency analysis, and relationship mapping across multiple registered CLEO projects. It uses neural network metaphors (neurons, synapses, weights, activation) to model the global task graph.

### Purpose

Solo developers and AI agents working across multiple repositories need to:

1. **Discover related work** across project boundaries
2. **Track cross-project dependencies** (e.g., `backend:T015` blocks `frontend:T042`)
3. **Enforce access control** between projects with tiered permissions
4. **Query tasks** using a unified `project:taskId` syntax

### Neural Brain Metaphor

| Concept       | Implementation                    | Purpose                    |
|---------------|-----------------------------------|----------------------------|
| **Neurons**   | Tasks (across all projects)       | Units of work              |
| **Synapses**  | Relationships (`depends` field)   | Connections between tasks  |
| **Weights**   | Similarity scores + boosts        | Relevance ranking          |
| **Activation**| Score threshold (0.0-1.0)         | Filtering noise            |
| **Memory**    | Persistent global graph cache     | Cross-session context      |

---

## Key Concepts Preserved from Bash Implementation

### 1. Cross-Project Query Syntax

The `project:taskId` syntax is the fundamental addressing scheme:

| Syntax           | Meaning                          |
|------------------|----------------------------------|
| `my-app:T001`    | Task T001 in project "my-app"    |
| `.:T001`         | Task T001 in current project     |
| `*:T001`         | Search T001 across all projects  |
| `T001`           | Implicit current project         |

### 2. Three-Tier Permission Model

Hierarchical permissions control cross-project access:

| Level     | Numeric | Capabilities                              |
|-----------|---------|-------------------------------------------|
| `read`    | 1       | Query tasks, discover relationships       |
| `write`   | 2       | read + modify task fields, add relations  |
| `execute` | 3       | write + create/delete tasks, run commands |

**Same-project exception**: Operations within the current project always have full permissions regardless of registry entry.

### 3. Global Project Registry

Projects are registered in the **Global Registry database** (`~/.cleo/cleo-nexus.db`, `project_registry` table) per ADR-006. Each entry contains:

- `hash`: 12-character hex identifier (SHA-256 of path)
- `path`: Absolute filesystem path
- `name`: Human-readable unique identifier
- `permissions`: read | write | execute
- `taskCount`: Cached task count
- `labels`: Cached label set
- `lastSync`: Last metadata sync timestamp

### 4. Global Dependency Graph

A cached graph of all tasks and their cross-project edges:

- **Nodes**: `{id, project, status, title}` from all registered projects
- **Edges**: `{from, fromProject, to, toProject}` from dependency references
- **Cache**: Invalidated via combined checksum of all project `todo.json` files

### 5. Discovery Algorithms

Four methods for finding related tasks:

- **labels**: Match by shared labels/topics (scored by overlap count)
- **description**: Keyword extraction and matching (NLP-lite)
- **hierarchy**: Tree structure proximity (same epic, siblings, cousins)
- **auto**: Weighted combination of all methods (default)

### 6. Exit Codes (70-79)

| Code | Name                       | Meaning                          |
|------|----------------------------|----------------------------------|
| 71   | NEXUS_NOT_INITIALIZED      | Nexus not set up                 |
| 72   | NEXUS_PROJECT_NOT_FOUND    | Project not in registry          |
| 73   | NEXUS_PERMISSION_DENIED    | Insufficient permissions         |
| 74   | NEXUS_INVALID_SYNTAX       | Bad query format                 |
| 75   | NEXUS_SYNC_FAILED          | Metadata sync failed             |
| 76   | NEXUS_REGISTRY_CORRUPT     | Registry file corrupt            |
| 77   | NEXUS_PROJECT_EXISTS       | Project already registered       |
| 78   | NEXUS_QUERY_FAILED         | Query execution failed           |
| 79   | NEXUS_GRAPH_ERROR          | Graph operation failed           |

---

## TypeScript Module Structure

```
src/core/nexus/
  ARCHITECTURE.md        # This document
  index.ts               # Barrel exports
  registry.ts            # Project registration and management
  permissions.ts         # Three-tier permission model
  query.ts               # Cross-project query parser and resolver
  deps.ts                # Global dependency graph and analysis
  __tests__/
    registry.test.ts
    permissions.test.ts
    query.test.ts
    deps.test.ts
```

### Module Responsibilities

#### `registry.ts`
- Initialize NEXUS tables in Global Registry (`~/.cleo/cleo-nexus.db`)
- Register/unregister projects in the global registry
- List registered projects
- Sync project metadata (task counts, labels)
- Project lookup by name or hash

#### `permissions.ts`
- Convert permission strings to numeric levels
- Check/require permissions for cross-project ops
- Convenience helpers: `canRead()`, `canWrite()`, `canExecute()`
- Same-project bypass logic

#### `query.ts`
- Parse `project:taskId` syntax into components
- Validate query syntax
- Resolve queries to task data (single or wildcard)
- Current project detection

#### `deps.ts`
- Build global dependency graph across all projects
- Forward and reverse dependency lookups
- Cross-project dependency resolution
- Critical path analysis
- Blocking impact analysis
- Orphaned dependency detection
- Graph caching with checksum-based invalidation

---

## Interface Sketches

### NexusProject

```typescript
interface NexusProject {
  hash: string;           // 12-char hex (SHA-256 of path)
  path: string;           // Absolute filesystem path
  name: string;           // Unique human-readable name
  permissions: NexusPermissionLevel;
  taskCount: number;
  labels: string[];
  registeredAt: string;   // ISO 8601
  lastSeen: string;       // ISO 8601
  lastSync: string;       // ISO 8601
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
}
```

### NexusPermission

```typescript
type NexusPermissionLevel = 'read' | 'write' | 'execute';

interface NexusPermissionCheck {
  project: string;
  required: NexusPermissionLevel;
  granted: NexusPermissionLevel;
  allowed: boolean;
}
```

### NexusQuery

```typescript
interface NexusParsedQuery {
  project: string;        // Project name, "." for current, "*" for wildcard
  taskId: string;         // Task ID (e.g., "T001")
  wildcard: boolean;      // True for "*:T001" queries
}
```

### NexusRegistry

```typescript
interface NexusRegistryFile {
  $schema: string;
  schemaVersion: string;
  lastUpdated: string;
  projects: Record<string, NexusProject>;
}
```

### NexusGraph

```typescript
interface NexusGraphNode {
  id: string;
  project: string;
  status: string;
  title: string;
}

interface NexusGraphEdge {
  from: string;
  fromProject: string;
  to: string;
  toProject: string;
}

interface NexusGlobalGraph {
  nodes: NexusGraphNode[];
  edges: NexusGraphEdge[];
}
```

---

## MCP Domain Integration Plan

The NEXUS subsystem will be exposed through the existing MCP server via dedicated domain routes. The MCP server at `mcp-server/` already has a domain structure that maps operations to engines.

### Planned MCP Operations

**Query operations** (read-only):
- `nexus.list` - List registered projects
- `nexus.query` - Cross-project task query
- `nexus.discover` - Find related tasks
- `nexus.search` - Pattern-based search
- `nexus.deps` - Dependency analysis
- `nexus.graph` - Global graph data

**Mutate operations** (state-changing):
- `nexus.init` - Initialize NEXUS
- `nexus.register` - Register a project
- `nexus.unregister` - Remove a project
- `nexus.sync` - Sync metadata
- `nexus.setPermission` - Update project permissions

---

## What Was Preserved vs Deferred

### Preserved (implemented in TypeScript port)

- Cross-project query syntax (`project:taskId`)
- Three-tier permission model (read/write/execute)
- Project registry with hash-based identification
- Global dependency graph with caching
- Forward and reverse dependency resolution
- Critical path analysis across projects
- Blocking impact analysis
- Orphan detection for broken cross-project refs
- Exit codes 71-79 (mapped from Bash originals)
- Same-project permission bypass

### Intentionally Deferred

- **Graph-RAG integration**: The Bash implementation had `graph-rag.sh` for AI-powered discovery across projects. This requires the GraphRAG engine to be ported first.
- **Neural discovery scoring**: The `discover_across_projects()` function from `graph-rag.sh` that implements label/description/hierarchy scoring. Deferred until GraphRAG port.
- **Metadata caching**: The TypeScript port uses in-memory caching instead of file-based cache initially. Future: SQLite-backed cache in `cleo-nexus.db`.
- **CLI scripts**: The 4 NEXUS CLI scripts (`nexus.sh`, `nexus-discover.sh`, `nexus-query.sh`, `nexus-search.sh`) will be ported as separate CLI commands (tracked by T4551).

### Storage Note (ADR-006 / ADR-009 Alignment)

Per ADR-006 (accepted) and ADR-009, all Nexus operational data is stored in the **Global Registry** SQLite database at `~/.cleo/cleo-nexus.db`. JSON file references in legacy code (`projects-registry.json`, `~/.cleo/nexus/registry.json`) are pre-SQLite artifacts. The TypeScript interfaces above (`NexusRegistryFile`, etc.) describe the API shape, not the physical storage format.
