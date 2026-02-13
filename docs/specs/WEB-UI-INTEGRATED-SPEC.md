# CLEO Web UI - Integrated Architecture Specification

## Overview

The Web UI is NOT a separate standalone server. It is an **optional interface layer** that:
- Uses the same domain handlers as the MCP server
- Is invoked via CLI command (`cleo web start`)
- Shares code with MCP server (no duplication)
- Provides visual Nexus dashboard

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  cleo web start                                             │
│     ↓                                                       │
│  ~/.cleo/scripts/web.sh (bash)                              │
│     ↓                                                       │
│  node mcp-server/dist/web-server.js [--port 3456]           │
│     ↓                                                       │
│  mcp-server/src/web/server.ts                               │
│     ↓                                                       │
│  mcp-server/src/domains/*.ts (shared handlers)              │
│     ↓                                                       │
│  cleo CLI (bash) or direct file access                      │
│     ↓                                                       │
│  ~/.cleo/* and ./.cleo/* files                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Web Server is Part of MCP Server Package

The web server code lives in `mcp-server/src/web/` and is built as part of the MCP server. This allows it to import directly from `mcp-server/src/domains/` without duplication.

### 2. CLI Manages Process Lifecycle

The bash CLI (`cleo web`) handles:
- Starting/stopping the Node.js process
- PID management
- Port checking
- Log files

### 3. Reuse Domain Handlers

Web routes import and use domain handlers directly:

```typescript
// web/routes/nexus.ts
import { systemDomain } from '../../domains/system';
import { tasksDomain } from '../../domains/tasks';

// Use same logic as MCP tools
const projects = await systemDomain.listProjects();
```

### 4. Nexus = Dashboard

There is ONE unified view called "Nexus" that shows:
- All registered projects
- Aggregated stats across projects
- Cross-project relationships
- Global search

Project-specific views are accessed by selecting a project from Nexus.

## Implementation

### Phase 1: Export Domain Handlers

Make domains exportable for use by web server:

```typescript
// mcp-server/src/domains/index.ts
export { tasksDomain } from './tasks';
export { systemDomain } from './system';
export { sessionDomain } from './session';
// ... etc
```

### Phase 2: Create Web Server Entry Point

```typescript
// mcp-server/src/web/index.ts
import { startServer } from './server';

if (require.main === module) {
  const port = parseInt(process.env.CLEO_WEB_PORT || '3456');
  const host = process.env.CLEO_WEB_HOST || '127.0.0.1';
  startServer({ port, host });
}
```

### Phase 3: Web Server Routes

Create routes that use domain handlers:

```typescript
// mcp-server/src/web/routes/nexus.ts
import { FastifyInstance } from 'fastify';
import { systemDomain } from '../../domains/system';
import { tasksDomain } from '../../domains/tasks';

export async function nexusRoutes(app: FastifyInstance) {
  app.get('/overview', async () => {
    const projects = await systemDomain.listProjects();
    // Aggregate stats across all projects...
    return { projects, stats };
  });
}
```

### Phase 4: UI/UX (8bitcn Style)

Apply 8bitcn aesthetic to the HTML/CSS.

### Phase 5: Build Integration

Add to mcp-server package.json:

```json
{
  "scripts": {
    "build:web": "tsc -p tsconfig.web.json",
    "web:start": "node dist/web/index.js"
  }
}
```

## File Structure

```
mcp-server/
├── src/
│   ├── domains/           # Existing domain handlers
│   │   ├── system.ts
│   │   ├── tasks.ts
│   │   └── ...
│   ├── web/              # NEW: Web server
│   │   ├── index.ts      # Entry point
│   │   ├── server.ts     # Fastify setup
│   │   ├── routes/
│   │   │   ├── nexus.ts  # Unified dashboard
│   │   │   └── projects.ts
│   │   └── public/       # Static files
│   │       └── index.html
│   └── index.ts          # MCP server entry
├── dist/
│   ├── index.js          # MCP server
│   └── web/
│       └── index.js      # Web server (when built)
```

## Usage

```bash
# Development
cd mcp-server
npm run build:web
npm run web:start

# Production (via CLI)
cleo web start
cleo web status
cleo web stop
```

## Benefits

1. **No Code Duplication** - Web server uses same handlers as MCP
2. **Single Package** - Web server built into mcp-server package
3. **CLI Integration** - Standard cleo web command interface
4. **Unified View** - Nexus is the dashboard, not separate
5. **Consistent Logic** - Same validation, same data access

## Next Steps

1. Export domain handlers from mcp-server
2. Create web server entry point
3. Implement Nexus routes using domain handlers
4. Apply 8bitcn UI
5. Update CLI to call web server from mcp-server
