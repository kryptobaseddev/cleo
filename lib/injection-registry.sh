#!/usr/bin/env bash
# lib/injection-registry.sh - Injection target registry (Layer 0)
# MUST NOT source any other library

[[ -n "${_INJECTION_REGISTRY_LOADED:-}" ]] && return 0
readonly _INJECTION_REGISTRY_LOADED=1

# ==============================================================================
# INJECTION TARGET REGISTRY
# ==============================================================================
# Single source of truth for all injectable documentation files.
# Add new targets here; all commands auto-discover them.

# Supported injection targets (space-separated)
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md"

# Marker format specification
readonly INJECTION_MARKER_START="<!-- CLEO:START"
readonly INJECTION_MARKER_END="<!-- CLEO:END -->"
# Version pattern - optional version for backward compatibility with old markers
# Matches: "CLEO:START -->" (new) or "CLEO:START v0.58.6 -->" (legacy)
readonly INJECTION_VERSION_PATTERN='CLEO:START( v([0-9]+\.[0-9]+\.[0-9]+))? -->'

# Template paths (relative to CLEO_HOME)
readonly INJECTION_TEMPLATE_MAIN="templates/AGENT-INJECTION.md"
readonly INJECTION_TEMPLATE_DIR="templates/agents"

# Agent-specific header files (filename without path)
declare -A INJECTION_HEADERS=(
    ["GEMINI.md"]="GEMINI-HEADER.md"
    ["CODEX.md"]="CODEX-HEADER.md"
    ["KIMI.md"]="KIMI-HEADER.md"
    # CLAUDE.md and AGENTS.md use main template only (no header)
)

# Validation key names for JSON output
declare -A INJECTION_VALIDATION_KEYS=(
    ["CLAUDE.md"]="claude_md"
    ["AGENTS.md"]="agents_md"
    ["GEMINI.md"]="gemini_md"
)
