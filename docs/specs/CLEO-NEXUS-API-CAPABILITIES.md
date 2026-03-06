# CLEO NEXUS API Capabilities

**Version**: 1.0.0  
**Status**: Canonical Reference  
**Date**: 2026-03-05  
**Epic**: T4284, T4820, T5365  

---

## Quick Navigation

| Document | Purpose |
|----------|---------|
| **[CLEO-API.md](./CLEO-API.md)** | **Master API specification** - Core API definitions |
| **[CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)** | Cross-project API (builds on CLEO-API) |
| **[CLEO-WEB-API.md](./CLEO-WEB-API.md)** | HTTP adapter & Fastify implementation spec |
| **[CLEO-SDK-GUIDE.md](./CLEO-SDK-GUIDE.md)** | Client SDK usage & integration |
| **[CLEO-ARCHITECTURE.md](./CLEO-ARCHITECTURE.md)** | System architecture & data flow |

---

## 1. System Architecture Overview

### 1.1 High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL SYSTEMS & TOOLS                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │  Web UI      │ │  IDE Plugin  │ │  CI/CD       │ │  Mobile App  │       │
│  │  (Svelte 5)  │ │  (VS Code)   │ │  (GitHub     │ │  (React      │       │
│  │              │ │              │ │   Actions)   │ │   Native)    │       │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘       │
│         │                │                │                │               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │  Python      │ │  Custom      │ │  n8n/Zapier  │ │  Other       │       │
│  │  Scripts     │ │  Dashboards  │ │  Workflows   │ │  Agents      │       │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘       │
└─────────┼────────────────┼────────────────┼────────────────┼───────────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   TRANSPORT ADAPTERS    │
                    │  (Unified Interface)    │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   HTTP API       │  │   MCP Server     │  │   CLI Interface  │
│   (Fastify)      │  │   (stdio)        │  │   (Commander)    │
│                  │  │                  │  │                  │
│  POST /api/query │  │  Tool: query     │  │  cleo <cmd>      │
│  POST /api/mutate│  │  Tool: mutate    │  │                  │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │    DISPATCH LAYER   │
                    │   (CQRS Pipeline)   │
                    │                     │
                    │  • Validation       │
                    │  • Sanitization     │
                    │  • Rate Limiting    │
                    │  • Audit Logging    │
                    │  • Field Filtering  │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Domain:       │  │   Domain:       │  │   Domain:       │
│   tasks         │  │   session       │  │   nexus         │
│   (26 ops)      │  │   (17 ops)      │  │   (24 ops)      │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │   CORE BUSINESS    │
                    │      LOGIC         │
                    │  (src/core/)       │
                    └─────────┬──────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   tasks.db       │ │   brain.db       │ │   nexus.db       │
│   (Per-project)  │ │   (Per-project)  │ │   (Global)       │
│                  │ │                  │ │                  │
│  • Tasks         │ │  • Patterns      │ │  • Project       │
│  • Sessions      │ │  • Learnings     │ │    Registry      │
│  • Pipelines     │ │  • Decisions     │ │  • Audit Log     │
│  • ADRs          │ │  • Memory        │ │  • Metadata      │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

### 1.2 Access Point Matrix

| Access Point | Protocol | Best For | Authentication | Response Format |
|--------------|----------|----------|----------------|-----------------|
| **HTTP API** | HTTP/1.1, JSON | Web apps, external tools | None (localhost) | Headers + JSON body |
| **MCP** | stdio, JSON-RPC | AI agents, Claude Code | Implicit | LAFS envelope |
| **CLI** | Process stdin/stdout | Scripts, automation | OS user | Text or JSON |
| **SDK** | TypeScript/JS | Type-safe integration | Configurable | Typed objects |

### 1.3 Database Architecture

```
┌────────────────────────────────────────────────────────────┐
│                      CLEO STORAGE                          │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────┐      ┌─────────────────┐             │
│  │   PROJECT A     │      │   PROJECT B     │             │
│  │   ~/projects/a  │      │   ~/projects/b  │             │
│  │                 │      │                 │             │
│  │  ┌───────────┐  │      │  ┌───────────┐  │             │
│  │  │ tasks.db  │  │      │  │ tasks.db  │  │             │
│  │  │           │  │      │  │           │  │             │
│  │  │ • tasks   │  │      │  │ • tasks   │  │             │
│  │  │ • session │  │      │  │ • session │  │             │
│  │  │ • audit   │  │      │  │ • audit   │  │             │
│  │  └───────────┘  │      │  └───────────┘  │             │
│  │                 │      │                 │             │
│  │  ┌───────────┐  │      │  ┌───────────┐  │             │
│  │  │ brain.db  │  │      │  │ brain.db  │  │             │
│  │  │           │  │      │  │           │  │             │
│  │  │ • memory  │  │      │  │ • memory  │  │             │
│  │  │ • patterns│  │      │  │ • patterns│  │             │
│  │  │ • vectors │  │      │  │ • vectors │  │             │
│  │  └───────────┘  │      │  └───────────┘  │             │
│  │                 │      │                 │             │
│  │  config.json    │      │  config.json    │             │
│  └─────────────────┘      └─────────────────┘             │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                    GLOBAL                           │  │
│  │                   ~/.cleo/                          │  │
│  │                                                     │  │
│  │  ┌─────────────────────────────────────────────┐   │  │
│  │  │              nexus.db                        │   │  │
│  │  │                                             │   │  │
│  │  │  • project_registry (all registered)        │   │  │
│  │  │  • nexus_audit_log (cross-project ops)      │   │  │
│  │  │  • nexus_schema_meta (versioning)           │   │  │
│  │  └─────────────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 2. Integration Patterns

### 2.1 HTTP API Integration

**For:** Web applications, mobile apps, third-party tools

```typescript
// TypeScript client example
import { createCleoClient } from '@cleo/sdk';

const client = createCleoClient({ 
  baseUrl: 'http://localhost:34567' 
});

// Query operations
const tasks = await client.tasks.list({ status: 'active' });
const project = await client.nexus.show({ name: 'my-app' });

// Mutate operations
await client.tasks.add({ 
  title: 'Implement feature',
  priority: 'high' 
});
```

**Features:**
- Default mode: Clean JSON responses + metadata headers
- LAFS mode: Full envelope with `Accept: application/vnd.lafs+json`
- MVI support: Field filtering with `_mvi` and `_fields` parameters
- ETag caching: Conditional requests for efficiency

### 2.2 MCP Integration

**For:** AI agents, Claude Code, LLM tools

```json
// MCP tool call
{
  "name": "query",
  "arguments": {
    "domain": "nexus",
    "operation": "list",
    "params": {}
  }
}
```

**Features:**
- Two tools only: `query` (read) and `mutate` (write)
- LAFS envelope always included
- Automatic cache invalidation on mutate
- Budget enforcement for token usage

### 2.3 CLI Integration

**For:** Shell scripts, automation, CI/CD

```bash
# Query
$ cleo nexus list --format json
$ cleo tasks show T001 --format json

# Mutate
$ cleo tasks add --title "New task" --priority high

# Exit codes for scripting
$ cleo nexus status > /dev/null 2>&1
$ echo $?  # 0 = success, non-zero = error
```

**Features:**
- Human-readable or JSON output (`--format`)
- Exit codes for automation
- Pipe-friendly

---

## 3. Use Cases Enabled

### 3.1 Web Dashboard (T4284)

**Real-time CLEO monitoring and management**

```
User Story: Developer wants to see all tasks across multiple projects

Implementation:
1. Start web server: cleo web start
2. Dashboard polls: POST /api/query { domain: "nexus", operation: "list" }
3. Display: Project cards with task counts, health status
4. Real-time: ETag-based polling every 5s for updates

Value: Single pane of glass for all CLEO projects
```

**Capabilities:**
- Task board with drag-and-drop
- Dependency graph visualization (D3.js)
- Session management
- Release pipeline tracking
- Cross-project search

### 3.2 IDE Integration

**CLEO in your development environment**

```
User Story: Developer wants to see tasks without leaving VS Code

Implementation:
1. VS Code extension activates
2. Connects to: http://localhost:34567
3. Sidebar shows: POST /api/query { domain: "tasks", operation: "list" }
4. Click task: Opens detail panel with full context

Value: Context-aware development workflow
```

**Capabilities:**
- Task list in sidebar
- Inline task creation
- Current task indicator
- Session start/stop from IDE
- Git integration (tasks in commits)

### 3.3 CI/CD Automation

**Automated testing and release management**

```yaml
# .github/workflows/release.yml
jobs:
  release:
    steps:
      - name: Start CLEO Session
        run: |
          cleo session start \
            --label "Release ${{ github.ref }}" \
            --task T0100
      
      - name: Run Release Gates
        run: |
          cleo pipeline stage.gate.run \
            --stage release \
            --task T0100
      
      - name: Complete Release
        run: |
          cleo tasks complete T0100 \
            --notes "Released ${{ github.ref }}"
```

**Capabilities:**
- Automated release pipelines
- Gate validation before deploy
- Session tracking for audit trail
- Integration with GitHub Actions, GitLab CI, etc.

### 3.4 Cross-Project Coordination

**Managing work across multiple repositories**

```
Scenario: Backend change requires Frontend updates

Projects:
  - backend-api (T015: Add authentication endpoint)
  - frontend-app (T042: Update login UI)

Dependency: frontend-app:T042 depends on backend-api:T015

NEXUS Query:
  POST /api/query
  {
    "domain": "nexus",
    "operation": "deps",
    "params": { "query": "backend-api:T015", "direction": "reverse" }
  }

Result: Shows T042 is blocked by T015

Action: Developer knows to complete backend first
```

**Capabilities:**
- Cross-project dependency tracking
- Critical path analysis
- Blocking impact visualization
- Orphaned dependency detection

### 3.5 Multi-Agent Collaboration

**Multiple AI agents working together**

```
Scenario: Two agents working on different aspects of a feature

Agent A (Backend):
  - Claims task: backend:T015
  - Creates session: "Auth Implementation"
  - Makes progress via MCP

Agent B (Frontend):
  - Queries: nexus.deps for "backend:T015"
  - Sees: frontend:T042 is blocked
  - Waits for Agent A to complete T015

Coordination:
  - Both agents use same MCP server
  - Session isolation prevents conflicts
  - Audit log tracks all operations
```

**Capabilities:**
- A2A-compliant communication
- Capability discovery
- Distributed tracing
- Conflict resolution

### 3.6 Workflow Automation

**n8n/Zapier/Make.com integration**

```
Trigger: New GitHub Issue labeled "bug"

Action 1: Create CLEO Task
  HTTP POST /api/mutate
  {
    "domain": "tasks",
    "operation": "add",
    "params": {
      "title": "Bug: {{issue.title}}",
      "type": "bug",
      "labels": ["github-sync"]
    }
  }

Action 2: Post to Slack
  "New bug tracked in CLEO: T{{task.id}}"

Result: All GitHub bugs automatically in CLEO
```

**Capabilities:**
- Webhook integration
- Bidirectional sync
- Automated task creation
- Notification routing

---

## 4. API Surface

### 4.1 Complete Operation Count

| Domain | Query | Mutate | Total | Purpose |
|--------|-------|--------|-------|---------|
| **tasks** | 17 | 15 | 32 | Task management |
| **session** | 11 | 8 | 19 | Session lifecycle |
| **memory** | 12 | 6 | 18 | BRAIN storage |
| **check** | 17 | 2 | 19 | Validation |
| **pipeline** | 14 | 23 | 37 | RCASD lifecycle |
| **orchestrate** | 11 | 8 | 19 | Multi-agent |
| **tools** | 21 | 11 | 32 | Skills & issues |
| **admin** | 23 | 20 | 43 | System mgmt |
| **nexus** | 17 | 14 | 31 | Cross-project |
| **sticky** | 2 | 4 | 6 | Quick capture |
| **TOTAL** | **145** | **111** | **256** | |

### 4.2 NEXUS Operations Detail

**Registry Management (10 operations):**
- `nexus.init` - Initialize global registry
- `nexus.status` - Get registry health
- `nexus.register` - Add project to registry
- `nexus.unregister` - Remove project
- `nexus.list` - List all projects
- `nexus.show` - Show project details
- `nexus.sync` - Sync project metadata
- `nexus.sync.all` - Sync all projects
- `nexus.permission.set` - Update permissions
- `nexus.reconcile` - Auto-detect and sync

**Cross-Project Query (8 operations):**
- `nexus.query` - Resolve `project:taskId` syntax
- `nexus.search` - Pattern search across projects
- `nexus.discover` - Find related tasks
- `nexus.deps` - Dependency analysis
- `nexus.graph` - Global dependency graph
- `nexus.path.show` / `nexus.critical-path` - Critical path
- `nexus.blockers.show` / `nexus.blocking` - Blocking analysis
- `nexus.orphans.list` / `nexus.orphans` - Broken refs

**Multi-Contributor Sharing (6 operations):**
- `nexus.share.status` - Sharing status
- `nexus.share.remotes` - List remotes
- `nexus.share.sync.status` - Sync status
- `nexus.share.snapshot.export` - Export snapshot
- `nexus.share.snapshot.import` - Import snapshot
- `nexus.share.sync.gitignore` - Sync .gitignore
- `nexus.share.remote.add` - Add remote
- `nexus.share.remote.remove` - Remove remote
- `nexus.share.push` - Push to remote
- `nexus.share.pull` - Pull from remote

---

## 5. Security Model

### 5.1 Localhost-Only (MVP)

```
All access points bind to 127.0.0.1
↓
Network-level isolation
↓
No authentication required for MVP
```

### 5.2 Permission Tiers (NEXUS)

| Level | Value | Capabilities |
|-------|-------|--------------|
| `read` | 1 | Query tasks, view graph, discover |
| `write` | 2 | Read + modify fields, add relations |
| `execute` | 3 | Write + create/delete, run commands |

**Same-Project Exception:** Always full permissions within current project

### 5.3 Data Isolation

```
┌─────────────────┐     ┌─────────────────┐
│   Project A     │     │   Project B     │
│   tasks.db      │ ◄──►│   tasks.db      │  ❌ No direct access
│                 │     │                 │
│   brain.db      │ ◄──►│   brain.db      │  ❌ No direct access
└─────────────────┘     └─────────────────┘
         │                       │
         └───────────┬───────────┘
                     │
            ┌────────┴────────┐
            │   nexus.db      │
            │   (shared)      │  ✅ Cross-project bridge
            └─────────────────┘
```

---

## 6. Document Index

### 6.1 API Specifications

| Document | Lines | Purpose | Audience |
|----------|-------|---------|----------|
| **CLEO-API.md** | ~300 | Master API specification | All developers |
| **CLEO-NEXUS-API.md** | ~1,630 | Cross-project API (NEXUS domain) | Multi-project developers |
| **CLEO-WEB-API.md** | ~1,200 | HTTP/Fastify implementation spec | Web developers |
| **CLEO-SDK-GUIDE.md** | ~600 | Client SDK usage | Application developers |

### 6.2 Architecture & Design

| Document | Purpose |
|----------|---------|
| **CLEO-ARCHITECTURE.md** | System architecture, data flow, component diagrams |
| **CLEO-VISION.md** | Project vision, pillars, strategic direction |
| **CLEO-DATA-MODEL.md** | Database schemas, entity relationships |

### 6.3 Implementation References

| Document | Purpose |
|----------|---------|
| **CLEO-OPERATION-REGISTRY.md** | All 256 operations, parameters, examples |
| **CLEO-EXIT-CODES.md** | Complete exit code reference |
| **CLEO-LAFS-SPEC.md** | LAFS protocol compliance details |

### 6.4 Generated Documentation

| Document | Source | Purpose |
|----------|--------|---------|
| `cleo-nexus-openapi.json` | Auto-generated | OpenAPI 3.1 spec for tools |
| `cleo-client.ts` | Auto-generated | TypeScript SDK |
| `cleo-api-reference.md` | Auto-generated | Markdown operation list |

---

## 7. Quick Start Examples

### 7.1 Connect from TypeScript

```typescript
import { createCleoClient } from '@cleo/sdk';

const client = createCleoClient({ 
  baseUrl: 'http://localhost:34567' 
});

// List all registered projects
const { projects } = await client.nexus.list({});

// Query task across projects
const task = await client.nexus.query({ 
  query: 'backend:T001' 
});

// Register new project
await client.nexus.register({
  path: '/home/user/projects/new-app',
  name: 'new-app',
  permission: 'write'
});
```

### 7.2 Connect from Python

```python
import requests

CLEO_URL = 'http://localhost:34567'

def query(domain, operation, params=None):
    response = requests.post(
        f'{CLEO_URL}/api/query',
        json={
            'domain': domain,
            'operation': operation,
            'params': params or {}
        }
    )
    return response.json()

# List projects
result = query('nexus', 'list')
print(f"Projects: {result['result']['count']}")

# Find related tasks
result = query('nexus', 'discover', {
    'query': 'my-app:T001',
    'method': 'auto'
})
```

### 7.3 Connect from curl

```bash
# Start server
cleo web start

# List projects
curl -X POST http://localhost:34567/api/query \
  -H "Content-Type: application/json" \
  -d '{"domain": "nexus", "operation": "list"}'

# Query task
curl -X POST http://localhost:34567/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "nexus",
    "operation": "query",
    "params": {"query": "my-app:T001"}
  }'

# Register project
curl -X POST http://localhost:34567/api/mutate \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "nexus",
    "operation": "register",
    "params": {
      "path": "/path/to/project",
      "name": "my-project"
    }
  }'
```

### 7.4 MCP/Agent Integration

```json
{
  "name": "query",
  "arguments": {
    "domain": "nexus",
    "operation": "status"
  }
}
```

Response:
```json
{
  "_meta": {
    "operation": "nexus.status",
    "exitCode": 0,
    "requestId": "req_abc123"
  },
  "success": true,
  "result": {
    "initialized": true,
    "projectCount": 5
  }
}
```

---

## 8. File Naming Conventions

### 8.1 Specification Documents

```
docs/specs/
├── CLEO-NEXUS-API.md              # NEXUS domain API (this ecosystem)
├── CLEO-WEB-API.md                # HTTP/Web adapter
├── CLEO-MCP-API.md                # MCP server spec
├── CLEO-SDK-GUIDE.md              # Client SDK guide
├── CLEO-ARCHITECTURE.md           # System architecture
├── CLEO-VISION.md                 # Project vision
├── CLEO-DATA-MODEL.md             # Database schemas
├── CLEO-OPERATION-REGISTRY.md     # All 256 operations
├── CLEO-EXIT-CODES.md             # Exit code reference
└── CLEO-LAFS-SPEC.md              # LAFS protocol compliance
```

### 8.2 Generated Artifacts

```
docs/specs/generated/
├── cleo-nexus-openapi.json        # OpenAPI 3.1 spec
├── cleo-full-openapi.json         # All domains OpenAPI
└── cleo-api-reference.md          # Auto-generated reference

src/clients/
├── nexus-client.ts                # NEXUS-only SDK
├── cleo-client.ts                 # Full CLEO SDK
└── cleo-client.d.ts               # Type definitions
```

### 8.3 Legacy/Deprecated

```
docs/specs/archive/
├── CLEO-WEB-API-SPEC-v1.md        # Previous version
├── NEXUS-SPEC-LEGACY.md           # Old nexus spec
└── ...
```

---

## 9. Version Compatibility

| Component | Version | Status |
|-----------|---------|--------|
| **CLEO Core** | 2.0.0 | ✅ Current |
| **NEXUS API** | 1.0.0 | ✅ Current |
| **LAFS Protocol** | 1.0.0 | ✅ Supported |
| **OpenAPI** | 3.1.0 | ✅ Generated |
| **MCP** | 2024-11-05 | ✅ Current |

---

## 10. Getting Help

- **Documentation**: Start with [CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)
- **Examples**: See Integration Examples section above
- **Issues**: Check [docs/guides/TROUBLESHOOTING.md](../guides/TROUBLESHOOTING.md)
- **Architecture**: Read [CLEO-ARCHITECTURE.md](./CLEO-ARCHITECTURE.md)

---

**Last Updated**: 2026-03-05  
**Specification Version**: 1.0.0  
**Next Review**: 2026-04-05
