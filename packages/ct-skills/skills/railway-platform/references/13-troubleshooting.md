# Troubleshooting

Common issues and their solutions.

## Installation Issues

### "command not found: railway"

**Cause:** CLI not installed or not in PATH.

**Solution:**
```bash
# Install
npm install -g @railway/cli

# Or via Homebrew
brew install railway

# Verify
which railway
```

### "EACCES: permission denied"

**Cause:** npm global permissions issue.

**Solution:**
```bash
# Fix npm permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# Then reinstall
npm install -g @railway/cli
```

## Authentication Issues

### "not authenticated"

**Cause:** Not logged in.

**Solution:**
```bash
railway login

# For SSH/browserless
railway login --browserless
```

### "token expired"

**Cause:** Session expired.

**Solution:**
```bash
railway logout
railway login
```

## Project Issues

### "No linked project"

**Cause:** Current directory not linked to Railway project.

**Solution:**
```bash
# Link to existing
railway link -p project-name

# Or create new
railway init -n new-project

# Check parent directories
# Railway CLI walks up directory tree
```

### "Project not found"

**Cause:** Wrong project name or no access.

**Solution:**
```bash
# List available projects
railway list

# Verify access in Railway dashboard
```

## Deployment Issues

### "Build failed"

**Symptoms:** Deployment status FAILED, CI mode shows errors.

**Common Causes & Fixes:**

**Missing dependencies:**
```bash
# Check package.json, requirements.txt exist
cat package.json | head -20

# Verify lock file
ls package-lock.json yarn.lock pnpm-lock.yaml
```

**Out of memory:**
```bash
# Increase Node memory
railway variables set NODE_OPTIONS="--max-old-space-size=4096"
```

**Wrong build command:**
```bash
# Check build command
railway logs --build --lines 100

# See 06-environments.md to fix
```

### "Service crashed"

**Symptoms:** Status CRASHED, constant restarts.

**Common Causes & Fixes:**

**Port not configured:**
```javascript
// Wrong
app.listen(3000);

// Right
app.listen(process.env.PORT || 3000);
```

**Missing start command:**
```bash
# Verify start command
railway logs --lines 50

# Set in package.json or via config
```

**Runtime error:**
```bash
# Check logs
railway logs --lines 200

# SSH to debug
railway ssh
```

### "No such file or directory"

**Cause:** File path issues in container.

**Fix:**
```bash
# Use absolute paths
const path = require('path');
const file = path.join(__dirname, 'file.txt');

# Or use process.cwd()
const file = path.join(process.cwd(), 'file.txt');
```

## Database Issues

### "connection refused"

**Cause:** Cannot connect to database.

**Check:**
1. Database service running
2. Using correct DATABASE_URL
3. Same environment
4. Database initialized

**Debug:**
```bash
# Test connection
railway connect

# Check database logs
railway logs --service postgres --lines 100
```

### "database does not exist"

**Cause:** Database not initialized.

**Solution:**
```bash
# Wait for database to start
# Or recreate from template
```

## Networking Issues

### "ENOTFOUND api.railway.internal"

**Cause:** Private domain not resolving.

**Check:**
1. Services in same project/environment
2. Target service deployed
3. Using correct domain format

**Debug:**
```bash
# SSH and test
railway ssh
nslookup api.railway.internal
ping api.railway.internal
```

### "Connection timeout"

**Cause:** Service not responding.

**Check:**
1. Service running: `railway service status`
2. Correct port exposed
3. No firewall blocking
4. Health checks passing

## Performance Issues

### Slow response times

**Check:**
```bash
# View metrics
railway metrics --service my-service

# Check CPU/Memory usage
# Look for spikes during requests
```

**Solutions:**
- Increase replicas
- Add caching (Redis)
- Optimize database queries
- Use CDN for static assets

### High memory usage

**Solutions:**
- Check for memory leaks
- Optimize data processing
- Increase memory limit (if on Pro)
- Use streaming for large files

## Debugging Commands

### Full Status Check

```bash
# CLI installed
command -v railway && echo "✓ CLI installed" || echo "✗ CLI missing"

# Authenticated
railway whoami --json && echo "✓ Authenticated" || echo "✗ Not authenticated"

# Project linked
railway status --json && echo "✓ Project linked" || echo "✗ Not linked"

# Service deployed
railway service status --json | jq '.deployment.status'
```

### Log Analysis

```bash
# Recent errors
railway logs --lines 100 --filter "@level:error"

# Specific time range
railway logs --since 1h --until 30m --lines 200

# Build and deploy
railway logs --build --lines 100
railway logs --lines 100
```

### SSH Debugging

```bash
# Access container
railway ssh

# Check environment
env | grep RAILWAY

# Test network
curl http://localhost:$PORT/health

# Check files
ls -la /app
```

## Getting Help

### Railway Support

1. **Central Station:** https://station.railway.com
2. **Discord:** https://discord.gg/railway
3. **Documentation:** https://docs.railway.com

### Information to Provide

When asking for help, include:
- Project ID
- Service name
- Error messages
- Recent changes
- Deployment ID (if specific)

### Debug Bundle

```bash
# Collect debug info
{
  echo "=== Status ==="
  railway status --json
  
  echo "=== Recent Deployments ==="
  railway deployment list --limit 5 --json
  
  echo "=== Recent Logs ==="
  railway logs --lines 50
} > debug.txt
```
