#!/usr/bin/env bats
# =============================================================================
# claude-aliases.bats - Unit tests for lib/ui/claude-aliases.sh
# =============================================================================
# Tests the Claude Code CLI alias library functions:
#   - Shell detection and RC file path resolution
#   - Alias content generation for bash/zsh/powershell/cmd
#   - Injection/removal operations with idempotency
#   - Status checking and version detection
#
# Part of: Claude Code CLI Aliases feature (T2089)
# =============================================================================

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# ==============================================================================
# SETUP / TEARDOWN
# ==============================================================================

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export HOME="$TEST_DIR"
    export LIB_DIR="${BATS_TEST_DIRNAME}/../../lib"

    # Create home directory structure
    mkdir -p "$TEST_DIR"

    # Source the library (with dependencies)
    source "$LIB_DIR/core/platform-compat.sh"
    source "$LIB_DIR/core/exit-codes.sh"
    source "$LIB_DIR/ui/claude-aliases.sh"
}

teardown() {
    [[ -d "$TEST_DIR" ]] && rm -rf "$TEST_DIR"
}

# ==============================================================================
# get_rc_file_path TESTS
# ==============================================================================

@test "get_rc_file_path bash returns valid path" {
    run get_rc_file_path "bash"
    assert_success
    # Should return a path containing .bashrc or .bash_profile
    assert_output --regexp "(\.bashrc|\.bash_profile)$"
}

@test "get_rc_file_path zsh returns valid path" {
    run get_rc_file_path "zsh"
    assert_success
    # Should return a path containing .zshrc
    assert_output --partial ".zshrc"
}

@test "get_rc_file_path powershell returns valid path" {
    run get_rc_file_path "powershell"
    assert_success
    # Should return a PowerShell profile path
    assert_output --partial "Microsoft.PowerShell_profile.ps1"
}

@test "get_rc_file_path cmd returns valid path" {
    run get_rc_file_path "cmd"
    assert_success
    # Should return a cmd batch file path
    assert_output --partial "cleo-aliases.cmd"
}

@test "get_rc_file_path invalid returns error" {
    run get_rc_file_path "invalid_shell"
    assert_failure
}

@test "get_rc_file_path bash prefers .bashrc when it exists" {
    touch "$HOME/.bashrc"
    run get_rc_file_path "bash"
    assert_success
    assert_output "$HOME/.bashrc"
}

@test "get_rc_file_path bash falls back to .bash_profile" {
    # Remove .bashrc if it exists
    rm -f "$HOME/.bashrc"
    touch "$HOME/.bash_profile"
    run get_rc_file_path "bash"
    assert_success
    assert_output "$HOME/.bash_profile"
}

@test "get_rc_file_path zsh respects ZDOTDIR" {
    export ZDOTDIR="$TEST_DIR/custom-zsh"
    mkdir -p "$ZDOTDIR"
    run get_rc_file_path "zsh"
    assert_success
    assert_output "$ZDOTDIR/.zshrc"
}

# ==============================================================================
# get_current_shell TESTS
# ==============================================================================

@test "get_current_shell returns non-empty value" {
    run get_current_shell
    assert_success
    # Should return something
    [[ -n "$output" ]]
}

@test "get_current_shell detects bash when BASH_VERSION is set" {
    # We're running in bash, so this should be bash
    run get_current_shell
    assert_success
    assert_output "bash"
}

# ==============================================================================
# generate_bash_aliases TESTS
# ==============================================================================

@test "generate_bash_aliases contains marker start" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "$CLAUDE_ALIASES_MARKER_START"
}

@test "generate_bash_aliases contains marker end" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "$CLAUDE_ALIASES_MARKER_END"
}

@test "generate_bash_aliases contains version" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "v$CLAUDE_ALIASES_VERSION"
}

@test "generate_bash_aliases contains cc alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias cc="
}

@test "generate_bash_aliases contains ccy alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias ccy="
}

@test "generate_bash_aliases contains ccr alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias ccr="
}

@test "generate_bash_aliases contains ccry alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias ccry="
}

@test "generate_bash_aliases contains cc-headless alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias cc-headless="
}

@test "generate_bash_aliases contains cc-headfull alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias cc-headfull="
}

@test "generate_bash_aliases contains cc-headfull-stream alias" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "alias cc-headfull-stream="
}

@test "generate_bash_aliases includes environment variables" {
    run generate_bash_aliases
    assert_success
    assert_output --partial "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true"
    assert_output --partial "ENABLE_BACKGROUND_TASKS=true"
    assert_output --partial "FORCE_AUTO_BACKGROUND_TASKS=true"
    assert_output --partial "CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true"
}

# ==============================================================================
# generate_powershell_aliases TESTS
# ==============================================================================

@test "generate_powershell_aliases contains marker start" {
    run generate_powershell_aliases
    assert_success
    assert_output --partial "$CLAUDE_ALIASES_MARKER_START"
}

@test "generate_powershell_aliases contains Set-ClaudeEnv function" {
    run generate_powershell_aliases
    assert_success
    assert_output --partial "function Set-ClaudeEnv"
}

@test "generate_powershell_aliases contains cc function" {
    run generate_powershell_aliases
    assert_success
    assert_output --partial "function cc"
}

# ==============================================================================
# generate_cmd_aliases TESTS
# ==============================================================================

@test "generate_cmd_aliases contains REM markers" {
    run generate_cmd_aliases
    assert_success
    assert_output --partial "REM CLEO-CLAUDE-ALIASES:START"
}

@test "generate_cmd_aliases contains doskey macros" {
    run generate_cmd_aliases
    assert_success
    assert_output --partial "doskey cc="
}

# ==============================================================================
# inject_aliases TESTS
# ==============================================================================

@test "inject_aliases creates file if not exists" {
    local rc_file="$TEST_DIR/.bashrc"

    # Ensure file does not exist
    rm -f "$rc_file"

    run inject_aliases "$rc_file" "bash"
    assert_success

    # File should now exist
    [[ -f "$rc_file" ]]

    # Should contain aliases
    grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file"
}

@test "inject_aliases adds block to existing file" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create existing file with content
    echo "# My existing bashrc" > "$rc_file"
    echo "export PATH=/usr/local/bin:\$PATH" >> "$rc_file"

    run inject_aliases "$rc_file" "bash"
    assert_success

    # Should have both original content and aliases
    grep -q "My existing bashrc" "$rc_file"
    grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file"
}

@test "inject_aliases skips if already current" {
    local rc_file="$TEST_DIR/.bashrc"

    # Install aliases first
    inject_aliases "$rc_file" "bash"

    # Try to install again
    run inject_aliases "$rc_file" "bash"
    assert_success

    # Output should indicate skipped
    echo "$output" | jq -e '.action == "skipped"'
    echo "$output" | jq -e '.reason == "already_current"'
}

@test "inject_aliases --force updates even if current" {
    local rc_file="$TEST_DIR/.bashrc"

    # Install aliases first
    inject_aliases "$rc_file" "bash"

    # Force reinstall
    run inject_aliases "$rc_file" "bash" "--force"
    assert_success

    # Output should indicate updated
    echo "$output" | jq -e '.action == "updated"'
}

@test "inject_aliases updates outdated version" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file with old version marker
    cat > "$rc_file" << 'EOF'
# CLEO-CLAUDE-ALIASES:START v0.0.1
alias cc='claude'
# CLEO-CLAUDE-ALIASES:END
EOF

    run inject_aliases "$rc_file" "bash"
    assert_success

    # Output should indicate updated
    echo "$output" | jq -e '.action == "updated"'

    # File should have new version
    grep -q "v$CLAUDE_ALIASES_VERSION" "$rc_file"
}

@test "inject_aliases creates parent directory if needed" {
    local rc_file="$TEST_DIR/subdir/deeper/.bashrc"

    run inject_aliases "$rc_file" "bash"
    assert_success

    # File should exist
    [[ -f "$rc_file" ]]
}

@test "inject_aliases returns valid JSON" {
    local rc_file="$TEST_DIR/.bashrc"

    run inject_aliases "$rc_file" "bash"
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null
}

# ==============================================================================
# remove_aliases TESTS
# ==============================================================================

@test "remove_aliases removes block from file" {
    local rc_file="$TEST_DIR/.bashrc"

    # Install aliases first
    inject_aliases "$rc_file" "bash"

    # Verify block exists
    grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file"

    # Remove aliases
    run remove_aliases "$rc_file"
    assert_success

    # Block should be gone
    ! grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file"
}

@test "remove_aliases returns skipped for file without block" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file without aliases
    echo "# Just a regular bashrc" > "$rc_file"

    run remove_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.action == "skipped"'
    echo "$output" | jq -e '.reason == "not_installed"'
}

@test "remove_aliases returns skipped for non-existent file" {
    local rc_file="$TEST_DIR/nonexistent"

    run remove_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.action == "skipped"'
    echo "$output" | jq -e '.reason == "file_not_found"'
}

@test "remove_aliases preserves other content" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file with content before and after aliases
    echo "# Before aliases" > "$rc_file"
    inject_aliases "$rc_file" "bash"
    echo "# After aliases" >> "$rc_file"

    # Remove aliases
    run remove_aliases "$rc_file"
    assert_success

    # Other content should remain
    grep -q "Before aliases" "$rc_file"
    grep -q "After aliases" "$rc_file"

    # Aliases should be gone
    ! grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file"
}

# ==============================================================================
# aliases_has_block TESTS
# ==============================================================================

@test "aliases_has_block detects presence" {
    local rc_file="$TEST_DIR/.bashrc"

    # Install aliases
    inject_aliases "$rc_file" "bash"

    run aliases_has_block "$rc_file"
    assert_success
}

@test "aliases_has_block returns failure for missing block" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file without aliases
    echo "# No aliases here" > "$rc_file"

    run aliases_has_block "$rc_file"
    assert_failure
}

@test "aliases_has_block returns failure for non-existent file" {
    run aliases_has_block "$TEST_DIR/nonexistent"
    assert_failure
}

# ==============================================================================
# get_installed_aliases_version TESTS
# ==============================================================================

@test "get_installed_aliases_version extracts version" {
    local rc_file="$TEST_DIR/.bashrc"

    # Install aliases
    inject_aliases "$rc_file" "bash"

    run get_installed_aliases_version "$rc_file"
    assert_success
    assert_output "$CLAUDE_ALIASES_VERSION"
}

@test "get_installed_aliases_version returns empty for file without version" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file without version marker
    echo "# No version here" > "$rc_file"

    run get_installed_aliases_version "$rc_file"
    # May succeed with empty output or fail
    [[ -z "$output" ]]
}

@test "get_installed_aliases_version returns failure for missing file" {
    run get_installed_aliases_version "$TEST_DIR/nonexistent"
    assert_failure
}

@test "get_installed_aliases_version extracts old version correctly" {
    local rc_file="$TEST_DIR/.bashrc"

    # Create file with old version
    cat > "$rc_file" << 'EOF'
# CLEO-CLAUDE-ALIASES:START v0.9.5
alias cc='claude'
# CLEO-CLAUDE-ALIASES:END
EOF

    run get_installed_aliases_version "$rc_file"
    assert_success
    assert_output "0.9.5"
}

# ==============================================================================
# check_aliases_status TESTS
# ==============================================================================

@test "check_aliases_status returns JSON array" {
    run check_aliases_status
    assert_success

    # Should be valid JSON array
    echo "$output" | jq -e 'type == "array"'
}

@test "check_aliases_status includes bash shell" {
    run check_aliases_status
    assert_success

    # Should include bash entry
    echo "$output" | jq -e '.[] | select(.shell == "bash")'
}

@test "check_aliases_status shows not_installed for new system" {
    run check_aliases_status
    assert_success

    # Bash entry should show not_installed
    local bash_status
    bash_status=$(echo "$output" | jq -r '.[] | select(.shell == "bash") | .status')
    [[ "$bash_status" == "not_installed" ]]
}

@test "check_aliases_status shows current after installation" {
    local rc_file
    rc_file=$(get_rc_file_path "bash")

    # Install aliases
    inject_aliases "$rc_file" "bash"

    run check_aliases_status
    assert_success

    # Bash entry should show current
    local bash_status
    bash_status=$(echo "$output" | jq -r '.[] | select(.shell == "bash") | .status')
    [[ "$bash_status" == "current" ]]
}

@test "check_aliases_status shows outdated for old version" {
    local rc_file
    rc_file=$(get_rc_file_path "bash")

    # Create file with old version
    mkdir -p "$(dirname "$rc_file")"
    cat > "$rc_file" << 'EOF'
# CLEO-CLAUDE-ALIASES:START v0.0.1
alias cc='claude'
# CLEO-CLAUDE-ALIASES:END
EOF

    run check_aliases_status
    assert_success

    # Bash entry should show outdated
    local bash_status
    bash_status=$(echo "$output" | jq -r '.[] | select(.shell == "bash") | .status')
    [[ "$bash_status" == "outdated" ]]
}

# ==============================================================================
# detect_available_shells TESTS
# ==============================================================================

@test "detect_available_shells returns JSON array" {
    run detect_available_shells
    assert_success

    # Should be valid JSON array
    echo "$output" | jq -e 'type == "array"'
}

@test "detect_available_shells includes bash" {
    # Bash should be available since we're running in bash
    run detect_available_shells
    assert_success

    echo "$output" | jq -e '.[] | select(.name == "bash")'
}

# ==============================================================================
# COLLISION DETECTION TESTS (T2119)
# ==============================================================================

@test "detect_existing_aliases returns empty array for file without aliases" {
    local rc_file="$TEST_DIR/.bashrc"
    echo "# Just a comment" > "$rc_file"

    run detect_existing_aliases "$rc_file"
    assert_success
    assert_output "[]"
}

@test "detect_existing_aliases detects shell alias" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# User aliases
alias cc='some-other-command'
alias ls='ls --color'
EOF

    run detect_existing_aliases "$rc_file"
    assert_success

    # Should find cc alias
    echo "$output" | jq -e '.[] | select(.name == "cc")'
    # Should mark it as potentially Claude-related (cc is our alias name)
    echo "$output" | jq -e '.[] | select(.name == "cc" and .type == "alias")'
}

@test "detect_existing_aliases detects shell function" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# User functions
cc() {
    echo "my custom cc function"
}
EOF

    run detect_existing_aliases "$rc_file"
    assert_success

    # Should find cc function
    echo "$output" | jq -e '.[] | select(.name == "cc" and .type == "function")'
}

@test "detect_existing_aliases identifies Claude-related aliases" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# Claude aliases
alias cc='claude code'
alias ccy='claude code -y'
EOF

    run detect_existing_aliases "$rc_file"
    assert_success

    # Both should be marked as Claude-related
    local claude_count
    claude_count=$(echo "$output" | jq '[.[] | select(.isClaudeRelated == true)] | length')
    [[ "$claude_count" -eq 2 ]]
}

@test "detect_existing_aliases identifies non-Claude aliases" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# Non-Claude alias using our name
alias cc='gcc -Wall'
EOF

    run detect_existing_aliases "$rc_file"
    assert_success

    # Should be marked as NOT Claude-related (contains gcc, not claude)
    echo "$output" | jq -e '.[] | select(.name == "cc" and .isClaudeRelated == false)'
}

@test "detect_legacy_claude_aliases returns false for empty file" {
    local rc_file="$TEST_DIR/.bashrc"
    echo "" > "$rc_file"

    run detect_legacy_claude_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.detected == false'
}

@test "detect_legacy_claude_aliases returns false for file without legacy patterns" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# Normal bashrc
alias ls='ls --color'
export PATH="$PATH:/usr/local/bin"
EOF

    run detect_legacy_claude_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.detected == false'
}

@test "detect_legacy_claude_aliases detects _cc_env function pattern" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# Legacy Claude aliases
_cc_env() {
    export ANTHROPIC_API_KEY="sk-..."
}
cc() {
    _cc_env && claude "$@"
}
EOF

    run detect_legacy_claude_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.detected == true'
    echo "$output" | jq -e '.hasCcEnv == true'
    echo "$output" | jq -e '.hasClaudeFunctions == true'
}

@test "detect_legacy_claude_aliases detects Claude comment marker" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# Claude Code aliases
alias cc='claude code'
EOF

    run detect_legacy_claude_aliases "$rc_file"
    assert_success

    echo "$output" | jq -e '.hasClaudeComment == true'
}

@test "check_alias_collisions returns no collision for new file" {
    local rc_file="$TEST_DIR/.bashrc"
    echo "# Empty bashrc" > "$rc_file"

    run check_alias_collisions "$rc_file"
    assert_success

    echo "$output" | jq -e '.hasCollisions == false'
}

@test "check_alias_collisions returns no collision for CLEO-managed file" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << EOF
# Other stuff
$CLAUDE_ALIASES_MARKER_START
alias cc='claude code'
$CLAUDE_ALIASES_MARKER_END
EOF

    run check_alias_collisions "$rc_file"
    assert_success

    echo "$output" | jq -e '.hasCollisions == false'
    echo "$output" | jq -e '.reason == "cleo_managed"'
}

@test "check_alias_collisions detects non-Claude collision" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# User's custom cc alias (not Claude)
alias cc='gcc -Wall -Wextra'
alias ccy='gcc -Wall -Wextra -pedantic'
EOF

    run check_alias_collisions "$rc_file"
    assert_success

    echo "$output" | jq -e '.hasCollisions == true'
    local non_claude_count
    non_claude_count=$(echo "$output" | jq '.nonClaudeCount')
    [[ "$non_claude_count" -gt 0 ]]
}

@test "check_alias_collisions allows Claude-only aliases" {
    local rc_file="$TEST_DIR/.bashrc"
    cat > "$rc_file" << 'EOF'
# User's Claude aliases (pre-CLEO)
alias cc='claude code'
alias ccy='claude code -y'
EOF

    run check_alias_collisions "$rc_file"
    assert_success

    # These are Claude-related, so no collision
    echo "$output" | jq -e '.hasCollisions == false'
}

@test "check_alias_collisions returns false for non-existent file" {
    run check_alias_collisions "$TEST_DIR/nonexistent"
    assert_success

    echo "$output" | jq -e '.hasCollisions == false'
}

# ==============================================================================
# WINDOWS-SPECIFIC HELPER TESTS (T2111)
# ==============================================================================

@test "normalize_windows_path returns unchanged on non-windows" {
    # On Linux/macOS, PLATFORM is not "windows"
    run normalize_windows_path "/home/user/file.txt"
    assert_success
    # Should return unchanged since we're not on Windows
    assert_output "/home/user/file.txt"
}

@test "normalize_windows_path handles forward slashes" {
    run normalize_windows_path "C:/Users/test/Documents"
    assert_success
    # On non-Windows, should return unchanged
    # On Windows, would convert to backslashes
    [[ "$output" == "C:/Users/test/Documents" ]] || [[ "$output" == 'C:\Users\test\Documents' ]]
}

@test "get_windows_documents_path returns path" {
    run get_windows_documents_path
    assert_success
    # Should return some path (HOME/Documents on non-Windows)
    [[ -n "$output" ]]
    [[ "$output" == *"Documents"* ]] || [[ "$output" == *"documents"* ]] || [[ -d "$output" ]]
}

@test "ensure_powershell_profile_dir returns JSON" {
    local test_profile="$TEST_DIR/PowerShell/Microsoft.PowerShell_profile.ps1"

    run ensure_powershell_profile_dir "$test_profile"
    assert_success

    # Should return JSON with created/exists fields
    echo "$output" | jq -e '.exists == true'
    echo "$output" | jq -e 'has("path")'
}

@test "ensure_powershell_profile_dir creates directory if missing" {
    local test_profile="$TEST_DIR/NewDir/SubDir/profile.ps1"

    # Directory shouldn't exist yet
    [[ ! -d "$TEST_DIR/NewDir" ]]

    run ensure_powershell_profile_dir "$test_profile"
    assert_success

    # Directory should now exist
    [[ -d "$TEST_DIR/NewDir/SubDir" ]]
    echo "$output" | jq -e '.created == true'
}

@test "ensure_powershell_profile_dir handles existing directory" {
    mkdir -p "$TEST_DIR/ExistingDir"
    local test_profile="$TEST_DIR/ExistingDir/profile.ps1"

    run ensure_powershell_profile_dir "$test_profile"
    assert_success

    echo "$output" | jq -e '.created == false'
    echo "$output" | jq -e '.exists == true'
}

@test "setup_cmd_autorun returns not_windows on non-windows platform" {
    # On Linux/macOS, PLATFORM is not "windows"
    run setup_cmd_autorun "$TEST_DIR/test.cmd"
    # Should fail gracefully
    assert_failure

    echo "$output" | jq -e '.error == "not_windows"'
}

@test "check_cmd_autorun returns not_windows on non-windows platform" {
    run check_cmd_autorun
    assert_success

    echo "$output" | jq -e '.configured == false'
    echo "$output" | jq -e '.reason == "not_windows"'
}

# ==============================================================================
# CONSTANTS TESTS
# ==============================================================================

@test "CLAUDE_ALIASES_VERSION is set" {
    [[ -n "$CLAUDE_ALIASES_VERSION" ]]
}

@test "CLAUDE_ALIASES_MARKER_START is set" {
    [[ -n "$CLAUDE_ALIASES_MARKER_START" ]]
}

@test "CLAUDE_ALIASES_MARKER_END is set" {
    [[ -n "$CLAUDE_ALIASES_MARKER_END" ]]
}

@test "SUPPORTED_SHELLS array has entries" {
    [[ ${#SUPPORTED_SHELLS[@]} -gt 0 ]]
}

@test "CLAUDE_ENV_VARS array has entries" {
    [[ ${#CLAUDE_ENV_VARS[@]} -gt 0 ]]
}
