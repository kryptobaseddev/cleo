# Deployments

Deploy code, manage releases, and debug issues.

## Deploy Code

### Basic Deploy

```bash
railway up --detach
```

### With Commit Message

```bash
railway up --detach -m "Add user authentication"
```

Always use commit messages for clarity.

### CI Mode (Streaming)

```bash
railway up --ci -m "Deploy with streaming logs"
```

Use for debugging builds. Streams build logs until completion.

### Deploy Specific Service

```bash
railway up --detach --service backend
```

### Deploy to Unlinked Project

```bash
railway up --project <project-id> --environment production --detach
```

## Deployment Lifecycle

### Redeploy

Redeploy latest without new code:

```bash
railway redeploy --service my-service -y
```

Use when:
- Config changed via environment
- External resources updated
- Service needs restart

### Restart

Restart container without rebuild:

```bash
railway restart --service my-service -y
```

Picks up external changes (S3, config maps).

### Remove Deployment

Take down service (keeps service):

```bash
railway down -y
```

## View Logs

### Deployment Logs

```bash
railway logs --lines 100
```

### Build Logs

```bash
railway logs --build --lines 100
```

### Latest Deployment

```bash
railway logs --latest --lines 100
```

For failed/in-progress deployments.

### Filter Logs

```bash
# Errors only
railway logs --lines 50 --filter "@level:error"

# Text search
railway logs --lines 50 --filter "connection refused"

# Time-based
railway logs --since 1h --lines 100
```

### Time Formats

- Relative: `30s`, `5m`, `2h`, `1d`, `1w`
- ISO 8601: `2024-01-15T10:00:00Z`

## List Deployments

```bash
railway deployment list --limit 10 --json
```

Shows:
- Deployment IDs
- Status (SUCCESS, FAILED, DEPLOYING, BUILDING)
- Timestamps

## Deployment Status

| Status | Meaning |
|--------|---------|
| SUCCESS | Deployed and running |
| FAILED | Build or deploy failed |
| DEPLOYING | Currently deploying |
| BUILDING | Build in progress |
| CRASHED | Runtime crash |
| REMOVED | Deployment removed |

## Troubleshooting

### Build Failures

**Symptoms:** Status shows FAILED, CI mode shows errors.

**Common causes:**
- Missing dependencies (package.json, requirements.txt)
- Incorrect build command
- Out of memory
- Dockerfile errors

**Fixes:**
```bash
# Check build logs
railway logs --build --lines 200

# Increase memory
# Set variable: NODE_OPTIONS="--max-old-space-size=4096"

# Fix build command
# See 06-environments.md
```

### Service Crashes

**Symptoms:** Status shows CRASHED, constant restarts.

**Common causes:**
- Port not using $PORT env var
- Missing start command
- Runtime errors

**Fixes:**
```bash
# Check deploy logs
railway logs --lines 200

# Verify PORT usage
# Should listen on process.env.PORT || 8080

# Check start command
# See 06-environments.md
```

### SSH Debugging

```bash
railway ssh
```

Access running container for interactive debugging.

## Rollback

### Via Dashboard

1. Go to service → Deployments
2. Find working deployment
3. Click "Redeploy"

### Via CLI

```bash
# Get deployment ID
railway deployment list --limit 5

# Redeploy specific deployment
railway redeploy --service my-service -y
```

## Next Steps

- [06-environments.md](06-environments.md) - Fix config issues
- [13-troubleshooting.md](13-troubleshooting.md) - Advanced debugging
