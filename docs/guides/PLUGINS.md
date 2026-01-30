# Plugin Architecture

Plugin system architecture and development guide for extending cleo functionality.

---

## Overview

The cleo plugin system enables extensibility through auto-discovered shell scripts. Plugins can add new commands without modifying the core CLI, enabling project-specific workflows and third-party integrations.

### Design Goals

1. **Zero-Dependency Extension**: Plugins are standalone shell scripts - no compilation or installation
2. **Auto-Discovery**: Drop scripts in plugin directories and they're immediately available
3. **Future-Proof Foundation**: Architecture supports evolution toward a robust microservice CLI
4. **Configuration Integration**: Plugins respect and can extend `config.json`
5. **Non-Invasive**: Core commands are never modified by plugins

---

## Plugin Directories

Plugins are discovered from two locations (in order of precedence):

| Directory | Scope | Priority | Use Case |
|-----------|-------|----------|----------|
| `./.cleo/plugins/` | Project | Higher | Project-specific workflows |
| `~/.cleo/plugins/` | Global | Lower | User-wide utilities |

**Precedence Rule**: If the same plugin name exists in both locations, the project-local version is used.

---

## Plugin Structure

### Minimal Plugin

```bash
#!/usr/bin/env bash
# ~/.cleo/plugins/my-command.sh

echo "Hello from my-command!"
```

**Requirements**:
- File must be executable (`chmod +x`)
- File must have `.sh` extension
- Filename becomes the command name (minus `.sh`)

### Plugin with Metadata

```bash
#!/usr/bin/env bash
###PLUGIN
# name: my-command
# description: Does something useful
# version: 1.0.0
# author: Your Name
# requires: jq, curl
###END

# Plugin implementation
echo "My command with metadata"
```

**Metadata Fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Override command name (default: filename) |
| `description` | Yes | Short description shown in `cleo help` |
| `version` | No | Plugin version for tracking |
| `author` | No | Plugin author |
| `requires` | No | Comma-separated external dependencies |

### Plugin with Arguments

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Generate custom report for date range
###END

# Arguments passed after command name
START_DATE="${1:-$(date -d '7 days ago' -Idate)}"
END_DATE="${2:-$(date -Idate)}"

echo "Report: $START_DATE to $END_DATE"

# Access todo.json
TODO_FILE=".cleo/todo.json"
if [[ -f "$TODO_FILE" ]]; then
  jq --arg start "$START_DATE" --arg end "$END_DATE" \
    '.tasks[] | select(.createdAt >= $start and .createdAt <= $end)' \
    "$TODO_FILE"
fi
```

**Usage**: `cleo my-report 2025-12-01 2025-12-10`

---

## Plugin Examples

### Example 1: Daily Standup Report

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Generate daily standup report
# version: 1.0.0
###END

set -euo pipefail

TODO_FILE=".cleo/todo.json"
[[ ! -f "$TODO_FILE" ]] && { echo "No todo.json found"; exit 1; }

echo "# Daily Standup - $(date -Idate)"
echo ""

echo "## Yesterday (Completed)"
jq -r '.tasks[] | select(.status == "done") | "- \(.title)"' "$TODO_FILE" | head -5

echo ""
echo "## Today (Active)"
jq -r '.tasks[] | select(.status == "active") | "- \(.title)"' "$TODO_FILE"

echo ""
echo "## Blockers"
jq -r '.tasks[] | select(.status == "blocked") | "- \(.title): \(.blockedBy)"' "$TODO_FILE"
```

### Example 2: Sprint Dashboard

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Show sprint progress dashboard
# requires: jq
###END

SPRINT_LABEL="${1:-sprint}"
TODO_FILE=".cleo/todo.json"

total=$(jq "[.tasks[] | select(.labels // [] | index(\"$SPRINT_LABEL\"))] | length" "$TODO_FILE")
done=$(jq "[.tasks[] | select(.labels // [] | index(\"$SPRINT_LABEL\")) | select(.status == \"done\")] | length" "$TODO_FILE")
active=$(jq "[.tasks[] | select(.labels // [] | index(\"$SPRINT_LABEL\")) | select(.status == \"active\")] | length" "$TODO_FILE")

echo "Sprint: $SPRINT_LABEL"
echo "Progress: $done/$total tasks done"
echo "Active: $active"
```

### Example 3: Export to External System

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Export tasks to GitHub Issues format
# requires: jq, gh
###END

TODO_FILE=".cleo/todo.json"

jq -r '.tasks[] | select(.status == "pending") |
  "gh issue create --title \"\(.title)\" --body \"\(.description // \"No description\")\" --label \"\(.labels // [] | join(\",\"))\""
' "$TODO_FILE"
```

---

## Plugin Configuration

Plugins can be configured in `config.json`:

```json
{
  "cli": {
    "plugins": {
      "enabled": true,
      "directories": [
        "~/.cleo/plugins",
        "./.cleo/plugins"
      ],
      "autoDiscover": true
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable plugin system |
| `directories` | array | `["~/.cleo/plugins", "./.cleo/plugins"]` | Plugin search paths |
| `autoDiscover` | boolean | `true` | Auto-discover plugins on startup |

---

## Plugin Development Guide

### Accessing Core Functionality

Plugins can source library functions:

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Plugin using core libraries
###END

# Source core libraries
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
source "$CLEO_HOME/lib/logging.sh"
source "$CLEO_HOME/lib/file-ops.sh"

# Use logging functions
log_info "Starting plugin operation..."
log_success "Plugin completed!"
```

### Best Practices

1. **Use `set -euo pipefail`** for error handling
2. **Check for required files** before operations
3. **Provide help with `-h` or `--help`**
4. **Use metadata block** for discoverability
5. **Respect exit codes**: 0 for success, non-zero for errors
6. **Log appropriately** using core logging functions

### Plugin Template

```bash
#!/usr/bin/env bash
###PLUGIN
# description: [Brief description]
# version: 1.0.0
# requires: jq
###END

set -euo pipefail

# Configuration
TODO_FILE=".cleo/todo.json"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Help
if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
  echo "Usage: cleo $(basename "$0" .sh) [OPTIONS]"
  echo ""
  echo "Description here..."
  exit 0
fi

# Check dependencies
[[ ! -f "$TODO_FILE" ]] && { echo "[ERROR] todo.json not found"; exit 1; }

# Main logic
main() {
  # Implementation
  echo "Plugin executed successfully"
}

main "$@"
```

---

## Future Architecture Roadmap

### Phase 1: Current State (v0.6.0)
- Auto-discovery from directories
- Metadata extraction via `###PLUGIN` blocks
- Basic argument passing
- Debug validation

### Phase 2: Enhanced Discovery (Planned)
- Plugin dependency resolution
- Hook registration (pre/post command hooks)
- Plugin update checking
- Conflict detection between plugins

### Phase 3: Plugin API (Future)
- Standardized plugin interface
- Event subscription system
- Inter-plugin communication
- Plugin registry and versioning

### Phase 4: Microservice Foundation (Long-term)
- Plugin isolation via subprocesses
- IPC mechanism for complex plugins
- Remote plugin loading
- Plugin marketplace integration

---

## Debugging Plugins

### Validate Plugin Discovery

```bash
# List discovered plugins
cleo --list-commands

# Debug mode shows plugin paths
cleo --validate
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Plugin not listed | Not executable | `chmod +x plugin.sh` |
| "Plugin not found" | Wrong extension | Ensure `.sh` extension |
| "Permission denied" | Missing execute bit | `chmod +x` |
| No description shown | Missing metadata | Add `###PLUGIN` block |

### Debug Environment Variable

```bash
# Enable verbose plugin output
CLEO_DEBUG=1 cleo my-plugin
```

---

## Security Considerations

1. **Plugin Origin**: Only install plugins from trusted sources
2. **Code Review**: Review plugin code before installation
3. **Permissions**: Plugins run with user permissions
4. **No Automatic Updates**: Plugins don't auto-update (security feature)
5. **Checksums**: Future versions will support plugin checksums

---

## Contributing Plugins

To contribute plugins to the community:

1. Follow the plugin template structure
2. Include comprehensive metadata
3. Add help documentation (`-h` flag)
4. Test with `cleo --validate`
5. Submit to plugin registry (future feature)

---

## Related Documentation

- [Configuration Reference](reference/configuration.md) - CLI configuration options
- [Usage Guide](usage.md) - Command reference
- [Architecture](architecture/ARCHITECTURE.md) - System design

---

*Last updated: v0.6.0*
