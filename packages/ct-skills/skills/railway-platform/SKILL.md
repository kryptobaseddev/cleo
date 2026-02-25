---
name: railway-platform
description: Deploy and manage applications on Railway platform. Use for creating projects, deploying services (Node.js, Python, Go, Docker, static sites), managing databases (Postgres, Redis, MySQL, MongoDB), configuring domains, environment variables, volumes, cron jobs, and networking. Integrates with GitHub for auto-deploys. Supports monorepos, private networking, and Railway Metal infrastructure.
version: 1.0.0
tier: 3
core: false
category: specialist
protocol: null
dependencies: []
sharedResources: []
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
metadata:
  author: Railway Skills Collective
  updated: "2025-02-17"
  repository: https://github.com/railwayapp/railway-skills
allowed-tools: Bash(railway:*), Bash(jq:*), Bash(curl:*), Read, Write
---

# Railway Platform

Railway is a deployment platform that builds and runs your code with minimal configuration. This skill provides comprehensive management of Railway resources.

## When to Use This Skill

- **Creating projects:** Initialize new Railway projects or link existing ones
- **Deploying code:** Push local code or connect GitHub repositories
- **Managing services:** Create, configure, and monitor services
- **Adding databases:** Deploy Postgres, Redis, MySQL, or MongoDB
- **Configuring domains:** Set up custom domains with SSL
- **Environment setup:** Variables, build commands, and configuration
- **Advanced features:** Volumes, cron jobs, private networking, Railway Functions

## Quick Start

### Deploy Current Directory

```bash
railway up --detach -m "Initial deploy"
```

### Check Status

```bash
railway status --json
```

### View Logs

```bash
railway logs --lines 100
```

## Installation & Setup

See [01-getting-started.md](references/01-getting-started.md) for:
- CLI installation
- Authentication
- Project linking
- Troubleshooting

Quick check:
```bash
railway status --json
```

## Decision Trees

### Decision: New Project vs Existing

```
railway status --json
        │
   ┌────┴────┐
  Linked    Not Linked
    │            │
    │     Check parent directory
    │            │
    │       ┌────┴────┐
    │    Linked    Not linked
    │       │            │
    │   Use parent    List projects
    │   project       or init new
    │       │            │
  Add      Set root   Link or
  service   dir       init
```

### Decision: Deploy Strategy

```
Local code    GitHub repo
    │              │
railway up    Connect in UI
    │              │
  Detach      Auto-deploys
  or CI           │
    │         On push to
  Monitor      main
```

### Decision: Database Setup

```
Need database?
      │
   ┌──┴──┐
  Yes    No
   │      │
Check    Skip
existing
   │
┌──┴──┐
Exists  New
  │      │
Skip   Deploy
  │    template
  │      │
Wire    Done
vars
```

## Core Workflows

### Workflow 1: New Project from Scratch

```bash
# 1. Create project
railway init -n my-project

# 2. Add service
railway add --service web

# 3. Deploy
railway up --detach -m "Initial deploy"

# 4. Add domain (optional)
railway domain
```

### Workflow 2: Connect to Existing Project

```bash
# 1. List projects
railway list --json

# 2. Link to project
railway link -p project-name

# 3. Check status
railway status

# 4. Deploy
railway up
```

### Workflow 3: Add Database + Wire Service

```bash
# 1. Deploy database template
# See database reference for template deployment

# 2. Wire connection
# Set DATABASE_URL via environment reference

# 3. Deploy with connection
railway up
```

### Workflow 4: Monorepo Setup

**First, detect type:**
```bash
# Check for workspace files
ls pnpm-workspace.yaml turbo.json nx.json 2>/dev/null
```

**Isolated monorepo (no shared code):**
```bash
railway add --service frontend
# Set rootDirectory: /frontend

railway add --service backend
# Set rootDirectory: /backend
```

**Shared monorepo (workspace tools):**
```bash
railway add --service frontend
# Build: pnpm --filter frontend build
# Watch: /packages/frontend/**, /packages/shared/**

railway add --service backend
# Build: pnpm --filter backend build
```

**See [12-monorepo.md](references/12-monorepo.md) for detailed patterns.**

## Command Reference

### Project Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `railway init -n <name>` | Create new project | Starting fresh |
| `railway link -p <name>` | Link to existing | Joining existing project |
| `railway status --json` | Check current state | Before any operation |
| `railway list --json` | List all projects | Finding project ID |
| `railway unlink` | Remove link | Switching projects |

### Deployment Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `railway up --detach` | Deploy without streaming | Most deployments |
| `railway up --ci` | Deploy with log streaming | Debugging builds |
| `railway up -m "msg"` | Deploy with message | Always recommended |
| `railway redeploy -y` | Redeploy latest | Restarting service |
| `railway restart -y` | Restart container | External changes |
| `railway down -y` | Remove deployment | Taking service offline |

### Service Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `railway add --service <name>` | Create service | Adding to project |
| `railway service link` | Link to service | Switching services |
| `railway service status` | Check service health | Monitoring |
| `railway scale` | Adjust replicas | Scaling workloads |

### Debugging Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `railway logs --lines 100` | View deploy logs | Debugging runtime |
| `railway logs --build --lines 100` | View build logs | Debugging builds |
| `railway logs --latest` | Latest deployment | Failed deploys |
| `railway logs --since 1h` | Recent logs | Time-based debugging |
| `railway ssh` | Access container | Interactive debugging |
| `railway connect` | Database shell | Database access |

## Configuration

### Via CLI

```bash
# Set variable
railway variables set KEY=value

# List variables
railway variables --json

# Add domain
railway domain example.com

# Switch environment
railway environment staging
```

### Via Environment Config (Advanced)

For complex configuration, use the environment staging API. See [06-environments.md](references/06-environments.md) for:
- Complex variable sets
- Build command overrides
- Health check configuration
- Replica count
- Watch paths

## Project Types

### Supported Languages & Frameworks

Railway auto-detects and builds:

| Type | Detected By | Notes |
|------|-------------|-------|
| **Next.js** | `next.config.*` | SSR and static supported |
| **Vite** | `vite.config.*` | Static sites |
| **Express/Fastify** | `package.json` | Node.js APIs |
| **FastAPI** | `main.py` | Python APIs |
| **Django** | `manage.py` | Python web apps |
| **Go** | `go.mod` | Compiled binaries |
| **Rust** | `Cargo.toml` | Compiled binaries |
| **Docker** | `Dockerfile` | Custom containers |
| **Static** | `index.html` | Simple sites |

### Build Configuration

**Default builds work for most projects.** Override when needed:

```json
{
  "services": {
    "my-service": {
      "build": {
        "buildCommand": "npm run build:prod",
        "startCommand": "node dist/server.js"
      }
    }
  }
}
```

**See [06-environments.md](references/06-environments.md) for detailed build configuration.**

## Advanced Features

### Progressive Disclosure

This SKILL.md covers common workflows. Load references for detailed guides:

| # | Feature | Reference | Load When |
|---|---------|-----------|-----------|
| 01 | **Getting Started** | [01-getting-started.md](references/01-getting-started.md) | Installation, auth |
| 02 | **Projects** | [02-projects.md](references/02-projects.md) | Project management |
| 03 | **Services** | [03-services.md](references/03-services.md) | Service operations |
| 04 | **Deployments** | [04-deployments.md](references/04-deployments.md) | Deploy, logs, rollback |
| 05 | **Databases** | [05-databases.md](references/05-databases.md) | Postgres, Redis, MySQL, Mongo |
| 06 | **Environments** | [06-environments.md](references/06-environments.md) | Variables, config, staging |
| 07 | **Domains** | [07-domains.md](references/07-domains.md) | Custom domains & SSL |
| 08 | **Volumes** | [08-volumes.md](references/08-volumes.md) | Persistent storage |
| 09 | **Networking** | [09-networking.md](references/09-networking.md) | Private networking, TCP |
| 10 | **Cron** | [10-cron.md](references/10-cron.md) | Scheduled jobs |
| 11 | **Functions** | [11-functions.md](references/11-functions.md) | Railway Functions |
| 12 | **Monorepo** | [12-monorepo.md](references/12-monorepo.md) | Workspace patterns |
| 13 | **Troubleshooting** | [13-troubleshooting.md](references/13-troubleshooting.md) | Common errors & fixes |
| 14 | **Railway Metal** | [14-railway-metal.md](references/14-railway-metal.md) | Migration guide |

### Databases

Railway provides managed databases via templates:

| Database | Template Code | Connection Variable |
|----------|---------------|-------------------|
| **PostgreSQL** | `postgres` | `DATABASE_URL` |
| **Redis** | `redis` | `REDIS_URL` |
| **MySQL** | `mysql` | `MYSQL_URL` |
| **MongoDB** | `mongodb` | `MONGO_URL` |

**See [05-databases.md](references/05-databases.md) for deployment and wiring patterns.**

### Networking

**Public networking:**
- Automatic HTTPS via Railway domains
- Custom domains with SSL
- No bandwidth limits

**Private networking:**
- Service-to-service communication
- No egress charges
- Uses `RAILWAY_PRIVATE_DOMAIN`

**See networking reference for configuration.**

## Troubleshooting

### Common Issues

**"No project linked"**
```bash
# Solution: Link or initialize
railway link -p project-name
# or
railway init -n new-project
```

**"Build failed"**
```bash
# Check build logs
railway logs --build --lines 100

# Common fixes:
# - Missing dependencies: check package.json/requirements.txt
# - Wrong build command: see railpack reference
# - Out of memory: add NODE_OPTIONS="--max-old-space-size=4096"
```

**"Service crashed"**
```bash
# Check runtime logs
railway logs --lines 100

# Common causes:
# - Port not using $PORT env var
# - Missing start command
# - Runtime dependencies missing
```

**"Database connection refused"**
```bash
# Verify:
# 1. Database service is running
# 2. Using correct DATABASE_URL reference
# 3. Both services in same environment
# 4. Database finished initializing
```

### Error Reference

| Error | Meaning | Solution |
|-------|---------|----------|
| `cli_missing` | Railway CLI not installed | `npm install -g @railway/cli` |
| `not_authenticated` | Not logged in | `railway login` |
| `not_linked` | No project linked | `railway link` or `railway init` |
| `build_failed` | Build error | Check build logs |
| `deploy_failed` | Deploy error | Check service logs |
| `no_service` | Service not found | Check `railway status` |

## Scripts & Utilities

This skill includes shared utilities in `_shared/scripts/`:

### railway-api.sh

GraphQL API helper for advanced operations:

```bash
# Usage
source _shared/scripts/railway-api.sh

# Make API call
railway_api '<query>' '<variables>'

# Get project context
get_project_context

# Fetch environment config
fetch_env_config
```

### railway-common.sh

Common CLI utilities:

```bash
# Usage
source _shared/scripts/railway-common.sh

# Preflight checks
railway_preflight

# Check if linked
check_railway_linked

# Detect project type
detect_project_type

# Detect monorepo type
detect_monorepo_type
```

## Best Practices

### 1. Always Use Commit Messages

```bash
# Good
railway up --detach -m "Fix user authentication bug"

# Bad (no context)
railway up --detach
```

### 2. Check Status Before Operations

```bash
# Always verify context first
railway status --json
```

### 3. Use References for Complex Config

Don't overload SKILL.md - load appropriate reference files for:
- Monorepo setup
- Complex environment configuration
- Database wiring
- Advanced networking

### 4. Progressive Loading

This skill uses progressive disclosure:
- **SKILL.md:** Common workflows (~500 lines)
- **Shared references:** Patterns used across skills
- **Skill-specific refs:** Detailed domain knowledge
- **Scripts:** Executable utilities

### 5. Keep Secrets Encrypted

```bash
# Set encrypted variable
railway variables set SECRET_KEY=value
# Mark as encrypted in dashboard
```

## Resources

- **Documentation:** https://docs.railway.com/api/llms-docs.md
- **Templates:** https://railway.com/llms-templates.md
- **Support:** https://station.railway.com

**Load appropriate references for specific domains rather than reading everything.**
