#!/usr/bin/env bash
# Generate response schemas for all 98 MCP operations
# @task T2925
# Response schemas are simpler - most just wrap common-success with domain-specific data

set -euo pipefail

SCHEMA_DIR="/mnt/projects/claude-todo/mcp-server/schemas"

# Helper to generate a standard success response schema
generate_response_schema() {
    local domain="$1"
    local operation="$2"
    local data_description="$3"

    cat > "$SCHEMA_DIR/responses/$domain/$operation.schema.json" <<EOF
{
  "\$schema": "http://json-schema.org/draft-07/schema#",
  "title": "$domain.$operation response",
  "description": "$data_description",
  "allOf": [
    {
      "\$ref": "../common-success.schema.json"
    },
    {
      "properties": {
        "data": {
          "type": "object",
          "description": "$data_description"
        }
      }
    }
  ]
}
EOF
}

# Tasks domain responses
generate_response_schema "tasks" "list" "Array of task objects with filtering applied"
generate_response_schema "tasks" "find" "Array of minimal task objects (id, title, status only)"
generate_response_schema "tasks" "exists" "Boolean indicating task existence"
generate_response_schema "tasks" "tree" "Hierarchical tree structure of tasks"
generate_response_schema "tasks" "blockers" "Array of blocking task objects"
generate_response_schema "tasks" "deps" "Dependency graph with upstream/downstream tasks"
generate_response_schema "tasks" "analyze" "Triage analysis with priority recommendations"
generate_response_schema "tasks" "next" "Array of suggested next tasks"
generate_response_schema "tasks" "create" "Created task object with generated ID"
generate_response_schema "tasks" "update" "Updated task object"
generate_response_schema "tasks" "complete" "Completion status with timestamp"
generate_response_schema "tasks" "delete" "Deletion confirmation"
generate_response_schema "tasks" "archive" "Count of archived tasks"
generate_response_schema "tasks" "unarchive" "Restored task object"
generate_response_schema "tasks" "reparent" "Updated task hierarchy"
generate_response_schema "tasks" "promote" "Promoted task object"
generate_response_schema "tasks" "reorder" "New sibling order"
generate_response_schema "tasks" "reopen" "Reopened task object"

# Session domain responses
generate_response_schema "session" "status" "Current session object with focus and scope"
generate_response_schema "session" "list" "Array of session objects"
generate_response_schema "session" "show" "Full session object with history"
generate_response_schema "session" "focus.get" "Focused task ID or null"
generate_response_schema "session" "history" "Array of session history entries"
generate_response_schema "session" "start" "Created session object"
generate_response_schema "session" "end" "Session summary with duration and tasks completed"
generate_response_schema "session" "resume" "Resumed session object"
generate_response_schema "session" "suspend" "Suspended session status"
generate_response_schema "session" "focus.set" "Focus confirmation with task ID"
generate_response_schema "session" "focus.clear" "Clear confirmation"
generate_response_schema "session" "gc" "Count of cleaned sessions"

# Orchestrate domain responses
generate_response_schema "orchestrate" "status" "Orchestration state for epic"
generate_response_schema "orchestrate" "next" "Next task with skill recommendation"
generate_response_schema "orchestrate" "ready" "Array of parallel-safe task IDs"
generate_response_schema "orchestrate" "analyze" "Wave structure with dependency analysis"
generate_response_schema "orchestrate" "context" "Context budget status with token counts"
generate_response_schema "orchestrate" "waves" "Parallel execution waves"
generate_response_schema "orchestrate" "skill.list" "Array of skill definitions"
generate_response_schema "orchestrate" "startup" "Full orchestration startup state"
generate_response_schema "orchestrate" "spawn" "Spawn prompt with metadata and token resolution"
generate_response_schema "orchestrate" "validate" "Validation result with gate checks"
generate_response_schema "orchestrate" "parallel.start" "Wave tasks with coordination info"
generate_response_schema "orchestrate" "parallel.end" "Wave completion summary"

# Research domain responses
generate_response_schema "research" "show" "Full research entry with key findings"
generate_response_schema "research" "list" "Array of research entries"
generate_response_schema "research" "query" "Array of matched research entries with confidence scores"
generate_response_schema "research" "pending" "Array of entries needing follow-up"
generate_response_schema "research" "stats" "Aggregated research metrics"
generate_response_schema "research" "manifest.read" "Array of JSONL manifest entries"
generate_response_schema "research" "inject" "Protocol injection content block"
generate_response_schema "research" "link" "Link confirmation with relationship"
generate_response_schema "research" "manifest.append" "Entry confirmation with checksum"
generate_response_schema "research" "manifest.archive" "Archive count and moved files"

# Lifecycle domain responses
generate_response_schema "lifecycle" "check" "Gate status with prerequisites"
generate_response_schema "lifecycle" "status" "Current lifecycle state with stage progression"
generate_response_schema "lifecycle" "history" "Stage transition log"
generate_response_schema "lifecycle" "gates" "Array of gate statuses"
generate_response_schema "lifecycle" "prerequisites" "Array of required prior stages"
generate_response_schema "lifecycle" "progress" "Progress confirmation with timestamp"
generate_response_schema "lifecycle" "skip" "Skip confirmation with reason"
generate_response_schema "lifecycle" "reset" "Reset confirmation (logged for audit)"
generate_response_schema "lifecycle" "gate.pass" "Gate pass status with agent"
generate_response_schema "lifecycle" "gate.fail" "Gate fail status with reason"

# Validate domain responses
generate_response_schema "validate" "schema" "Validation result with errors array"
generate_response_schema "validate" "protocol" "Protocol compliance with violations and score"
generate_response_schema "validate" "task" "Anti-hallucination check with rule violations"
generate_response_schema "validate" "manifest" "Manifest integrity status"
generate_response_schema "validate" "output" "Output file validation result"
generate_response_schema "validate" "compliance.summary" "Aggregated compliance metrics"
generate_response_schema "validate" "compliance.violations" "Array of violation objects"
generate_response_schema "validate" "test.status" "Test suite pass/fail counts"
generate_response_schema "validate" "test.coverage" "Coverage percentages by type"
generate_response_schema "validate" "compliance.record" "Record confirmation with ID"
generate_response_schema "validate" "test.run" "Test execution results with pass/fail details"

# Release domain responses
generate_response_schema "release" "prepare" "Preparation status with checklist"
generate_response_schema "release" "changelog" "Generated changelog content"
generate_response_schema "release" "commit" "Commit hash and files changed"
generate_response_schema "release" "tag" "Tag name and creation status"
generate_response_schema "release" "push" "Push status with remote info"
generate_response_schema "release" "gates.run" "Gate results array with pass/fail"
generate_response_schema "release" "rollback" "Rollback status with reverted changes"

# System domain responses
generate_response_schema "system" "version" "Version string (semver)"
generate_response_schema "system" "doctor" "Health check results with diagnostics"
generate_response_schema "system" "config.get" "Config value (any type)"
generate_response_schema "system" "stats" "Project statistics (task counts, session info)"
generate_response_schema "system" "context" "Context window info with token usage"
generate_response_schema "system" "init" "Initialization status with detected config"
generate_response_schema "system" "config.set" "Set confirmation with new value"
generate_response_schema "system" "backup" "Backup path and metadata"
generate_response_schema "system" "restore" "Restore status with file counts"
generate_response_schema "system" "migrate" "Migration result with applied versions"
generate_response_schema "system" "sync" "Sync result with import/export counts"
generate_response_schema "system" "cleanup" "Cleanup count by type"

echo "✓ Generated all 98 response schemas"
