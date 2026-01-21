---
name: ct-docs-sync
description: |
  CLEO canonical documentation synchronization and drift detection.
  Use when: (1) Adding new commands or features to CLEO, (2) Before releases to verify docs are current,
  (3) After noticing documentation inconsistencies, (4) Periodic maintenance checks,
  (5) User reports "command not documented" or "docs outdated".
  Monitors: README.md, COMMANDS-INDEX.json, TODO_Task_Management.md, CLEO-UNIFIED-VISION.md, ORCHESTRATOR-VISION.md
---

# CLEO Documentation Sync

Maintain synchronization between CLEO's canonical documentation sources.

## Canonical Document Registry

| Document | Purpose | Authority Level |
|----------|---------|-----------------|
| `scripts/*.sh` | **Source of Truth** for commands | PRIMARY |
| `docs/commands/COMMANDS-INDEX.json` | Command registry (must match scripts/) | DERIVED |
| `README.md` | Public-facing overview | SUMMARY |
| `~/.cleo/docs/TODO_Task_Management.md` | Agent injection content | OPERATIONAL |
| `docs/CLEO-UNIFIED-VISION.md` | System architecture | VISION |
| `docs/ORCHESTRATOR-VISION.md` | Orchestrator protocol | VISION |

## Drift Detection Workflow

### Step 1: Run Drift Detection Script

```bash
./dev/skills/ct-docs-sync/scripts/detect-drift.sh
```

This script checks:
1. Commands in scripts/ vs COMMANDS-INDEX.json
2. Commands mentioned in README vs COMMANDS-INDEX.json
3. Version consistency across files
4. Missing command documentation in docs/commands/

### Step 2: Review Drift Report

The script outputs a structured report:

```
DRIFT DETECTION REPORT
======================

[COMMANDS] Scripts not in COMMANDS-INDEX.json:
  - self-update.sh
  - orchestrator.sh

[COMMANDS] Index entries without scripts:
  - deprecated-cmd

[README] Commands in README not in index:
  - (none)

[DOCS] Commands without individual docs:
  - self-update
  - orchestrator

[VERSION] Version mismatches:
  - README.md: 0.55.0
  - VERSION: 0.57.1
```

### Step 3: Apply Fixes

For each drift category:

#### Missing from COMMANDS-INDEX.json

```bash
# 1. Get command info
head -50 scripts/<command>.sh  # Read header for description

# 2. Add to COMMANDS-INDEX.json
# Use jq or manual edit following existing pattern
```

#### Missing Command Docs

```bash
# Create from template
cp docs/commands/_template.md docs/commands/<command>.md
# Edit with command-specific content
```

#### Version Mismatch

```bash
# Use bump-version script
./dev/bump-version.sh <new-version>
```

## Validation Checks

### Pre-Release Checklist

Run before any release:

```bash
# 1. Full drift detection
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --strict

# 2. Verify version consistency
./dev/validate-version.sh

# 3. Check COMMANDS-INDEX completeness
jq '.commands | length' docs/commands/COMMANDS-INDEX.json
ls scripts/*.sh | wc -l
# These should match (or document why they differ)
```

### Periodic Maintenance

Run weekly or after significant changes:

```bash
# Quick check
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --quick

# Full check with recommendations
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend
```

## Document Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                    SOURCE OF TRUTH                              │
│                                                                 │
│  scripts/*.sh ──────────────────────────────────────────────►   │
│       │                                                         │
│       │ derives                                                 │
│       ▼                                                         │
│  COMMANDS-INDEX.json ◄────────────────────────────────────────  │
│       │                                                         │
│       ├─────► docs/commands/*.md (individual command docs)      │
│       │                                                         │
│       ├─────► README.md (command quick reference)               │
│       │                                                         │
│       ├─────► TODO_Task_Management.md (agent injection)         │
│       │                                                         │
│       └─────► CLEO-UNIFIED-VISION.md (Command System section)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Sync Priorities

When updating documentation, follow this order:

1. **COMMANDS-INDEX.json** - Update registry first (canonical command list)
2. **docs/commands/<cmd>.md** - Individual command docs
3. **TODO_Task_Management.md** - Agent-facing operational reference
4. **README.md** - Public-facing summary
5. **CLEO-UNIFIED-VISION.md** - Architecture documentation
6. **ORCHESTRATOR-VISION.md** - Protocol documentation (if orchestrator-related)

## Common Drift Scenarios

### New Command Added

```bash
# 1. Script created at scripts/new-cmd.sh
# 2. Run drift detection
./dev/skills/ct-docs-sync/scripts/detect-drift.sh

# 3. Update in order:
#    a. COMMANDS-INDEX.json
#    b. docs/commands/new-cmd.md
#    c. TODO_Task_Management.md (if agent-critical)
#    d. README.md (if user-facing)
#    e. CLEO-UNIFIED-VISION.md (if architectural)
```

### Command Renamed/Removed

```bash
# 1. Update script (rename or delete)
# 2. Run drift detection (will show orphaned index entries)
# 3. Update COMMANDS-INDEX.json (remove/rename entry)
# 4. Update or remove docs/commands/<old-cmd>.md
# 5. Search and update all references:
grep -r "old-cmd" docs/ README.md ~/.cleo/docs/
```

### Version Bump

```bash
# Use the version bump script which updates all locations
./dev/bump-version.sh X.Y.Z

# Verify
./dev/validate-version.sh
```

## Integration with CI

For automated checking, add to CI pipeline:

```yaml
- name: Check documentation drift
  run: |
    ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --strict
    if [ $? -ne 0 ]; then
      echo "Documentation drift detected!"
      exit 1
    fi
```

## References

- [Canonical Registry Details](references/canonical-registry.md)
- [Command Documentation Template](../../docs/commands/_template.md)
