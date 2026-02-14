# CLEO Web Dashboard - Architecture & Feature Specification

**Epic**: T4284 (CLEO Nexus Command Center WebUI)
**Version**: 1.0.0
**Status**: Active Specification (web.sh lifecycle management references will be ported to TypeScript during V2 conversion)
**Last Updated**: 2026-02-14

**Companion Document**: [CLEO-WEB-DASHBOARD-UI.md](./CLEO-WEB-DASHBOARD-UI.md) -- Visual design, layouts, components

---

## 1. Vision

A local web-based Command Center that provides visual access to everything CLEO knows -- tasks, sessions, dependencies, research, compliance, releases, and cross-project intelligence. The dashboard starts as a read-only visualization layer and evolves through phases to become an interactive management interface.

### Core Principles

1. **Single Source of Truth** -- Reads the same `.cleo/` files as CLI and MCP. No separate database.
2. **No Code Duplication** -- Imports existing MCP domain handlers directly. No re-implementation.
3. **Local-First** -- Runs on localhost only. No cloud, no auth for MVP.
4. **CLI-Managed Lifecycle** -- `cleo web start|stop|status|open`. Bash manages the Node.js process.
5. **Progressive Enhancement** -- Read-only first, then interactive, then write-capable.

---

## 2. System Architecture

### 2.1 Stack

```
Browser (localhost:3456)
    |
    | HTTP REST + WebSocket
    v
Fastify Web Server (mcp-server/src/web/)
    |
    | Direct import (in-process, no exec)
    v
MCP Domain Handlers (mcp-server/src/domains/)
    |
    | Native engine or CLI exec
    v
CLEO Data Files (~/.cleo/ + ./.cleo/)
```

The web server is part of the `@cleocode/mcp-server` package. It imports domain handlers directly -- same code path as MCP tool calls, but served over HTTP instead of stdio.

### 2.2 Why Inside mcp-server/

- Domain handlers already have query/mutate for all 10 domains (123 operations)
- Native engine implementations avoid CLI exec overhead for critical paths
- Single `npm run build` produces both MCP server and web server
- Shared TypeScript types, validation, and error handling

### 2.3 Process Model

```
cleo web start [--port 3456]
    |
    v
~/.cleo/scripts/web.sh
    |
    | node mcp-server/dist/web/index.js --port 3456
    v
Fastify server bound to 127.0.0.1:3456
    |
    | PID -> ~/.cleo/web-server.pid
    | Config -> ~/.cleo/web-server.json
    | Log -> ~/.cleo/logs/web-server.log
```

---

## 3. Data Sources

The dashboard has access to rich structured data from CLEO's file-based storage.

### 3.1 Project-Level Data (`.cleo/`)

| Source | Content | Records (this project) |
|--------|---------|----------------------|
| `todo.json` | Active tasks with status, priority, phase, labels, deps, notes | 566 tasks |
| `todo-archive.json` | Completed/archived tasks with cycle times | 4,165 tasks |
| `sessions.json` | Session history with focus, stats, token usage | 622 sessions |
| `todo-log.json` | Before/after change log for all task mutations | Append-only |
| `log.json` | Audit trail of all operations | 2,256 entries |
| `config.json` | Project configuration, phases, release settings | 1 file |
| `project-info.json` | Registration, health, schema versions, injection status | 1 file |
| `.cache/graph.forward.json` | Dependency graph (forward edges) | 119 edges |
| `.cache/graph.reverse.json` | Dependency graph (reverse edges) | 113 edges |
| `.cache/hierarchy.index.json` | Parent-child task hierarchy | Full tree |
| `.cache/labels.index.json` | Label-to-task mappings | 68 labels |
| `.cache/phases.index.json` | Phase-to-task mappings | 5 phases |
| `research/` | Research plans and findings | 43 artifacts |
| `rcsd/` | Research/Consensus/Spec/Design docs | 20 task dirs |
| `consensus/` | Agent consensus reports | 11 reports |
| `metrics/SESSIONS.jsonl` | Per-session efficiency, tokens, completion | Stream |
| `metrics/TOKEN_USAGE.jsonl` | Token usage events by category | Stream |
| `metrics/COMPLIANCE.jsonl` | Compliance pass rates, violations | Stream |
| `releases` (in todo.json) | Release versions, status, task lists | ~10 releases |
| `backups/` | Snapshot/safety/migration backups | 25 entries |
| `migrations.json` | Schema migration history | Version chain |

### 3.2 Global Data (`~/.cleo/`)

| Source | Content |
|--------|---------|
| `registry.json` | Registered project list (paths, hashes) |
| `config.json` | Global CLEO settings |
| `cache/` | Global caches |
| `backups/` | Global backups |

### 3.3 Computed/Derived Data (calculated by dashboard)

| Metric | Source | Calculation |
|--------|--------|-------------|
| Task velocity | todo-log.json | Completed tasks per day/week |
| Average cycle time | todo-archive.json | createdAt to completedAt delta |
| Phase completion % | todo.json + phases.index | done/total per phase |
| Dependency bottlenecks | graph.forward.json | Nodes with highest in-degree |
| Session efficiency | metrics/SESSIONS.jsonl | tokens_consumed / tasks_completed |
| Priority distribution | todo.json | Count by priority level |
| Label frequency | labels.index.json | Count per label |
| Epic progress | hierarchy.index.json | Recursive child completion % |
| Release readiness | todo.json releases | Assigned tasks completion % |
| Compliance trend | metrics/COMPLIANCE.jsonl | Pass rate over time |

---

## 4. API Design

All endpoints return JSON. The web server creates a `DomainRouter` instance and calls `handler.query()` / `handler.mutate()` directly -- no CLI exec for supported operations.

### 4.1 Dashboard Endpoints

```
GET /api/dashboard
    Returns: project overview, task counts by status/priority, phase progress,
             active sessions, recent activity, system health

GET /api/dashboard/stats
    Returns: velocity, cycle times, completion rates, trends over time

GET /api/dashboard/activity?limit=50&since=<ISO>
    Returns: recent task changes, session events, releases from audit log
```

### 4.2 Task Endpoints

```
GET /api/tasks
    Query: ?status=pending&priority=high&phase=core&label=bug&parent=T001
           &search=keyword&sort=priority&limit=50&offset=0
    Returns: paginated task list with hierarchy info

GET /api/tasks/:id
    Returns: full task detail including deps, notes, files, acceptance criteria

GET /api/tasks/:id/tree
    Returns: subtask tree rooted at :id with recursive status rollup

GET /api/tasks/graph
    Query: ?root=T001&depth=3
    Returns: dependency graph data (nodes + edges) for visualization

GET /api/tasks/epics
    Returns: all epic tasks with child completion percentages

# Phase 3+ (write operations)
POST   /api/tasks              { title, priority, phase, parentId, ... }
PATCH  /api/tasks/:id          { status, priority, notes, ... }
POST   /api/tasks/:id/complete
DELETE /api/tasks/:id
```

### 4.3 Session Endpoints

```
GET /api/sessions
    Query: ?status=active&limit=20
    Returns: session list with current focus, stats

GET /api/sessions/:id
    Returns: session detail with focus history, token usage

GET /api/sessions/metrics
    Returns: aggregated session efficiency, token consumption trends

# Phase 3+ (write operations)
POST /api/sessions/start       { name, scope }
POST /api/sessions/:id/end
POST /api/sessions/:id/focus   { taskId }
```

### 4.4 Release Endpoints

```
GET /api/releases
    Returns: all releases with status, task lists, dates

GET /api/releases/:version
    Returns: release detail with task completion status, changelog

GET /api/releases/:version/readiness
    Returns: completion %, blocking tasks, guard results
```

### 4.5 System Endpoints

```
GET /api/system/health
    Returns: CLEO version, schema versions, storage usage, warnings

GET /api/system/config
    Returns: project config (sanitized)

GET /api/system/compliance
    Returns: compliance summary, recent violations, trend

GET /api/system/metrics
    Query: ?type=tokens|sessions|compliance&since=<ISO>&until=<ISO>
    Returns: time-series metric data for charts
```

### 4.6 Research & Brain Endpoints

```
GET /api/research
    Query: ?status=active&topic=keyword
    Returns: research artifact list with status, findings count

GET /api/research/:id
    Returns: full research entry with findings, linked tasks

GET /api/brain/consensus
    Returns: consensus reports list

GET /api/brain/rcsd
    Returns: RCSD document index with lifecycle stage status
```

### 4.7 WebSocket Events

```
WS /api/events

Events emitted on file change (via chokidar):
  task:updated      { taskId, changes }
  task:created      { task }
  task:completed    { taskId }
  session:started   { session }
  session:ended     { sessionId }
  release:shipped   { version }
  system:health     { status, warnings }
  metrics:updated   { type }
```

---

## 5. Implementation Phases

### Phase 1: Read-Only Dashboard (MVP)

**Goal**: See everything CLEO knows. No writes.

**Features**:
- Project overview with task counts, phase progress, health status
- Task list with filtering (status, priority, phase, label, search)
- Task detail view with full metadata, notes, acceptance criteria
- Task hierarchy tree (epic -> task -> subtask) with expand/collapse
- Dependency graph visualization (D3.js force-directed)
- Session list with efficiency metrics
- Release list with completion percentages
- System health panel (version, schema, storage, warnings)
- Real-time updates via WebSocket when files change
- `cleo web start|stop|status` CLI commands

**Data shown**:
- Active tasks (566), priorities, phases, labels
- Dependency graph (119 edges)
- Sessions (622), focus history
- Releases (~10), task assignments
- Project health, CLEO version

### Phase 2: Enhanced Visualization & Analytics

**Goal**: Charts, trends, and deeper data exploration.

**Features**:
- Task velocity chart (completed per day/week over time)
- Priority distribution donut chart
- Phase progress bar chart
- Epic progress cards with completion %
- Session efficiency trends (tokens per task completed)
- Compliance trend line chart
- Cycle time histogram (how long tasks take by priority/size)
- Token usage breakdown by category
- Activity timeline (audit log visualization)
- Label cloud / tag frequency
- Dependency bottleneck highlighting (highest blocking count)
- Archive explorer -- browse 4,165 completed tasks with search
- Research artifact browser with status filtering
- RCSD lifecycle pipeline visualization

### Phase 3: Interactive Management

**Goal**: Perform common task operations from the dashboard.

**Features**:
- Create tasks (title, priority, phase, parent, labels, description)
- Update task status (pending -> active -> done)
- Quick-complete tasks with one click
- Edit task priority, labels, notes
- Drag-and-drop task reordering within lists
- Set/clear session focus from task detail
- Start/end sessions from UI
- Add task notes (append-only, matches CLI behavior)
- Bulk status updates (select multiple, change status)
- Task dependency editing (add/remove deps)
- Confirmation dialogs for destructive actions
- Undo for recent operations (where supported)

**Safety**: All writes go through MCP domain handler `mutate()` which enforces validation, atomic writes, and audit logging. No direct file manipulation.

### Phase 4: Advanced Intelligence

**Goal**: Cross-project views, brain exploration, automation.

**Features**:
- Multi-project Nexus view (aggregate across registered projects)
- Cross-project dependency visualization
- Global task search across all projects
- Brain/memory explorer (research, consensus, patterns)
- Decision log viewer with linked tasks
- Release planning interface (assign tasks, set dates, preview)
- Compliance dashboard with violation drill-down
- Backup management (list, restore from UI)
- Schema migration status
- Custom dashboard layouts (pin/arrange panels)
- Keyboard shortcuts for power users
- Export views as PNG/PDF

---

## 6. File Structure

```
mcp-server/
  src/
    web/
      index.ts              # Entry point (startServer)
      server.ts             # Fastify setup, middleware, static serving
      routes/
        index.ts            # Route registration
        dashboard.ts        # GET /api/dashboard, /api/dashboard/stats
        tasks.ts            # GET /api/tasks, /api/tasks/:id, /api/tasks/graph
        sessions.ts         # GET /api/sessions, /api/sessions/metrics
        releases.ts         # GET /api/releases
        system.ts           # GET /api/system/health, /api/system/config
        research.ts         # GET /api/research, /api/brain/*
      services/
        data-service.ts     # Unified data access (wraps domain handlers)
        file-watcher.ts     # chokidar file watching + event emission
        metrics-service.ts  # JSONL parsing for time-series data
      websocket/
        events.ts           # WebSocket connection manager + event dispatch
    domains/                # Existing (unchanged) -- imported by web routes
  public/
    index.html              # SPA shell
    logo.png                # CLEO logo
    css/                    # Styles (Tailwind + custom)
    js/                     # Client-side JS (vanilla or Alpine.js)
    assets/                 # Icons, fonts
  dist/
    web/
      index.js              # Built web server entry
```

### CLI Command

```
scripts/web.sh              # New CLEO CLI command
```

```bash
cleo web start              # Start server (default port 3456)
cleo web start --port 8080  # Custom port
cleo web start --open       # Start + open browser
cleo web stop               # Stop server (via PID file)
cleo web status             # Check if running, show URL
cleo web open               # Open browser to running instance
```

---

## 7. Technical Decisions

### 7.1 Frontend Approach

**Phase 1-2**: Server-rendered HTML + vanilla JS + Alpine.js for interactivity.
- No build step for client code
- Tailwind CSS via CDN or pre-built
- D3.js for graph visualization
- Chart.js for statistical charts
- Fast iteration, simple deployment

**Phase 3+**: Evaluate migration to SvelteKit or similar if complexity warrants it.

### 7.2 Data Access Pattern

Web routes call domain handlers directly:

```typescript
// routes/tasks.ts
import { TasksHandler } from '../../domains/tasks';

app.get('/api/tasks', async (req, reply) => {
  const handler = new TasksHandler(executor);
  const result = await handler.query('list', {
    status: req.query.status,
    priority: req.query.priority,
  });
  return result;
});
```

For time-series metrics (JSONL files), a dedicated `MetricsService` parses and aggregates:

```typescript
// services/metrics-service.ts
class MetricsService {
  async getSessionMetrics(since?: string): Promise<TimeSeriesData>
  async getTokenUsage(since?: string): Promise<TimeSeriesData>
  async getComplianceTrend(since?: string): Promise<TimeSeriesData>
}
```

### 7.3 File Watching Strategy

```typescript
// Watch these paths, debounce 200ms
const watchPaths = [
  '.cleo/todo.json',           // Task changes
  '.cleo/sessions.json',       // Session changes
  '.cleo/config.json',         // Config changes
  '.cleo/project-info.json',   // Health changes
  '.cleo/todo-log.json',       // Audit events
  '.cleo/metrics/*.jsonl',     // Metric updates
];
```

On change, the watcher:
1. Invalidates cached data
2. Emits typed WebSocket event to all connected clients
3. Logs the event for debugging

### 7.4 Security

- Bind to `127.0.0.1` only (never `0.0.0.0`)
- No authentication for local access
- CORS restricted to localhost origins
- Path validation prevents directory traversal
- Read-only in Phase 1-2 (no file writes)
- Phase 3+ writes go through domain handler validation + atomic write pattern
- No arbitrary command execution from web requests

---

## 8. Available Domain Operations

The dashboard can leverage all 162 MCP domain operations across 10 domains:

| Domain | Query Ops | Mutate Ops | Dashboard Use |
|--------|-----------|------------|---------------|
| `tasks` | 17 | 13 | Task list, detail, hierarchy, graph, stats |
| `session` | 7 | 10 | Session list, focus, metrics, start/end |
| `system` | 19 | 11 | Health, config, version, diagnostics, dash |
| `validate` | 13 | 8 | Compliance summary, violations, test status |
| `lifecycle` | 9 | 9 | RCSD pipeline status, stage tracking |
| `release` | 3 | 9 | Release list, version, changelog, ship |
| `orchestrate` | 6 | 6 | Epic orchestration status, wave progress |
| `research` | 5 | 5 | Research artifacts, search, reports |
| `skills` | 6 | 6 | Installed skills, dispatch info |
| `issues` | 1 | 3 | Bug/feature filing (Phase 4) |

---

## 9. Success Criteria

### Phase 1 (MVP)
- [ ] Dashboard loads in < 2 seconds
- [ ] Task list renders 500+ tasks in < 1 second
- [ ] Real-time updates propagate within 500ms of file change
- [ ] All task statuses, priorities, phases visible at a glance
- [ ] Dependency graph renders and is navigable
- [ ] `cleo web start/stop/status` works reliably
- [ ] No impact on CLI or MCP server functionality

### Phase 2
- [ ] At least 5 chart types rendering real data
- [ ] Archive search returns results in < 1 second
- [ ] Metric trends cover at least 30 days of history

### Phase 3
- [ ] Task create/update/complete from UI works correctly
- [ ] All writes produce correct audit log entries
- [ ] Undo works for status changes
- [ ] No data corruption from concurrent CLI + web writes

### Phase 4
- [ ] Multi-project view aggregates correctly
- [ ] Cross-project search returns results from all registered projects
- [ ] Brain explorer shows research linked to tasks

---

## 10. Related Documents

- **UI/UX Specification**: [CLEO-WEB-DASHBOARD-UI.md](./CLEO-WEB-DASHBOARD-UI.md)
- **Epic**: T4284 (CLEO Nexus Command Center WebUI)
- **MCP Server**: `mcp-server/src/domains/` (domain handlers)
- **Data Schema**: `schemas/todo.schema.json`, `schemas/config.schema.json`
