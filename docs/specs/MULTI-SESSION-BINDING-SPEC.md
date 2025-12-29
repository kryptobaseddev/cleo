# Multi-Session Binding Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-29
**Task**: T1016
**Related**: MULTI-SESSION-SPEC.md, LLM-AGENT-FIRST-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in RFC 2119.

---

## Executive Summary

This specification defines how session context is automatically bound and resolved across CLI commands in multi-session mode. It complements MULTI-SESSION-SPEC.md by specifying:

1. Session context auto-binding after `session start`
2. Agent identity detection and assignment
3. Consistent session resolution across all commands
4. Actionable error handling for session-related failures

### Key Capabilities

| Capability | Description |
|------------|-------------|
| **Auto-Binding** | `.current-session` file written on session start |
| **Agent Detection** | Automatic LLM agent identification |
| **Consistent Resolution** | All commands resolve session in same order |
| **Actionable Errors** | Errors include `error.fix` and `error.alternatives` |

---

## Part 1: Session Context Binding

### 1.1 Session ID Sources

Session context MUST be resolved from these sources in priority order:

| Priority | Source | Type | Description |
|----------|--------|------|-------------|
| 1 | `--session ID` | Explicit | CLI flag, highest priority |
| 2 | `CLEO_SESSION` | Environment | Env var for persistent context |
| 3 | `.current-session` | File | Auto-written on session start |
| 4 | Auto-detect | Computed | Single active session inference |

### 1.2 Resolution Algorithm

```bash
resolve_current_session_id() {
    local provided="${1:-}"
    
    # Priority 1: Explicit flag
    if [[ -n "$provided" ]]; then
        validate_session_exists "$provided" && echo "$provided" && return 0
        return 1  # Invalid session ID
    fi
    
    # Priority 2: Environment variable
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        validate_session_exists "$CLEO_SESSION" && echo "$CLEO_SESSION" && return 0
        return 1  # Invalid env var
    fi
    
    # Priority 3: .current-session file
    local current_file="${CLEO_DIR}/.current-session"
    if [[ -f "$current_file" ]]; then
        local file_session
        file_session=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$file_session" ]]; then
            validate_session_exists "$file_session" && echo "$file_session" && return 0
            # File points to invalid session - clear it
            rm -f "$current_file"
        fi
    fi
    
    # Priority 4: Auto-detect single active
    local active_count active_session
    active_count=$(list_active_sessions | jq 'length')
    
    if [[ "$active_count" -eq 1 ]]; then
        active_session=$(list_active_sessions | jq -r '.[0].id')
        echo "$active_session"
        return 0
    fi
    
    return 1  # Could not resolve
}
```

### 1.3 Auto-Binding on Session Start

When `session start` succeeds, the CLI MUST:

1. Write session ID to `.cleo/.current-session`
2. Include export instruction in output
3. Detect and bind agent identity (if detectable)

```bash
# After successful session creation
auto_bind_session() {
    local session_id="$1"
    local agent_id="$2"
    
    # Write .current-session file
    echo "$session_id" > "${CLEO_DIR}/.current-session"
    
    # Update session with agent ID if detected
    if [[ -n "$agent_id" ]]; then
        update_session_agent "$session_id" "$agent_id"
    fi
}
```

### 1.4 Session Start Output (JSON)

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "session start",
    "timestamp": "2025-12-29T16:00:00Z",
    "version": "0.42.0"
  },
  "success": true,
  "sessionId": "session_20251229_160000_abc123",
  "agentId": "claude-opus",
  "scope": "epic:T001",
  "focusedTask": "T005",
  "binding": {
    "file": ".cleo/.current-session",
    "envVar": "CLEO_SESSION",
    "export": "export CLEO_SESSION=session_20251229_160000_abc123"
  },
  "hint": "Session context auto-bound. All subsequent commands will use this session."
}
```

---

## Part 2: Agent Detection

### 2.1 Detection Sources

| Priority | Source | Example Value | Agent ID |
|----------|--------|---------------|----------|
| 1 | `CLEO_AGENT` env | `my-custom-agent` | As specified |
| 2 | `CURSOR_AGENT` env | `1` | `cursor-agent` |
| 3 | Non-interactive shell | N/A | `llm-agent` |
| 4 | Unknown | N/A | `null` |

### 2.2 Detection Algorithm

```bash
# lib/agent-detection.sh

# Known agent environment markers
declare -A AGENT_MARKERS=(
    ["CURSOR_AGENT"]="cursor-agent"
    ["CLAUDE_CODE"]="claude-code"
    ["CODEX_SESSION"]="codex-agent"
    ["WINDSURF_AGENT"]="windsurf-agent"
    ["AIDER_MODEL"]="aider-agent"
)

detect_agent_identity() {
    # Priority 1: Explicit CLEO_AGENT
    if [[ -n "${CLEO_AGENT:-}" ]]; then
        echo "$CLEO_AGENT"
        return 0
    fi
    
    # Priority 2: Known agent markers
    for marker in "${!AGENT_MARKERS[@]}"; do
        if [[ -n "${!marker:-}" ]]; then
            echo "${AGENT_MARKERS[$marker]}"
            return 0
        fi
    done
    
    # Priority 3: Non-interactive shell heuristic
    if [[ ! -t 0 ]] && [[ ! -t 1 ]]; then
        echo "llm-agent"
        return 0
    fi
    
    # Priority 4: Unknown
    return 1
}

get_agent_id() {
    local agent_id
    agent_id=$(detect_agent_identity 2>/dev/null || true)
    echo "${agent_id:-}"
}
```

### 2.3 Agent ID Storage

Agent ID is stored in session entry:

```json
{
  "id": "session_20251229_160000_abc123",
  "agentId": "claude-opus",
  "status": "active"
}
```

---

## Part 3: Command Integration

### 3.1 Commands Using Session Context

All commands that operate within a session MUST call `resolve_current_session_id()`:

| Command | Session Required | Behavior |
|---------|-----------------|----------|
| `focus set/clear/show` | Yes | Uses resolved session |
| `session end` | Yes | Ends resolved session |
| `session suspend` | Yes | Suspends resolved session |
| `complete` | No | Uses session if available |
| `update` | No | Uses session if available |
| `list` | No | Filters by session scope if available |

### 3.2 Command Pattern

```bash
# All session-aware commands MUST follow this pattern
cmd_focus_set() {
    local task_id="$1"
    local provided_session="${SESSION_FLAG:-}"
    
    # Resolve session context
    local session_id
    if ! session_id=$(resolve_current_session_id "$provided_session"); then
        # Multi-session mode but no context
        output_error_actionable "E_SESSION_REQUIRED" \
            "No session context. Start a session or set CLEO_SESSION." \
            36 true \
            "Session required for focus operations" \
            "cleo session start --scope epic:T001 --auto-focus" \
            '{}' \
            '[{"action":"Start session","command":"cleo session start --scope epic:T001 --auto-focus"},{"action":"List sessions","command":"cleo session list"}]'
        exit 36
    fi
    
    # Proceed with resolved session
    set_session_focus "$session_id" "$task_id"
}
```

### 3.3 Session End Behavior

`session end` MUST:

1. Resolve session using standard algorithm
2. Clear `.current-session` file after ending
3. Provide actionable error if ambiguous

```bash
cmd_end() {
    local note="${NOTE:-}"
    local provided_session="${SESSION_FLAG:-}"
    
    # Resolve session
    local session_id
    if ! session_id=$(resolve_current_session_id "$provided_session"); then
        # Check why resolution failed
        local active_count
        active_count=$(list_active_sessions | jq 'length')
        
        if [[ "$active_count" -gt 1 ]]; then
            output_error_actionable "E_AMBIGUOUS_SESSION" \
                "Multiple active sessions. Specify which to end." \
                36 true \
                "Use --session ID or set CLEO_SESSION env var" \
                "cleo session list --status active" \
                '{"activeCount": '"$active_count"'}' \
                '[{"action":"List sessions","command":"cleo session list --status active"},{"action":"Set session","command":"export CLEO_SESSION=<session-id>"}]'
            exit 36
        else
            output_error "E_SESSION_NOT_FOUND" \
                "No active session to end" 31 false \
                "Start a session first: cleo session start --scope epic:T001"
            exit 31
        fi
    fi
    
    # End session
    end_session "$session_id" "$note"
    
    # Clear .current-session file
    rm -f "${CLEO_DIR}/.current-session"
}
```

---

## Part 4: Error Handling

### 4.1 Error JSON Requirements

All session errors MUST include:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
  "_meta": {...},
  "success": false,
  "error": {
    "code": "E_SESSION_REQUIRED",
    "message": "No session context. Start a session or set CLEO_SESSION.",
    "exitCode": 36,
    "recoverable": true,
    "suggestion": "Run 'cleo session start' or set CLEO_SESSION env var",
    "fix": "cleo session start --scope epic:T001 --auto-focus",
    "alternatives": [
      {"action": "Start session", "command": "cleo session start --scope epic:T001 --auto-focus"},
      {"action": "List sessions", "command": "cleo session list"},
      {"action": "Set env var", "command": "export CLEO_SESSION=<session-id>"}
    ],
    "context": {
      "resolvedFrom": null,
      "activeSessionCount": 0
    }
  }
}
```

### 4.2 Error Code Table

| Exit Code | Constant | Meaning | Recoverable |
|-----------|----------|---------|-------------|
| 31 | `E_SESSION_NOT_FOUND` | Session ID not found | Yes |
| 35 | `E_TASK_CLAIMED` | Task focused by another session | Yes |
| 36 | `E_SESSION_REQUIRED` | Session context required | Yes |
| 38 | `E_FOCUS_REQUIRED` | Focus task required for session start | Yes |

### 4.3 Error Recovery

All recoverable errors MUST include `error.fix` - a copy-paste command:

| Error | fix Command |
|-------|-------------|
| `E_SESSION_REQUIRED` | `cleo session start --scope epic:T001 --auto-focus` |
| `E_AMBIGUOUS_SESSION` | `cleo session list --status active` |
| `E_TASK_CLAIMED` | `cleo session suspend --session <claiming-session>` |
| `E_FOCUS_REQUIRED` | `cleo session start --scope <scope> --focus <task>` |

---

## Part 5: Configuration

### 5.1 Config Options

```json
{
  "multiSession": {
    "enabled": true,
    "autoBindSession": true,
    "agentDetection": true,
    "clearCurrentSessionOnEnd": true
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoBindSession` | boolean | `true` | Write .current-session on start |
| `agentDetection` | boolean | `true` | Detect agent identity |
| `clearCurrentSessionOnEnd` | boolean | `true` | Remove .current-session on end |

---

## Part 6: Files

### 6.1 .current-session File

**Location**: `.cleo/.current-session`
**Format**: Single line containing session ID

```
session_20251229_160000_abc123
```

**Lifecycle**:
- Created: On `session start` (if `autoBindSession = true`)
- Read: On all session-aware commands
- Deleted: On `session end` (if `clearCurrentSessionOnEnd = true`)
- Validated: Session existence checked before use; file cleared if invalid

### 6.2 File Permissions

`.current-session` SHOULD be created with mode `0600` to prevent cross-user access.

---

## Part 7: Implementation Checklist

### Phase 1: Core Functions
- [ ] Create `lib/agent-detection.sh`
- [ ] Add `resolve_current_session_id()` to `lib/sessions.sh`
- [ ] Add `auto_bind_session()` to `lib/sessions.sh`

### Phase 2: Command Updates
- [ ] Update `scripts/session.sh` cmd_start() for auto-binding
- [ ] Update `scripts/session.sh` cmd_end() for consistent resolution
- [ ] Update `scripts/focus.sh` for session resolution

### Phase 3: Error Handling
- [ ] Add `E_SESSION_REQUIRED` (36) to exit-codes.sh
- [ ] Add `E_AMBIGUOUS_SESSION` (36 with different context) 
- [ ] Update `output_error_actionable()` for session errors

### Phase 4: Testing
- [ ] Test auto-binding on session start
- [ ] Test resolution from .current-session file
- [ ] Test resolution from CLEO_SESSION env var
- [ ] Test auto-detect single active session
- [ ] Test error recovery commands

### Phase 5: Documentation
- [ ] Update LLM-AGENT-FIRST-SPEC.md with exit codes 35-39
- [ ] Update docs/commands/session.md
- [ ] Update CLAUDE.md injection template

---

## Appendix A: Migration Notes

### From v0.41.x

- `.current-session` file is new (v0.42.0)
- Existing sessions continue to work
- CLEO_SESSION env var takes precedence over .current-session
- No breaking changes to existing workflows

### Backwards Compatibility

Single-session mode (`multiSession.enabled = false`):
- All binding features disabled
- Legacy `._meta.activeSession` in todo.json used
- No .current-session file created

---

*End of Specification*
