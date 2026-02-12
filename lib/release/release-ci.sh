#!/usr/bin/env bash
# release-ci.sh - CI/CD template generation for release workflows
#
# PURPOSE: Generate platform-specific CI/CD configurations from templates
# LAYER: 3 (Feature Layer)
# DEPENDENCIES: config.sh, file-ops.sh
# PROVIDES: generate_ci_config, get_ci_platform, validate_ci_config
# @task T2670

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_CI_LIB_LOADED:-}" ]] && return 0
declare -r _RELEASE_CI_LIB_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source dependencies
if [[ -f "$_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_LIB_DIR/core/config.sh"
fi

if [[ -f "$_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_LIB_DIR/data/file-ops.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Template directory
TEMPLATE_DIR="${CLEO_HOME:-$HOME/.cleo}/templates/ci"
LOCAL_TEMPLATE_DIR="./templates/ci"

# Supported platforms (as space-separated string for portability)
readonly SUPPORTED_PLATFORMS="github-actions gitlab-ci circleci"

# Platform-specific output paths (use function instead of associative array)
get_platform_path() {
    local platform="$1"
    case "$platform" in
        github-actions)
            echo ".github/workflows/release.yml"
            ;;
        gitlab-ci)
            echo ".gitlab-ci.yml"
            ;;
        circleci)
            echo ".circleci/config.yml"
            ;;
        *)
            echo ""
            ;;
    esac
}

# ============================================================================
# LOGGING HELPERS
# ============================================================================

_ci_log_info() {
    local message="$1"
    echo "[INFO] $message" >&2
}

_ci_log_warn() {
    local message="$1"
    echo "[WARN] $message" >&2
}

_ci_log_error() {
    local message="$1"
    echo "[ERROR] $message" >&2
}

_ci_log_step() {
    local message="$1"
    echo "[→] $message" >&2
}

# ============================================================================
# CONFIGURATION HELPERS
# ============================================================================

# get_ci_platform - Get CI platform from config
#
# Returns:
#   Platform string (github-actions|gitlab-ci|circleci) or default
get_ci_platform() {
    local config_file="${1:-.cleo/config.json}"

    if [[ ! -f "$config_file" ]]; then
        echo "github-actions"  # Default platform
        return 0
    fi

    local platform
    platform=$(jq -r '.release.ci.platform // "github-actions"' "$config_file" 2>/dev/null || echo "github-actions")

    echo "$platform"
}

# get_artifact_type - Get primary artifact type from config
#
# Returns:
#   Artifact type string or "generic"
get_artifact_type() {
    local config_file="${1:-.cleo/config.json}"

    if [[ ! -f "$config_file" ]]; then
        echo "generic"
        return 0
    fi

    local artifact_type
    artifact_type=$(jq -r '.release.artifacts[0].type // "generic"' "$config_file" 2>/dev/null || echo "generic")

    echo "$artifact_type"
}

# get_release_gates_for_ci - Format release gates for CI template
#
# Returns:
#   Formatted gate steps for CI platform
get_release_gates_for_ci() {
    local platform="$1"
    local config_file="${2:-.cleo/config.json}"

    if [[ ! -f "$config_file" ]]; then
        echo ""
        return 0
    fi

    local gates_json
    gates_json=$(jq -r '.release.gates // []' "$config_file" 2>/dev/null || echo "[]")

    local gate_count
    gate_count=$(echo "$gates_json" | jq 'length')

    if [[ "$gate_count" -eq 0 ]]; then
        echo ""
        return 0
    fi

    # Format gates based on platform
    case "$platform" in
        github-actions)
            _format_gates_github "$gates_json"
            ;;
        gitlab-ci)
            _format_gates_gitlab "$gates_json"
            ;;
        circleci)
            _format_gates_circleci "$gates_json"
            ;;
        *)
            echo ""
            ;;
    esac
}

# _format_gates_github - Format gates for GitHub Actions
_format_gates_github() {
    local gates_json="$1"

    echo "$gates_json" | jq -r '.[] |
        "      - name: Gate - \(.name)\n" +
        "        run: \(.command)\n"
    ' | sed 's/^/      /'
}

# _format_gates_gitlab - Format gates for GitLab CI
_format_gates_gitlab() {
    local gates_json="$1"

    echo "$gates_json" | jq -r '.[] |
        "    - echo \"Running gate: \(.name)\"\n" +
        "    - \(.command)\n"
    '
}

# _format_gates_circleci - Format gates for CircleCI
_format_gates_circleci() {
    local gates_json="$1"

    echo "$gates_json" | jq -r '.[] |
        "            echo \"Running gate: \(.name)\"\n" +
        "            \(.command)\n"
    ' | sed 's/^/            /'
}

# ============================================================================
# TEMPLATE PROCESSING
# ============================================================================

# find_template - Locate template file for platform
#
# Args:
#   $1 - platform (github-actions|gitlab-ci|circleci)
#
# Returns:
#   Template file path or empty string if not found
find_template() {
    local platform="$1"

    # Try local template directory first (for development)
    if [[ -d "$LOCAL_TEMPLATE_DIR/$platform" ]]; then
        local local_template="$LOCAL_TEMPLATE_DIR/$platform/release.yml"
        if [[ "$platform" == "circleci" ]]; then
            local_template="$LOCAL_TEMPLATE_DIR/$platform/config.yml"
        fi

        if [[ -f "$local_template" ]]; then
            echo "$local_template"
            return 0
        fi
    fi

    # Try installed template directory
    if [[ -d "$TEMPLATE_DIR/$platform" ]]; then
        local installed_template="$TEMPLATE_DIR/$platform/release.yml"
        if [[ "$platform" == "circleci" ]]; then
            installed_template="$TEMPLATE_DIR/$platform/config.yml"
        fi

        if [[ -f "$installed_template" ]]; then
            echo "$installed_template"
            return 0
        fi
    fi

    echo ""
    return 1
}

# substitute_template_vars - Replace template variables
#
# Args:
#   $1 - template content
#   $2 - version
#   $3 - artifact type
#   $4 - formatted gates
#
# Returns:
#   Processed template content
substitute_template_vars() {
    local content="$1"
    local version="$2"
    local artifact_type="$3"
    local gates="$4"

    # Replace variables
    content="${content//\{\{VERSION\}\}/$version}"
    content="${content//\{\{ARTIFACT_TYPE\}\}/$artifact_type}"

    # Replace gates placeholder (multiline)
    # Use awk to preserve indentation
    if [[ -n "$gates" ]]; then
        echo "$content" | awk -v gates="$gates" '
            /\{\{GATES\}\}/ {
                print gates
                next
            }
            { print }
        '
    else
        # No gates - just remove placeholder
        echo "$content" | grep -v '{{GATES}}'
    fi
}

# ============================================================================
# MAIN GENERATION FUNCTION
# ============================================================================

# generate_ci_config - Generate CI/CD configuration from template
#
# Args:
#   $1 - platform (github-actions|gitlab-ci|circleci) - optional
#   $2 - output path - optional
#   $3 - dry-run flag (true/false) - optional
#   $4 - force flag (true/false) - optional
#
# Returns:
#   0 - Success
#   1 - Error
#
# Environment:
#   VERSION - Version string for template
generate_ci_config() {
    local platform="${1:-}"
    local output_path="${2:-}"
    local dry_run="${3:-false}"
    local force="${4:-false}"

    # Get platform from config if not specified
    if [[ -z "$platform" ]]; then
        platform=$(get_ci_platform)
        _ci_log_info "Using platform from config: $platform"
    fi

    # Validate platform
    if [[ ! " $SUPPORTED_PLATFORMS " =~ " $platform " ]]; then
        _ci_log_error "Unsupported platform: $platform"
        _ci_log_info "Supported platforms: $SUPPORTED_PLATFORMS"
        return 1
    fi

    # Determine output path
    if [[ -z "$output_path" ]]; then
        output_path=$(get_platform_path "$platform")
        if [[ -z "$output_path" ]]; then
            _ci_log_error "Could not determine output path for platform: $platform"
            return 1
        fi
        _ci_log_info "Using default output path: $output_path"
    fi

    # Check if output file already exists (skip in dry-run mode)
    if [[ "$dry_run" != "true" ]] && [[ -f "$output_path" ]] && [[ "$force" != "true" ]]; then
        _ci_log_error "Output file already exists: $output_path"
        _ci_log_info "Use --force to overwrite"
        return 1
    fi

    # Find template
    local template_file
    template_file=$(find_template "$platform")

    if [[ -z "$template_file" ]]; then
        _ci_log_error "Template not found for platform: $platform"
        return 1
    fi

    _ci_log_step "Using template: $template_file"

    # Get template variables
    local version="${VERSION:-0.1.0}"
    local artifact_type
    artifact_type=$(get_artifact_type)

    local gates
    gates=$(get_release_gates_for_ci "$platform")

    _ci_log_info "Version: $version"
    _ci_log_info "Artifact type: $artifact_type"

    if [[ -n "$gates" ]]; then
        local gate_count
        gate_count=$(jq -r '.release.gates // [] | length' .cleo/config.json 2>/dev/null || echo "0")
        _ci_log_info "Gates: $gate_count configured"
    fi

    # Read template
    local template_content
    template_content=$(cat "$template_file")

    # Substitute variables
    local processed_content
    processed_content=$(substitute_template_vars "$template_content" "$version" "$artifact_type" "$gates")

    # Dry run - just output to stdout
    if [[ "$dry_run" == "true" ]]; then
        _ci_log_info "DRY RUN - would write to: $output_path"
        echo ""
        echo "$processed_content"
        return 0
    fi

    # Create output directory if needed
    local output_dir
    output_dir=$(dirname "$output_path")
    if [[ ! -d "$output_dir" ]]; then
        _ci_log_step "Creating directory: $output_dir"
        mkdir -p "$output_dir"
    fi

    # Write output file
    _ci_log_step "Writing CI config to: $output_path"
    echo "$processed_content" > "$output_path"

    _ci_log_info "CI configuration generated successfully"

    # Print next steps
    echo ""
    echo "Next steps:"
    echo "  1. Review generated file: $output_path"
    echo "  2. Configure secrets in CI platform"
    echo "  3. Customize build/publish commands"
    echo "  4. Commit and push: git add $output_path && git commit -m 'ci: Add release workflow'"

    return 0
}

# ============================================================================
# VALIDATION
# ============================================================================

# validate_ci_config - Validate generated CI configuration
#
# Args:
#   $1 - config file path
#   $2 - platform
#
# Returns:
#   0 - Valid
#   1 - Invalid
validate_ci_config() {
    local config_file="$1"
    local platform="$2"

    if [[ ! -f "$config_file" ]]; then
        _ci_log_error "Config file not found: $config_file"
        return 1
    fi

    # Basic YAML syntax check (if yq available)
    if command -v yq &>/dev/null; then
        if ! yq eval '.' "$config_file" >/dev/null 2>&1; then
            _ci_log_error "Invalid YAML syntax in $config_file"
            return 1
        fi
        _ci_log_info "YAML syntax valid"
    else
        _ci_log_warn "yq not installed - skipping YAML validation"
    fi

    # Platform-specific validation
    case "$platform" in
        github-actions)
            if ! grep -q "^name:" "$config_file"; then
                _ci_log_error "Missing 'name:' field in GitHub Actions workflow"
                return 1
            fi
            ;;
        gitlab-ci)
            if ! grep -q "^stages:" "$config_file"; then
                _ci_log_error "Missing 'stages:' field in GitLab CI config"
                return 1
            fi
            ;;
        circleci)
            if ! grep -q "^version:" "$config_file"; then
                _ci_log_error "Missing 'version:' field in CircleCI config"
                return 1
            fi
            ;;
    esac

    _ci_log_info "Platform-specific validation passed"
    return 0
}
