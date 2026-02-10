#!/usr/bin/env bash
# Generate remaining JSON schemas (validate, release, system domains)
# @task T2925

set -euo pipefail

SCHEMA_DIR="/mnt/projects/claude-todo/mcp-server/schemas"

# Validate domain schemas (9 query + 2 mutate)
cat > "$SCHEMA_DIR/requests/validate/schema.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.schema request",
  "description": "JSON Schema validation",
  "type": "object",
  "properties": {
    "fileType": {
      "type": "string",
      "enum": ["todo", "config", "archive", "log", "manifest"],
      "description": "File type to validate"
    },
    "filePath": {
      "type": "string",
      "description": "Optional file path (default: .cleo/<type>.json)"
    }
  },
  "required": ["fileType"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/protocol.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.protocol request",
  "description": "Protocol compliance",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "protocolType": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "contribution", "release", "validation", "testing"],
      "description": "Protocol type"
    }
  },
  "required": ["taskId", "protocolType"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/task.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.task request",
  "description": "Anti-hallucination check",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "checkMode": {
      "type": "string",
      "enum": ["basic", "full"],
      "default": "basic",
      "description": "Check depth"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/manifest.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.manifest request",
  "description": "Manifest entry check",
  "type": "object",
  "properties": {
    "entry": {
      "type": "object",
      "description": "Manifest entry object to validate",
      "additionalProperties": true
    },
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID to validate manifest for"
    }
  },
  "oneOf": [
    {"required": ["entry"]},
    {"required": ["taskId"]}
  ],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/output.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.output request",
  "description": "Output file validation",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "filePath": {
      "type": "string",
      "description": "Output file path"
    }
  },
  "required": ["taskId", "filePath"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/compliance.summary.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.compliance.summary request",
  "description": "Aggregated compliance",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "Scope filter (epic ID or all)"
    },
    "since": {
      "type": "string",
      "format": "date",
      "description": "Include entries since date"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/compliance.violations.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.compliance.violations request",
  "description": "List violations",
  "type": "object",
  "properties": {
    "severity": {
      "type": "string",
      "enum": ["error", "warning", "info"],
      "description": "Filter by severity"
    },
    "protocol": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "contribution", "release", "validation", "testing"],
      "description": "Filter by protocol"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/test.status.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.test.status request",
  "description": "Test suite status",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID (default: all)"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/test.coverage.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.test.coverage request",
  "description": "Coverage metrics",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID (default: all)"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/compliance.record.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.compliance.record request",
  "description": "Record compliance check",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "result": {
      "type": "object",
      "description": "Compliance result object",
      "additionalProperties": true
    }
  },
  "required": ["taskId", "result"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/validate/test.run.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "validate.test.run request",
  "description": "Execute test suite",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "Test scope (unit, integration, all)"
    },
    "pattern": {
      "type": "string",
      "description": "Test file pattern"
    },
    "parallel": {
      "type": "boolean",
      "default": false,
      "description": "Run in parallel"
    }
  },
  "additionalProperties": false
}
EOF

# Release domain schemas (7 mutations)
cat > "$SCHEMA_DIR/requests/release/prepare.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.prepare request",
  "description": "Prepare release",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version (semver)"
    },
    "type": {
      "type": "string",
      "enum": ["major", "minor", "patch"],
      "description": "Release type"
    }
  },
  "required": ["version", "type"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/changelog.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.changelog request",
  "description": "Generate changelog",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version"
    },
    "sections": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["features", "fixes", "breaking", "docs", "chore"]
      },
      "description": "Changelog sections to include"
    }
  },
  "required": ["version"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/commit.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.commit request",
  "description": "Create release commit",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version"
    },
    "files": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Files to include (default: VERSION, CHANGELOG.md, README.md)"
    }
  },
  "required": ["version"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/tag.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.tag request",
  "description": "Create git tag",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version"
    },
    "message": {
      "type": "string",
      "description": "Tag message (default: version number)"
    }
  },
  "required": ["version"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/push.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.push request",
  "description": "Push to remote",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version"
    },
    "remote": {
      "type": "string",
      "default": "origin",
      "description": "Remote name"
    }
  },
  "required": ["version"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/gates.run.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.gates.run request",
  "description": "Run release gates",
  "type": "object",
  "properties": {
    "gates": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["tests", "lint", "security", "docs"]
      },
      "description": "Gates to run (default: all)"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/release/rollback.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "release.rollback request",
  "description": "Rollback release",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Version to rollback"
    },
    "reason": {
      "type": "string",
      "minLength": 20,
      "description": "Rollback reason"
    }
  },
  "required": ["version", "reason"],
  "additionalProperties": false
}
EOF

# System domain schemas (5 query + 7 mutate)
cat > "$SCHEMA_DIR/requests/system/version.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.version request",
  "description": "CLEO version",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/doctor.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.doctor request",
  "description": "Health check",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/config.get.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.config.get request",
  "description": "Get config value",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "description": "Config key path (dot-separated)"
    }
  },
  "required": ["key"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/stats.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.stats request",
  "description": "Project statistics",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/context.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.context request",
  "description": "Context window info",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/init.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.init request",
  "description": "Initialize CLEO",
  "type": "object",
  "properties": {
    "projectType": {
      "type": "string",
      "description": "Project type (bash, python, node, etc.)"
    },
    "detect": {
      "type": "boolean",
      "default": true,
      "description": "Auto-detect project type"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/config.set.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.config.set request",
  "description": "Set config value",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "description": "Config key path (dot-separated)"
    },
    "value": {
      "description": "Config value (any type)",
      "oneOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "boolean"},
        {"type": "object"},
        {"type": "array"}
      ]
    }
  },
  "required": ["key", "value"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/backup.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.backup request",
  "description": "Create backup",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": ["snapshot", "safety", "archive", "migration"],
      "default": "snapshot",
      "description": "Backup type"
    },
    "note": {
      "type": "string",
      "description": "Backup note"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/restore.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.restore request",
  "description": "Restore from backup",
  "type": "object",
  "properties": {
    "backupId": {
      "type": "string",
      "description": "Backup ID to restore"
    }
  },
  "required": ["backupId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/migrate.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.migrate request",
  "description": "Run migrations",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Target version (default: latest)"
    },
    "dryRun": {
      "type": "boolean",
      "default": false,
      "description": "Preview migrations without applying"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/sync.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.sync request",
  "description": "Sync with TodoWrite",
  "type": "object",
  "properties": {
    "direction": {
      "type": "string",
      "enum": ["import", "export", "bidirectional"],
      "default": "import",
      "description": "Sync direction"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/system/cleanup.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "system.cleanup request",
  "description": "Cleanup stale data",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": ["sessions", "backups", "logs", "all"],
      "description": "Cleanup type"
    },
    "olderThan": {
      "type": "string",
      "format": "date",
      "description": "Remove data older than date"
    }
  },
  "required": ["type"],
  "additionalProperties": false
}
EOF

echo "✓ Generated all remaining request schemas (validate, release, system)"
