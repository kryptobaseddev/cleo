# CLEO Web UI Integration Architecture

## Problem Statement

The current standalone web server has these issues:
1. **Duplication** - Services exist in both mcp-server/src and mcp-server/web
2. **No CLI integration** - No `cleo web start|stop|status` commands
3. **Wrong data model** - Dashboard and Nexus are separate, should be unified
4. **Missing stats** - Not showing correct project/task counts
5. **Not using existing infrastructure** - Should reuse MCP server domain handlers

## Correct Architecture

### 1. CLI Integration (Bash)

Add `cleo web` command to existing bash CLI:

```
cleo web start [--port 3456] [--host 127.0.0.1]  # Start web server
cleo web stop                                     # Stop web server
cleo web status                                   # Check if running
cleo web open                                     # Open browser to UI
```

The web server process is managed via:
- PID file: `~/.cleo/web-server.pid`
- Log file: `~/.cleo/logs/web-server.log`
- Port stored in: `~/.cleo/web-server.json`

### 2. Server Integration (Node.js)

The web server imports directly from `mcp-server/src`:

```typescript
// Instead of duplicating:
import { TaskService } from './services/task-service';  // ❌ Duplicate

// Use existing:
import { taskQueryHandler } from '../../mcp-server/src/handlers/tasks/query';  // ✅ Reuse
```

### 3. Unified Dashboard = Nexus

There is NO separate "Dashboard" view. The Nexus IS the dashboard:

**Nexus View** shows:
- All registered projects (from `~/.cleo/projects-registry.json`)
- Cross-project task aggregation
- Global stats (total tasks across ALL projects)
- Relationship graph
- Recent activity across all projects

**Project View** shows:
- Single project details
- Project-local tasks
- Project stats
- Project graph

### 4. Data Flow

```
Web UI (Browser)
       ↓ HTTP/WebSocket
CLEO Web Server (Fastify)
       ↓ Import (not exec)
MCP Server Handlers (src/handlers/)
       ↓ Function calls
CLI Tools (bash) via exec or direct file reads
       ↓
~/.cleo/ and ./.cleo/ files
```

### 5. UI/UX Design (8bitcn Style)

Reference: https://www.8bitcn.com/docs

Key characteristics:
- Retro pixel aesthetic with modern usability
- High contrast, limited color palette
- Monospace fonts for technical data
- Clear visual hierarchy with borders
- Dark theme with accent colors

Implementation approach:
- Use Tailwind CSS with custom 8-bit inspired theme
- CSS Grid for pixel-perfect layouts
- Monospace font stack for data
- Accent colors: Cyan (#00ffff), Magenta (#ff00ff), Green (#00ff00)

## Implementation Plan

### Phase 1: CLI Integration
1. Create `~/.cleo/scripts/web.sh` command
2. Add PID management
3. Add port detection and conflict handling

### Phase 2: Server Refactoring
1. Move web server to `~/.cleo/web-server/`
2. Import handlers from mcp-server/src
3. Remove duplicate services

### Phase 3: Data Layer Fix
1. Create unified Nexus query handlers
2. Aggregate data from multiple projects
3. Fix stats calculations

### Phase 4: UI Redesign
1. Apply 8bitcn aesthetic
2. Merge Dashboard into Nexus view
3. Fix missing data displays

## File Structure

```
~/.cleo/
├── scripts/
│   └── web.sh              # CLI command
├── web-server/             # Web server code
│   ├── package.json
│   ├── src/
│   │   ├── server.ts       # Fastify setup
│   │   ├── routes/
│   │   │   ├── nexus.ts    # Unified dashboard
│   │   │   └── projects.ts # Project endpoints
│   │   └── websocket/
│   └── public/
│       └── index.html      # 8bitcn UI
├── web-server.json         # Server config
└── logs/
    └── web-server.log
```

## Key Principles

1. **Single Source of Truth**: Web UI reads same data as CLI/MCP
2. **No Duplication**: Reuse existing handlers and services
3. **CLI First**: Web UI is optional enhancement, not replacement
4. **Nexus = Dashboard**: Unified cross-project view
5. **Process Management**: Server lifecycle managed by CLI

## Migration Path

1. Remove duplicate code from mcp-server/web/
2. Create new ~/.cleo/web-server/ location
3. Add cleo web command
4. Update MCP server to export handlers
5. Apply 8bitcn UI
