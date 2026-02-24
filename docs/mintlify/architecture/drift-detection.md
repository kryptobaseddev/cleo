---
title: "detect-drift Architecture"
description: "How the documentation drift detection system works and how to integrate it into other projects"
icon: "git-compare"
---

# Documentation Drift Detection Architecture

CLEO's `detect-drift` command provides automated validation of documentation synchronization with source code. This document explains how it works and how to integrate it into other projects.

## How It Works

### Core Checks

The drift detection system performs 8 canonical checks:

| Check | Validates | Source of Truth | Fail Condition |
|-------|-----------|-----------------|----------------|
| Gateway-to-spec | MCP operations match spec | `src/mcp/gateways/` + `docs/specs/CLEO-OPERATIONS-REFERENCE.md` | Missing operations or undocumented implementations |
| CLI-to-core | CLI commands exist | `src/cli/commands/*.ts` | Commands directory missing |
| Domain handlers | Domain coverage | `src/mcp/domains/*.ts` | No domain handlers found |
| Capability matrix | Feature matrix | `src/mcp/engine/capability-matrix.ts` | Matrix file missing |
| Schema validation | Database schema | `src/store/schema.ts` | No CREATE TABLE statements |
| Canonical identity | Vision/pillars | `docs/concepts/vision.mdx` + `docs/specs/PORTABLE-BRAIN-SPEC.md` | Missing canonical documents or pillars |
| Agent injection | Agent templates | `.cleo/templates/CLEO-INJECTION.md` | Template missing |
| Exit codes | Exit code definitions | `src/types/exit-codes.ts` | Exit codes file missing |

### Exit Code Strategy

```
Exit 0: All checks passed - documentation is synchronized
Exit 1: Warnings only - documentation exists but needs attention
Exit 2: Errors detected - missing documentation or critical drift
```

## Integration Guide

### For CLEO-Based Projects

If your project uses CLEO, drift detection is already available:

```bash
# Run drift detection
cleo detect-drift

# JSON output for CI/CD
cleo detect-drift --json

# Exit codes for scripting
if cleo detect-drift --json; then
  echo "Documentation synchronized"
else
  echo "Drift detected - review required"
fi
```

### For Custom Projects

To implement drift detection in other projects:

#### 1. Configuration File

Create `.drift-config.json` in your project root:

```json
{
  "projectName": "My Project",
  "version": "1.0.0",
  "checks": {
    "gatewayToSpec": {
      "enabled": true,
      "specPath": "docs/api-spec.md",
      "gatewayPaths": [
        "src/api/gateway.ts"
      ],
      "operationPattern": "## `(\w+)`"
    },
    "cliToCore": {
      "enabled": true,
      "cliPath": "src/cli/commands",
      "corePath": "src/core"
    },
    "canonicalIdentity": {
      "enabled": true,
      "visionPath": "docs/vision.md",
      "specPath": "docs/product-spec.md",
      "pillars": [
        "Core Value 1",
        "Core Value 2",
        "Core Value 3"
      ]
    },
    "schemaValidation": {
      "enabled": true,
      "schemaPath": "src/database/schema.sql",
      "requiredStatements": ["CREATE TABLE", "CREATE INDEX"]
    }
  }
}
```

#### 2. CI/CD Integration

**GitHub Actions:**

```yaml
name: Documentation Drift Check

on:
  push:
    paths:
      - 'docs/**'
      - 'src/**'
  pull_request:
    paths:
      - 'docs/**'
      - 'src/**'

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install CLEO
        run: npm install -g @cleocode/cleo
      
      - name: Check Documentation Drift
        run: |
          if ! cleo detect-drift --json; then
            echo "::error::Documentation drift detected!"
            cleo detect-drift --human
            exit 1
          fi
```

**GitLab CI:**

```yaml
drift-check:
  script:
    - npm install -g @cleocode/cleo
    - cleo detect-drift --json || (cleo detect-drift --human && exit 1)
  only:
    changes:
      - docs/**
      - src/**
```

#### 3. Pre-commit Hook

`.git/hooks/pre-commit`:

```bash
#!/bin/bash
# Prevent commits with documentation drift

if command -v cleo &> /dev/null; then
  if ! cleo detect-drift --json > /dev/null 2>&1; then
    echo "❌ Documentation drift detected!"
    echo ""
    cleo detect-drift --human
    echo ""
    echo "Fix documentation drift before committing."
    exit 1
  fi
fi
```

#### 4. IDE Integration

**VS Code Task** (`.vscode/tasks.json`):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Check Documentation Drift",
      "type": "shell",
      "command": "cleo detect-drift --human",
      "group": "test",
      "presentation": {
        "reveal": "always",
        "panel": "new"
      }
    }
  ]
}
```

## Output Format

### JSON Output (Default for Agents)

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.2.3",
    "schemaVersion": "2026.2.1",
    "timestamp": "2026-02-21T10:30:00Z",
    "operation": "cli.output"
  },
  "success": true,
  "result": {
    "summary": {
      "totalChecks": 8,
      "passed": 6,
      "warnings": 1,
      "errors": 1,
      "exitCode": 2
    },
    "checks": [
      {
        "name": "Gateway-to-spec sync",
        "status": "warn",
        "message": "Found 3 operation mismatches",
        "issues": [
          {
            "severity": "warning",
            "category": "implementation-coverage",
            "message": "3 operations in gateways but not in spec",
            "recommendation": "Document missing operations"
          }
        ]
      }
    ],
    "recommendations": [
      "Address all ERROR-level issues before proceeding"
    ]
  }
}
```

### Human Output

```
CLEO Documentation Drift Detection

✅ Gateway-to-spec sync: All operations synchronized
✅ CLI-to-core sync: Found 76 CLI command implementations  
✅ Domain handler coverage: Found 12 domain handlers
✅ Capability matrix: Capability matrix exists
⚠️ Schema validation: Schema file exists but no CREATE TABLE statements
  → Recommendation: Add CREATE TABLE statements for all entities
✅ Canonical identity: All canonical pillars documented
❌ Agent injection: Agent injection template missing
  → Recommendation: Create .cleo/templates/CLEO-INJECTION.md
✅ Exit codes: 72 exit codes defined

Summary: 1 errors, 1 warnings
```

## Best Practices

### 1. Run in CI/CD
Always run drift detection in CI to catch documentation issues before merge:

```yaml
- name: Documentation Drift Check
  run: cleo detect-drift --json
```

### 2. Fix Errors Immediately
Exit code 2 (errors) should block releases and deployments.

### 3. Review Warnings Regularly
Exit code 1 (warnings) indicates opportunities for improvement but shouldn't block.

### 4. Document Exceptions
If a check doesn't apply to your project, document why:

```markdown
<!-- docs/drift-exceptions.md -->
# Drift Check Exceptions

## Schema Validation (Disabled)
This project uses an ORM that generates schema automatically.
The schema.ts check is disabled in .drift-config.json.
```

### 5. Version Control Config
Commit `.drift-config.json` to version control so the entire team uses the same checks.

## Troubleshooting

### "Gateway files missing" Error

```bash
# Verify MCP gateway structure
ls -la src/mcp/gateways/
# Should contain: query.ts, mutate.ts
```

### "Spec file exists but could not parse operations"

Check your spec file format. Operations should be documented as:

```markdown
## `operation_name`

Description of operation...
```

### High Number of Warnings

If you have many warnings, prioritize:
1. Critical documentation gaps (missing command docs)
2. API/contract mismatches (gateway vs spec)
3. Schema definitions
4. Nice-to-have improvements

## Advanced Configuration

### Custom Checks

You can extend drift detection with custom checks:

```typescript
// src/drift/custom-checks.ts
export function customCheck(projectRoot: string): DriftCheck {
  return {
    name: 'Custom validation',
    status: 'pass',
    message: 'All custom checks passed',
    issues: []
  };
}
```

### Excluding Files

```json
{
  "exclude": [
    "docs/archive/**",
    "docs/drafts/**"
  ]
}
```

## Migration from detect-drift.sh

If you're migrating from the old Bash-based `detect-drift.sh`:

| Old Check | New Check | Status |
|-----------|-----------|--------|
| check_prerequisites | Auto-detected | Improved |
| check_commands_sync | CLI-to-core sync | Enhanced |
| check_wrapper_template_sync | Removed | Not applicable to TypeScript |
| check_header_sync | Removed | Not applicable to TypeScript |
| check_generated_index | Removed | COMMANDS-INDEX.json deprecated |
| check_command_docs | Distributed across checks | Enhanced |
| check_version_sync | Not implemented | Can be added via custom check |
| check_readme_commands | Not implemented | Can be added via custom check |
| check_canonical_contract | Canonical identity | Enhanced with pillar validation |
| check_docs_json_frontmatter | Not implemented | Mintlify-specific |
| check_vision_docs | Canonical identity | Merged |
| check_agent_injection | Agent injection | Kept |

## See Also

- [detect-drift command reference](/commands/detect-drift)
- [CLEO Operations Reference](/specs/CLEO-OPERATIONS-REFERENCE)
- [Documentation Maintenance](/guides/DOCUMENTATION-MAINTENANCE)
