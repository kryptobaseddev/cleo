# Getting Started

Install Railway CLI and authenticate for first-time setup.

## Installation

### macOS

```bash
brew install railway
```

### Linux / Windows (WSL)

```bash
npm install -g @railway/cli
```

### Verify Installation

```bash
railway --version
# Should be 4.27.0 or higher
```

## Authentication

### Interactive Login

```bash
railway login
```

Opens browser for authentication.

### Browserless Login (SSH/CI)

```bash
railway login --browserless
```

Follow the URL provided and paste the code.

### Token-Based Authentication

For CI/CD pipelines:

```bash
# Project-level token
RAILWAY_TOKEN=xxx railway up

# Account-level token  
RAILWAY_API_TOKEN=xxx railway list
```

Get tokens from Railway dashboard:
1. Project Settings → Tokens
2. Account Settings → API Tokens

## Project Linking

### Create New Project

```bash
railway init -n my-project
```

Options:
- `-n, --name` - Project name
- `-w, --workspace` - Workspace (if multiple)

### Link to Existing Project

```bash
railway link -p project-name
```

Options:
- `-p, --project` - Project name or ID
- `-e, --environment` - Environment (default: production)
- `-s, --service` - Service to link

### Check Current Status

```bash
railway status --json
```

Returns:
```json
{
  "project": {
    "id": "...",
    "name": "my-project"
  },
  "environment": {
    "id": "...",
    "name": "production"
  },
  "service": {
    "id": "...",
    "name": "web"
  }
}
```

## Quick Verification

### Full Check

```bash
# Check CLI
command -v railway

# Check auth
railway whoami

# Check linked project
railway status
```

### Troubleshooting

**"command not found"**
```bash
# Reinstall
npm install -g @railway/cli
```

**"not authenticated"**
```bash
railway login
```

**"no linked project"**
```bash
# Link existing
railway link -p project-name

# Or create new
railway init -n new-project
```

## Next Steps

Once installed and authenticated:
- [02-projects.md](02-projects.md) - Manage projects
- [03-services.md](03-services.md) - Create services
- [04-deployments.md](04-deployments.md) - Deploy code
