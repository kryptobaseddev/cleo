#!/usr/bin/env bash
###CLEO
# command: mcp-install
# category: maintenance
# synopsis: Build and configure the CLEO MCP server for AI tool integration
# relevance: medium
# flags: --json,--format
# exits: 0,1
# json-output: false
###END
# @task T4248
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PROJECT_ROOT/mcp-server"
DIST_INDEX="$MCP_DIR/dist/index.js"

# Build if needed
if [[ ! -f "$DIST_INDEX" ]]; then
    echo "Building MCP server..."
    (cd "$MCP_DIR" && npm install && npm run build)
    if [[ ! -f "$DIST_INDEX" ]]; then
        echo "ERROR: Build failed - $DIST_INDEX not found" >&2
        exit 1
    fi
    echo "Build complete."
    echo ""
fi

# Resolve absolute path
MCP_PATH="$(cd "$MCP_DIR" && pwd)/dist/index.js"

echo "CLEO MCP Server is ready!"
echo ""
echo "Add this to your AI tool's MCP configuration:"
echo ""
echo "  For Claude Desktop (claude_desktop_config.json):"
echo "  For Claude Code (.claude/settings.json under mcpServers):"
echo "  For Cursor/other tools (check their MCP config location):"
echo ""
echo '  "cleo": {'
echo '    "command": "node",'
echo "    \"args\": [\"$MCP_PATH\"]"
echo '  }'
echo ""
echo "Or if published to npm:"
echo ""
echo '  "cleo": {'
echo '    "command": "npx",'
echo '    "args": ["-y", "@cleocode/mcp-server"]'
echo '  }'
