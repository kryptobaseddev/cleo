# validate Command

**Alias**: `check`

Validate todo.json against schema and business rules.

## Usage

```bash
cleo validate [OPTIONS]
```

## Description

The `validate` command checks `todo.json` for structural integrity, data consistency, and business rule compliance. It can optionally auto-fix common issues.

Run validation after manual JSON edits or when troubleshooting issues.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--strict` | | Treat warnings as errors | `false` |
| `--fix` | | Auto-fix simple issues | `false` |
| `--json` | | Output as JSON | `false` |
| `--format FORMAT` | `-f` | Output format: `text`, `json` | `text` |
| `--quiet` | `-q` | Suppress info messages | `false` |
| `--help` | `-h` | Show help message | |

## Examples

### Basic Validation

```bash
cleo validate
```

Output:
```
[OK] JSON syntax valid
[OK] No duplicate task IDs in todo.json
[OK] No duplicate IDs in archive
[OK] No cross-file duplicate IDs
[OK] Single active task
[OK] All dependencies exist
[OK] No circular dependencies
[OK] All blocked tasks have reasons
[OK] All done tasks have completedAt
[OK] Schema version compatible (2.0.0)
[OK] All tasks have required fields
[OK] Focus matches active task
[OK] Checksum valid
[OK] CLAUDE.md injection current (v1.0.0)

Validation passed (0 warnings)
```

### Auto-Fix Issues

```bash
cleo validate --fix
```

Output:
```
[ERROR] Checksum mismatch: stored=abc123, computed=def456
  Fixed: Updated checksum (was: abc123, now: def456)
[OK] Checksum valid (after fix)

[WARN] CLAUDE.md injection outdated (0.9.0 → 1.0.0)
  Fixed: Updated CLAUDE.md injection (0.9.0 → 1.0.0)
[OK] CLAUDE.md injection current (v1.0.0)

Validation passed (0 warnings)
```

### JSON Output

```bash
cleo validate --format json
```

```json
{
  "_meta": {
    "format": "json",
    "version": "0.12.0",
    "command": "validate",
    "timestamp": "2025-12-13T10:00:00Z"
  },
  "valid": true,
  "errors": 0,
  "warnings": 1,
  "details": []
}
```

### Strict Mode

```bash
# Fail on warnings too
cleo validate --strict
```

## Validations Performed

### Structural Checks

| Check | Description |
|-------|-------------|
| JSON syntax | Valid JSON format |
| Schema version | Compatible major version |
| Required fields | `id`, `title`, `status`, `priority`, `createdAt` |

### ID Uniqueness

| Check | Description |
|-------|-------------|
| Duplicate IDs | No duplicates in todo.json |
| Archive duplicates | No duplicates in archive |
| Cross-file duplicates | IDs unique across todo.json and archive |

### Business Rules

| Check | Description |
|-------|-------------|
| Single active | Only one task with `status: active` |
| Dependencies exist | All `depends[]` reference valid task IDs |
| Circular dependencies | No dependency cycles |
| Blocked reason | Blocked tasks have `blockedBy` |
| Completed timestamp | Done tasks have `completedAt` |
| Focus consistency | `focus.currentTask` matches active task |

### Integrity

| Check | Description |
|-------|-------------|
| Checksum | `_meta.checksum` matches computed value |
| CLAUDE.md injection | Version matches installed template |

## Auto-Fixable Issues

| Issue | Fix Applied |
|-------|-------------|
| Duplicate IDs | Keep first occurrence |
| Multiple active | Set extras to pending |
| Missing completedAt | Set to current timestamp |
| Focus mismatch | Sync with active task |
| Checksum mismatch | Recalculate checksum |
| Outdated injection | Update CLAUDE.md |
| Missing version | Add `_meta.version` |

## Warnings

Warnings don't cause validation failure (unless `--strict`):

| Warning | Description |
|---------|-------------|
| Stale tasks | Pending >30 days |
| No checksum | Missing checksum field |
| Outdated injection | CLAUDE.md needs update |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Validation passed |
| `1` | Validation failed (errors found) |
| `1` | Strict mode with warnings |

## See Also

- [init](init.md) - Initialize project
- [migrate](migrate.md) - Schema migration
- [backup](backup.md) - Create backups
