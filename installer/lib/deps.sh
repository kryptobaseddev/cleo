#!/usr/bin/env bash
# CLEO Installer - Dependency Management
# Verifies and reports on required and optional dependencies
#
# Version: 1.0.0
# Task: T1860
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# LAYER: 1 (Utilities)
# DEPENDENCIES: core.sh
# PROVIDES: installer_deps_check_all, installer_deps_check_required,
#           installer_deps_check_optional, installer_deps_report

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_DEPS_LOADED:-}" ]] && return 0
readonly _INSTALLER_DEPS_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# ============================================
# CONSTANTS
# ============================================
readonly DEPS_NODE_MIN_VERSION=20
readonly DEPS_BASH_MIN_VERSION=4
readonly DEPS_JQ_MIN_VERSION="1.5"

# Dependency status tracking (using simple variables for Bash 3.2 compatibility)
DEPS_STATUS_node=""
DEPS_STATUS_npm=""
DEPS_STATUS_bash=""
DEPS_STATUS_jq=""
DEPS_STATUS_checksum=""
DEPS_STATUS_ajv=""
DEPS_STATUS_git=""
DEPS_STATUS_downloader=""
DEPS_VERSION_node=""
DEPS_VERSION_npm=""
DEPS_VERSION_bash=""
DEPS_VERSION_jq=""
DEPS_VERSION_checksum=""
DEPS_VERSION_ajv=""
DEPS_VERSION_git=""
DEPS_VERSION_downloader=""

# ============================================
# PLATFORM DETECTION
# ============================================

# Detect operating system
# Returns: linux, darwin, wsl, unknown
installer_deps_detect_os() {
    local os="unknown"

    case "$(uname -s)" in
        Linux*)
            if grep -q Microsoft /proc/version 2>/dev/null; then
                os="wsl"
            else
                os="linux"
            fi
            ;;
        Darwin*)
            os="darwin"
            ;;
    esac

    echo "$os"
}

# Detect system architecture
# Returns: x86_64, aarch64, arm64, unknown
installer_deps_detect_arch() {
    local arch
    arch=$(uname -m)

    case "$arch" in
        x86_64|amd64)
            echo "x86_64"
            ;;
        aarch64|arm64)
            echo "aarch64"
            ;;
        *)
            echo "$arch"
            ;;
    esac
}

# Detect package manager
# Returns: apt, dnf, yum, brew, pacman, apk, unknown
installer_deps_detect_package_manager() {
    if command -v apt-get &>/dev/null; then
        echo "apt"
    elif command -v dnf &>/dev/null; then
        echo "dnf"
    elif command -v yum &>/dev/null; then
        echo "yum"
    elif command -v brew &>/dev/null; then
        echo "brew"
    elif command -v pacman &>/dev/null; then
        echo "pacman"
    elif command -v apk &>/dev/null; then
        echo "apk"
    else
        echo "unknown"
    fi
}

# ============================================
# DEPENDENCY CHECKS
# ============================================

# Check Node.js availability and version (required: 20+)
# Returns: 0 if meets requirements, 1 otherwise
installer_deps_check_node() {
    if ! command -v node &>/dev/null; then
        DEPS_VERSION_node=""
        DEPS_STATUS_node="missing"
        installer_log_error "Node.js is required but not found"
        return 1
    fi

    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/^v//')
    DEPS_VERSION_node="$node_version"

    local node_major
    node_major=$(echo "$node_version" | cut -d. -f1)

    if [[ "$node_major" -ge "$DEPS_NODE_MIN_VERSION" ]]; then
        DEPS_STATUS_node="ok"
        installer_log_debug "Node.js version $node_version meets requirements (>= $DEPS_NODE_MIN_VERSION)"
        return 0
    else
        DEPS_STATUS_node="fail"
        installer_log_error "Node.js version $node_version is too old (need >= $DEPS_NODE_MIN_VERSION)"
        return 1
    fi
}

# Check npm availability (required)
# Returns: 0 if available, 1 otherwise
installer_deps_check_npm() {
    if command -v npm &>/dev/null; then
        local npm_version
        npm_version=$(npm -v 2>/dev/null)
        DEPS_VERSION_npm="$npm_version"
        DEPS_STATUS_npm="ok"
        installer_log_debug "npm version $npm_version found"
        return 0
    else
        DEPS_VERSION_npm=""
        DEPS_STATUS_npm="missing"
        installer_log_error "npm is required but not found"
        return 1
    fi
}

# Check Bash version (optional for TypeScript CLEO, used by installer itself)
# Returns: 0 if meets requirements, 1 otherwise
installer_deps_check_bash() {
    local bash_version="${BASH_VERSION%%.*}"

    DEPS_VERSION_bash="$BASH_VERSION"

    if [[ "$bash_version" -ge "$DEPS_BASH_MIN_VERSION" ]]; then
        DEPS_STATUS_bash="ok"
        installer_log_debug "Bash version $BASH_VERSION meets requirements (>= $DEPS_BASH_MIN_VERSION)"
        return 0
    else
        DEPS_STATUS_bash="fail"
        installer_log_error "Bash version $BASH_VERSION is too old (need >= $DEPS_BASH_MIN_VERSION)"
        return 1
    fi
}

# Check jq availability (required)
# Returns: 0 if available, 1 otherwise
installer_deps_check_jq() {
    if command -v jq &>/dev/null; then
        local jq_version
        jq_version=$(jq --version 2>/dev/null | sed 's/jq-//')
        DEPS_VERSION_jq="$jq_version"
        DEPS_STATUS_jq="ok"
        installer_log_debug "jq version $jq_version found"
        return 0
    else
        DEPS_VERSION_jq=""
        DEPS_STATUS_jq="missing"
        installer_log_error "jq is required but not found"
        return 1
    fi
}

# Check sha256sum/shasum availability (required for checksums)
# Returns: 0 if available, 1 otherwise
installer_deps_check_checksum() {
    if command -v sha256sum &>/dev/null; then
        DEPS_VERSION_checksum="sha256sum"
        DEPS_STATUS_checksum="ok"
        installer_log_debug "sha256sum found"
        return 0
    elif command -v shasum &>/dev/null; then
        DEPS_VERSION_checksum="shasum"
        DEPS_STATUS_checksum="ok"
        installer_log_debug "shasum found (BSD variant)"
        return 0
    else
        DEPS_VERSION_checksum=""
        DEPS_STATUS_checksum="missing"
        installer_log_warn "No checksum utility found (sha256sum or shasum)"
        return 1
    fi
}

# Check ajv-cli availability (optional - for JSON Schema validation)
# Returns: 0 if available, 1 otherwise
installer_deps_check_ajv() {
    if command -v ajv &>/dev/null; then
        local ajv_version
        ajv_version=$(ajv --version 2>/dev/null || echo "unknown")
        DEPS_VERSION_ajv="$ajv_version"
        DEPS_STATUS_ajv="ok"
        installer_log_debug "ajv-cli found: $ajv_version"
        return 0
    else
        DEPS_VERSION_ajv=""
        DEPS_STATUS_ajv="missing"
        installer_log_debug "ajv-cli not found (optional)"
        return 1
    fi
}

# Check git availability (optional - for version control features)
# Returns: 0 if available, 1 otherwise
installer_deps_check_git() {
    if command -v git &>/dev/null; then
        local git_version
        git_version=$(git --version 2>/dev/null | sed 's/git version //')
        DEPS_VERSION_git="$git_version"
        DEPS_STATUS_git="ok"
        installer_log_debug "git found: $git_version"
        return 0
    else
        DEPS_VERSION_git=""
        DEPS_STATUS_git="missing"
        installer_log_debug "git not found (optional)"
        return 1
    fi
}

# Check curl/wget availability (optional - for remote downloads)
# Returns: 0 if available, 1 otherwise
installer_deps_check_downloader() {
    if command -v curl &>/dev/null; then
        local curl_version
        curl_version=$(curl --version 2>/dev/null | head -1 | sed 's/curl //' | cut -d' ' -f1)
        DEPS_VERSION_downloader="curl:$curl_version"
        DEPS_STATUS_downloader="ok"
        installer_log_debug "curl found: $curl_version"
        return 0
    elif command -v wget &>/dev/null; then
        local wget_version
        wget_version=$(wget --version 2>/dev/null | head -1 | sed 's/GNU Wget //' | cut -d' ' -f1)
        DEPS_VERSION_downloader="wget:$wget_version"
        DEPS_STATUS_downloader="ok"
        installer_log_debug "wget found: $wget_version"
        return 0
    else
        DEPS_VERSION_downloader=""
        DEPS_STATUS_downloader="missing"
        installer_log_debug "No downloader found (curl or wget - optional)"
        return 1
    fi
}

# ============================================
# AGGREGATE CHECKS
# ============================================

# Check all required dependencies
# Returns: 0 if all required deps met, 1 otherwise
installer_deps_check_required() {
    local failed=0

    installer_log_info "Checking required dependencies..."

    # Primary: Node.js and npm (required for TypeScript CLEO)
    installer_deps_check_node || ((failed++))
    installer_deps_check_npm || ((failed++))

    # Secondary: bash and jq are optional for the TypeScript version
    # but still useful for the installer itself
    installer_deps_check_bash || true
    installer_deps_check_jq || true

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Missing $failed required dependency(s)"
        return 1
    fi

    installer_log_info "All required dependencies satisfied"
    return 0
}

# Check all optional dependencies
# Returns: 0 always (optional deps don't fail installation)
installer_deps_check_optional() {
    installer_log_info "Checking optional dependencies..."

    installer_deps_check_checksum || true
    installer_deps_check_ajv || true
    installer_deps_check_git || true
    installer_deps_check_downloader || true

    return 0
}

# Check all dependencies (required + optional)
# Returns: 0 if required deps met, 1 otherwise
installer_deps_check_all() {
    local result=0

    installer_deps_check_required || result=1
    installer_deps_check_optional

    return $result
}

# ============================================
# REPORTING
# ============================================

# Generate dependency report as JSON
# Args: [format: json|text] (default: json)
# Outputs: JSON or formatted text report
installer_deps_report() {
    local format="${1:-json}"

    # Ensure all checks have been run
    if [[ ${#DEPS_STATUS[@]} -eq 0 ]]; then
        installer_deps_check_all
    fi

    local os arch pkg_manager
    os=$(installer_deps_detect_os)
    arch=$(installer_deps_detect_arch)
    pkg_manager=$(installer_deps_detect_package_manager)

    if [[ "$format" == "json" ]]; then
        local json_deps="{"
        local first=true

        for dep in "${!DEPS_STATUS[@]}"; do
            if [[ "$first" != "true" ]]; then
                json_deps+=","
            fi
            first=false
            json_deps+="\"$dep\":{\"status\":\"${DEPS_STATUS[$dep]}\",\"version\":\"${DEPS_VERSION[$dep]:-}\"}"
        done
        json_deps+="}"

        jq -n \
            --arg os "$os" \
            --arg arch "$arch" \
            --arg pkg_manager "$pkg_manager" \
            --argjson deps "$json_deps" \
            '{
                platform: {
                    os: $os,
                    arch: $arch,
                    package_manager: $pkg_manager
                },
                dependencies: $deps
            }'
    else
        echo "===== Dependency Report ====="
        echo ""
        echo "Platform:"
        echo "  OS:              $os"
        echo "  Architecture:    $arch"
        echo "  Package Manager: $pkg_manager"
        echo ""
        echo "Required Dependencies:"
        printf "  %-15s %-10s %s\n" "bash" "${DEPS_STATUS[bash]:-unknown}" "${DEPS_VERSION[bash]:-}"
        printf "  %-15s %-10s %s\n" "jq" "${DEPS_STATUS[jq]:-unknown}" "${DEPS_VERSION[jq]:-}"
        echo ""
        echo "Optional Dependencies:"
        printf "  %-15s %-10s %s\n" "checksum" "${DEPS_STATUS[checksum]:-unknown}" "${DEPS_VERSION[checksum]:-}"
        printf "  %-15s %-10s %s\n" "ajv-cli" "${DEPS_STATUS[ajv]:-unknown}" "${DEPS_VERSION[ajv]:-}"
        printf "  %-15s %-10s %s\n" "git" "${DEPS_STATUS[git]:-unknown}" "${DEPS_VERSION[git]:-}"
        printf "  %-15s %-10s %s\n" "downloader" "${DEPS_STATUS[downloader]:-unknown}" "${DEPS_VERSION[downloader]:-}"
        echo ""
    fi
}

# Get installation instructions for missing dependencies
# Outputs: Platform-specific installation commands
installer_deps_install_instructions() {
    local pkg_manager
    pkg_manager=$(installer_deps_detect_package_manager)

    echo "Installation instructions for missing dependencies:"
    echo ""

    if [[ "$DEPS_STATUS_node" == "missing" || "$DEPS_STATUS_node" == "fail" ]]; then
        echo "Node.js >= ${DEPS_NODE_MIN_VERSION} (required):"
        echo "  nvm (recommended): curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
        echo "                     nvm install ${DEPS_NODE_MIN_VERSION}"
        case "$pkg_manager" in
            apt)    echo "  apt:     sudo apt-get install nodejs npm" ;;
            brew)   echo "  Homebrew: brew install node@${DEPS_NODE_MIN_VERSION}" ;;
            dnf)    echo "  dnf:     sudo dnf install nodejs npm" ;;
            *)      echo "  Official: https://nodejs.org/" ;;
        esac
        echo ""
    fi

    if [[ "$DEPS_STATUS_npm" == "missing" ]]; then
        echo "npm (required, usually included with Node.js):"
        echo "  Install Node.js to get npm included."
        echo ""
    fi

    if [[ "$DEPS_STATUS_jq" == "missing" ]]; then
        echo "jq (optional - used by some legacy features):"
        case "$pkg_manager" in
            apt)    echo "  sudo apt-get install jq" ;;
            dnf)    echo "  sudo dnf install jq" ;;
            yum)    echo "  sudo yum install jq" ;;
            brew)   echo "  brew install jq" ;;
            pacman) echo "  sudo pacman -S jq" ;;
            apk)    echo "  apk add jq" ;;
            *)      echo "  Download from: https://stedolan.github.io/jq/download/" ;;
        esac
        echo ""
    fi
}

# Attempt to auto-install missing dependencies
# Returns: 0 if all required deps installed, 1 if failed
installer_deps_auto_install() {
    # Node.js and npm cannot be reliably auto-installed via package managers
    # because versions are often too old. Guide users to proper install methods.
    if [[ "$DEPS_STATUS_node" == "missing" || "$DEPS_STATUS_node" == "fail" || "$DEPS_STATUS_npm" == "missing" ]]; then
        installer_log_warn "Node.js >= ${DEPS_NODE_MIN_VERSION} and npm are required"
        installer_log_info ""
        installer_log_info "Install Node.js using one of these methods:"
        installer_log_info ""
        installer_log_info "  nvm (recommended):"
        installer_log_info "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
        installer_log_info "    nvm install ${DEPS_NODE_MIN_VERSION}"
        installer_log_info ""
        installer_log_info "  Official installer:"
        installer_log_info "    https://nodejs.org/"
        installer_log_info ""
        return 1
    fi

    installer_log_success "All required dependencies are installed"
    return 0
}

# ============================================
# EXPORT PUBLIC API
# ============================================
export -f installer_deps_detect_os
export -f installer_deps_detect_arch
export -f installer_deps_detect_package_manager
export -f installer_deps_check_node
export -f installer_deps_check_npm
export -f installer_deps_check_bash
export -f installer_deps_check_jq
export -f installer_deps_check_checksum
export -f installer_deps_check_ajv
export -f installer_deps_check_git
export -f installer_deps_check_downloader
export -f installer_deps_check_required
export -f installer_deps_check_optional
export -f installer_deps_check_all
export -f installer_deps_report
export -f installer_deps_install_instructions
export -f installer_deps_auto_install
