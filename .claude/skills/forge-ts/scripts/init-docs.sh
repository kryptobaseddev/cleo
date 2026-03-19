#!/usr/bin/env bash
# Scaffold a documentation site for the target SSG
# Usage: ./init-docs.sh [mintlify|docusaurus|nextra|vitepress]
set -euo pipefail
TARGET="${1:-mintlify}"
npx forge-ts docs init --target "$TARGET" --json
