# CLEO Web UI MVP Specification

**Version**: 0.1.0  
**Status**: Specification  
**Date**: 2026-02-10  
**Epic**: T#### (Web UI Implementation)  

---

## 1. Executive Summary

### 1.1 Vision

Create a local web-based UI for the CLEO MCP server that provides a visual "Command Center" for:
- **System Overview**: Global view of all registered CLEO projects and Nexus intelligence
- **Project Drill-Down**: Deep inspection of individual projects (tasks, memory, brain)
- **Read-First Architecture**: MVP is read-only visualization; future phases add management

### 1.2 Architecture Principles

1. **Single Source of Truth**: Web UI reads from same data as CLI/MCP (`~/.cleo/` and project `.cleo/`)
2. **No Data Duplication**: Live reads from JSON files, not a separate database
3. **Local-First**: Runs on localhost, no cloud dependencies
4. **MCP Integration**: Leverages existing MCP server infrastructure via internal API
5. **Extensible Foundation**: MVP establishes patterns for future write capabilities

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Web Browser (localhost:PORT)                                   │
│  - React/Vue/Svelte SPA                                         │
│  - Real-time updates via WebSocket/SSE                          │
└─────────────────┬───────────────────────────────────────────────┘
                  │ HTTP/WebSocket
┌─────────────────▼───────────────────────────────────────────────┐
│  CLEO Web Server (Node.js/Express/Fastify)                      │
│  - Static file serving (built UI)                               │
│  - REST API endpoints                                           │
│  - WebSocket for real-time updates                              │
│  - File watcher for live data updates                           │
└─────────────────┬───────────────────────────────────────────────┘
                  │ Internal API calls
┌─────────────────▼───────────────────────────────────────────────┐
│  MCP Server Integration Layer                                   │
│  - Direct imports from mcp-server/src                           │
│  - Bypasses stdio transport (in-process)                        │
│  - Reuses domain handlers (tasks, session, system, etc.)        │
└─────────────────┬───────────────────────────────────────────────┘
                  │ File system reads
┌─────────────────▼───────────────────────────────────────────────┐
│  Data Layer                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ ~/.cleo/     │  │ ~/.cleo/     │  │ Project      │          │
│  │ config.json  │  │ nexus/       │  │ .cleo/       │          │
│  │ registry     │  │ relationships│  │ todo.json    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

**Global to Project Hierarchy**:
```
~/.cleo/
├── config.json                    # Global CLEO settings
├── projects-registry.json         # Registered projects list
├── nexus/
│   ├── relationships.json         # Cross-project relationships
│   └── global-graph.json          # Unified dependency graph
└── agents/
    └── agent-configs.json         # Agent configurations

Project/.cleo/
├── todo.json                      # Active tasks (source of truth)
├── todo-archive.json              # Completed tasks
├── todo-log.json                  # Audit trail
├── config.json                    # Project-specific config
├── project-info.json              # Project metadata
├── sessions.json                  # Session state
└── .cache/
    ├── graph.forward.json         # Dependency graph
    ├── graph.reverse.json         # Reverse dependencies
    └── hierarchy.index.json       # Task hierarchy
```

### 2.3 Web Server Components

```typescript
// Core server structure
src/
├── server/
│   ├── index.ts                   # Entry point, HTTP server setup
│   ├── routes/
│   │   ├── system.ts              # Global/system endpoints
│   │   ├── projects.ts            # Project listing & overview
│   │   ├── nexus.ts               # Nexus/cross-project endpoints
│   │   ├── tasks.ts               # Task detail endpoints
│   │   └── memory.ts              # Brain/memory endpoints
│   ├── middleware/
│   │   ├── cors.ts                # CORS for localhost
│   │   ├── error-handler.ts       # Error handling
│   │   └── file-watcher.ts        # Watch for data changes
│   ├── services/
│   │   ├── project-service.ts     # Project data aggregation
│   │   ├── nexus-service.ts       # Nexus intelligence service
│   │   ├── task-service.ts        # Task detail service
│   │   └── memory-service.ts      # Brain/memory aggregation
│   └── websocket/
│       └── events.ts              # Real-time update events
├── client/                        # UI (separate build)
└── integration/
    └── mcp-adapter.ts             # Direct MCP server integration
```

---

## 3. MVP Feature Scope (Read-Only)

### 3.1 Dashboard (System Overview)

**Purpose**: High-level command center view

**Components**:
1. **Project Grid**: Cards for all registered projects
   - Project name, path, health status
   - Task counts (total, pending, active, completed)
   - Current phase indicator
   - Last activity timestamp

2. **Nexus Intelligence Panel**:
   - Total projects count
   - Cross-project relationship count
   - Recent global activity feed
   - Critical tasks across all projects

3. **System Health Summary**:
   - CLEO version
   - Schema versions across projects
   - Warning/issue count
   - Storage usage

4. **Quick Actions** (UI navigation, not CLI):
   - Open project detail
   - View global task search
   - Access settings

### 3.2 Project Detail View

**Purpose**: Deep dive into a single project

**Components**:
1. **Project Header**:
   - Project name, path, hash
   - Current phase with visual indicator
   - Health status badge
   - CLEO version

2. **Task Hierarchy Visualization**:
   - Epic → Task → Subtask tree
   - Expandable/collapsible
   - Status colors (pending, active, blocked, done)
   - Priority indicators (critical, high, medium, low)
   - Filter by status, priority, phase

3. **Task Detail Panel** (when task selected):
   - Full task metadata
   - Description, notes
   - Dependencies (graph visualization)
   - Lifecycle stage
   - Related tasks

4. **Project Stats**:
   - Completion rate
   - Phase progress
   - Priority distribution chart
   - Activity timeline

5. **Brain/Memory Section**:
   - Research artifacts
   - Decision log
   - Pattern memory
   - Session history

### 3.3 Nexus View (Cross-Project Intelligence)

**Purpose**: Visualize relationships across projects

**Components**:
1. **Global Task Graph**:
   - Force-directed graph of all tasks across projects
   - Color-coded by project
   - Relationship lines (depends, relates, blocks)
   - Zoom and pan

2. **Relationship Explorer**:
   - Search for task by ID or name
   - Show related tasks across projects
   - Filter by relationship type

3. **Project Comparison**:
   - Side-by-side project stats
   - Shared patterns/themes
   - Cross-project dependencies

### 3.4 Task Search & Discovery

**Purpose**: Find tasks across all projects

**Components**:
1. **Global Search**:
   - Full-text search across all project tasks
   - Filters: status, priority, project, phase
   - Results with project context

2. **Task Detail Modal**:
   - Read-only task view
   - Navigate to project
   - See relationships

### 3.5 Memory/Brain Explorer

**Purpose**: Visualize CLEO's accumulated intelligence

**Components**:
1. **Research Manifest**:
   - List of research entries
   - Search and filter
   - Link to source tasks

2. **Decision Log**:
   - Architectural decisions
   - Rationale and context
   - Linked tasks

3. **Pattern Recognition**:
   - Discovered workflow patterns
   - Anti-patterns
   - Success metrics

---

## 4. Technical Implementation

### 4.1 Web Server Technology Stack

**Backend**:
- **Runtime**: Node.js 18+ (same as MCP server)
- **Framework**: Fastify (performance, WebSocket support)
- **API**: REST + WebSocket for real-time
- **File Watching**: chokidar (watch ~/.cleo and project files)
- **Data Access**: Direct file reads (JSON parsing)

**Frontend** (MVP - simple stack):
- **Framework**: Vanilla JS or lightweight framework (Alpine.js)
- **Styling**: Tailwind CSS (consistent with CLEO branding)
- **Charts**: Chart.js or D3.js (for stats/visualizations)
- **Icons**: Lucide or Heroicons

**Alternative Frontend** (if complex UI needed):
- **Framework**: React or Vue 3
- **Build**: Vite
- **State**: Pinia or Zustand

### 4.2 API Endpoints (MVP)

```typescript
// System/System Overview
GET /api/system/overview
GET /api/system/health
GET /api/system/config

// Projects
GET /api/projects                    // List all registered projects
GET /api/projects/:hash              // Project detail + stats
GET /api/projects/:hash/tasks        // Task list with hierarchy
GET /api/projects/:hash/tasks/:id    // Task detail
GET /api/projects/:hash/graph        // Dependency graph
GET /api/projects/:hash/stats        // Project statistics

// Nexus (Cross-project)
GET /api/nexus/overview              // Nexus system overview
GET /api/nexus/graph                 // Global relationship graph
GET /api/nexus/relationships         // Cross-project relationships
GET /api/nexus/search?q=term         // Global task search

// Memory/Brain
GET /api/projects/:hash/memory       // Project memory summary
GET /api/projects/:hash/research     // Research artifacts
GET /api/projects/:hash/decisions    // Decision log
GET /api/projects/:hash/patterns     // Discovered patterns

// Real-time (WebSocket)
WS /api/events                       // Subscribe to file changes
```

### 4.3 Data Service Layer

**ProjectService**:
```typescript
class ProjectService {
  // Read global registry
  async getAllProjects(): Promise<ProjectOverview[]>
  
  // Aggregate project data from .cleo/todo.json
  async getProjectDetail(hash: string): Promise<ProjectDetail>
  
  // Compute stats from task data
  async getProjectStats(hash: string): Promise<ProjectStats>
  
  // Build hierarchy tree
  async getTaskHierarchy(hash: string): Promise<TaskTree>
}
```

**NexusService**:
```typescript
class NexusService {
  // Read ~/.cleo/nexus/relationships.json
  async getGlobalRelationships(): Promise<Relationship[]>
  
  // Aggregate cross-project data
  async getNexusOverview(): Promise<NexusOverview>
  
  // Build global graph
  async getGlobalGraph(): Promise<GraphData>
  
  // Search across all projects
  async globalSearch(query: string): Promise<SearchResult[]>
}
```

**MemoryService**:
```typescript
class MemoryService {
  // Aggregate research from .cleo/research/
  async getResearchManifest(projectHash: string): Promise<ResearchEntry[]>
  
  // Read decision log
  async getDecisionLog(projectHash: string): Promise<Decision[]>
  
  // Extract patterns from completed work
  async getPatterns(projectHash: string): Promise<Pattern[]>
}
```

### 4.4 File Watcher Strategy

**Watch Paths**:
- `~/.cleo/projects-registry.json` → Refresh project list
- `~/.cleo/nexus/*.json` → Refresh Nexus data
- `~/.cleo/config.json` → Refresh global settings
- Each project's `.cleo/todo.json` → Refresh that project's data
- Each project's `.cleo/sessions.json` → Refresh session state

**Optimization**:
- Debounce rapid changes (100ms)
- Only emit WebSocket events to connected clients
- Cache parsed data with invalidation on file change

---

## 5. UI/UX Design

### 5.1 Layout Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ CLEO Command Center                                [Search] [⚙] │
├──────────┬──────────────────────────────────────────────────────┤
│          │                                                      │
│ Projects │  Main Content Area                                   │
│ ─────────┤  - Dashboard (default)                               │
│ Project A│  - Project Detail                                     │
│ Project B│  - Nexus View                                         │
│ Project C│  - Task Search                                        │
│          │  - Memory Explorer                                    │
│ Nexus    │                                                      │
│ ─────────┤                                                      │
│ System   │                                                      │
│          │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

### 5.2 Color Scheme

**Primary** (CLEO Brand):
- Primary: `#0D9373` (teal/green)
- Light: `#07C983`
- Dark: `#0A7A5E`

**Semantic Colors**:
- Pending: `#6B7280` (gray)
- Active: `#0D9373` (primary)
- Blocked: `#DC2626` (red)
- Done: `#10B981` (green)
- Critical: `#DC2626` (red)
- High: `#F59E0B` (orange)
- Medium: `#3B82F6` (blue)
- Low: `#6B7280` (gray)

**Dark Mode** (default):
- Background: `#0F172A` (slate-900)
- Surface: `#1E293B` (slate-800)
- Text: `#F8FAFC` (slate-50)
- Muted: `#94A3B8` (slate-400)

### 5.3 Key Visualizations

**Task Hierarchy**:
- Tree view with indentation
- Expand/collapse chevrons
- Status dots (colored)
- Priority badges

**Dependency Graph**:
- D3.js force-directed graph
- Nodes = tasks (color by status)
- Edges = dependencies (arrows)
- Zoom/pan controls

**Project Cards**:
- Mini stats (task counts)
- Health indicator
- Phase progress bar
- Last activity

**Stats Charts**:
- Donut: Priority distribution
- Bar: Phase completion
- Line: Activity over time

---

## 6. Implementation Phases

### Phase 1: Foundation (MVP Core)

**Week 1-2: Server Setup**
- [ ] Create web server package structure
- [ ] Implement Fastify server with static file serving
- [ ] Set up file watcher for data changes
- [ ] Implement basic project listing endpoint
- [ ] Create WebSocket event system

**Week 3-4: Basic UI**
- [ ] Create simple HTML/CSS/JS frontend
- [ ] Project list sidebar
- [ ] Project detail view (task list)
- [ ] Basic task hierarchy display
- [ ] Real-time updates via WebSocket

**Deliverable**: Working read-only dashboard showing projects and tasks

### Phase 2: Enhanced Visualization

**Week 5-6: Advanced Views**
- [ ] Task dependency graph visualization
- [ ] Project statistics charts
- [ ] Global search across projects
- [ ] Nexus relationship explorer
- [ ] System health dashboard

**Deliverable**: Rich visualizations, search, and cross-project views

### Phase 3: Memory & Brain

**Week 7-8: Intelligence Layer**
- [ ] Research artifact viewer
- [ ] Decision log explorer
- [ ] Pattern recognition display
- [ ] Session history visualization
- [ ] Cross-project pattern detection

**Deliverable**: Complete read-only "Brain" interface

### Phase 4: Polish & Future Prep

**Week 9-10: Refinement**
- [ ] Dark/light mode toggle
- [ ] Responsive design improvements
- [ ] Performance optimizations
- [ ] Design write-capability hooks (disabled in MVP)
- [ ] Documentation

**Deliverable**: Production-ready MVP

---

## 7. Future Write Capabilities (Post-MVP)

### Planned Write Operations

**Task Management**:
- Create/edit tasks via UI
- Drag-and-drop task reordering
- Status transitions
- Bulk operations

**Project Management**:
- Phase transitions
- Release planning
- Configuration editing

**Session Management**:
- Start/end sessions
- Set focus tasks
- Add session notes

**Safety Considerations**:
- All writes go through MCP server's validation
- Audit logging
- Confirmation dialogs for destructive actions
- Undo capability where possible

---

## 8. Integration with Existing Infrastructure

### 8.1 MCP Server Reuse

**Direct Integration** (recommended):
```typescript
// Import and use MCP domain handlers directly
import { DomainRouter } from '../mcp-server/src/lib/router.js'
import { createExecutor } from '../mcp-server/src/lib/executor.js'

// Skip stdio transport, use in-process
const executor = createExecutor()
const router = new DomainRouter(executor)

// Use router.query() and router.mutate() for data access
```

**Benefits**:
- Reuses all validation and business logic
- Consistent data access patterns
- Automatic protocol enforcement
- Minimal code duplication

### 8.2 CLI Compatibility

- Web UI reads same files as CLI
- No conflicts with CLI usage
- File watcher keeps UI in sync with CLI changes
- Changes from UI (future) will use same atomic write patterns

### 8.3 Config Integration

**Web Server Config** (`~/.cleo/web-config.json`):
```json
{
  "server": {
    "port": 8080,
    "host": "127.0.0.1"
  },
  "ui": {
    "theme": "dark",
    "defaultView": "dashboard",
    "refreshInterval": 5000
  },
  "features": {
    "realTimeUpdates": true,
    "graphVisualization": true,
    "readOnly": true
  }
}
```

---

## 9. Security Considerations

### 9.1 Local-Only Security

- Bind to `127.0.0.1` only (not 0.0.0.0)
- No authentication needed for local access
- CORS restricted to localhost origins

### 9.2 File Access Safety

- Read-only access to CLEO data files (MVP)
- No arbitrary file system access
- Path validation (prevent directory traversal)
- Sandbox to `~/.cleo` and registered project paths

### 9.3 Future Write Safety

- All writes validated by existing CLEO validation layer
- Atomic write operations (temp file → validate → rename)
- Backup creation before modifications
- Audit logging to `.cleo/todo-log.json`

---

## 10. Testing Strategy

### 10.1 Unit Tests
- Service layer data aggregation
- File watcher behavior
- API endpoint responses

### 10.2 Integration Tests
- End-to-end data flow
- WebSocket event propagation
- File change detection

### 10.3 Visual Tests
- UI renders correctly with sample data
- Charts display accurate information
- Responsive layout works

### 10.4 Performance Tests
- Load time with 1000+ tasks
- File watcher with frequent changes
- Memory usage over time

---

## 11. Success Metrics

### MVP Success Criteria

1. **Functionality**:
   - [ ] Display all registered projects
   - [ ] Show task hierarchy for any project
   - [ ] Display basic stats (counts, completion rates)
   - [ ] Real-time updates when files change
   - [ ] Works with existing CLEO installations

2. **Performance**:
   - [ ] Initial load < 2 seconds
   - [ ] Task list renders < 1 second (1000 tasks)
   - [ ] Updates propagate < 500ms after file change

3. **Usability**:
   - [ ] Intuitive navigation
   - [ ] Clear visual hierarchy
   - [ ] Responsive to window resizing
   - [ ] No CLI knowledge required to use

---

## 12. Appendix

### 12.1 File Locations

**Web Server**: `mcp-server/web/` or new `cleo-web/` package
**UI Build**: `dist/web/` or served from memory
**Config**: `~/.cleo/web-config.json`
**Logs**: `~/.cleo/logs/web-server.log`

### 12.2 Dependencies

**Production**:
- `fastify` - Web framework
- `@fastify/websocket` - WebSocket support
- `chokidar` - File watching
- `d3` or `chart.js` - Visualizations (client-side)

**Development**:
- `typescript` - Type safety
- `vitest` or `jest` - Testing
- `tailwindcss` - Styling

### 12.3 Commands

```bash
# Start web server
cleo web start          # Start server (default port 8080)
cleo web start --port 3000
cleo web start --open   # Open browser automatically

# Build UI (if separate)
cleo web build

# Development mode
cleo web dev            # Watch mode with hot reload
```

---

**Next Steps**:
1. Create task epic for Web UI implementation
2. Set up basic server structure
3. Implement project listing endpoint
4. Build minimal HTML frontend
5. Iterate based on user feedback
