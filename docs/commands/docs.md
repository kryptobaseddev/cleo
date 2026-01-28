# cleo docs

Documentation management commands for drift detection and gap validation.

## Usage

```bash
cleo docs <subcommand> [options]
```

## Subcommands

### sync

Run documentation drift detection between code and docs.

```bash
cleo docs sync [--strict] [--quick]
```

**Options:**
- `--strict` - Fail on any drift (for CI)
- `--quick` - Quick check, skip detailed analysis

**Output:**
- List of undocumented commands
- List of phantom documentation
- Version consistency check

### gap-check

Validate knowledge transfer from working docs to canonical docs.

```bash
cleo docs gap-check [--epic <id>] [--task <id>] [--all-review]
```

**Options:**
- `--epic <id>` - Check docs linked to specific epic
- `--task <id>` - Check docs linked to specific task
- `--all-review` - Check all docs in 'review' status

**Exit Codes:**
- `0` - All docs have coverage in canonical docs
- `1` - Gaps found (undocumented content)
- `2` - Error during check

**Output (JSON):**
```json
{
  "success": true,
  "gaps": [],
  "covered": ["file1.md", "file2.md"],
  "summary": {
    "total": 10,
    "covered": 10,
    "gaps": 0
  }
}
```

## Examples

```bash
# Run full drift detection
cleo docs sync

# Check gaps for an epic
cleo docs gap-check --epic T2526

# Check all review-status docs before archive
cleo docs gap-check --all-review

# CI pipeline check
cleo docs sync --strict && cleo docs gap-check --all-review
```

## Configuration

Settings in `config.json`:

```json
{
  "documentation": {
    "driftDetection": {
      "enabled": true,
      "criticalCommands": ["list", "add", "complete", "find"],
      "autoCheck": true
    }
  }
}
```

## Related Commands

- [validate](./validate.md) - Validate data integrity
- [doctor](./doctor.md) - System health checks

## See Also

- [Documentation Standards](/docs/CLEO-DOCUMENTATION-SOP.md)
- [ct-docs-sync skill](/dev/skills/ct-docs-sync/SKILL.md)
