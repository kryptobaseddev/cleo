#!/usr/bin/env bash
# Test the schema diff analyzer

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZER="$SCRIPT_DIR/schema-diff-analyzer.sh"

echo "Testing Schema Diff Analyzer"
echo "============================"
echo ""

# Test 1: PATCH - maxLength increase
echo "Test 1: PATCH (maxLength increase)"
echo "-----------------------------------"

OLD_SCHEMA='{
  "schemaVersion": "2.6.0",
  "properties": {
    "tasks": {
      "items": {
        "properties": {
          "notes": {
            "maxLength": 1000
          }
        }
      }
    }
  }
}'

NEW_SCHEMA='{
  "schemaVersion": "2.6.1",
  "properties": {
    "tasks": {
      "items": {
        "properties": {
          "notes": {
            "maxLength": 2500
          }
        }
      }
    }
  }
}'

echo "Generating migration for todo v2.6.1..."
"$ANALYZER" "$OLD_SCHEMA" "$NEW_SCHEMA" "todo" "2.6.1"
echo ""

# Test 2: MINOR - new optional field
echo "Test 2: MINOR (new optional field)"
echo "-----------------------------------"

OLD_SCHEMA2='{
  "schemaVersion": "2.4.0",
  "properties": {
    "tasks": {
      "items": {
        "properties": {
          "title": {"type": "string"}
        }
      }
    }
  }
}'

NEW_SCHEMA2='{
  "schemaVersion": "2.5.0",
  "properties": {
    "tasks": {
      "items": {
        "properties": {
          "title": {"type": "string"},
          "newField": {"type": "string"}
        }
      }
    }
  }
}'

echo "Generating migration for config v2.5.0..."
"$ANALYZER" "$OLD_SCHEMA2" "$NEW_SCHEMA2" "config" "2.5.0"
echo ""

echo "✓ Tests completed"
