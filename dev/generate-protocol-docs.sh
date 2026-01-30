#!/usr/bin/env bash
#
# generate-protocol-docs.sh - Generate Mintlify MDX docs from protocols/*.md
#
# USAGE:
#   ./dev/generate-protocol-docs.sh [OPTIONS]
#
# OPTIONS:
#   --dry-run    Preview changes without writing
#   --force      Overwrite existing files
#   --single     Generate single protocol (e.g., --single research)
#   --verbose    Show detailed output
#   --help       Show help
#
# OUTPUT:
#   Creates/updates MDX files in docs/developer/protocols/
#
# EXAMPLES:
#   ./dev/generate-protocol-docs.sh --dry-run           # Preview all changes
#   ./dev/generate-protocol-docs.sh --single research   # Generate only research.mdx
#   ./dev/generate-protocol-docs.sh --force             # Regenerate all docs
#
# This script transforms the source-of-truth protocol definitions in /protocols/
# into Mintlify-compatible MDX files for documentation.
#
# SOURCE OF TRUTH: protocols/*.md
# GENERATED OUTPUT: docs/developer/protocols/*.mdx
#
# AUTHOR: CLEO Documentation System
# VERSION: 1.0.0

set -euo pipefail

# ==============================================================================
# Configuration
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROTOCOLS_DIR="$PROJECT_ROOT/protocols"
OUTPUT_DIR="$PROJECT_ROOT/docs/developer/protocols"

# Protocol metadata for frontmatter
declare -A PROTOCOL_TITLES=(
    ["research"]="Research Protocol"
    ["consensus"]="Consensus Protocol"
    ["specification"]="Specification Protocol"
    ["decomposition"]="Decomposition Protocol"
    ["implementation"]="Implementation Protocol"
    ["validation"]="Validation Protocol"
    ["testing"]="Testing Protocol"
    ["contribution"]="Contribution Protocol"
    ["release"]="Release Protocol"
)

declare -A PROTOCOL_DESCRIPTIONS=(
    ["research"]="Information gathering and analysis protocol for RCSD pipeline"
    ["consensus"]="Multi-agent validation and decision protocol"
    ["specification"]="RFC 2119 specification writing protocol"
    ["decomposition"]="Epic decomposition and task breakdown protocol"
    ["implementation"]="Code implementation and execution protocol"
    ["validation"]="Output verification and compliance protocol"
    ["testing"]="BATS test creation and execution protocol"
    ["contribution"]="Multi-agent work attribution protocol"
    ["release"]="Version management and changelog protocol"
)

declare -A PROTOCOL_ICONS=(
    ["research"]="telescope"
    ["consensus"]="users"
    ["specification"]="file-contract"
    ["decomposition"]="sitemap"
    ["implementation"]="code"
    ["validation"]="shield-check"
    ["testing"]="flask-vial"
    ["contribution"]="code-merge"
    ["release"]="rocket"
)

# Flags
DRY_RUN=false
FORCE=false
SINGLE=""
VERBOSE=false

# ==============================================================================
# Functions
# ==============================================================================

log() {
    echo "[INFO] $*" >&2
}

log_verbose() {
    [[ "$VERBOSE" == "true" ]] && echo "[DEBUG] $*" >&2 || true
}

log_error() {
    echo "[ERROR] $*" >&2
}

show_help() {
    sed -n '2,/^# AUTHOR/p' "$0" | sed 's/^# //' | head -n -1
    exit 0
}

# Generate MDX content for a single protocol
generate_protocol_doc() {
    local protocol_name="$1"
    local source_file="$2"

    local title="${PROTOCOL_TITLES[$protocol_name]}"
    local description="${PROTOCOL_DESCRIPTIONS[$protocol_name]}"
    local icon="${PROTOCOL_ICONS[$protocol_name]}"
    local current_date
    current_date=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    # Read the source content (skip the first line if it's a heading)
    local content
    content=$(cat "$source_file")

    # Build MDX content with frontmatter
    cat << EOF
---
title: "$title"
description: "$description"
icon: "$icon"
---

{/* AUTO-GENERATED from protocols/$protocol_name.md - DO NOT EDIT DIRECTLY */}
{/* Source of truth: /protocols/$protocol_name.md */}
{/* Last generated: $current_date */}

$content
EOF
}

# Process all protocols or single protocol
process_protocols() {
    log "Reading protocols from $PROTOCOLS_DIR"

    # Verify protocols directory exists
    if [[ ! -d "$PROTOCOLS_DIR" ]]; then
        log_error "Protocols directory not found at $PROTOCOLS_DIR"
        exit 1
    fi

    # Create output directory if it doesn't exist
    if [[ ! -d "$OUTPUT_DIR" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Would create directory: $OUTPUT_DIR"
        else
            mkdir -p "$OUTPUT_DIR"
            log "Created output directory: $OUTPUT_DIR"
        fi
    fi

    local total_protocols=0
    local generated=0
    local skipped=0

    # Find all .md files in protocols directory
    while IFS= read -r -d '' protocol_file; do
        ((total_protocols++)) || true

        # Extract protocol name (filename without extension)
        local protocol_name
        protocol_name=$(basename "$protocol_file" .md)

        # Filter for single protocol if specified
        if [[ -n "$SINGLE" && "$protocol_name" != "$SINGLE" ]]; then
            continue
        fi

        log_verbose "Processing protocol: $protocol_name"

        # Verify we have metadata for this protocol
        if [[ -z "${PROTOCOL_TITLES[$protocol_name]:-}" ]]; then
            log_error "No metadata found for protocol: $protocol_name"
            log_error "Add metadata to PROTOCOL_TITLES, PROTOCOL_DESCRIPTIONS, and PROTOCOL_ICONS arrays"
            ((skipped++)) || true
            continue
        fi

        local output_file="$OUTPUT_DIR/${protocol_name}.mdx"

        # Check if output already exists and skip if not forcing
        if [[ -f "$output_file" && "$FORCE" != "true" ]]; then
            # Check if file is auto-generated (safe to overwrite)
            if ! grep -q "AUTO-GENERATED" "$output_file" 2>/dev/null; then
                log_verbose "Skipping $protocol_name - existing manual documentation"
                ((skipped++)) || true
                continue
            fi
        fi

        # Generate MDX content
        local mdx_content
        mdx_content=$(generate_protocol_doc "$protocol_name" "$protocol_file")

        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Would write: $output_file"
            echo "--- Preview: $protocol_name ---"
            echo "$mdx_content" | head -30
            echo "..."
            echo ""
        else
            echo "$mdx_content" > "$output_file"
            log "Generated: $output_file"
            ((generated++)) || true
        fi
    done < <(find "$PROTOCOLS_DIR" -maxdepth 1 -name "*.md" -type f -print0 | sort -z)

    log "Found $total_protocols protocol files"
    log "Processing complete: $generated generated, $skipped skipped"
}

# ==============================================================================
# Main
# ==============================================================================

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --single)
                SINGLE="$2"
                shift 2
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --help|-h)
                show_help
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                ;;
        esac
    done

    log "CLEO Protocol Documentation Generator v1.0.0"
    log "Project root: $PROJECT_ROOT"

    # Process protocols
    process_protocols

    log "Done."
}

main "$@"
