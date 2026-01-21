# Session Binding Architecture Specification

**Version**: 2.0.0
**Status**: ACTIVE
**Created**: 2026-01-20
**Task**: T1774
**Related**: MULTI-SESSION-BINDING-SPEC.md, MULTI-SESSION-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in RFC 2119.

---

## Executive Summary

This specification extends the Multi-Session Binding architecture to support **true multi-terminal isolation** through hybrid session binding. The core problem with the original singleton `.current-session` file is that multiple terminals/Claude instances sharing the same project directory all see the same "current" session, breaking session isolation.

### The Core Problem

```
Terminal A: cleo session start --scope epic:T001 --name "Feature A"
  -> Writes session_abc to .current-session

Terminal B: cleo session start --scope epic:T002 --name "Feature B"
  -> Overwrites .current-session with session_xyz

Terminal A: cleo focus set T005
  -> Now uses session_xyz instead of session_abc!
```

### The Solution

Hybrid binding with priority chain:
1. `--session <id>` flag (explicit CLI override)
2. `CLEO_SESSION` environment variable (user-set or from session start)
3. **TTY-based binding file** (terminal-specific, NEW)
4. `.current-session` file (legacy singleton, deprecated in multi-mode)
5. Auto-detect single active session (fallback)

---

## Part 1: Resolution Priority Chain

### 1.1 Updated Resolution Algorithm

```bash
resolve_current_session_id() {
    local provided="${1:-}"

    # Priority 1: Explicit --session flag
    if [[ -n "$provided" ]]; then
        _validate_session_exists "$provided" && echo "$provided" && return 0
        return 1
    fi

    # Priority 2: CLEO_SESSION environment variable
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        _validate_session_exists "$CLEO_SESSION" && echo "$CLEO_SESSION" && return 0
        return 1
    fi

    # Priority 3: TTY-based binding (NEW - multi-terminal isolation)
    local tty_session
    tty_session=$(get_tty_bound_session)
    if [[ -n "$tty_session" ]]; then
        _validate_session_exists "$tty_session" && echo "$tty_session" && return 0
        # Stale TTY binding - clean it up
        clear_tty_binding
    fi

    # Priority 4: .current-session file (legacy singleton)
    local current_file="${CLEO_DIR}/.current-session"
    if [[ -f "$current_file" ]]; then
        local file_session
        file_session=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$file_session" ]] && _validate_session_exists "$file_session"; then
            echo "$file_session"
            return 0
        fi
        rm -f "$current_file" 2>/dev/null
    fi

    # Priority 5: Auto-detect single active session
    local active_count active_session
    active_count=$(list_active_sessions | jq 'length')
    if [[ "$active_count" -eq 1 ]]; then
        active_session=$(list_active_sessions | jq -r '.[0].id')
        echo "$active_session"
        return 0
    fi

    return 1
}
```

### 1.2 Priority Table

| Priority | Source | Scope | Persistence | Use Case |
|----------|--------|-------|-------------|----------|
| 1 | `--session ID` | Command | None | Explicit override |
| 2 | `CLEO_SESSION` env | Process | Shell session | Manual binding |
| 3 | TTY binding file | Terminal | Until session end | **Multi-terminal isolation** |
| 4 | `.current-session` | Project | Until session end | Legacy/single-terminal |
| 5 | Auto-detect | Project | None | Single active session |

---

## Part 2: TTY-Based Binding

### 2.1 Concept

Each terminal (TTY) can be bound to a specific session. When a session starts in a terminal:
1. The terminal's TTY identifier is captured (e.g., `/dev/pts/5`)
2. A binding file is created: `.cleo/tty-bindings/tty-dev-pts-5`
3. The binding contains the session ID and metadata

### 2.2 Directory Structure

```
.cleo/
  tty-bindings/           # TTY binding files (gitignored)
    tty-dev-pts-0         # Binding for /dev/pts/0
    tty-dev-pts-1         # Binding for /dev/pts/1
  .current-session        # Legacy singleton (deprecated)
  sessions.json           # Session registry
```

### 2.3 TTY Identification

```bash
# Get sanitized TTY identifier
get_tty_id() {
    local tty_path
    tty_path=$(tty 2>/dev/null) || return 1

    # Not a TTY (pipe, cron, etc.)
    [[ "$tty_path" == "not a tty" ]] && return 1

    # Sanitize: /dev/pts/0 -> tty-dev-pts-0
    echo "$tty_path" | sed 's|^/||; s|/|-|g; s|^|tty-|'
}
```

### 2.4 Binding Operations

```bash
# Bind session to current TTY
bind_session_to_tty() {
    local session_id="$1"
    local tty_id
    tty_id=$(get_tty_id) || return 1

    local binding_dir="${CLEO_DIR}/tty-bindings"
    mkdir -p "$binding_dir"

    local binding_file="${binding_dir}/${tty_id}"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Write binding with metadata
    jq -nc --arg sid "$session_id" \
           --arg tty "$(tty 2>/dev/null || echo 'unknown')" \
           --arg ts "$timestamp" \
           --arg pid "$$" '{
        sessionId: $sid,
        tty: $tty,
        boundAt: $ts,
        pid: ($pid | tonumber)
    }' > "$binding_file"
}

# Get session bound to current TTY
get_tty_bound_session() {
    local tty_id
    tty_id=$(get_tty_id) || return 1

    local binding_file="${CLEO_DIR}/tty-bindings/${tty_id}"
    [[ -f "$binding_file" ]] || return 1

    jq -r '.sessionId' "$binding_file" 2>/dev/null
}

# Clear binding for current TTY
clear_tty_binding() {
    local tty_id
    tty_id=$(get_tty_id) || return 0

    local binding_file="${CLEO_DIR}/tty-bindings/${tty_id}"
    rm -f "$binding_file" 2>/dev/null
}

# Clear binding for specific session (called on session end)
clear_session_tty_bindings() {
    local session_id="$1"
    local binding_dir="${CLEO_DIR}/tty-bindings"

    [[ -d "$binding_dir" ]] || return 0

    for file in "$binding_dir"/*; do
        [[ -f "$file" ]] || continue
        local bound_session
        bound_session=$(jq -r '.sessionId' "$file" 2>/dev/null)
        if [[ "$bound_session" == "$session_id" ]]; then
            rm -f "$file"
        fi
    done
}
```

### 2.5 Binding File Format

```json
{
  "sessionId": "session_20260120_143000_abc123",
  "tty": "/dev/pts/5",
  "boundAt": "2026-01-20T14:30:00Z",
  "pid": 12345
}
```

### 2.6 Non-TTY Handling

When TTY is unavailable (pipes, cron, CI/CD):
- `get_tty_id()` returns failure (exit 1)
- TTY binding is skipped silently
- Resolution continues to Priority 4 (.current-session) or Priority 5 (auto-detect)
- Warning only if `multiSession.warnOnNoTty = true` (default: false)

---

## Part 3: Session Start Integration

### 3.1 Updated Session Start Flow

```bash
cmd_start_multi_session() {
    # ... existing session creation logic ...

    local session_id
    session_id=$(start_session "$scope_def" "$focus_task" "$session_name")

    # Create TTY binding (Priority 3)
    if bind_session_to_tty "$session_id"; then
        log_info "Session bound to terminal: $(tty 2>/dev/null)"
    fi

    # Also write .current-session for backwards compatibility (Priority 4)
    echo "$session_id" > "${CLEO_DIR}/.current-session"

    # Output export statement for manual binding (Priority 2)
    if [[ "$FORMAT" == "json" ]]; then
        jq -n --arg sid "$session_id" '{
            binding: {
                envVar: "CLEO_SESSION",
                export: ("export CLEO_SESSION=" + $sid),
                ttyBound: true
            }
        }'
    else
        echo ""
        echo "To bind in another terminal:"
        echo "  export CLEO_SESSION=$session_id"
    fi
}
```

### 3.2 Session End Cleanup

```bash
cmd_end() {
    local session_id
    session_id=$(resolve_current_session_id "$provided_session") || exit 31

    # End session in registry
    end_session "$session_id" "$note"

    # Clear TTY binding for this session
    clear_session_tty_bindings "$session_id"

    # Clear .current-session if it points to this session
    local current_file="${CLEO_DIR}/.current-session"
    if [[ -f "$current_file" ]]; then
        local current_session
        current_session=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [[ "$current_session" == "$session_id" ]]; then
            rm -f "$current_file"
        fi
    fi
}
```

---

## Part 4: Validation and Warnings

### 4.1 Concurrent Binding Detection

```bash
validate_session_binding() {
    local session_id="$1"

    # Check if another session is bound to this TTY
    local existing_tty_session
    existing_tty_session=$(get_tty_bound_session)

    if [[ -n "$existing_tty_session" && "$existing_tty_session" != "$session_id" ]]; then
        log_warn "Another session ($existing_tty_session) is bound to this terminal"
        log_info "  Switch: cleo session switch $session_id"
        log_info "  Or set: export CLEO_SESSION=$session_id"
        return 1
    fi

    return 0
}
```

### 4.2 Stale Binding Detection

```bash
check_binding_staleness() {
    local binding_file="$1"
    local max_age_days="${2:-7}"

    [[ -f "$binding_file" ]] || return 1

    local bound_at
    bound_at=$(jq -r '.boundAt' "$binding_file" 2>/dev/null)
    [[ -n "$bound_at" ]] || return 0

    local bound_ts now_ts age_days
    bound_ts=$(date -d "$bound_at" +%s 2>/dev/null || echo 0)
    now_ts=$(date +%s)
    age_days=$(( (now_ts - bound_ts) / 86400 ))

    if [[ "$age_days" -gt "$max_age_days" ]]; then
        log_warn "Session binding is stale (bound ${age_days}d ago)"
        return 1
    fi

    return 0
}
```

---

## Part 5: Configuration

### 5.1 New Config Options

```json
{
  "multiSession": {
    "enabled": true,
    "ttyBinding": {
      "enabled": true,
      "maxAgeHours": 168,
      "cleanupOnEnd": true
    },
    "warnOnNoTty": false,
    "warnOnConflict": true
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ttyBinding.enabled` | boolean | `true` | Enable TTY-based binding |
| `ttyBinding.maxAgeHours` | number | `168` | Max binding age (7 days) |
| `ttyBinding.cleanupOnEnd` | boolean | `true` | Clean TTY bindings on session end |
| `warnOnNoTty` | boolean | `false` | Warn when TTY unavailable |
| `warnOnConflict` | boolean | `true` | Warn on binding conflicts |

---

## Part 6: Gitignore

The `.cleo/tty-bindings/` directory MUST be gitignored:

```gitignore
# .gitignore
.cleo/tty-bindings/
```

This is machine-local state and MUST NOT be committed.

---

## Part 7: Migration

### 7.1 Backwards Compatibility

- Existing `.current-session` files continue to work
- TTY binding is additive (Priority 3), not replacing
- Single-session mode unchanged (TTY binding disabled)

### 7.2 Migration Path

1. Enable `multiSession.enabled = true`
2. `ttyBinding.enabled` defaults to true
3. New sessions automatically create TTY bindings
4. Old sessions work via `.current-session` fallback

---

## Part 8: User Workflows

### 8.1 Multi-Terminal Development

```bash
# Terminal 1: Start session for Epic A
cleo session start --scope epic:T001 --name "Auth Feature"
# Output: Session bound to terminal. export CLEO_SESSION=session_abc

# Terminal 2: Start different session for Epic B
cleo session start --scope epic:T002 --name "Payment Feature"
# Output: Session bound to terminal. export CLEO_SESSION=session_xyz

# Both terminals now have isolated sessions
# Terminal 1 commands use session_abc
# Terminal 2 commands use session_xyz
```

### 8.2 Cross-Terminal Resume

```bash
# Terminal 1 closes, reopen Terminal 3
# No TTY binding exists for Terminal 3

# Option A: Set environment variable
export CLEO_SESSION=session_abc
cleo focus show  # Uses session_abc

# Option B: Use explicit flag
cleo focus show --session session_abc

# Option C: Resume creates new TTY binding
cleo session resume session_abc
# Binds session_abc to Terminal 3's TTY
```

### 8.3 Session Switch

```bash
# Currently bound to session_abc, want to switch to session_xyz
cleo session switch session_xyz

# Updates TTY binding to session_xyz
# All subsequent commands use session_xyz
```

---

## Part 9: Error Messages

| Scenario | Message | Fix Command |
|----------|---------|-------------|
| No binding found | "No session context. Start or resume a session." | `cleo session start --scope epic:T001` |
| TTY unavailable | "Cannot create TTY binding (not a terminal)" | `export CLEO_SESSION=<id>` |
| Binding conflict | "Another session (xyz) bound to this terminal" | `cleo session switch <id>` |
| Stale binding | "Session binding is stale (8d old)" | `cleo session resume <id>` |

---

## Appendix A: Implementation Checklist

### Task T1774 (This Document)
- [x] Design hybrid session binding architecture
- [x] Document priority chain
- [x] Document TTY binding mechanism
- [x] Document user workflows

### Task T1778 (Resolution Logic)
- [ ] Add `get_tty_id()` function
- [ ] Add `bind_session_to_tty()` function
- [ ] Add `get_tty_bound_session()` function
- [ ] Update `resolve_current_session_id()` with TTY priority

### Task T1788 (Session Start)
- [ ] Update `cmd_start_multi_session()` to create TTY binding
- [ ] Add `clear_tty_binding()` function
- [ ] Add `clear_session_tty_bindings()` function
- [ ] Update session end to clear bindings

### Task T1794 (Validation)
- [ ] Add `validate_session_binding()` function
- [ ] Add `check_binding_staleness()` function
- [ ] Integrate validation into session-dependent commands

---

*End of Specification*
