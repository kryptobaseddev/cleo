#!/usr/bin/env bash
# Generate Mintlify changelog from CHANGELOG.md
# Usage: ./scripts/generate-changelog.sh [LIMIT]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CHANGELOG_SRC="$PROJECT_ROOT/CHANGELOG.md"
CHANGELOG_DST="$PROJECT_ROOT/docs/changelog/overview.mdx"

LIMIT="${1:-15}"

# Write MDX header
cat > "$CHANGELOG_DST" << 'HEADER'
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

# Use awk to parse and convert CHANGELOG.md
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
' "$CHANGELOG_SRC" >> "$CHANGELOG_DST"

# Escape < followed by numbers (e.g., <200ms) to prevent MDX/JSX parse errors
sed -i 's/<\([0-9]\)/\&lt;\1/g' "$CHANGELOG_DST"

# Add footer
cat >> "$CHANGELOG_DST" << 'FOOTER'
## Earlier Releases

For the complete release history, see:
- [CHANGELOG.md](https://github.com/kryptobaseddev/cleo/blob/main/CHANGELOG.md) - Full detailed changelog
- [GitHub Releases](https://github.com/kryptobaseddev/cleo/releases) - Release artifacts and notes
FOOTER

echo "Generated $CHANGELOG_DST"
