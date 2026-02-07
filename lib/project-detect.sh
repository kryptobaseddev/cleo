#!/usr/bin/env bash
# lib/project-detect.sh - Project type and framework detection
# Part of CLEO project-agnostic configuration system
# @task T2778

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Supported project types
declare -a PROJECT_TYPES=(node python rust go ruby elixir java php deno bun unknown)

# Framework enum (16 values)
declare -a TEST_FRAMEWORKS=(bats jest vitest playwright cypress mocha ava uvu tap "node:test" deno bun pytest go cargo custom)

# ============================================================================
# TIER 1: MANIFEST FILE DETECTION
# ============================================================================

# Detect project type from manifest files
# Returns: project type string (node, python, rust, go, etc.)
# Usage: type=$(detect_manifest_type)
detect_manifest_type() {
    if [[ -f "package.json" ]]; then
        echo "node"
    elif [[ -f "Cargo.toml" ]]; then
        echo "rust"
    elif [[ -f "go.mod" ]]; then
        echo "go"
    elif [[ -f "pyproject.toml" ]] || [[ -f "setup.py" ]] || [[ -f "requirements.txt" ]]; then
        echo "python"
    elif [[ -f "Gemfile" ]]; then
        echo "ruby"
    elif [[ -f "mix.exs" ]]; then
        echo "elixir"
    elif [[ -f "pom.xml" ]] || [[ -f "build.gradle" ]]; then
        echo "java"
    elif [[ -f "composer.json" ]]; then
        echo "php"
    elif [[ -f "deno.json" ]] || [[ -f "deno.jsonc" ]]; then
        echo "deno"
    else
        echo "unknown"
    fi
}

# ============================================================================
# TIER 2: DEPENDENCY SCANNING
# ============================================================================

# Detect test framework from package.json devDependencies
# Returns: framework name or empty
detect_node_framework() {
    [[ ! -f "package.json" ]] && return 1

    local deps
    deps=$(jq -r '.devDependencies // {} | keys[]' package.json 2>/dev/null || echo "")

    # Priority order: vitest > jest > playwright > cypress > mocha > ava > uvu > tap
    if echo "$deps" | grep -q "^vitest$"; then
        echo "vitest"
    elif echo "$deps" | grep -q "^jest$"; then
        echo "jest"
    elif echo "$deps" | grep -q "^@playwright/test$"; then
        echo "playwright"
    elif echo "$deps" | grep -q "^cypress$"; then
        echo "cypress"
    elif echo "$deps" | grep -q "^mocha$"; then
        echo "mocha"
    elif echo "$deps" | grep -q "^ava$"; then
        echo "ava"
    elif echo "$deps" | grep -q "^uvu$"; then
        echo "uvu"
    elif echo "$deps" | grep -q "^tap$"; then
        echo "tap"
    else
        echo ""
    fi
}

# Detect test framework from Python project
detect_python_framework() {
    if [[ -f "pyproject.toml" ]] && grep -q "pytest" pyproject.toml 2>/dev/null; then
        echo "pytest"
    elif [[ -f "requirements.txt" ]] && grep -q "pytest" requirements.txt 2>/dev/null; then
        echo "pytest"
    else
        echo "pytest"  # Default for Python
    fi
}

# ============================================================================
# TIER 3: TEST FILE ANALYSIS
# ============================================================================

# Detect framework from test file patterns
detect_from_test_files() {
    # Check for BATS files (need globstar for recursive matching)
    if compgen -G "tests/*.bats" >/dev/null 2>&1 || compgen -G "tests/*/*.bats" >/dev/null 2>&1 || { shopt -s globstar 2>/dev/null && compgen -G "**/*.bats" >/dev/null 2>&1; }; then
        echo "bats"
        return 0
    fi

    # Check for vitest/jest config
    if [[ -f "vitest.config.ts" ]] || [[ -f "vitest.config.js" ]]; then
        echo "vitest"
        return 0
    fi
    if [[ -f "jest.config.js" ]] || [[ -f "jest.config.ts" ]]; then
        echo "jest"
        return 0
    fi

    # Check for playwright config
    if [[ -f "playwright.config.ts" ]] || [[ -f "playwright.config.js" ]]; then
        echo "playwright"
        return 0
    fi

    echo ""
    return 1
}

# ============================================================================
# MAIN DETECTION FUNCTIONS
# ============================================================================

# Detect project type with confidence level
# Returns: JSON with type and confidence
# Usage: result=$(detect_project_type)
detect_project_type() {
    local type confidence="HIGH"

    type=$(detect_manifest_type)

    if [[ "$type" == "unknown" ]]; then
        confidence="LOW"
    fi

    jq -n --arg type "$type" --arg confidence "$confidence" \
        '{projectType: $type, confidence: $confidence}'
}

# Detect test framework with confidence
# Returns: JSON with framework, confidence, detectedFrom
# Usage: result=$(detect_test_framework)
detect_test_framework() {
    local project_type framework="" confidence="UNKNOWN" detected_from=""

    project_type=$(detect_manifest_type)

    case "$project_type" in
        node)
            framework=$(detect_node_framework)
            if [[ -n "$framework" ]]; then
                confidence="HIGH"
                detected_from="package.json devDependencies"
            else
                framework=$(detect_from_test_files)
                if [[ -n "$framework" ]]; then
                    confidence="MEDIUM"
                    detected_from="config file detection"
                fi
            fi
            ;;
        python)
            framework=$(detect_python_framework)
            confidence="HIGH"
            detected_from="pyproject.toml/requirements.txt"
            ;;
        rust)
            framework="cargo"
            confidence="HIGH"
            detected_from="Cargo.toml"
            ;;
        go)
            framework="go"
            confidence="HIGH"
            detected_from="go.mod"
            ;;
        deno)
            framework="deno"
            confidence="HIGH"
            detected_from="deno.json"
            ;;
        unknown)
            framework=$(detect_from_test_files)
            if [[ -n "$framework" ]]; then
                confidence="LOW"
                detected_from="test file heuristics"
            else
                framework="custom"
                confidence="UNKNOWN"
                detected_from="none"
            fi
            ;;
    esac

    # Default to bats if still empty (CLEO default)
    [[ -z "$framework" ]] && framework="bats" && confidence="LOW" && detected_from="default fallback"

    jq -n --arg framework "$framework" --arg confidence "$confidence" --arg from "$detected_from" \
        '{framework: $framework, confidence: $confidence, detectedFrom: $from}'
}

# Detect if project is a monorepo
# Returns: "true" or "false"
detect_monorepo() {
    # Check Node.js workspaces
    if [[ -f "package.json" ]] && jq -e '.workspaces' package.json >/dev/null 2>&1; then
        echo "true"
        return 0
    fi

    # Check pnpm workspaces
    if [[ -f "pnpm-workspace.yaml" ]]; then
        echo "true"
        return 0
    fi

    # Check Lerna
    if [[ -f "lerna.json" ]]; then
        echo "true"
        return 0
    fi

    # Check Cargo workspaces
    if [[ -f "Cargo.toml" ]] && grep -q "\[workspace\]" Cargo.toml 2>/dev/null; then
        echo "true"
        return 0
    fi

    echo "false"
}

# Full detection - combines all tiers
# Returns: Complete detection result JSON
run_full_detection() {
    local project_result framework_result monorepo

    project_result=$(detect_project_type)
    framework_result=$(detect_test_framework)
    monorepo=$(detect_monorepo)

    local project_type framework confidence detected_from
    project_type=$(echo "$project_result" | jq -r '.projectType')
    framework=$(echo "$framework_result" | jq -r '.framework')
    confidence=$(echo "$framework_result" | jq -r '.confidence')
    detected_from=$(echo "$framework_result" | jq -r '.detectedFrom')

    jq -n \
        --arg projectType "$project_type" \
        --arg framework "$framework" \
        --arg confidence "$confidence" \
        --arg detectedFrom "$detected_from" \
        --argjson monorepo "$monorepo" \
        '{
            success: true,
            projectType: $projectType,
            framework: $framework,
            confidence: $confidence,
            detectedFrom: $detectedFrom,
            monorepo: $monorepo
        }'
}

# Export functions
export -f detect_manifest_type
export -f detect_node_framework
export -f detect_python_framework
export -f detect_from_test_files
export -f detect_project_type
export -f detect_test_framework
export -f detect_monorepo
export -f run_full_detection
