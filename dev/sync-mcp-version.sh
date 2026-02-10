#!/usr/bin/env bash
# Syncs mcp-server/package.json version with VERSION file
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION=$(cat "$PROJECT_ROOT/VERSION")
cd "$PROJECT_ROOT/mcp-server"
# Update version in package.json using node (safer than sed for JSON)
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Synced mcp-server version to ' + pkg.version);
"
