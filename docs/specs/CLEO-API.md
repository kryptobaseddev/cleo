# CLEO API Specification

**Version**: 2.0.0  
**Status**: Canonical Specification  
**Date**: 2026-03-05  
**Epic**: T4820 (CLEO Core Architecture)  

---

## 1. Overview

The **CLEO API** is the canonical interface for all CLEO operations. It provides a unified, transport-agnostic contract that powers:

- **CLEO-NEXUS-API**: Cross-project coordination (multi-project view)
- **CLEO-WEB-API**: HTTP/REST adapter (browser access)
- **MCP Integration**: AI agent tools (Claude Code)
- **CLI Interface**: Command-line access

All adapters consume the same core API through the Dispatcher layer.

---

## 2. Architecture

### 2.1 Unified API Layer

```
┌─────────────────────────────────────────────────────────────┐
│                     API CONSUMERS                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ CLEO-NEXUS   │  │ CLEO-WEB     │  │ MCP/CLI      │      │
│  │ (Cross-Proj) │  │ (HTTP)       │  │ (Agents)     │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │  CLEO API   │                          │
│                    │  (Canonical)│                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │  DISPATCHER │                          │
│                    │  (CQRS)     │                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│         ┌─────────────────┼─────────────────┐               │
│         │                 │                 │               │
│         ▼                 ▼                 ▼               │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │ tasks.db │      │ brain.db │      │ nexus.db │          │
│  │(project) │      │(project) │      │ (global) │          │
│  └──────────┘      └──────────┘      └──────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Transport Adapters

| Adapter | Transport | Purpose |
|---------|-----------|---------|
| **CLEO-NEXUS-API** | HTTP/MCP/CLI | Cross-project operations, global registry |
| **CLEO-WEB-API** | HTTP (Fastify) | Web dashboard, browser access |
| **MCP Tools** | stdio (JSON-RPC) | AI agents, Claude Code |
| **CLI** | Process | Scripts, automation, human use |

---

## 3. Core Concepts

### 3.1 Domain-Based Organization

All operations organized by **domain**:

| Domain | Query | Mutate | Total | Purpose |
|--------|-------|--------|-------|---------|
| `tasks` | 17 | 15 | 32 | Task CRUD, hierarchy, dependencies |
| `session` | 11 | 8 | 19 | Session lifecycle, handoffs |
| `memory` | 12 | 6 | 18 | BRAIN storage, patterns, learnings |
| `check` | 17 | 2 | 19 | Validation, compliance, testing |
| `pipeline` | 14 | 23 | 37 | RCASD lifecycle, releases |
| `orchestrate` | 11 | 8 | 19 | Multi-agent coordination |
| `tools` | 21 | 11 | 32 | Skills, issues, providers |
| `admin` | 23 | 20 | 43 | System management, configuration |
| `nexus` | 17 | 14 | 31 | Cross-project coordination |
| `sticky` | 2 | 4 | 6 | Ephemeral capture, quick notes |
| **Total** | **145** | **111** | **256** | |

### 3.2 Gateway Pattern

Two gateways for all operations:

- **`query`**: Read operations (idempotent, cacheable)
- **`mutate`**: Write operations (validated, logged, atomic)

### 3.3 LAFS Protocol

All responses follow **LAFS** (LLM-Agent-First Specification):

```json
{
  "_meta": {
    "operation": "tasks.show",
    "requestId": "req_abc123",
    "exitCode": 0,
    "durationMs": 42
  },
  "success": true,
  "result": { /* data */ }
}
```

---

## 4. API Surface

### 4.1 Total Operations

**256 operations** across **10 canonical domains**:

- **145** query operations (read-only, idempotent)
- **111** mutate operations (state-changing, validated)

#### Why 256 Operations?

This large surface reflects CLEO's comprehensive scope across four interdependent systems:

**System Coverage:**
- **BRAIN** (memory domain): 18 ops - Cognitive memory, observations, patterns, learnings
- **LOOM** (pipeline domain): 37 ops - RCASD-IVTR+C lifecycle, phases, chains, releases
- **NEXUS** (nexus domain): 31 ops - Cross-project coordination, registry, and `nexus.share.*` relay operations
- **LAFS** (protocol layer): Enforced via all response envelopes

**Granularity:**
- Each domain provides CRUD operations
- Separate query/mutate gateways (CQRS)
- Sub-namespace operations (e.g., `pipeline.stage.validate`, `nexus.share.push`)
- Lifecycle-specific operations (validate, verify, check distinctions per VERB-STANDARDS.md)

**Progressive Disclosure:**
- Tier 0 (Core): ~149 ops - Basic workflows
- Tier 1 (Extended): ~51 ops - Memory, manifest, advanced queries
- Tier 2 (Full System): ~56 ops - Cross-project, admin, advanced tooling

**For comparison:**
- GitHub REST API: ~600+ endpoints
- Linear API: ~100+ operations
- Jira REST API: ~1,000+ endpoints

CLEO's 256 operations provide comprehensive control while maintaining strict domain boundaries and canonical verb standards.

### 4.2 Operation Registry

Single source of truth: `src/dispatch/registry.ts`

```typescript
export const OPERATIONS: OperationDef[] = [
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    description: 'Show task details',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
  },
  // ... 255 more operations
];
```

### 4.3 Dynamic Generation

API specifications generated from registry:

```bash
# Generate OpenAPI spec
npm run generate:api -- --format openapi

# Generate TypeScript client
npm run generate:api -- --format typescript

# Generate Markdown docs
npm run generate:api -- --format markdown
```

---

## 5. Data Storage

### 5.1 Three-Database Architecture

| Database | Scope | Tables | Purpose |
|----------|-------|--------|---------|
| **tasks.db** | Per-project | tasks, sessions, pipelines, adrs | Project operations |
| **brain.db** | Per-project | memory, patterns, learnings, vectors | Cognitive storage |
| **nexus.db** | Global | project_registry, nexus_audit_log | Cross-project |

### 5.2 Storage Location

```
~/.cleo/
├── nexus.db              # Global registry
└── projects/
    └── {project-hash}/
        ├── tasks.db      # Project data
        ├── brain.db      # BRAIN memory
        └── config.json   # Project config
```

---

## 6. Transport Details

### 6.1 HTTP (CLEO-WEB-API)

See: [CLEO-WEB-API.md](./CLEO-WEB-API.md)

```
POST /api/query   { domain, operation, params }
POST /api/mutate  { domain, operation, params }
GET  /api/poll    (ETag-based change detection)
```

### 6.2 MCP

```json
{
  "name": "query",
  "arguments": {
    "domain": "tasks",
    "operation": "show",
    "params": { "taskId": "T001" }
  }
}
```

### 6.3 CLI

```bash
cleo tasks show T001
cleo nexus list
cleo session start
```

---

## 7. Related Specifications

| Document | Purpose |
|----------|---------|
| **[CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)** | Cross-project API (builds on CLEO-API) |
| **[CLEO-WEB-API.md](./CLEO-WEB-API.md)** | HTTP adapter specification |
| **[CLEO-ARCHITECTURE.md](./CLEO-ARCHITECTURE.md)** | System architecture |
| **[LAFS Protocol](https://github.com/kryptobaseddev/lafs-protocol)** | LLM-Agent-First Specification |

---

## 8. Document Hierarchy

```
CLEO-API.md (Master)
├── CLEO-NEXUS-API.md (Cross-project layer)
└── CLEO-WEB-API.md (HTTP transport layer)
```

---

**Version**: 2.0.0  
**Last Updated**: 2026-03-05
