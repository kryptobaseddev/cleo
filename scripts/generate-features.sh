#!/usr/bin/env bash
# ============================================================================
# CLEO - generate-features.sh
# Generate FEATURES.md from FEATURES.json
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$(dirname "$SCRIPT_DIR")}"
FEATURES_JSON="${CLEO_HOME}/docs/FEATURES.json"
FEATURES_MD="${CLEO_HOME}/docs/FEATURES.md"

# Verify FEATURES.json exists
if [[ ! -f "$FEATURES_JSON" ]]; then
    echo "ERROR: FEATURES.json not found at $FEATURES_JSON" >&2
    exit 1
fi

# Get version from JSON
VERSION=$(jq -r '._meta.version' "$FEATURES_JSON")
GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Generate FEATURES.md
cat > "$FEATURES_MD" << 'HEADER'
# CLEO Features

> **Auto-generated from FEATURES.json** - Do not edit directly. Run `./scripts/generate-features.sh` to regenerate.

HEADER

# Add metadata
cat >> "$FEATURES_MD" << EOF
**Version**: $VERSION
**Generated**: $GENERATED_AT

---

## Table of Contents

EOF

# Generate TOC
jq -r '.categories[] | "- [\(.name)](#\(.id))"' "$FEATURES_JSON" >> "$FEATURES_MD"

echo "" >> "$FEATURES_MD"
echo "---" >> "$FEATURES_MD"
echo "" >> "$FEATURES_MD"

# Generate each category
jq -r '.categories[] | @json' "$FEATURES_JSON" | while read -r category_json; do
    cat_id=$(echo "$category_json" | jq -r '.id')
    cat_name=$(echo "$category_json" | jq -r '.name')
    cat_desc=$(echo "$category_json" | jq -r '.description')
    cat_status=$(echo "$category_json" | jq -r '.status')

    # Category header
    echo "## $cat_name" >> "$FEATURES_MD"
    echo "" >> "$FEATURES_MD"
    echo "**Status**: $cat_status  " >> "$FEATURES_MD"
    echo "$cat_desc" >> "$FEATURES_MD"
    echo "" >> "$FEATURES_MD"

    # Features table
    echo "| Feature | Command | Status | Version |" >> "$FEATURES_MD"
    echo "|---------|---------|--------|---------|" >> "$FEATURES_MD"

    echo "$category_json" | jq -r '.features[] | "| \(.name) | `\(.command // "-")` | \(.status) | \(.version // "-") |"' >> "$FEATURES_MD"

    echo "" >> "$FEATURES_MD"

    # Feature details (if any have descriptions worth showing)
    echo "<details>" >> "$FEATURES_MD"
    echo "<summary>Feature Details</summary>" >> "$FEATURES_MD"
    echo "" >> "$FEATURES_MD"

    echo "$category_json" | jq -r '.features[] | "### \(.name)\n\(.description)\n"' >> "$FEATURES_MD"

    echo "</details>" >> "$FEATURES_MD"
    echo "" >> "$FEATURES_MD"
    echo "---" >> "$FEATURES_MD"
    echo "" >> "$FEATURES_MD"
done

# Add summary section
cat >> "$FEATURES_MD" << EOF
## Summary

| Metric | Count |
|--------|-------|
| Categories | $(jq -r '.summary.totalCategories' "$FEATURES_JSON") |
| Features | $(jq -r '.summary.totalFeatures' "$FEATURES_JSON") |
| Complete | $(jq -r '.summary.completeFeatures' "$FEATURES_JSON") |
| Commands | $(jq -r '.summary.commands' "$FEATURES_JSON") |
| Libraries | $(jq -r '.summary.libraries' "$FEATURES_JSON") |

---

*Generated from [FEATURES.json](FEATURES.json) by \`scripts/generate-features.sh\`*
EOF

echo "Generated $FEATURES_MD from $FEATURES_JSON"
