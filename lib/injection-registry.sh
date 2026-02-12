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
# Only 3 real instruction files: CLAUDE.md (Claude Code), AGENTS.md (all others), GEMINI.md (Gemini CLI)
# Codex and Kimi use AGENTS.md - no standalone CODEX.md or KIMI.md files
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

# Legacy header system removed - all agents use unified AGENT-INJECTION.md
# Header files were never implemented (injection_apply ignores content param)
declare -gA INJECTION_HEADERS=(
    # No agent-specific headers - all use @.cleo/templates/AGENT-INJECTION.md
)

# Validation key names for JSON output
declare -gA INJECTION_VALIDATION_KEYS=(
    ["CLAUDE.md"]="claude_md"
    ["AGENTS.md"]="agents_md"
    ["GEMINI.md"]="gemini_md"
)
