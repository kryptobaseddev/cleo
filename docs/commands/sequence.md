# cleo sequence

Manage the task ID sequence counter for data integrity.

## Synopsis

```bash
cleo sequence <subcommand> [options]
```

## Subcommands

### show

Display current sequence state.

```bash
cleo sequence show [--json|--human]
```

**Output includes:**
- `counter` - Current sequence counter value
- `lastId` - Last assigned task ID
- `checksum` - Integrity checksum
- `valid` - Whether sequence is valid

**Example:**
```bash
$ cleo sequence show
╭──────────────────────────────────────╮
│ Sequence Status                      │
├──────────────────────────────────────┤
│ Counter:  1548                       │
│ Last ID:  T1548                      │
│ Valid:    Yes                        │
│ Checksum: a1b2c3d4                   │
╰──────────────────────────────────────╯
```

### check

Verify sequence counter is valid (non-destructive).

```bash
cleo sequence check [--json|--human]
```

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Sequence is valid |
| 4 | Sequence file missing |
| 6 | Sequence file invalid |
| 20 | Checksum mismatch |
| 22 | Counter drift (behind max ID) |

**Example:**
```bash
$ cleo sequence check
Sequence valid: counter=1548, max_id=1546
```

### repair

Fix sequence issues (counter drift, missing file, checksum).

```bash
cleo sequence repair [--json|--human]
```

**What it fixes:**
- Missing `.sequence` file - creates new one
- Counter behind max ID - updates counter
- Checksum mismatch - recalculates checksum

**Example:**
```bash
$ cleo sequence repair
Sequence repaired: counter updated from 1000 to 1548
```

## How the Sequence System Works

### Overview

The sequence system prevents task ID collisions by maintaining a monotonic counter:

1. **Counter storage**: `.cleo/.sequence` JSON file
2. **ID generation**: `T` + zero-padded counter (e.g., T001, T1548)
3. **Auto-recovery**: If counter is behind max ID, automatically recovers
4. **Dual-file scanning**: Checks both `todo.json` and `todo-archive.json`

### Sequence File Structure

```json
{
  "counter": 1548,
  "lastId": "T1548",
  "checksum": "a1b2c3d4",
  "updatedAt": "2026-01-17T10:00:00Z",
  "recoveredAt": null
}
```

### Auto-Recovery

When creating a new task, if the sequence counter is behind the max ID found in files:

1. Scans `todo.json` and `todo-archive.json` for all task IDs
2. Finds maximum ID number
3. Sets counter to max + 1
4. Updates `.sequence` file with `recoveredAt` timestamp

## Related Commands

- `cleo validate` - Detects ID integrity issues
- `cleo validate --fix-duplicates` - Interactive duplicate resolution
- `cleo upgrade` - Bootstraps sequence for legacy projects

## See Also

- [Troubleshooting ID Issues](../troubleshooting.md#id-integrity-issues)
