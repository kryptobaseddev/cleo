# SkillsMP Integration Guide

**Version**: 1.0.0
**Status**: Active
**Last Updated**: 2026-01-27

This guide covers integration with SkillsMP (agentskills.in), a marketplace for discovering and installing agent skills for CLEO's multi-agent architecture.

---

## Overview

### What is SkillsMP?

SkillsMP (Skills Marketplace) is a community-driven platform at [agentskills.in](https://www.agentskills.in) that provides:

- **Skill Discovery** - Search and browse community-created agent skills
- **Version Management** - Track skill versions and updates
- **GitHub Integration** - Skills hosted on GitHub for transparency
- **Metadata Standards** - Standardized skill information and ratings

### What is agentskills.in?

[agentskills.in](https://www.agentskills.in) is the web interface for SkillsMP, offering:

- Browse skills by category and tags
- View skill ratings and popularity
- Search by functionality or keywords
- Access GitHub repositories directly

### CLEO Integration

CLEO integrates with SkillsMP through:

1. **Search API** - Query skills from CLI
2. **Metadata API** - Retrieve skill details
3. **Content Fetching** - Download skills from GitHub
4. **Local Caching** - Cache results for performance
5. **Automatic Installation** - Install skills directly to CLEO

---

## Configuration

### Initial Setup

SkillsMP integration is **opt-in**. To enable:

1. **Create configuration file** at `.cleo/skillsmp.json`:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/skillsmp.schema.json",
  "_meta": {
    "schemaVersion": "1.0.0"
  },
  "enabled": true,
  "api": {
    "endpoint": "https://www.agentskills.in/api/skills",
    "version": "v1",
    "timeout": 30,
    "retries": 3,
    "retryDelay": 1000
  },
  "cache": {
    "enabled": true,
    "directory": ".cleo/.cache/skillsmp",
    "ttl": 3600,
    "maxSize": 100
  },
  "install": {
    "defaultLocation": "project",
    "projectDir": "./skills",
    "globalDir": "~/.cleo/skills",
    "updateManifest": true,
    "verifyChecksum": true
  },
  "validation": {
    "strictMode": false,
    "checkDependencies": true,
    "checkVersion": true,
    "minVersion": "1.0.0"
  },
  "logging": {
    "enabled": true,
    "level": "info",
    "file": ".cleo/skillsmp.log"
  }
}
```

2. **Verify configuration**:

```bash
# Check if SkillsMP is enabled
jq '.enabled' .cleo/skillsmp.json

# Validate JSON structure
jq empty .cleo/skillsmp.json && echo "Valid JSON"
```

### Configuration Sections

#### API Settings

Controls API connection behavior:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `endpoint` | string | `https://www.agentskills.in/api/skills` | API base URL |
| `version` | enum | `v1` | API version (`v1`, `v2`) |
| `timeout` | integer | `30` | Request timeout (seconds, 1-300) |
| `retries` | integer | `3` | Retry attempts on failure (0-5) |
| `retryDelay` | integer | `1000` | Initial retry delay (ms, exponential backoff) |

**Override endpoint via environment variable**:

```bash
export SKILLSMP_ENDPOINT="https://custom-api.example.com/skills"
```

#### Cache Settings

Optimizes performance and reduces API calls:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable response caching |
| `directory` | string | `.cleo/.cache/skillsmp` | Cache directory path |
| `ttl` | integer | `3600` | Cache TTL (seconds, 60-86400) |
| `maxSize` | integer | `100` | Max cached entries before eviction |

**Cache behavior**:
- **Search results**: 5 minutes TTL
- **Skill content**: 1 hour TTL
- **Cache invalidation**: Automatic on TTL expiry

#### Installation Settings

Controls where and how skills are installed:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultLocation` | enum | `project` | Install target (`project`, `global`) |
| `projectDir` | string | `./skills` | Project skills directory |
| `globalDir` | string | `~/.cleo/skills` | Global skills directory |
| `updateManifest` | boolean | `true` | Auto-update `skills/manifest.json` |
| `verifyChecksum` | boolean | `true` | Verify package checksums |

**Installation locations**:
- **Project** (`project`): Skills installed to `./skills/` (project-specific)
- **Global** (`global`): Skills installed to `~/.cleo/skills/` (available to all projects)

#### Validation Settings

Controls skill validation during installation:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strictMode` | boolean | `false` | Treat warnings as errors |
| `checkDependencies` | boolean | `true` | Validate skill dependencies exist |
| `checkVersion` | boolean | `true` | Validate CLEO version compatibility |
| `minVersion` | string | `1.0.0` | Minimum required API version |

#### Logging Settings

Controls operation logging:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable logging |
| `level` | enum | `info` | Log level (`error`, `warn`, `info`, `debug`) |
| `file` | string | `.cleo/skillsmp.log` | Log file path |

---

## Searching Skills

### Basic Search

Search skills by query string:

```bash
# Search for skills
cleo skills search --source skillsmp "bash automation"

# Search with limit
cleo skills search --source skillsmp "testing" --limit 20

# Sort by popularity
cleo skills search --source skillsmp "documentation" --sort stars
```

### Search Parameters

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--source` | string | `local` | Skill source (`local`, `skillsmp`) |
| `--limit` | integer | `10` | Max results (1-100) |
| `--sort` | enum | `stars` | Sort method (`stars`, `recent`, `name`) |

### Search Output

Results are returned as JSON:

```json
{
  "skills": [
    {
      "name": "ct-research-agent",
      "author": "cleo-official",
      "description": "Research and investigation agent for gathering information",
      "tags": ["research", "investigation", "discovery"],
      "stars": 150,
      "version": "1.2.0",
      "repoFullName": "cleo-official/skills",
      "path": "ct-research-agent/SKILL.md",
      "lastUpdated": "2026-01-20T10:30:00Z"
    }
  ],
  "totalResults": 42,
  "page": 1,
  "limit": 10
}
```

### Filter Results with jq

```bash
# Get skill names only
cleo skills search --source skillsmp "testing" | jq -r '.skills[].name'

# Filter by tag
cleo skills search --source skillsmp "agent" | jq '.skills[] | select(.tags[] | contains("research"))'

# Sort by stars (client-side)
cleo skills search --source skillsmp "bash" | jq '.skills | sort_by(.stars) | reverse'
```

---

## Installing Skills

### Installation Methods

#### Install by Scoped Name

```bash
# Install skill from SkillsMP
cleo skills install --source skillsmp "@cleo-official/ct-research-agent"

# Install to specific location
cleo skills install --source skillsmp "@author/skill-name" --location global

# Install without prompt (non-interactive)
cleo skills install --source skillsmp "@author/skill" --yes
```

#### Install by Search

```bash
# Search and install first result
SKILL=$(cleo skills search --source skillsmp "bash testing" | jq -r '.skills[0].name')
cleo skills install --source skillsmp "@author/$SKILL"
```

### Installation Process

When you install a skill:

1. **Metadata Fetch** - Retrieve skill details from SkillsMP API
2. **Dependency Check** - Validate required dependencies (if `checkDependencies: true`)
3. **Version Check** - Verify CLEO compatibility (if `checkVersion: true`)
4. **Download** - Fetch `SKILL.md` from GitHub repository
5. **Validation** - Verify content and checksums (if `verifyChecksum: true`)
6. **Installation** - Write to `skills/{skill-name}/SKILL.md`
7. **Metadata** - Create `skills/{skill-name}/metadata.json`
8. **Manifest Update** - Update `skills/manifest.json` (if `updateManifest: true`)

### Installation Locations

| Location | Directory | Use Case |
|----------|-----------|----------|
| `project` | `./skills/` | Project-specific skills |
| `global` | `~/.cleo/skills/` | Shared across all projects |

**Set default location** in `skillsmp.json`:

```json
{
  "install": {
    "defaultLocation": "project"
  }
}
```

**Override per-installation**:

```bash
# Install to global directory
cleo skills install --source skillsmp "@author/skill" --location global

# Install to project directory
cleo skills install --source skillsmp "@author/skill" --location project
```

### Post-Installation

After installation:

1. **Verify skill file**:
   ```bash
   ls -la skills/ct-research-agent/SKILL.md
   cat skills/ct-research-agent/SKILL.md
   ```

2. **Check metadata**:
   ```bash
   cat skills/ct-research-agent/metadata.json | jq .
   ```

3. **Verify manifest update**:
   ```bash
   jq '.skills[] | select(.name == "ct-research-agent")' skills/manifest.json
   ```

4. **Test skill invocation**:
   ```bash
   # Create test task
   cleo add "Test research skill" --type research

   # Invoke skill (via orchestrator or directly)
   # Skill will be auto-selected based on task type
   ```

---

## Troubleshooting

### Common Issues

#### API Connection Errors

**Symptom**: `ERROR: Network request failed`

**Causes**:
- No internet connection
- API endpoint unreachable
- Firewall blocking requests
- API timeout

**Solutions**:

```bash
# Test connectivity
curl -I https://www.agentskills.in/api/skills

# Increase timeout in config
jq '.api.timeout = 60' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json

# Override endpoint
export SKILLSMP_ENDPOINT="https://backup-api.example.com"
```

#### Invalid JSON Response

**Symptom**: `ERROR: Invalid JSON response from API`

**Causes**:
- API returning HTML error page
- Network proxy injecting content
- API version mismatch

**Solutions**:

```bash
# Check raw response
curl -sL "https://www.agentskills.in/api/skills?search=test"

# Verify API version
jq '.api.version' .cleo/skillsmp.json

# Clear cache
rm -rf .cleo/.cache/skillsmp/*
```

#### Skill Not Found

**Symptom**: `ERROR: Skill not found: @author/skill-name`

**Causes**:
- Incorrect scoped name format
- Skill removed from marketplace
- Author name typo

**Solutions**:

```bash
# Search for skill first
cleo skills search --source skillsmp "partial-name"

# Verify scoped name format (must be @author/name)
echo "@cleo-official/ct-research-agent"  # Correct
echo "ct-research-agent"                  # Wrong (missing @author)

# Browse marketplace directly
open https://www.agentskills.in
```

#### Download Failed

**Symptom**: `ERROR: Failed to download skill from GitHub`

**Causes**:
- GitHub repository deleted or moved
- Network issues
- Rate limiting
- Private repository

**Solutions**:

```bash
# Test direct download
curl -sL "https://raw.githubusercontent.com/author/repo/main/path/SKILL.md"

# Check GitHub status
open https://www.githubstatus.com

# Increase retry attempts
jq '.api.retries = 5' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json

# Retry with exponential backoff
jq '.api.retryDelay = 2000' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json
```

#### Permission Denied

**Symptom**: Permission errors during installation

**Causes**:
- Write permission denied to skills directory
- Attempting to install to system directory

**Solutions**:

```bash
# Check directory permissions
ls -ld ./skills
ls -ld ~/.cleo/skills

# Fix permissions
chmod u+w ./skills
mkdir -p ~/.cleo/skills && chmod u+w ~/.cleo/skills

# Install to alternate location
cleo skills install --source skillsmp "@author/skill" --location project
```

#### Cache Issues

**Symptom**: Stale search results or outdated skill content

**Solutions**:

```bash
# Clear cache manually
rm -rf .cleo/.cache/skillsmp/*
rm -rf ~/.cleo/.skills-cache/*

# Disable caching temporarily
jq '.cache.enabled = false' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json

# Reduce TTL for fresher results
jq '.cache.ttl = 300' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json
```

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging in config
jq '.logging.level = "debug"' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json

# View logs
tail -f .cleo/skillsmp.log

# Filter for errors
grep ERROR .cleo/skillsmp.log

# Filter for specific skill
grep "@author/skill-name" .cleo/skillsmp.log
```

### Configuration Validation

Verify configuration file validity:

```bash
# Validate JSON syntax
jq empty .cleo/skillsmp.json && echo "✓ Valid JSON"

# Check required fields
jq '.enabled, ._meta.schemaVersion' .cleo/skillsmp.json

# Verify schema compliance
# (requires schema validation tool or manual inspection)
jq '."$schema"' .cleo/skillsmp.json
```

---

## Security

### API Key Handling

**IMPORTANT**: SkillsMP currently does **NOT** require API keys. If future versions implement authentication:

#### Environment Variable Method (Recommended)

```bash
# Set environment variable
export SKILLSMP_API_KEY="your-api-key-here"

# Configure key variable name in skillsmp.json
jq '.auth.envVar = "SKILLSMP_API_KEY"' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json
```

#### Key File Method (Alternative)

```bash
# Create key file (outside version control)
echo "your-api-key-here" > .cleo/.skillsmp-key
chmod 600 .cleo/.skillsmp-key

# Configure key file path
jq '.auth.keyFile = ".cleo/.skillsmp-key"' .cleo/skillsmp.json > tmp.json && mv tmp.json .cleo/skillsmp.json

# Add to .gitignore
echo ".cleo/.skillsmp-key" >> .gitignore
```

### Critical Security Rules

#### MUST NOT Hardcode Keys

**❌ NEVER do this**:

```json
{
  "auth": {
    "apiKey": "sk-1234567890abcdef"
  }
}
```

**Why**: API keys in config files can be:
- Accidentally committed to version control
- Exposed in logs or error messages
- Visible in process listings
- Shared unintentionally

#### MUST Use Environment Variables or Key Files

**✅ Correct approach**:

```json
{
  "auth": {
    "envVar": "SKILLSMP_API_KEY"
  }
}
```

Or:

```json
{
  "auth": {
    "keyFile": ".cleo/.skillsmp-key"
  }
}
```

### Version Control Best Practices

#### .gitignore Configuration

Always exclude sensitive files:

```bash
# Add to .gitignore
cat >> .gitignore << 'EOF'
# SkillsMP credentials
.cleo/.skillsmp-key
.cleo/skillsmp.log

# SkillsMP cache
.cleo/.cache/skillsmp/
EOF
```

#### Configuration Sharing

When sharing `skillsmp.json`:

```json
{
  "auth": {
    "envVar": "SKILLSMP_API_KEY",
    "keyFile": ".cleo/.skillsmp-key"
  }
}
```

**Do NOT include** actual keys. Team members should:
1. Copy config template
2. Set their own `SKILLSMP_API_KEY` environment variable
3. Create their own `.cleo/.skillsmp-key` file

### Skill Verification

Verify downloaded skills before use:

```bash
# Check skill source repository
jq '.repoFullName' skills/ct-skill-name/metadata.json

# Inspect SKILL.md content
less skills/ct-skill-name/SKILL.md

# Verify no suspicious commands
grep -E "(curl|wget|bash|eval)" skills/ct-skill-name/SKILL.md
```

**Enable checksum verification** (recommended):

```json
{
  "install": {
    "verifyChecksum": true
  }
}
```

### Network Security

#### Use HTTPS

Always use HTTPS endpoints:

```json
{
  "api": {
    "endpoint": "https://www.agentskills.in/api/skills"
  }
}
```

**❌ NEVER use HTTP**:

```json
{
  "api": {
    "endpoint": "http://www.agentskills.in/api/skills"
  }
}
```

#### Timeout Protection

Set reasonable timeouts to prevent hanging:

```json
{
  "api": {
    "timeout": 30,
    "retries": 3,
    "retryDelay": 1000
  }
}
```

---

## Related Documentation

- **Skill Development**: [docs/guides/skill-development.md](skill-development.md)
- **Skills Architecture**: [docs/architecture/CLEO-SUBAGENT.md](../architecture/CLEO-SUBAGENT.md)
- **Orchestrator Protocol**: [docs/guides/ORCHESTRATOR-PROTOCOL.md](ORCHESTRATOR-PROTOCOL.md)
- **Configuration Schema**: [schemas/skillsmp.schema.json](../../schemas/skillsmp.schema.json)

---

## FAQ

### Q: Do I need an API key for SkillsMP?

**A**: Currently, no. SkillsMP API is public and does not require authentication. The `auth` configuration section is reserved for future use.

### Q: Can I use SkillsMP with private skill repositories?

**A**: Not directly. SkillsMP indexes public GitHub repositories only. For private skills, use local installation or host your own skill registry.

### Q: How often is the SkillsMP index updated?

**A**: The marketplace index updates periodically based on GitHub repository changes. Use `--sort recent` to find newly added skills.

### Q: Can I contribute skills to SkillsMP?

**A**: Yes! Visit [agentskills.in](https://www.agentskills.in) for submission guidelines. Skills must:
- Be hosted on public GitHub repository
- Follow CLEO skill structure (`SKILL.md` with YAML frontmatter)
- Include proper metadata and documentation

### Q: What happens if a skill is removed from SkillsMP?

**A**: Installed skills remain in your `skills/` directory. You'll need to manually remove them if desired. Future updates won't be available.

### Q: Can I use SkillsMP offline?

**A**: Partially. Cached search results and skill content remain available. New searches and downloads require internet connectivity.

### Q: How do I update an installed skill?

**A**: Re-run installation command with `--yes` flag to overwrite existing skill:

```bash
cleo skills install --source skillsmp "@author/skill-name" --yes
```

Cache will automatically fetch the latest version after TTL expiry.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-27 | Initial release |
