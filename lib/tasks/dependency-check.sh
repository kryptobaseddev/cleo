#!/usr/bin/env bash
# Centralized dependency validation for cleo
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: platform-compat.sh (optional)
# PROVIDES: check_dependencies, check_critical_deps, check_required_deps,
#           check_optional_deps, get_install_hint, validate_bash_version

#=== SOURCE GUARD ================================================
[[ -n "${_DEPENDENCY_CHECK_LOADED:-}" ]] && return 0
declare -r _DEPENDENCY_CHECK_LOADED=1

set -euo pipefail

# ============================================================================
# DEPENDENCY CHECK MODULE
# ============================================================================
# This module provides centralized dependency validation for cleo
# system. All dependency checks should be routed through this module.
#
# Dependencies are categorized as:
#   - CRITICAL: Required for basic operation (jq, bash 4+)
#   - REQUIRED: Needed for core features (sha256sum, tar, flock, date, find)
#   - OPTIONAL: Enhance functionality (numfmt, ajv, jsonschema)
# ============================================================================

# Source platform-compat for platform detection if available
_DEP_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$_DEP_CHECK_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=platform-compat.sh
    source "$_DEP_CHECK_DIR/core/platform-compat.sh"
elif [[ -z "${PLATFORM:-}" ]]; then
    # Minimal platform detection fallback
    case "$(uname -s)" in
        Linux*)     PLATFORM="linux" ;;
        Darwin*)    PLATFORM="macos" ;;
        CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
        *)          PLATFORM="unknown" ;;
    esac
fi

# ============================================================================
# CONFIGURATION
# ============================================================================

# Minimum required bash version (major.minor)
REQUIRED_BASH_MAJOR=4
REQUIRED_BASH_MINOR=0

# Dependency categories
declare -A DEP_CRITICAL=(
    [jq]="JSON processing - core functionality"
    [bash]="Bash 4+ required for associative arrays"
)

declare -A DEP_REQUIRED=(
    [sha256sum]="Checksum verification for integrity"
    [tar]="Archive creation and extraction"
    [flock]="File locking for atomic operations"
    [date]="Timestamp generation (POSIX)"
    [find]="File discovery (POSIX)"
)

declare -A DEP_OPTIONAL=(
    [numfmt]="Human-readable size formatting"
    [ajv]="JSON Schema validation (ajv-cli)"
    [jsonschema]="JSON Schema validation (Python)"
)

# ============================================================================
# PLATFORM-SPECIFIC INSTALL HINTS
# ============================================================================

# Get install command for a dependency on the current platform
get_install_hint() {
    local dep="$1"
    local platform="${PLATFORM:-unknown}"

    case "$dep" in
        jq)
            case "$platform" in
                linux)   echo "sudo apt install jq  OR  sudo yum install jq  OR  sudo dnf install jq" ;;
                macos)   echo "brew install jq" ;;
                windows) echo "choco install jq  OR  scoop install jq" ;;
                *)       echo "Install jq from https://stedolan.github.io/jq/download/" ;;
            esac
            ;;
        sha256sum)
            case "$platform" in
                linux)   echo "Usually pre-installed. If missing: sudo apt install coreutils" ;;
                macos)   echo "Use 'shasum -a 256' (pre-installed) or brew install coreutils" ;;
                windows) echo "choco install coreutils  OR  use CertUtil -hashfile" ;;
                *)       echo "Part of GNU coreutils" ;;
            esac
            ;;
        tar)
            case "$platform" in
                linux)   echo "sudo apt install tar  (usually pre-installed)" ;;
                macos)   echo "Pre-installed. For GNU tar: brew install gnu-tar" ;;
                windows) echo "choco install tartool  OR  use built-in Windows tar" ;;
                *)       echo "Install tar from your package manager" ;;
            esac
            ;;
        flock)
            case "$platform" in
                linux)   echo "sudo apt install util-linux  (usually pre-installed)" ;;
                macos)   echo "brew install flock  OR  brew install util-linux" ;;
                windows) echo "Not natively available - use WSL or Cygwin" ;;
                *)       echo "Part of util-linux package" ;;
            esac
            ;;
        numfmt)
            case "$platform" in
                linux)   echo "sudo apt install coreutils  (usually pre-installed)" ;;
                macos)   echo "brew install coreutils  (provides gnumfmt)" ;;
                windows) echo "choco install coreutils" ;;
                *)       echo "Part of GNU coreutils" ;;
            esac
            ;;
        date)
            echo "POSIX standard tool - should be pre-installed on all systems"
            ;;
        find)
            echo "POSIX standard tool - should be pre-installed on all systems"
            ;;
        ajv)
            echo "npm install -g ajv-cli" ;;
        jsonschema)
            echo "pip install jsonschema" ;;
        bash)
            case "$platform" in
                linux)   echo "sudo apt install bash  (check with: bash --version)" ;;
                macos)   echo "brew install bash  (macOS ships with bash 3.x)" ;;
                windows) echo "Use Git Bash, WSL, or Cygwin for bash 4+" ;;
                *)       echo "Install bash 4+ from your package manager" ;;
            esac
            ;;
        *)
            echo "Check your system package manager" ;;
    esac
}

# ============================================================================
# INDIVIDUAL DEPENDENCY CHECKS
# ============================================================================

# Check if a command exists
dep_command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check jq availability
check_jq() {
    if dep_command_exists jq; then
        local version
        version=$(jq --version 2>/dev/null | sed 's/jq-//' || echo "unknown")
        echo "jq:ok:$version"
        return 0
    fi
    echo "jq:missing:"
    return 1
}

# Check bash version (T168)
check_bash_version() {
    local major="${BASH_VERSINFO[0]:-0}"
    local minor="${BASH_VERSINFO[1]:-0}"
    local version="${BASH_VERSION:-unknown}"

    if (( major > REQUIRED_BASH_MAJOR )) || \
       (( major == REQUIRED_BASH_MAJOR && minor >= REQUIRED_BASH_MINOR )); then
        echo "bash:ok:$version"
        return 0
    fi
    echo "bash:outdated:$version:requires $REQUIRED_BASH_MAJOR.$REQUIRED_BASH_MINOR+"
    return 1
}

# Check sha256sum/shasum availability (T170)
check_sha256sum() {
    # Try sha256sum first (GNU coreutils - Linux)
    if dep_command_exists sha256sum; then
        local version
        version=$(sha256sum --version 2>/dev/null | head -1 || echo "available")
        echo "sha256sum:ok:$version"
        return 0
    fi

    # Try shasum (BSD/macOS) with -a 256
    if dep_command_exists shasum; then
        echo "sha256sum:ok:shasum-fallback"
        return 0
    fi

    echo "sha256sum:missing:"
    return 1
}

# Get the appropriate sha256 command for this system
get_sha256_command() {
    if dep_command_exists sha256sum; then
        echo "sha256sum"
    elif dep_command_exists shasum; then
        echo "shasum -a 256"
    else
        echo ""
    fi
}

# Check tar availability (T171)
check_tar() {
    if dep_command_exists tar; then
        local version
        version=$(tar --version 2>/dev/null | head -1 || echo "available")
        echo "tar:ok:$version"
        return 0
    fi
    echo "tar:missing:"
    return 1
}

# Check flock availability (T172)
check_flock() {
    if dep_command_exists flock; then
        local version
        version=$(flock --version 2>/dev/null | head -1 || echo "available")
        echo "flock:ok:$version"
        return 0
    fi
    echo "flock:missing:"
    return 1
}

# Check numfmt availability (T173)
check_numfmt() {
    # Try numfmt first (GNU coreutils)
    if dep_command_exists numfmt; then
        local version
        version=$(numfmt --version 2>/dev/null | head -1 || echo "available")
        echo "numfmt:ok:$version"
        return 0
    fi

    # Try gnumfmt (macOS with coreutils)
    if dep_command_exists gnumfmt; then
        echo "numfmt:ok:gnumfmt-fallback"
        return 0
    fi

    echo "numfmt:missing:"
    return 1
}

# Get the appropriate numfmt command for this system
get_numfmt_command() {
    if dep_command_exists numfmt; then
        echo "numfmt"
    elif dep_command_exists gnumfmt; then
        echo "gnumfmt"
    else
        echo ""
    fi
}

# Check date availability (T174)
check_date() {
    if dep_command_exists date; then
        # Test basic functionality
        if date +%Y-%m-%d >/dev/null 2>&1; then
            echo "date:ok:POSIX"
            return 0
        fi
    fi
    echo "date:missing:"
    return 1
}

# Check find availability (T174)
check_find() {
    if dep_command_exists find; then
        # Test basic functionality
        if find . -maxdepth 0 >/dev/null 2>&1; then
            echo "find:ok:POSIX"
            return 0
        fi
    fi
    echo "find:missing:"
    return 1
}

# ============================================================================
# COMPREHENSIVE VALIDATION
# ============================================================================

# Check all critical dependencies
# Returns: 0 if all OK, 1 if any missing
check_critical_deps() {
    local missing=()
    local outdated=()

    # Check jq
    if ! check_jq >/dev/null 2>&1; then
        missing+=("jq")
    fi

    # Check bash version
    local bash_result
    bash_result=$(check_bash_version)
    if [[ "$bash_result" == *":outdated:"* ]]; then
        outdated+=("bash (have: ${BASH_VERSION:-unknown}, need: $REQUIRED_BASH_MAJOR.$REQUIRED_BASH_MINOR+)")
    fi

    if [[ ${#missing[@]} -gt 0 ]] || [[ ${#outdated[@]} -gt 0 ]]; then
        return 1
    fi
    return 0
}

# Check all required dependencies
# Returns: 0 if all OK, 1 if any missing
check_required_deps() {
    local missing=()

    # sha256sum (or shasum)
    if ! check_sha256sum >/dev/null 2>&1; then
        missing+=("sha256sum")
    fi

    # tar
    if ! check_tar >/dev/null 2>&1; then
        missing+=("tar")
    fi

    # flock
    if ! check_flock >/dev/null 2>&1; then
        missing+=("flock")
    fi

    # date (POSIX)
    if ! check_date >/dev/null 2>&1; then
        missing+=("date")
    fi

    # find (POSIX)
    if ! check_find >/dev/null 2>&1; then
        missing+=("find")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        return 1
    fi
    return 0
}

# Check all optional dependencies
# Returns: always 0 (optional), but sets OPTIONAL_MISSING array
check_optional_deps() {
    OPTIONAL_MISSING=()

    # numfmt
    if ! check_numfmt >/dev/null 2>&1; then
        OPTIONAL_MISSING+=("numfmt")
    fi

    # ajv (optional schema validator)
    if ! dep_command_exists ajv; then
        OPTIONAL_MISSING+=("ajv")
    fi

    # jsonschema (optional schema validator)
    if ! dep_command_exists jsonschema; then
        OPTIONAL_MISSING+=("jsonschema")
    fi

    return 0
}

# ============================================================================
# MASTER VALIDATION FUNCTION (T166)
# ============================================================================

# Comprehensive dependency check for install.sh
# Args: --quiet (suppress OK messages), --strict (fail on optional missing)
# Returns: 0 if all critical/required OK, 1 otherwise
validate_all_dependencies() {
    local quiet=false
    local strict=false
    local exit_code=0

    for arg in "$@"; do
        case "$arg" in
            --quiet|-q) quiet=true ;;
            --strict|-s) strict=true ;;
        esac
    done

    local critical_missing=()
    local critical_outdated=()
    local required_missing=()
    local optional_missing=()

    # ========== CRITICAL DEPENDENCIES ==========

    # jq
    local jq_result
    jq_result=$(check_jq 2>/dev/null || echo "jq:missing:")
    if [[ "$jq_result" == *":missing:"* ]]; then
        critical_missing+=("jq")
    elif [[ "$quiet" == "false" ]]; then
        local jq_ver="${jq_result##*:}"
        echo "[OK] jq ($jq_ver)"
    fi

    # bash version
    local bash_result
    bash_result=$(check_bash_version 2>/dev/null || echo "bash:outdated:${BASH_VERSION:-unknown}")
    if [[ "$bash_result" == *":outdated:"* ]]; then
        critical_outdated+=("bash (have: ${BASH_VERSION:-unknown}, need: $REQUIRED_BASH_MAJOR.$REQUIRED_BASH_MINOR+)")
    elif [[ "$quiet" == "false" ]]; then
        echo "[OK] bash (${BASH_VERSION:-unknown})"
    fi

    # ========== REQUIRED DEPENDENCIES ==========

    # sha256sum
    local sha_result
    sha_result=$(check_sha256sum 2>/dev/null || echo "sha256sum:missing:")
    if [[ "$sha_result" == *":missing:"* ]]; then
        required_missing+=("sha256sum")
    elif [[ "$quiet" == "false" ]]; then
        local sha_type="${sha_result##*:}"
        [[ "$sha_type" == "shasum-fallback" ]] && sha_type="shasum -a 256"
        echo "[OK] sha256sum ($sha_type)"
    fi

    # tar
    local tar_result
    tar_result=$(check_tar 2>/dev/null || echo "tar:missing:")
    if [[ "$tar_result" == *":missing:"* ]]; then
        required_missing+=("tar")
    elif [[ "$quiet" == "false" ]]; then
        echo "[OK] tar"
    fi

    # flock
    local flock_result
    flock_result=$(check_flock 2>/dev/null || echo "flock:missing:")
    if [[ "$flock_result" == *":missing:"* ]]; then
        required_missing+=("flock")
    elif [[ "$quiet" == "false" ]]; then
        echo "[OK] flock"
    fi

    # date
    local date_result
    date_result=$(check_date 2>/dev/null || echo "date:missing:")
    if [[ "$date_result" == *":missing:"* ]]; then
        required_missing+=("date")
    elif [[ "$quiet" == "false" ]]; then
        echo "[OK] date (POSIX)"
    fi

    # find
    local find_result
    find_result=$(check_find 2>/dev/null || echo "find:missing:")
    if [[ "$find_result" == *":missing:"* ]]; then
        required_missing+=("find")
    elif [[ "$quiet" == "false" ]]; then
        echo "[OK] find (POSIX)"
    fi

    # ========== OPTIONAL DEPENDENCIES ==========

    # numfmt
    local numfmt_result
    numfmt_result=$(check_numfmt 2>/dev/null || echo "numfmt:missing:")
    if [[ "$numfmt_result" == *":missing:"* ]]; then
        optional_missing+=("numfmt")
    elif [[ "$quiet" == "false" ]]; then
        local numfmt_type="${numfmt_result##*:}"
        [[ "$numfmt_type" == "gnumfmt-fallback" ]] && numfmt_type="gnumfmt"
        echo "[OK] numfmt ($numfmt_type)"
    fi

    # ajv (optional)
    if dep_command_exists ajv; then
        [[ "$quiet" == "false" ]] && echo "[OK] ajv (JSON Schema validator)"
    else
        optional_missing+=("ajv")
    fi

    # jsonschema (optional)
    if dep_command_exists jsonschema; then
        [[ "$quiet" == "false" ]] && echo "[OK] jsonschema (Python JSON Schema validator)"
    else
        optional_missing+=("jsonschema")
    fi

    # ========== REPORT RESULTS ==========

    echo ""

    # Critical errors
    if [[ ${#critical_missing[@]} -gt 0 ]]; then
        echo "CRITICAL - Missing dependencies:"
        for dep in "${critical_missing[@]}"; do
            echo "  [MISSING] $dep - ${DEP_CRITICAL[$dep]:-Required}"
            echo "            Install: $(get_install_hint "$dep")"
        done
        echo ""
        exit_code=1
    fi

    if [[ ${#critical_outdated[@]} -gt 0 ]]; then
        echo "CRITICAL - Outdated dependencies:"
        for dep in "${critical_outdated[@]}"; do
            echo "  [OUTDATED] $dep"
            echo "             Install: $(get_install_hint bash)"
        done
        echo ""
        exit_code=1
    fi

    # Required errors
    if [[ ${#required_missing[@]} -gt 0 ]]; then
        echo "REQUIRED - Missing dependencies:"
        for dep in "${required_missing[@]}"; do
            echo "  [MISSING] $dep - ${DEP_REQUIRED[$dep]:-Required for full functionality}"
            echo "            Install: $(get_install_hint "$dep")"
        done
        echo ""
        exit_code=1
    fi

    # Optional warnings
    if [[ ${#optional_missing[@]} -gt 0 ]]; then
        echo "OPTIONAL - Missing (system will work, some features limited):"
        for dep in "${optional_missing[@]}"; do
            echo "  [OPTIONAL] $dep - ${DEP_OPTIONAL[$dep]:-Enhanced functionality}"
            echo "             Install: $(get_install_hint "$dep")"
        done
        echo ""
        if [[ "$strict" == "true" ]]; then
            exit_code=1
        fi
    fi

    # Summary
    if [[ $exit_code -eq 0 ]]; then
        echo "All required dependencies are available."
    else
        echo "Some dependencies are missing. Please install them before continuing."
    fi

    return $exit_code
}

# Quick check for scripts (just validates critical deps)
quick_dependency_check() {
    local missing=()

    # jq is always required
    if ! dep_command_exists jq; then
        missing+=("jq")
    fi

    # date is always required
    if ! dep_command_exists date; then
        missing+=("date")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "ERROR: Missing required tools: ${missing[*]}" >&2
        echo "Run 'cleo --check-deps' for installation instructions." >&2
        return 1
    fi
    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f dep_command_exists
export -f check_jq
export -f check_bash_version
export -f check_sha256sum
export -f get_sha256_command
export -f check_tar
export -f check_flock
export -f check_numfmt
export -f get_numfmt_command
export -f check_date
export -f check_find
export -f check_critical_deps
export -f check_required_deps
export -f check_optional_deps
export -f validate_all_dependencies
export -f quick_dependency_check
export -f get_install_hint

export REQUIRED_BASH_MAJOR
export REQUIRED_BASH_MINOR
