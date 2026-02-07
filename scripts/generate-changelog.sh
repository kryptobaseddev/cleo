#!/usr/bin/env bash
###CLEO
# command: generate-changelog
# category: maintenance
# synopsis: Generate Mintlify changelog from CHANGELOG.md (dev tool)
# relevance: low
# exits: 0,1
# json-output: false
# note: Internal development tool for documentation generation
###END
# Generate changelog for configured documentation platforms
# Usage: ./scripts/generate-changelog.sh [LIMIT] [--platform TARGET_PLATFORM]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$PROJECT_ROOT/lib"

# Source config library
source "$LIB_DIR/config.sh"

LIMIT="${1:-15}"
TARGET_PLATFORM="${2:-}"

# Get changelog configuration
get_changelog_source() {
    jq -r '.release.changelog.source // "CHANGELOG.md"' "$PROJECT_CONFIG_FILE" 2>/dev/null || echo "CHANGELOG.md"
}

# Get changelog output path for a specific platform
get_changelog_output_path() {
    local platform="${1:-mintlify}"
    local config_path
    config_path=$(jq -r ".release.changelog.outputs[]? | select(.platform == \"$platform\" and .enabled == true) | .path // empty" "$PROJECT_CONFIG_FILE" 2>/dev/null)

    if [[ -z "$config_path" ]]; then
        # Default paths by platform
        case "$platform" in
            mintlify) echo "docs/changelog/overview.mdx" ;;
            docusaurus) echo "docs/changelog.md" ;;
            github) echo "CHANGELOG.md" ;;
            plain) echo "CHANGELOG.md" ;;
            *) echo "" ;;
        esac
    else
        echo "$config_path"
    fi
}

# Get all enabled platforms
get_enabled_platforms() {
    jq -r '.release.changelog.outputs[]? | select(.enabled == true) | .platform' "$PROJECT_CONFIG_FILE" 2>/dev/null || echo "mintlify"
}

CHANGELOG_SRC="$PROJECT_ROOT/$(get_changelog_source)"

# Generate changelog for a specific platform
generate_for_platform() {
    local platform="$1"
    local output_path="$2"
    local dst="$PROJECT_ROOT/$output_path"

    echo "Generating changelog for platform: $platform → $output_path"

    case "$platform" in
        mintlify)
            generate_mintlify "$dst"
            ;;
        docusaurus)
            generate_docusaurus "$dst"
            ;;
        plain|github)
            # For plain/github, just copy source
            cp "$CHANGELOG_SRC" "$dst"
            echo "Copied source to $output_path"
            ;;
        *)
            echo "Warning: Unknown platform '$platform', skipping"
            return 1
            ;;
    esac
}

# Generate Mintlify MDX format
generate_mintlify() {
    local dst="$1"

    # Write MDX header
    cat > "$dst" << 'HEADER'
---
title: "Changelog"
description: "CLEO release history and product updates"
icon: "clock-rotate-left"
rss: true
---

# Changelog

Stay up to date with the latest CLEO improvements, features, and fixes.

<Info>
Subscribe to updates via RSS at `/rss.xml` or follow the [GitHub releases](https://github.com/kryptobaseddev/cleo/releases).
</Info>

<Tip>
This changelog is auto-generated from [CHANGELOG.md](https://github.com/kryptobaseddev/cleo/blob/main/CHANGELOG.md). Run `./scripts/generate-changelog.sh` to update.
</Tip>

HEADER

    # Use awk to parse and convert CHANGELOG.md to Mintlify format
    awk -v limit="$LIMIT" '
BEGIN {
    count = 0
    in_version = 0
    content = ""
}

# Match version header: ## [0.60.1] - 2026-01-21
/^## \[[0-9]+\.[0-9]+\.[0-9]+\] - [0-9]{4}-[0-9]{2}-[0-9]{2}/ {
    # Output previous version if exists
    if (version != "" && count < limit) {
        output_version()
        count++
    }

    # Parse new version
    match($0, /\[([0-9]+\.[0-9]+\.[0-9]+)\]/, arr)
    version = arr[1]

    match($0, /- ([0-9]{4})-([0-9]{2})-([0-9]{2})/, darr)
    year = darr[1]
    month = darr[2]

    # Convert month number to name
    months["01"] = "January"; months["02"] = "February"; months["03"] = "March"
    months["04"] = "April"; months["05"] = "May"; months["06"] = "June"
    months["07"] = "July"; months["08"] = "August"; months["09"] = "September"
    months["10"] = "October"; months["11"] = "November"; months["12"] = "December"

    month_name = months[month]
    date_label = month_name " " year

    content = ""
    in_version = 1
    next
}

# Skip Unreleased
/^## \[Unreleased\]/ {
    in_version = 0
    next
}

# Accumulate content
in_version == 1 {
    # Convert ### to bold
    if (/^### /) {
        sub(/^### /, "**")
        $0 = $0 "**"
    }
    content = content $0 "\n"
}

function output_version() {
    # Detect tags from content
    tags = ""
    if (content ~ /[Ff]ix/) tags = tags "\"Fix\", "
    if (content ~ /[Aa]dd/) tags = tags "\"Feature\", "
    if (content ~ /[Ii]nstall/) tags = tags "\"Installer\", "
    if (content ~ /[Ss]kill/) tags = tags "\"Skills\", "
    if (content ~ /[Oo]rchestrat/) tags = tags "\"Orchestrator\", "
    if (content ~ /[Ss]ession/) tags = tags "\"Sessions\", "
    if (content ~ /[Cc]ontext/) tags = tags "\"Context\", "
    if (content ~ /[Rr]esearch/) tags = tags "\"Research\", "
    if (content ~ /[Dd]oc/) tags = tags "\"Documentation\", "
    if (content ~ /CLI|[Cc]ommand/) tags = tags "\"CLI\", "

    # Remove trailing comma and space
    sub(/, $/, "", tags)

    # Default tag
    if (tags == "") tags = "\"Core\""

    # Limit to 3 tags
    n = split(tags, tag_arr, ", ")
    if (n > 3) {
        tags = tag_arr[1] ", " tag_arr[2] ", " tag_arr[3]
    }

    # Get title from first bold item
    title = "v" version " Release"
    if (match(content, /\*\*[^*]+\*\*:/)) {
        t = substr(content, RSTART+2, RLENGTH-5)
        if (length(t) < 60) title = t
    }

    # Output Update component
    printf "<Update label=\"%s\" description=\"v%s\" tags={[%s]}>\n", date_label, version, tags
    printf "## %s\n\n", title
    printf "%s\n", content
    printf "[View full release notes](https://github.com/kryptobaseddev/cleo/releases/tag/v%s)\n", version
    printf "</Update>\n\n"
}

END {
    # Output last version
    if (version != "" && count < limit) {
        output_version()
    }
}
' "$CHANGELOG_SRC" >> "$dst"

    # Escape < followed by numbers (e.g., <200ms) to prevent MDX/JSX parse errors
    sed -i 's/<\([0-9]\)/\&lt;\1/g' "$dst"

    # Add footer
    cat >> "$dst" << 'FOOTER'
## Earlier Releases

For the complete release history, see:
- [CHANGELOG.md](https://github.com/kryptobaseddev/cleo/blob/main/CHANGELOG.md) - Full detailed changelog
- [GitHub Releases](https://github.com/kryptobaseddev/cleo/releases) - Release artifacts and notes
FOOTER

    echo "✓ Generated Mintlify changelog: $dst"
}

# Generate Docusaurus markdown format
generate_docusaurus() {
    local dst="$1"

    # Write markdown header
    cat > "$dst" << 'HEADER'
---
id: changelog
title: Changelog
sidebar_label: Changelog
---

# Changelog

All notable changes to CLEO will be documented in this file.

HEADER

    # Use simpler format for Docusaurus (just copy/transform from source)
    awk -v limit="$LIMIT" '
BEGIN { count = 0 }

# Pass through version headers
/^## \[[0-9]+\.[0-9]+\.[0-9]+\]/ {
    if (count >= limit) exit
    count++
}

# Skip Unreleased
/^## \[Unreleased\]/ { next }

# Pass through all other content when within limit
count > 0 && count <= limit { print }
' "$CHANGELOG_SRC" >> "$dst"

    echo "✓ Generated Docusaurus changelog: $dst"
}

# Main execution
if [[ -n "$TARGET_PLATFORM" ]]; then
    # Generate for specific platform only
    output_path=$(get_changelog_output_path "$TARGET_PLATFORM")
    if [[ -z "$output_path" ]]; then
        echo "Error: Platform '$TARGET_PLATFORM' not enabled or not found in config" >&2
        exit 1
    fi
    generate_for_platform "$TARGET_PLATFORM" "$output_path"
else
    # Generate for all enabled platforms
    while IFS= read -r platform; do
        output_path=$(get_changelog_output_path "$platform")
        if [[ -n "$output_path" ]]; then
            generate_for_platform "$platform" "$output_path" || true
        fi
    done < <(get_enabled_platforms)
fi
