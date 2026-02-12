#!/usr/bin/env bash
# release-artifacts.sh - Pluggable artifact handlers for Release System v2
#
# LAYER: 2 (Business Logic)
# DEPENDENCIES: release-config.sh, exit-codes.sh, logging.sh
# PROVIDES: Artifact type handlers (build, validate, publish)
#
# @task T2671

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_ARTIFACTS_SH_LOADED:-}" ]] && return 0
declare -r _RELEASE_ARTIFACTS_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_RELEASE_ARTIFACTS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source release-config.sh for configuration loading
if [[ -f "$_RELEASE_ARTIFACTS_LIB_DIR/release/release-config.sh" ]]; then
    source "$_RELEASE_ARTIFACTS_LIB_DIR/release/release-config.sh"
fi

# Source exit codes
if [[ -f "$_RELEASE_ARTIFACTS_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_RELEASE_ARTIFACTS_LIB_DIR/core/exit-codes.sh"
fi

# Source logging
if [[ -f "$_RELEASE_ARTIFACTS_LIB_DIR/core/logging.sh" ]]; then
    source "$_RELEASE_ARTIFACTS_LIB_DIR/core/logging.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

declare -A ARTIFACT_HANDLERS=()

# ============================================================================
# HANDLER REGISTRY
# ============================================================================

# Register an artifact handler
# Arguments:
#   $1 - Artifact type (e.g., "npm-package")
#   $2 - Function name prefix (e.g., "npm_package")
# Usage: register_artifact_handler "npm-package" "npm_package"
register_artifact_handler() {
    local artifact_type="$1"
    local function_prefix="$2"

    ARTIFACT_HANDLERS["$artifact_type"]="$function_prefix"
}

# Get handler function prefix for artifact type
# Arguments:
#   $1 - Artifact type
# Returns: Function prefix or empty string
# Usage: prefix=$(get_artifact_handler "npm-package")
# Note: Uses case statement for subshell compatibility (bash can't export assoc arrays)
get_artifact_handler() {
    local artifact_type="$1"

    case "$artifact_type" in
        npm-package)     echo "npm_package" ;;
        python-wheel)    echo "python_wheel" ;;
        python-sdist)    echo "python_sdist" ;;
        go-module)       echo "go_module" ;;
        cargo-crate)     echo "cargo_crate" ;;
        ruby-gem)        echo "ruby_gem" ;;
        docker-image)    echo "docker_image" ;;
        github-release)  echo "github_release" ;;
        generic-tarball) echo "generic_tarball" ;;
        *)               echo "" ;;
    esac
}

# Check if handler is registered
# Arguments:
#   $1 - Artifact type
# Returns: 0 if registered, 1 otherwise
# Usage: if has_artifact_handler "npm-package"; then ...; fi
has_artifact_handler() {
    local artifact_type="$1"
    local handler
    handler=$(get_artifact_handler "$artifact_type")
    [[ -n "$handler" ]]
}

# ============================================================================
# GENERIC HANDLER DISPATCHER
# ============================================================================

# Build artifact
# Arguments:
#   $1 - Artifact type
#   $2 - Artifact config JSON
#   $3 - Optional: dry-run flag (true/false)
# Returns: 0=success, 1=error
# Usage: build_artifact "npm-package" "$config_json" "false"
build_artifact() {
    local artifact_type="$1"
    local artifact_config="${2:-}"
    local dry_run="${3:-false}"

    local handler_prefix
    handler_prefix=$(get_artifact_handler "$artifact_type")

    if [[ -z "$handler_prefix" ]]; then
        echo "ERROR: No handler registered for artifact type: $artifact_type" >&2
        return 1
    fi

    local build_function="${handler_prefix}_build"

    if ! declare -f "$build_function" >/dev/null 2>&1; then
        echo "ERROR: Build function not found: $build_function" >&2
        return 1
    fi

    "$build_function" "$artifact_config" "$dry_run"
}

# Validate artifact
# Arguments:
#   $1 - Artifact type
#   $2 - Artifact config JSON
# Returns: 0=valid, 1=invalid
# Usage: validate_artifact "npm-package" "$config_json"
validate_artifact() {
    local artifact_type="$1"
    local artifact_config="${2:-}"

    local handler_prefix
    handler_prefix=$(get_artifact_handler "$artifact_type")

    if [[ -z "$handler_prefix" ]]; then
        echo "ERROR: No handler registered for artifact type: $artifact_type" >&2
        return 1
    fi

    local validate_function="${handler_prefix}_validate"

    if ! declare -f "$validate_function" >/dev/null 2>&1; then
        echo "ERROR: Validate function not found: $validate_function" >&2
        return 1
    fi

    "$validate_function" "$artifact_config"
}

# Publish artifact
# Arguments:
#   $1 - Artifact type
#   $2 - Artifact config JSON
#   $3 - Optional: dry-run flag (true/false)
# Returns: 0=success, 1=error
# Usage: publish_artifact "npm-package" "$config_json" "false"
publish_artifact() {
    local artifact_type="$1"
    local artifact_config="${2:-}"
    local dry_run="${3:-false}"

    local handler_prefix
    handler_prefix=$(get_artifact_handler "$artifact_type")

    if [[ -z "$handler_prefix" ]]; then
        echo "ERROR: No handler registered for artifact type: $artifact_type" >&2
        return 1
    fi

    local publish_function="${handler_prefix}_publish"

    if ! declare -f "$publish_function" >/dev/null 2>&1; then
        echo "ERROR: Publish function not found: $publish_function" >&2
        return 1
    fi

    "$publish_function" "$artifact_config" "$dry_run"
}

# ============================================================================
# HANDLER: generic-tarball
# ============================================================================

generic_tarball_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -z "$build_command" ]]; then
        # Default tarball creation
        local tarball_name="release-$(date +%Y%m%d-%H%M%S).tar.gz"
        build_command="tar czf $tarball_name --exclude=.git --exclude=.cleo --exclude=node_modules ."
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building generic tarball..."
    eval "$build_command"
}

generic_tarball_validate() {
    local artifact_config="$1"

    # Generic tarball has no strict requirements
    # Just check if build command is valid shell syntax
    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -n "$build_command" ]]; then
        if ! bash -n <<<"$build_command" 2>/dev/null; then
            echo "ERROR: Invalid build command syntax" >&2
            return 1
        fi
    fi

    return 0
}

generic_tarball_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // empty')

    if [[ -z "$publish_command" ]]; then
        echo "WARN: No publish command specified for generic tarball. Skipping publish." >&2
        return 0
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing generic tarball..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: npm-package
# ============================================================================

npm_package_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -z "$build_command" ]]; then
        echo "No build command specified for npm package. Skipping build step."
        return 0
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building npm package..."
    eval "$build_command"
}

npm_package_validate() {
    local artifact_config="$1"

    # Check package.json exists
    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "package.json"')

    if [[ ! -f "$package_file" ]]; then
        echo "ERROR: package.json not found: $package_file" >&2
        return 1
    fi

    # Validate required fields
    local required_fields=("name" "version" "description" "license")
    for field in "${required_fields[@]}"; do
        if ! jq -e ".$field" "$package_file" >/dev/null 2>&1; then
            echo "ERROR: package.json missing required field: $field" >&2
            return 1
        fi
    done

    # Validate package name format
    local package_name
    package_name=$(jq -r '.name' "$package_file")
    if [[ ! "$package_name" =~ ^(@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*$ ]]; then
        echo "ERROR: Invalid npm package name: $package_name" >&2
        return 1
    fi

    return 0
}

npm_package_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // "npm publish"')

    # Add provenance flag if enabled
    local provenance
    provenance=$(echo "$artifact_config" | jq -r '.options.provenance // false')
    if [[ "$provenance" == "true" ]]; then
        publish_command="$publish_command --provenance"
    fi

    # Add access flag if specified
    local access
    access=$(echo "$artifact_config" | jq -r '.options.access // empty')
    if [[ -n "$access" ]]; then
        publish_command="$publish_command --access $access"
    fi

    # Add tag if specified
    local tag
    tag=$(echo "$artifact_config" | jq -r '.options.tag // empty')
    if [[ -n "$tag" ]]; then
        publish_command="$publish_command --tag $tag"
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing npm package..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: python-wheel
# ============================================================================

python_wheel_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // "python -m build"')

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building Python wheel..."
    eval "$build_command"
}

python_wheel_validate() {
    local artifact_config="$1"

    # Check pyproject.toml or setup.py exists
    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "pyproject.toml"')

    if [[ ! -f "$package_file" ]] && [[ ! -f "setup.py" ]]; then
        echo "ERROR: Neither pyproject.toml nor setup.py found" >&2
        return 1
    fi

    # Check for build tool
    if ! command -v python >/dev/null 2>&1; then
        echo "ERROR: python command not found" >&2
        return 1
    fi

    # Check if build module is available
    if ! python -c "import build" 2>/dev/null; then
        echo "WARN: python build module not found. Install with: pip install build" >&2
    fi

    return 0
}

python_wheel_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // "twine upload dist/*"')

    # Add attestations flag if enabled (requires twine 5.0+)
    local attestations
    attestations=$(echo "$artifact_config" | jq -r '.options.attestations // false')
    if [[ "$attestations" == "true" ]]; then
        publish_command="$publish_command --attestations"
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing Python wheel to PyPI..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: go-module
# ============================================================================

go_module_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // "go mod tidy"')

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Tidying Go module..."
    eval "$build_command"
}

go_module_validate() {
    local artifact_config="$1"

    # Check go.mod exists
    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "go.mod"')

    if [[ ! -f "$package_file" ]]; then
        echo "ERROR: go.mod not found: $package_file" >&2
        return 1
    fi

    # Check for go command
    if ! command -v go >/dev/null 2>&1; then
        echo "ERROR: go command not found" >&2
        return 1
    fi

    # Validate module path format
    local module_path
    module_path=$(grep -E '^module ' "$package_file" | awk '{print $2}')
    if [[ -z "$module_path" ]]; then
        echo "ERROR: Module path not found in go.mod" >&2
        return 1
    fi

    return 0
}

go_module_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    # Go modules are published via Git tags, not direct upload
    # The publish command should create a tag
    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // empty')

    if [[ -z "$publish_command" ]]; then
        echo "Go modules are published via Git tags. Create a tag with: git tag v<version> && git push --tags"
        return 0
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing Go module (creating tag)..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: cargo-crate
# ============================================================================

cargo_crate_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // "cargo build --release"')

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building Cargo crate..."
    eval "$build_command"
}

cargo_crate_validate() {
    local artifact_config="$1"

    # Check Cargo.toml exists
    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "Cargo.toml"')

    if [[ ! -f "$package_file" ]]; then
        echo "ERROR: Cargo.toml not found: $package_file" >&2
        return 1
    fi

    # Check for cargo command
    if ! command -v cargo >/dev/null 2>&1; then
        echo "ERROR: cargo command not found" >&2
        return 1
    fi

    # Validate required fields exist
    if ! grep -q '^\[package\]' "$package_file"; then
        echo "ERROR: [package] section not found in Cargo.toml" >&2
        return 1
    fi

    local required_fields=("name" "version" "authors" "edition")
    for field in "${required_fields[@]}"; do
        if ! grep -q "^$field = " "$package_file"; then
            echo "ERROR: Cargo.toml missing required field: $field" >&2
            return 1
        fi
    done

    return 0
}

cargo_crate_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // "cargo publish"')

    if [[ "$dry_run" == "true" ]]; then
        # Cargo has built-in dry-run
        publish_command="$publish_command --dry-run"
    fi

    echo "Publishing Cargo crate to crates.io..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: ruby-gem
# ============================================================================

ruby_gem_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "*.gemspec"')

    # Find gemspec file if wildcard
    if [[ "$package_file" == "*.gemspec" ]]; then
        package_file=$(find . -maxdepth 1 -name "*.gemspec" | head -1)
        if [[ -z "$package_file" ]]; then
            echo "ERROR: No .gemspec file found" >&2
            return 1
        fi
    fi

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -z "$build_command" ]]; then
        build_command="gem build $package_file"
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building Ruby gem..."
    eval "$build_command"
}

ruby_gem_validate() {
    local artifact_config="$1"

    # Check for gemspec file
    local package_file
    package_file=$(echo "$artifact_config" | jq -r '.package // "*.gemspec"')

    if [[ "$package_file" == "*.gemspec" ]]; then
        if ! find . -maxdepth 1 -name "*.gemspec" | grep -q .; then
            echo "ERROR: No .gemspec file found" >&2
            return 1
        fi
    elif [[ ! -f "$package_file" ]]; then
        echo "ERROR: Gemspec file not found: $package_file" >&2
        return 1
    fi

    # Check for gem command
    if ! command -v gem >/dev/null 2>&1; then
        echo "ERROR: gem command not found" >&2
        return 1
    fi

    return 0
}

ruby_gem_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // "gem push"')

    # Find built gem file
    local gem_file
    gem_file=$(find . -maxdepth 1 -name "*.gem" | head -1)

    if [[ -z "$gem_file" ]]; then
        echo "ERROR: No .gem file found. Run build first." >&2
        return 1
    fi

    if [[ "$publish_command" == "gem push" ]]; then
        publish_command="$publish_command $gem_file"
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing Ruby gem to RubyGems.org..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: docker-image
# ============================================================================

docker_image_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -z "$build_command" ]]; then
        local registry
        registry=$(echo "$artifact_config" | jq -r '.registry // "localhost"')
        build_command="docker build -t $registry:latest ."
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building Docker image..."
    eval "$build_command"
}

docker_image_validate() {
    local artifact_config="$1"

    # Check Dockerfile exists
    if [[ ! -f "Dockerfile" ]] && [[ ! -f "dockerfile" ]]; then
        echo "ERROR: Dockerfile not found" >&2
        return 1
    fi

    # Check for docker command
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERROR: docker command not found" >&2
        return 1
    fi

    return 0
}

docker_image_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // empty')

    if [[ -z "$publish_command" ]]; then
        local registry
        registry=$(echo "$artifact_config" | jq -r '.registry // empty')
        if [[ -z "$registry" ]]; then
            echo "ERROR: Docker registry not specified" >&2
            return 1
        fi
        publish_command="docker push $registry:latest"
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Publishing Docker image..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: github-release
# ============================================================================

github_release_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // empty')

    if [[ -z "$build_command" ]]; then
        echo "No build command for GitHub release. Skipping build step."
        return 0
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building GitHub release artifacts..."
    eval "$build_command"
}

github_release_validate() {
    local artifact_config="$1"

    # Check for gh command
    if ! command -v gh >/dev/null 2>&1; then
        echo "ERROR: gh (GitHub CLI) command not found" >&2
        return 1
    fi

    # Check if we're in a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "ERROR: Not in a git repository" >&2
        return 1
    fi

    return 0
}

github_release_publish() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local publish_command
    publish_command=$(echo "$artifact_config" | jq -r '.publishCommand // empty')

    if [[ -z "$publish_command" ]]; then
        echo "ERROR: GitHub release publish command not specified" >&2
        return 1
    fi

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $publish_command"
        return 0
    fi

    echo "Creating GitHub release..."
    eval "$publish_command"
}

# ============================================================================
# HANDLER: python-sdist
# ============================================================================

python_sdist_build() {
    local artifact_config="$1"
    local dry_run="${2:-false}"

    local build_command
    build_command=$(echo "$artifact_config" | jq -r '.buildCommand // "python -m build --sdist"')

    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would execute: $build_command"
        return 0
    fi

    echo "Building Python source distribution..."
    eval "$build_command"
}

python_sdist_validate() {
    # Same validation as python-wheel
    python_wheel_validate "$1"
}

python_sdist_publish() {
    # Same publish as python-wheel
    python_wheel_publish "$1" "$2"
}

# ============================================================================
# HANDLER REGISTRATION
# ============================================================================

# Register all built-in handlers
register_artifact_handler "generic-tarball" "generic_tarball"
register_artifact_handler "npm-package" "npm_package"
register_artifact_handler "python-wheel" "python_wheel"
register_artifact_handler "python-sdist" "python_sdist"
register_artifact_handler "go-module" "go_module"
register_artifact_handler "cargo-crate" "cargo_crate"
register_artifact_handler "ruby-gem" "ruby_gem"
register_artifact_handler "docker-image" "docker_image"
register_artifact_handler "github-release" "github_release"

# ============================================================================
# EXPORTS
# ============================================================================

export -f register_artifact_handler
export -f get_artifact_handler
export -f has_artifact_handler
export -f build_artifact
export -f validate_artifact
export -f publish_artifact

# Export all handler functions
export -f generic_tarball_build generic_tarball_validate generic_tarball_publish
export -f npm_package_build npm_package_validate npm_package_publish
export -f python_wheel_build python_wheel_validate python_wheel_publish
export -f python_sdist_build python_sdist_validate python_sdist_publish
export -f go_module_build go_module_validate go_module_publish
export -f cargo_crate_build cargo_crate_validate cargo_crate_publish
export -f ruby_gem_build ruby_gem_validate ruby_gem_publish
export -f docker_image_build docker_image_validate docker_image_publish
export -f github_release_build github_release_validate github_release_publish
