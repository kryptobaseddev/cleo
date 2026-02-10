#!/usr/bin/env bash
# Generate JSON schemas for all remaining MCP operations
# @task T2925

set -euo pipefail

SCHEMA_DIR="/mnt/projects/claude-todo/mcp-server/schemas"

# Session domain schemas
cat > "$SCHEMA_DIR/requests/session/status.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.status request",
  "description": "Current session status",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/list.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.list request",
  "description": "List all sessions",
  "type": "object",
  "properties": {
    "active": {
      "type": "boolean",
      "description": "Filter active sessions only"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/show.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.show request",
  "description": "Session details",
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Session ID"
    }
  },
  "required": ["sessionId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/focus.get.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.focus.get request",
  "description": "Get focused task",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/history.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.history request",
  "description": "Session history",
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20,
      "description": "Maximum entries"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/start.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.start request",
  "description": "Start new session",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "Session scope (e.g., epic:T001)"
    },
    "name": {
      "type": "string",
      "description": "Session name"
    },
    "autoFocus": {
      "type": "boolean",
      "default": false,
      "description": "Auto-set focus"
    }
  },
  "required": ["scope"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/end.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.end request",
  "description": "End current session",
  "type": "object",
  "properties": {
    "notes": {
      "type": "string",
      "description": "Session notes"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/resume.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.resume request",
  "description": "Resume existing session",
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Session ID to resume"
    }
  },
  "required": ["sessionId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/suspend.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.suspend request",
  "description": "Suspend session",
  "type": "object",
  "properties": {
    "notes": {
      "type": "string",
      "description": "Suspend notes"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/focus.set.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.focus.set request",
  "description": "Set focused task",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID to focus"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/focus.clear.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.focus.clear request",
  "description": "Clear focus",
  "type": "object",
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/session/gc.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "session.gc request",
  "description": "Garbage collect sessions",
  "type": "object",
  "properties": {
    "olderThan": {
      "type": "string",
      "format": "date",
      "description": "Remove sessions older than date"
    }
  },
  "additionalProperties": false
}
EOF

# Orchestrate domain schemas
cat > "$SCHEMA_DIR/requests/orchestrate/status.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.status request",
  "description": "Orchestrator status",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/next.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.next request",
  "description": "Next task to spawn",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/ready.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.ready request",
  "description": "Parallel-safe tasks",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/analyze.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.analyze request",
  "description": "Dependency analysis",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/context.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.context request",
  "description": "Context usage check",
  "type": "object",
  "properties": {
    "tokens": {
      "type": "integer",
      "description": "Current token count for budget check"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/waves.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.waves request",
  "description": "Wave computation",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/skill.list.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.skill.list request",
  "description": "Available skills",
  "type": "object",
  "properties": {
    "filter": {
      "type": "string",
      "description": "Filter by skill name or tag"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/startup.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.startup request",
  "description": "Initialize orchestration",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    }
  },
  "required": ["epicId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/spawn.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.spawn request",
  "description": "Generate spawn prompt",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID to spawn"
    },
    "skill": {
      "type": "string",
      "description": "Skill name (optional, auto-detected if omitted)"
    },
    "model": {
      "type": "string",
      "enum": ["sonnet", "opus", "haiku"],
      "default": "sonnet",
      "description": "Model preference"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/validate.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.validate request",
  "description": "Validate spawn readiness",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/parallel.start.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.parallel.start request",
  "description": "Start parallel wave",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    },
    "wave": {
      "type": "integer",
      "minimum": 0,
      "description": "Wave number"
    }
  },
  "required": ["epicId", "wave"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/orchestrate/parallel.end.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "orchestrate.parallel.end request",
  "description": "End parallel wave",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID"
    },
    "wave": {
      "type": "integer",
      "minimum": 0,
      "description": "Wave number"
    }
  },
  "required": ["epicId", "wave"],
  "additionalProperties": false
}
EOF

# Research domain schemas
cat > "$SCHEMA_DIR/requests/research/show.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.show request",
  "description": "Research entry details",
  "type": "object",
  "properties": {
    "researchId": {
      "type": "string",
      "description": "Research entry ID"
    }
  },
  "required": ["researchId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/list.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.list request",
  "description": "List research entries",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Filter by epic"
    },
    "status": {
      "type": "string",
      "enum": ["complete", "partial", "blocked"],
      "description": "Filter by status"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/query.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.query request",
  "description": "Search research",
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "Search query"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Minimum confidence score"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/pending.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.pending request",
  "description": "Pending research",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Filter by epic"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/stats.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.stats request",
  "description": "Research statistics",
  "type": "object",
  "properties": {
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Filter by epic"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/manifest.read.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.manifest.read request",
  "description": "Read manifest entries",
  "type": "object",
  "properties": {
    "filter": {
      "type": "object",
      "description": "Filter criteria",
      "additionalProperties": true
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 100,
      "description": "Maximum entries"
    }
  },
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/inject.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.inject request",
  "description": "Get protocol injection",
  "type": "object",
  "properties": {
    "protocolType": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "contribution", "release", "validation", "testing"],
      "description": "Protocol type"
    },
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID (for context resolution)"
    },
    "variant": {
      "type": "string",
      "description": "Protocol variant"
    }
  },
  "required": ["protocolType"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/link.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.link request",
  "description": "Link research to task",
  "type": "object",
  "properties": {
    "researchId": {
      "type": "string",
      "description": "Research entry ID"
    },
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "relationship": {
      "type": "string",
      "enum": ["informs", "blocks", "supports"],
      "default": "informs",
      "description": "Relationship type"
    }
  },
  "required": ["researchId", "taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/manifest.append.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.manifest.append request",
  "description": "Append manifest entry",
  "type": "object",
  "properties": {
    "entry": {
      "type": "object",
      "description": "Manifest entry object",
      "additionalProperties": true
    },
    "validateFile": {
      "type": "boolean",
      "default": true,
      "description": "Validate file exists"
    }
  },
  "required": ["entry"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/research/manifest.archive.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "research.manifest.archive request",
  "description": "Archive old entries",
  "type": "object",
  "properties": {
    "beforeDate": {
      "type": "string",
      "format": "date",
      "description": "Archive entries before date"
    },
    "moveFiles": {
      "type": "boolean",
      "default": false,
      "description": "Move associated files"
    }
  },
  "additionalProperties": false
}
EOF

# Lifecycle domain schemas
cat > "$SCHEMA_DIR/requests/lifecycle/check.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.check request",
  "description": "Check stage prerequisites",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "targetStage": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "validation", "testing", "release"],
      "description": "Target stage"
    }
  },
  "required": ["taskId", "targetStage"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/status.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.status request",
  "description": "Current lifecycle state",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID (mutually exclusive with epicId)"
    },
    "epicId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Epic ID (mutually exclusive with taskId)"
    }
  },
  "oneOf": [
    {"required": ["taskId"]},
    {"required": ["epicId"]}
  ],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/history.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.history request",
  "description": "Stage transition history",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/gates.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.gates request",
  "description": "All gate statuses",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    }
  },
  "required": ["taskId"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/prerequisites.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.prerequisites request",
  "description": "Required prior stages",
  "type": "object",
  "properties": {
    "targetStage": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "validation", "testing", "release"],
      "description": "Target stage"
    }
  },
  "required": ["targetStage"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/progress.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.progress request",
  "description": "Record stage completion",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "stage": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "validation", "testing", "release"],
      "description": "Stage name"
    },
    "status": {
      "type": "string",
      "enum": ["completed", "skipped", "pending"],
      "description": "Stage status"
    },
    "notes": {
      "type": "string",
      "description": "Progress notes"
    }
  },
  "required": ["taskId", "stage", "status"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/skip.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.skip request",
  "description": "Skip optional stage",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "stage": {
      "type": "string",
      "enum": ["consensus"],
      "description": "Stage to skip (only optional stages)"
    },
    "reason": {
      "type": "string",
      "minLength": 10,
      "description": "Reason for skipping"
    }
  },
  "required": ["taskId", "stage", "reason"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/reset.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.reset request",
  "description": "Reset stage (emergency)",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "stage": {
      "type": "string",
      "enum": ["research", "consensus", "specification", "decomposition", "implementation", "validation", "testing", "release"],
      "description": "Stage to reset"
    },
    "reason": {
      "type": "string",
      "minLength": 20,
      "description": "Reason for reset (logged for audit)"
    }
  },
  "required": ["taskId", "stage", "reason"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/gate.pass.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.gate.pass request",
  "description": "Mark gate as passed",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "gateName": {
      "type": "string",
      "enum": ["implemented", "testsPassed", "qaPassed", "cleanupDone", "securityPassed", "documented"],
      "description": "Gate name"
    },
    "agent": {
      "type": "string",
      "description": "Agent that passed gate"
    },
    "notes": {
      "type": "string",
      "description": "Pass notes"
    }
  },
  "required": ["taskId", "gateName", "agent"],
  "additionalProperties": false
}
EOF

cat > "$SCHEMA_DIR/requests/lifecycle/gate.fail.schema.json" <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "lifecycle.gate.fail request",
  "description": "Mark gate as failed",
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "pattern": "^T[0-9]+$",
      "description": "Task ID"
    },
    "gateName": {
      "type": "string",
      "enum": ["implemented", "testsPassed", "qaPassed", "cleanupDone", "securityPassed", "documented"],
      "description": "Gate name"
    },
    "reason": {
      "type": "string",
      "minLength": 10,
      "description": "Failure reason"
    }
  },
  "required": ["taskId", "gateName", "reason"],
  "additionalProperties": false
}
EOF

echo "✓ Generated all domain request schemas"
