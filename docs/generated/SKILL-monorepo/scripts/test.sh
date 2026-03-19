#!/usr/bin/env bash
# Run the project's test suite
# Usage: ./scripts/test.sh [additional args]

if [ -f package.json ]; then
  npm test "$@"
else
  echo "No package.json found"
  exit 1
fi
