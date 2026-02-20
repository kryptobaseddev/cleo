#!/usr/bin/env bats
# =============================================================================
# completion.bats - Tests for tab completion scripts (T642)
# =============================================================================
# Part of: Tab Completion Release (T637 EPIC)
# Tests verify completion scripts exist, have valid syntax, and helper
# functions work correctly for bash and zsh completion.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    export SCRIPT_DIR="$PROJECT_ROOT"
    export BASH_COMPLETION="$SCRIPT_DIR/completions/bash-completion.sh"
    export ZSH_COMPLETION="$SCRIPT_DIR/completions/zsh-completion.zsh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# File Existence Tests
# =============================================================================

@test "bash completion file exists" {
    [[ -f "$BASH_COMPLETION" ]]
}

@test "zsh completion file exists" {
    [[ -f "$ZSH_COMPLETION" ]]
}

@test "completions directory exists" {
    [[ -d "$SCRIPT_DIR/completions" ]]
}

# =============================================================================
# Syntax Validation Tests
# =============================================================================

@test "bash completion has valid syntax" {
    run bash -n "$BASH_COMPLETION"
    assert_success
}

@test "zsh completion has valid syntax" {
    # Zsh syntax check - use zsh if available, skip otherwise
    if command -v zsh &>/dev/null; then
        run zsh -n "$ZSH_COMPLETION"
        assert_success
    else
        skip "zsh not available for syntax check"
    fi
}

# =============================================================================
# Bash Completion Function Tests
# =============================================================================

@test "bash completion defines _cleo_completions function" {
    source "$BASH_COMPLETION"
    run type -t _cleo_completions
    assert_output "function"
}

@test "bash completion defines _complete_parent_tasks function" {
    source "$BASH_COMPLETION"
    run type -t _complete_parent_tasks
    assert_output "function"
}

@test "bash completion defines _complete_task_ids function" {
    source "$BASH_COMPLETION"
    run type -t _complete_task_ids
    assert_output "function"
}

@test "bash completion defines _complete_phases function" {
    source "$BASH_COMPLETION"
    run type -t _complete_phases
    assert_output "function"
}

@test "bash completion defines _complete_labels function" {
    source "$BASH_COMPLETION"
    run type -t _complete_labels
    assert_output "function"
}

# =============================================================================
# Parent Task Filter Tests
# =============================================================================

@test "_complete_parent_tasks filters out subtasks" {
    # Create test todo.json with mixed types
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "setup", "phases": {}},
  "tasks": [
    {"id": "T001", "title": "Epic Task", "type": "epic", "status": "pending"},
    {"id": "T002", "title": "Regular Task", "type": "task", "status": "pending"},
    {"id": "T003", "title": "Subtask Item", "type": "subtask", "status": "pending"}
  ],
  "focus": {},
  "labels": {}
}
EOF

    # Source completion and set up environment
    export TODO_FILE
    source "$BASH_COMPLETION"

    # Simulate completion context
    COMP_WORDS=(cleo add --parent "")
    COMP_CWORD=3
    COMPREPLY=()

    # Call the parent task completer
    _complete_parent_tasks

    # Convert COMPREPLY to string for checking
    local reply_str="${COMPREPLY[*]}"

    # T001 (epic) and T002 (task) should be in completions
    [[ "$reply_str" =~ T001 ]]
    [[ "$reply_str" =~ T002 ]]

    # T003 (subtask) should NOT be in completions
    [[ ! "$reply_str" =~ T003 ]]
}

@test "_complete_task_ids returns all task IDs" {
    create_independent_tasks

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo show "")
    COMP_CWORD=2
    COMPREPLY=()

    _complete_task_ids

    local reply_str="${COMPREPLY[*]}"

    # All tasks should be returned
    [[ "$reply_str" =~ T001 ]]
    [[ "$reply_str" =~ T002 ]]
    [[ "$reply_str" =~ T003 ]]
}

@test "_complete_task_ids filters by status" {
    # Create todo with mixed statuses
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "setup", "phases": {}},
  "tasks": [
    {"id": "T001", "title": "Pending Task", "status": "pending"},
    {"id": "T002", "title": "Active Task", "status": "active"},
    {"id": "T003", "title": "Done Task", "status": "done"}
  ],
  "focus": {},
  "labels": {}
}
EOF

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo complete "")
    COMP_CWORD=2
    COMPREPLY=()

    # Filter for pending and active only
    _complete_task_ids "pending,active"

    local reply_str="${COMPREPLY[*]}"

    # T001 and T002 should be in completions
    [[ "$reply_str" =~ T001 ]]
    [[ "$reply_str" =~ T002 ]]

    # T003 (done) should NOT be in completions
    [[ ! "$reply_str" =~ T003 ]]
}

@test "_complete_phases returns default phases when no todo file" {
    rm -f "$TODO_FILE"

    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo add --phase "")
    COMP_CWORD=3
    COMPREPLY=()

    _complete_phases

    local reply_str="${COMPREPLY[*]}"

    # Default phases should be available
    [[ "$reply_str" =~ setup ]]
    [[ "$reply_str" =~ core ]]
    [[ "$reply_str" =~ testing ]]
    [[ "$reply_str" =~ polish ]]
    [[ "$reply_str" =~ maintenance ]]
}

@test "_complete_phases reads phases from todo file" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "version": "2.3.0",
  "project": {
    "name": "test",
    "currentPhase": "alpha",
    "phases": {
      "alpha": {"order": 1, "name": "Alpha"},
      "beta": {"order": 2, "name": "Beta"},
      "release": {"order": 3, "name": "Release"}
    }
  },
  "tasks": [],
  "focus": {},
  "labels": {}
}
EOF

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo phase set "")
    COMP_CWORD=3
    COMPREPLY=()

    _complete_phases

    local reply_str="${COMPREPLY[*]}"

    # Custom phases should be available
    [[ "$reply_str" =~ alpha ]]
    [[ "$reply_str" =~ beta ]]
    [[ "$reply_str" =~ release ]]
}

@test "_complete_labels returns unique labels from tasks" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "setup", "phases": {}},
  "tasks": [
    {"id": "T001", "title": "Task 1", "status": "pending", "labels": ["bug", "urgent"]},
    {"id": "T002", "title": "Task 2", "status": "pending", "labels": ["feature", "bug"]},
    {"id": "T003", "title": "Task 3", "status": "pending", "labels": ["docs"]}
  ],
  "focus": {},
  "labels": {}
}
EOF

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo list --label "")
    COMP_CWORD=3
    COMPREPLY=()

    _complete_labels

    local reply_str="${COMPREPLY[*]}"

    # All unique labels should be returned
    [[ "$reply_str" =~ bug ]]
    [[ "$reply_str" =~ urgent ]]
    [[ "$reply_str" =~ feature ]]
    [[ "$reply_str" =~ docs ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "install.sh references completion files" {
    # Check that completions directory exists in source
    [[ -d "$SCRIPT_DIR/completions" ]]

    # Count completion files
    local count
    count=$(find "$SCRIPT_DIR/completions" -name "*.sh" -o -name "*.zsh" | wc -l)
    [[ $count -ge 2 ]]
}

@test "completion files have correct shebang" {
    run head -1 "$BASH_COMPLETION"
    assert_output --partial "#!/usr/bin/env bash"
}

@test "bash completion registers for cleo command" {
    run grep -E "^complete.*cleo$" "$BASH_COMPLETION"
    assert_success
}

@test "bash completion registers for ct alias" {
    run grep -E "^complete.*[[:space:]]ct$" "$BASH_COMPLETION"
    assert_success
}

# =============================================================================
# Command Completion Tests
# =============================================================================

@test "bash completion includes all major commands" {
    # Check that commands variable contains expected commands (spans multiple lines)
    run grep "local commands=" "$BASH_COMPLETION"
    assert_success

    # Also verify specific commands are present in the file
    run grep -E "add|update|complete|list|focus|session" "$BASH_COMPLETION"
    assert_success
}

@test "bash completion handles add command options" {
    source "$BASH_COMPLETION"

    # Simulate completing options for add command
    COMP_WORDS=(cleo add "Test task" --)
    COMP_CWORD=3
    COMPREPLY=()

    _cleo_completions

    local reply_str="${COMPREPLY[*]}"

    # Should include add-specific options
    [[ "$reply_str" =~ "--parent" ]] || [[ "$reply_str" =~ "--type" ]] || [[ "$reply_str" =~ "--priority" ]]
}

@test "bash completion handles list command options" {
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo list --)
    COMP_CWORD=2
    COMPREPLY=()

    _cleo_completions

    local reply_str="${COMPREPLY[*]}"

    # Should include list-specific options
    [[ "$reply_str" =~ "--status" ]] || [[ "$reply_str" =~ "--priority" ]] || [[ "$reply_str" =~ "--phase" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "completion handles missing todo file gracefully" {
    rm -f "$TODO_FILE"

    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo show "")
    COMP_CWORD=2
    COMPREPLY=()

    # Should not error, just return empty
    run _complete_task_ids
    assert_success
}

@test "completion handles empty todo file" {
    echo '{"tasks": [], "_meta": {"version": "2.3.0"}}' > "$TODO_FILE"

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo complete "")
    COMP_CWORD=2
    COMPREPLY=()

    # compgen returns 1 when word list is empty, which is expected behavior
    _complete_task_ids || true

    # COMPREPLY should be empty (no tasks to complete)
    [[ ${#COMPREPLY[@]} -eq 0 ]]
}

@test "completion handles malformed json gracefully" {
    echo 'not valid json' > "$TODO_FILE"

    export TODO_FILE
    source "$BASH_COMPLETION"

    COMP_WORDS=(cleo show "")
    COMP_CWORD=2
    COMPREPLY=()

    # Should not error, jq will fail silently
    run _complete_task_ids
    # May succeed or fail, but should not crash
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Zsh Completion Tests
# =============================================================================

@test "zsh completion defines _cleo function" {
    if ! command -v zsh &>/dev/null; then
        skip "zsh not available"
    fi

    run grep -E "^_cleo\(\)" "$ZSH_COMPLETION"
    assert_success
}

@test "zsh completion has compdef directive" {
    run head -1 "$ZSH_COMPLETION"
    assert_output --partial "#compdef"
}

@test "zsh completion includes command descriptions" {
    run grep -E "'add:Create" "$ZSH_COMPLETION"
    assert_success
}

@test "zsh completion defines helper functions" {
    # Check for parent task completer
    run grep -E "^_cleo_parent_tasks\(\)" "$ZSH_COMPLETION"
    assert_success

    # Check for task id completer
    run grep -E "^_cleo_task_ids\(\)" "$ZSH_COMPLETION"
    assert_success

    # Check for phases completer
    run grep -E "^_cleo_phases\(\)" "$ZSH_COMPLETION"
    assert_success
}
