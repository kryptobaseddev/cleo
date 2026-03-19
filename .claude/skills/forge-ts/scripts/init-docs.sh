#!/usr/bin/env bash
# Scaffold a documentation site for the target SSG
# Usage: ./init-docs.sh [mintlify|docusaurus|nextra|vitepress]
# Non-TTY defaults to JSON (LAFS envelope) — no --json flag needed
set -euo pipefail
TARGET="${1:-mintlify}"
npx forge-ts docs init --target "$TARGET"
