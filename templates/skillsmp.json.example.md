# SkillsMP Configuration Reference

**File**: `~/.cleo/skillsmp.json` (global) or `./.cleo/skillsmp.json` (project)

Configuration file for the SkillsMP (Skills Marketplace) integration in CLEO.

---

## Configuration Fields

### Core Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `$schema` | string | (see example) | JSON Schema reference for validation |
| `endpoint` | string | `https://www.agentskills.in/api` | SkillsMP API endpoint URL |
| `apiKey` | string | `""` | API key for authenticated requests (optional for public skills) |
| `defaultInstallLocation` | enum | `"project"` | Default install location: `"project"` or `"global"` |
| `timeout` | number | `30` | Request timeout in seconds |
| `retries` | number | `3` | Number of retry attempts for failed requests |

### Cache Settings

Controls local caching of API responses to reduce network calls.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cache.enabled` | boolean | `true` | Enable response caching |
| `cache.searchTtlMinutes` | number | `5` | Cache duration for search results (minutes) |
| `cache.contentTtlMinutes` | number | `60` | Cache duration for skill content (minutes) |

### Validation Settings

Controls skill validation and verification during installation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `validation.checkSchemaVersion` | boolean | `true` | Verify skill schema version compatibility |
| `validation.requireSignature` | boolean | `false` | Require cryptographic signature on skills |
| `validation.allowedPublishers` | array | `[]` | Whitelist of trusted publishers (empty = allow all) |

### Security Settings

Sandbox and execution safety controls.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `security.sandboxMode` | boolean | `true` | Run skill validation in sandbox |
| `security.restrictedCommands` | array | (see example) | Blocked shell commands in skill content |
| `security.maxFileSize` | number | `10485760` | Max skill file size in bytes (10MB default) |

### Logging Settings

Controls diagnostic output and audit trails.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logging.level` | enum | `"info"` | Log level: `"debug"`, `"info"`, `"warn"`, `"error"` |
| `logging.logInstalls` | boolean | `true` | Log skill installation events |
| `logging.logSearches` | boolean | `false` | Log search queries (verbose) |

---

## API Key Handling

### Security Notes

⚠️ **CRITICAL**: Never commit API keys to version control.

**Recommended practices**:
1. Use environment variable: `SKILLSMP_API_KEY`
2. Store in global config: `~/.cleo/skillsmp.json`
3. Add `.cleo/skillsmp.json` to `.gitignore`
4. Use project config only for public/read-only access

### Priority Order

API key resolution order (first found wins):
1. Environment variable: `$SKILLSMP_API_KEY`
2. Project config: `./.cleo/skillsmp.json`
3. Global config: `~/.cleo/skillsmp.json`
4. No key (public access only)

### Example: Environment Variable Setup

```bash
# Add to ~/.bashrc or ~/.zshrc
export SKILLSMP_API_KEY="your-api-key-here"

# Or set per-command
SKILLSMP_API_KEY="key" cleo skill search "terraform"
```

---

## Installation

### Global Configuration (Recommended)

```bash
# Copy example to global location
cp templates/skillsmp.json.example ~/.cleo/skillsmp.json

# Edit with your API key
nano ~/.cleo/skillsmp.json
```

### Project Configuration

```bash
# Copy example to project location
cp templates/skillsmp.json.example ./.cleo/skillsmp.json

# Add to .gitignore
echo ".cleo/skillsmp.json" >> .gitignore
```

---

## Validation

Verify configuration syntax:

```bash
# Check if config is valid JSON
jq empty ~/.cleo/skillsmp.json

# Validate against schema (if ajv-cli installed)
ajv validate -s schemas/skillsmp.schema.json -d ~/.cleo/skillsmp.json
```

---

## Examples

### Minimal Configuration (Public Access)

```json
{
  "endpoint": "https://www.agentskills.in/api"
}
```

### Development Configuration (Verbose Logging)

```json
{
  "endpoint": "https://www.agentskills.in/api",
  "cache": {
    "enabled": false
  },
  "logging": {
    "level": "debug",
    "logSearches": true
  }
}
```

### Enterprise Configuration (Strict Security)

```json
{
  "endpoint": "https://skills.enterprise.internal/api",
  "apiKey": "${SKILLSMP_API_KEY}",
  "defaultInstallLocation": "project",
  "validation": {
    "requireSignature": true,
    "allowedPublishers": ["verified-publisher-1", "verified-publisher-2"]
  },
  "security": {
    "sandboxMode": true,
    "maxFileSize": 5242880
  }
}
```

---

## Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| `Connection timeout` | Increase `timeout` value or check network |
| `API key invalid` | Verify key in config or environment variable |
| `Skill validation failed` | Check `validation.checkSchemaVersion` or disable strict mode |
| `Cache stale` | Lower TTL values or disable cache |

### Debug Mode

Enable verbose logging:

```bash
# Temporary debug
cleo skill search "query" --debug

# Persistent debug
cleo config set skillsmp.logging.level debug
```

---

## See Also

- **Full Documentation**: `docs/commands/skill.md`
- **Schema Definition**: `schemas/skillsmp.schema.json`
- **CLI Reference**: `cleo skill --help`
- **SkillsMP API Docs**: https://www.agentskills.in/docs

---

**Version**: 1.0.0
**Last Updated**: 2026-01-27
