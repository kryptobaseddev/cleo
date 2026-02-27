#!/usr/bin/env bash
# Subagent Protocol Installer v2.0.0
# Usage: ./install.sh /path/to/project

set -euo pipefail

TARGET="${1:-}"
DEFAULT_DIR=".cleo/agent-outputs"

if [[ -z "$TARGET" ]]; then
    echo "Usage: ./install.sh /path/to/project"
    echo ""
    echo "This will create: /path/to/project/$DEFAULT_DIR/"
    echo "With files: SUBAGENT_PROTOCOL.md, INJECT.md, MANIFEST.jsonl"
    exit 1
fi

DEST="$TARGET/$DEFAULT_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Subagent Protocol v2.0.0..."
echo "Target: $DEST"

mkdir -p "$DEST"

cp "$SCRIPT_DIR/SUBAGENT_PROTOCOL.md" "$DEST/"
cp "$SCRIPT_DIR/INJECT.md" "$DEST/"

# Only create MANIFEST.jsonl if it doesn't exist (preserve existing data)
if [[ ! -f "$DEST/MANIFEST.jsonl" ]]; then
    touch "$DEST/MANIFEST.jsonl"
    echo "Created empty MANIFEST.jsonl"
else
    echo "MANIFEST.jsonl already exists, preserving data"
fi

echo ""
echo "Done. Files installed:"
ls -la "$DEST"/*.md "$DEST"/*.jsonl 2>/dev/null || true
echo ""
echo "Next: Edit $DEST/SUBAGENT_PROTOCOL.md config block if needed."
