# Canonical Document Registry

This reference defines the authoritative sources for CLEO documentation and their relationships.

## Document Authority Hierarchy

```
LEVEL 1: SOURCE OF TRUTH (Implementation)
├── scripts/*.sh           Commands exist if and only if script exists
├── lib/*.sh               Library functions
├── schemas/*.json         Data structure definitions
└── VERSION                 Single version source

LEVEL 2: DERIVED REGISTRIES (Must match Level 1)
├── docs/commands/COMMANDS-INDEX.json    Command metadata registry
├── docs/docs.json                       Documentation navigation
└── skills/manifest.json                 Skills registry

LEVEL 3: DOCUMENTATION (Derived from Levels 1-2)
├── docs/commands/*.md                   Individual command docs
├── docs/specs/*.md                      Technical specifications
├── docs/guides/*.md                     User guides
└── docs/*.mdx                           Mintlify pages

LEVEL 4: SUMMARY DOCUMENTS (High-level overviews)
├── README.md                            Public-facing overview
├── docs/CLEO-UNIFIED-VISION.md          System architecture
├── docs/ORCHESTRATOR-VISION.md          Orchestrator protocol
└── ~/.cleo/docs/TODO_Task_Management.md Agent injection content
```

## Canonical Documents

### 1. COMMANDS-INDEX.json

**Path:** `docs/commands/COMMANDS-INDEX.json`

**Authority:** Definitive registry of all CLI commands

**Must contain:**
- Every command in scripts/*.sh
- Command metadata (name, description, category, relevance)
- Aliases and shortcuts
- Subcommand definitions

**Schema:**
```json
{
  "commands": [
    {
      "name": "string",
      "description": "string",
      "category": "read|write|analyze|orchestrate|maintain",
      "relevance": "critical|high|medium|low",
      "script": "string.sh",
      "aliases": ["string"],
      "subcommands": [...]
    }
  ]
}
```

**Sync sources:**
- `scripts/*.sh` (must have entry for each script)
- Command usage in README.md (subset)
- Command documentation in docs/commands/*.md

### 2. README.md

**Path:** `README.md` (project root)

**Authority:** Public-facing project overview

**Must contain:**
- Current version (matching VERSION file)
- Quick start guide
- Command quick reference (critical commands only)
- Installation instructions
- Link to full documentation

**Sync sources:**
- VERSION file (version badge)
- COMMANDS-INDEX.json (command subset)

### 3. TODO_Task_Management.md

**Path:** `~/.cleo/docs/TODO_Task_Management.md`

**Authority:** Agent-facing operational reference (injected into CLAUDE.md)

**Must contain:**
- All agent-critical commands
- Error handling protocol
- Session workflow
- Exit codes
- Common patterns

**Sync sources:**
- COMMANDS-INDEX.json (command details)
- Exit codes from lib/exit-codes.sh

### 4. CLEO-UNIFIED-VISION.md

**Path:** `docs/CLEO-UNIFIED-VISION.md`

**Authority:** System architecture and philosophy

**Must contain:**
- Mission statement
- Core philosophy (agent-first, anti-hallucination, persistence)
- Architecture layers
- Command System Architecture (all command categories)
- Data flow
- Session protocol

**Sync sources:**
- COMMANDS-INDEX.json (Command System Architecture section)
- lib/*.sh (architecture documentation)

### 5. ORCHESTRATOR-VISION.md

**Path:** `docs/ORCHESTRATOR-VISION.md`

**Authority:** Orchestrator protocol philosophy and design

**Must contain:**
- Core problem statement
- ORC constraints (001-005)
- Subagent protocol
- Manifest format
- Wave-based execution
- Skill dispatch rules

**Sync sources:**
- skills/ct-orchestrator/SKILL.md
- docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md

## Drift Detection Rules

### Critical Drift (ERRORS)

Must be fixed before release:

1. Script exists but no COMMANDS-INDEX.json entry
2. COMMANDS-INDEX.json entry but no script
3. VERSION file doesn't match README badge
4. Missing required sections in canonical docs

### Warning Drift

Should be reviewed:

1. Command not documented in docs/commands/*.md
2. Critical command missing from README
3. Vision document older than 30 days
4. TODO_Task_Management.md missing sections

## Update Procedures

### Adding a New Command

1. Create `scripts/new-cmd.sh`
2. Add entry to `docs/commands/COMMANDS-INDEX.json`
3. Create `docs/commands/new-cmd.md`
4. Update `~/.cleo/docs/TODO_Task_Management.md` if agent-critical
5. Update `README.md` if user-facing
6. Update `docs/CLEO-UNIFIED-VISION.md` if architectural

### Removing a Command

1. Delete or rename `scripts/old-cmd.sh`
2. Remove from `docs/commands/COMMANDS-INDEX.json`
3. Archive or delete `docs/commands/old-cmd.md`
4. Search and update all references:
   ```bash
   grep -r "old-cmd" docs/ README.md ~/.cleo/docs/
   ```

### Version Bump

1. Update `VERSION` file
2. Run `./dev/bump-version.sh X.Y.Z`
3. Verify with `./dev/validate-version.sh`

## Validation Commands

```bash
# Full drift check
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full

# Strict mode (fail on warnings)
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --strict

# With recommendations
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --recommend

# Quick check (commands only)
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --quick
```
