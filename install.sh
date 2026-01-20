#!/usr/bin/env bash
#
# CLEO Installer - User-friendly entry point
# Delegates to the modular installer at installer/install.sh
#
# Usage:
#   ./install.sh              # Interactive mode (human)
#   ./install.sh --auto       # Non-interactive (AI agent)
#   ./install.sh --dev        # Development mode (symlinks)
#   ./install.sh --help       # Show all options
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/installer/install.sh"

# Colors (disabled if not TTY or NO_COLOR set)
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
    BOLD='\033[1m'
    DIM='\033[2m'
    BLUE='\033[34m'
    GREEN='\033[32m'
    YELLOW='\033[33m'
    CYAN='\033[36m'
    RESET='\033[0m'
else
    BOLD='' DIM='' BLUE='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

show_banner() {
    echo -e "${BOLD}${BLUE}"
    echo "   _____ _      ______ ____  "
    echo "  / ____| |    |  ____/ __ \\ "
    echo " | |    | |    | |__ | |  | |"
    echo " | |    | |    |  __|| |  | |"
    echo " | |____| |____| |___| |__| |"
    echo "  \\_____|______|______\\____/ "
    echo -e "${RESET}"
    echo -e "${DIM}Command Line Entity Orchestrator${RESET}"
    echo ""
}

show_help() {
    echo "CLEO Installer"
    echo ""
    echo "Usage: ./install.sh [OPTIONS]"
    echo ""
    echo "Installation Modes:"
    echo "  --dev             Development mode (symlinks to repo)"
    echo "  --release         Release mode (copy files)"
    echo "  --auto            Non-interactive mode for AI agents"
    echo ""
    echo "Options:"
    echo "  --force           Overwrite existing installation"
    echo "  --skip-profile    Skip shell profile updates"
    echo "  --skip-skills     Skip skills installation"
    echo "  --version VER     Install specific version"
    echo ""
    echo "Information:"
    echo "  --check-deps      Check dependencies only"
    echo "  --status          Show installation status"
    echo "  --help            Show this help"
    echo ""
    echo "Recovery:"
    echo "  --recover         Recover from interrupted installation"
    echo "  --rollback        Rollback to previous backup"
    echo "  --uninstall       Remove CLEO installation"
    echo ""
    echo "Examples:"
    echo "  ./install.sh                    # Interactive installation"
    echo "  ./install.sh --auto --dev       # AI agent, dev mode"
    echo "  ./install.sh --force            # Reinstall/upgrade"
    echo ""
}

interactive_install() {
    show_banner

    echo -e "${CYAN}Welcome to the CLEO installer!${RESET}"
    echo ""

    # Check if this looks like a git repo (dev mode candidate)
    local is_git_repo=false
    [[ -d "$SCRIPT_DIR/.git" ]] && is_git_repo=true

    # Detect existing installation
    local has_existing=false
    [[ -d "$HOME/.cleo" ]] && has_existing=true

    if $has_existing; then
        local current_version=$(cat "$HOME/.cleo/VERSION" 2>/dev/null | head -1 || echo "unknown")
        echo -e "${YELLOW}Existing installation detected: v${current_version}${RESET}"
        echo ""
    fi

    # Installation mode selection
    echo -e "${BOLD}Select installation mode:${RESET}"
    echo ""
    if $is_git_repo; then
        echo -e "  ${GREEN}1)${RESET} Development mode ${DIM}(recommended for contributors)${RESET}"
        echo "     Creates symlinks to this repository"
        echo "     Changes in repo reflect immediately"
        echo ""
        echo -e "  ${GREEN}2)${RESET} Release mode"
        echo "     Copies files to ~/.cleo"
        echo "     Independent of this repository"
    else
        echo -e "  ${GREEN}1)${RESET} Standard installation ${DIM}(recommended)${RESET}"
        echo "     Copies files to ~/.cleo"
        echo ""
        echo -e "  ${GREEN}2)${RESET} Development mode"
        echo "     Creates symlinks (requires git clone)"
    fi
    echo ""

    local choice
    read -p "Enter choice [1]: " choice
    choice="${choice:-1}"

    local mode_flag=""
    case "$choice" in
        1)
            if $is_git_repo; then
                mode_flag="--dev"
                echo -e "\n${GREEN}→ Development mode selected${RESET}\n"
            else
                mode_flag=""
                echo -e "\n${GREEN}→ Standard installation selected${RESET}\n"
            fi
            ;;
        2)
            if $is_git_repo; then
                mode_flag=""
                echo -e "\n${GREEN}→ Release mode selected${RESET}\n"
            else
                mode_flag="--dev"
                echo -e "\n${GREEN}→ Development mode selected${RESET}\n"
            fi
            ;;
        *)
            echo -e "${YELLOW}Invalid choice, using default${RESET}"
            mode_flag=$($is_git_repo && echo "--dev" || echo "")
            ;;
    esac

    # Force flag for existing installations
    local force_flag=""
    if $has_existing; then
        echo -e "${YELLOW}This will upgrade/reinstall CLEO.${RESET}"
        read -p "Continue? [Y/n]: " confirm
        confirm="${confirm:-Y}"
        if [[ "${confirm,,}" =~ ^(y|yes)$ ]]; then
            force_flag="--force"
        else
            echo -e "${YELLOW}Installation cancelled.${RESET}"
            exit 0
        fi
    fi

    echo -e "${CYAN}Starting installation...${RESET}\n"

    # Run the modular installer
    exec "$INSTALLER" $mode_flag $force_flag
}

# Parse arguments
AUTO_MODE=false
PASS_THROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --auto)
            AUTO_MODE=true
            shift
            ;;
        *)
            PASS_THROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

# Verify modular installer exists
if [[ ! -f "$INSTALLER" ]]; then
    echo "Error: Modular installer not found at $INSTALLER" >&2
    echo "Please ensure you have the complete CLEO repository." >&2
    exit 1
fi

# Run in appropriate mode
if $AUTO_MODE || [[ ${#PASS_THROUGH_ARGS[@]} -gt 0 ]] || [[ ! -t 0 ]]; then
    # Non-interactive: pass through to modular installer
    exec "$INSTALLER" "${PASS_THROUGH_ARGS[@]}"
else
    # Interactive mode for humans
    interactive_install
fi
