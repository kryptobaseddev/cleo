#!/usr/bin/env bash
# Shared Railway CLI utilities
# Source this file for common preflight checks and helper functions
# Usage: source _shared/scripts/railway-common.sh

set -euo pipefail

# Minimum required CLI version
readonly MIN_RAILWAY_VERSION="4.27.3"

# Check if Railway CLI is installed
check_railway_cli() {
    if command -v railway &>/dev/null; then
        local path
        path=$(which railway)
        echo '{"installed": true, "path": "'"$path"'"}'
        return 0
    else
        echo '{"installed": false, "error": "cli_missing", "message": "Railway CLI not installed. Install with: npm install -g @railway/cli or brew install railway"}'
        return 1
    fi
}

# Check if user is authenticated
check_railway_auth() {
    local output
    local exit_code
    
    output=$(railway whoami --json 2>&1) || exit_code=$?
    
    if [[ ${exit_code:-0} -eq 0 ]]; then
        echo "$output"
        return 0
    else
        echo '{"authenticated": false, "error": "not_authenticated", "message": "Not logged in to Railway. Run: railway login"}'
        return 1
    fi
}

# Get workspace info
get_workspaces() {
    local whoami
    whoami=$(check_railway_auth) || return 1
    echo "$whoami" | jq '.workspaces // []'
}

# Check if project is linked
check_railway_linked() {
    local output
    local exit_code
    
    output=$(railway status --json 2>&1) || exit_code=$?
    
    if [[ ${exit_code:-0} -eq 0 ]] && [[ "$output" != *"No linked project"* ]] && [[ "$output" != *"error"* ]]; then
        echo "$output"
        return 0
    else
        echo '{"linked": false, "error": "not_linked", "message": "No Railway project linked. Run: railway link or railway init"}'
        return 1
    fi
}

# Check if parent directory is linked
check_parent_linked() {
    local current_dir
    current_dir=$(pwd)
    
    cd .. || return 1
    
    local output
    local exit_code
    
    output=$(railway status --json 2>&1) || exit_code=$?
    
    cd "$current_dir" || return 1
    
    if [[ ${exit_code:-0} -eq 0 ]] && [[ "$output" != *"No linked project"* ]]; then
        echo '{"parent_linked": true, "context": '"$output"'}'
        return 0
    else
        echo '{"parent_linked": false}'
        return 1
    fi
}

# Check CLI version
check_railway_version() {
    local required="${1:-$MIN_RAILWAY_VERSION}"
    local version
    
    if ! command -v railway &>/dev/null; then
        echo '{"ok": false, "error": "cli_missing", "message": "Railway CLI not installed"}'
        return 1
    fi
    
    version=$(railway --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    
    if [[ -z "$version" ]]; then
        echo '{"ok": false, "error": "version_unknown", "message": "Could not determine Railway CLI version"}'
        return 1
    fi
    
    # Compare versions
    local lowest
    lowest=$(printf '%s\n%s' "$required" "$version" | sort -V | head -n1)
    
    if [[ "$lowest" == "$required" ]]; then
        echo "{\"ok\": true, \"version\": \"$version\", \"required\": \"$required\"}"
        return 0
    else
        echo "{\"ok\": false, \"version\": \"$version\", \"required\": \"$required\", \"error\": \"version_outdated\", \"message\": \"Railway CLI $version is below required $required. Run: railway upgrade\"}"
        return 1
    fi
}

# Full preflight check
railway_preflight() {
    local check_version="${1:-true}"
    
    # Check CLI installed
    if ! command -v railway &>/dev/null; then
        echo '{"ready": false, "error": "cli_missing", "step": "cli", "message": "Railway CLI not installed. Install with: npm install -g @railway/cli or brew install railway"}'
        return 1
    fi
    
    # Check version if requested
    if [[ "$check_version" == "true" ]]; then
        local version_check
        version_check=$(check_railway_version) || {
            echo "$version_check"
            return 1
        }
    fi
    
    # Check authenticated
    local auth_check
    auth_check=$(railway whoami --json 2>&1) || {
        echo '{"ready": false, "error": "not_authenticated", "step": "auth", "message": "Not logged in to Railway. Run: railway login"}'
        return 1
    }
    
    echo '{"ready": true, "cli": true, "authenticated": true}'
    return 0
}

# List projects with essential fields only
list_projects_essential() {
    if ! railway_preflight >/dev/null; then
        return 1
    fi
    
    railway list --json 2>/dev/null | jq '[.[] | {
        id: .id,
        name: .name,
        workspace: (.workspace // .workspaceId // "personal"),
        services: [.services[].name // empty]
    }]' 2>/dev/null || echo '[]'
}

# Get project context (safely)
get_project_context() {
    local context
    context=$(check_railway_linked) || return 1
    
    # Extract essential fields
    echo "$context" | jq '{
        project: {
            id: .project.id,
            name: .project.name
        },
        environment: {
            id: .environment.id,
            name: .environment.name
        },
        service: {
            id: .service.id,
            name: .service.name
        },
        services: [.services[].node // .services[] | {id: .id, name: .name}]
    }'
}

# Detect project type from files
detect_project_type() {
    local dir="${1:-.}"
    
    # Check for various project types
    if [[ -f "$dir/package.json" ]]; then
        if [[ -f "$dir/next.config.js" ]] || [[ -f "$dir/next.config.ts" ]] || [[ -f "$dir/next.config.mjs" ]]; then
            echo '{"type": "nextjs", "language": "javascript", "framework": "next"}'
        elif [[ -f "$dir/nuxt.config.ts" ]] || [[ -f "$dir/nuxt.config.js" ]]; then
            echo '{"type": "nuxt", "language": "javascript", "framework": "nuxt"}'
        elif grep -q '"express"' "$dir/package.json" 2>/dev/null; then
            echo '{"type": "express", "language": "javascript", "framework": "express"}'
        elif [[ -f "$dir/vite.config.ts" ]] || [[ -f "$dir/vite.config.js" ]]; then
            echo '{"type": "vite", "language": "javascript", "framework": "vite"}'
        else
            echo '{"type": "nodejs", "language": "javascript", "framework": null}'
        fi
    elif [[ -f "$dir/requirements.txt" ]] || [[ -f "$dir/pyproject.toml" ]]; then
        if [[ -f "$dir/main.py" ]] && grep -q 'fastapi\|FastAPI' "$dir/main.py" 2>/dev/null; then
            echo '{"type": "fastapi", "language": "python", "framework": "fastapi"}'
        elif [[ -f "$dir/manage.py" ]]; then
            echo '{"type": "django", "language": "python", "framework": "django"}'
        else
            echo '{"type": "python", "language": "python", "framework": null}'
        fi
    elif [[ -f "$dir/go.mod" ]]; then
        echo '{"type": "go", "language": "go", "framework": null}'
    elif [[ -f "$dir/Cargo.toml" ]]; then
        echo '{"type": "rust", "language": "rust", "framework": null}'
    elif [[ -f "$dir/Dockerfile" ]]; then
        echo '{"type": "docker", "language": null, "framework": "docker"}'
    elif [[ -f "$dir/index.html" ]]; then
        echo '{"type": "static", "language": "html", "framework": null}'
    else
        echo '{"type": "unknown", "language": null, "framework": null}'
    fi
}

# Detect monorepo type
detect_monorepo_type() {
    local dir="${1:-.}"
    
    if [[ -f "$dir/pnpm-workspace.yaml" ]]; then
        echo '{"type": "pnpm-workspace", "shared": true}'
    elif [[ -f "$dir/turbo.json" ]]; then
        echo '{"type": "turborepo", "shared": true}'
    elif [[ -f "$dir/nx.json" ]]; then
        echo '{"type": "nx", "shared": true}'
    elif [[ -f "$dir/package.json" ]] && grep -q '"workspaces"' "$dir/package.json"; then
        echo '{"type": "npm-workspace", "shared": true}'
    elif [[ -d "$dir/packages" ]] || [[ -d "$dir/apps" ]]; then
        # Check if apps share code
        local has_shared=false
        if [[ -d "$dir/packages/shared" ]] || [[ -d "$dir/libs" ]]; then
            has_shared=true
        fi
        if [[ "$has_shared" == "true" ]]; then
            echo '{"type": "monorepo", "shared": true}'
        else
            echo '{"type": "monorepo", "shared": false}'
        fi
    else
        echo '{"type": "single", "shared": false}'
    fi
}

# Helper: Print error message to stderr
railway_error() {
    echo "Error: $1" >&2
}

# Helper: Print warning message
railway_warn() {
    echo "Warning: $1"
}

# Helper: Print success message
railway_success() {
    echo "✓ $1"
}
