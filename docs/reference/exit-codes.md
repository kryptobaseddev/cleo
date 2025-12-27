# Exit Codes Reference

> **Version**: 1.0 | **Updated**: 2025-12-23
> **Spec**: [LLM-AGENT-FIRST-SPEC.md](../specs/LLM-AGENT-FIRST-SPEC.md) Parts 4, 5.6, 5.7

This document defines all exit codes used by cleo CLI and the retry protocol for LLM agents.

---

## Exit Code Categories

### General Codes (0-9)

| Code | Name | Meaning | Recoverable |
|:----:|------|---------|:-----------:|
| 0 | `EXIT_SUCCESS` | Command completed successfully | N/A |
| 1 | `EXIT_GENERAL_ERROR` | Unspecified error | No |
| 2 | `EXIT_INVALID_INPUT` | Invalid arguments or input | No |
| 3 | `EXIT_FILE_ERROR` | File read/write failure | No |
| 4 | `EXIT_NOT_FOUND` | Resource not found | No |
| 5 | `EXIT_DEPENDENCY_ERROR` | Missing tool (e.g., jq) | No |
| 6 | `EXIT_VALIDATION_ERROR` | Data validation failure | No |
| 7 | `EXIT_LOCK_TIMEOUT` | Could not acquire file lock | **Yes** |
| 8 | `EXIT_CONFIG_ERROR` | Configuration error | No |

### Hierarchy Codes (10-19)

| Code | Name | Meaning | Recoverable |
|:----:|------|---------|:-----------:|
| 10 | `EXIT_PARENT_NOT_FOUND` | Parent task does not exist | No |
| 11 | `EXIT_DEPTH_EXCEEDED` | Max hierarchy depth (3) exceeded | No |
| 12 | `EXIT_SIBLING_LIMIT` | Max siblings (7) exceeded | No |
| 13 | `EXIT_INVALID_PARENT_TYPE` | Parent cannot have children (subtask) | No |
| 14 | `EXIT_CIRCULAR_REFERENCE` | Would create dependency cycle | No |
| 15 | `EXIT_ORPHAN_DETECTED` | Task references invalid parent | No |

### Concurrency Codes (20-29)

| Code | Name | Meaning | Recoverable |
|:----:|------|---------|:-----------:|
| 20 | `EXIT_CHECKSUM_MISMATCH` | File modified during operation | **Yes** |
| 21 | `EXIT_CONCURRENT_MODIFICATION` | Multi-agent conflict detected | **Yes** |
| 22 | `EXIT_ID_COLLISION` | Generated ID already exists | **Yes** |

### Special Codes (100+)

| Code | Name | Meaning | Recoverable |
|:----:|------|---------|:-----------:|
| 100 | `EXIT_NO_DATA` | Query returned no results | N/A |
| 101 | `EXIT_ALREADY_EXISTS` | Resource already exists | No |
| 102 | `EXIT_NO_CHANGE` | Valid command but no state change | N/A |

---

## Retry Protocol for LLM Agents

LLM agents **SHOULD** implement retry logic for recoverable errors using exponential backoff.

### Recoverable Errors

| Exit Code | Name | Max Retries | Initial Delay | Backoff Factor |
|:---------:|------|:-----------:|:-------------:|:--------------:|
| 7 | `EXIT_LOCK_TIMEOUT` | 3 | 100ms | 2x |
| 20 | `EXIT_CHECKSUM_MISMATCH` | 5 | 50ms | 1.5x |
| 21 | `EXIT_CONCURRENT_MODIFICATION` | 5 | 100ms | 2x |
| 22 | `EXIT_ID_COLLISION` | 3 | 0ms | Immediate |

### Retry Algorithm

```python
def execute_with_retry(command, max_retries, initial_delay_ms, backoff_factor):
    delay = initial_delay_ms
    for attempt in range(max_retries + 1):
        exit_code, output = execute(command)

        if exit_code == 0 or not is_recoverable(exit_code):
            return exit_code, output

        if attempt < max_retries:
            sleep(delay / 1000)  # Convert to seconds
            delay *= backoff_factor

    return exit_code, output  # Final failure

def is_recoverable(code):
    return code in [7, 20, 21, 22]
```

### ID Collision Handling (Exit Code 22)

For `EXIT_ID_COLLISION`, agents **SHOULD**:
1. Extract the colliding ID from error JSON
2. Regenerate a new ID (or let CLI auto-generate)
3. Retry immediately without delay

### Maximum Total Wait

Total retry time is capped at 5 seconds maximum:
- Lock timeout: 100 + 200 + 400 = 700ms
- Checksum mismatch: 50 + 75 + 113 + 169 + 253 = 660ms
- Concurrent modification: 100 + 200 + 400 + 800 + 1600 = 3100ms
- ID collision: Immediate retries (3x max)

---

## Idempotency (EXIT_NO_CHANGE = 102)

Exit code 102 indicates a valid command that made no state changes.

### When EXIT_NO_CHANGE is Returned

| Command | Condition |
|---------|-----------|
| `update` | All field values identical to current |
| `complete` | Task already has status `done` |
| `archive` | Task already in archive |
| `restore` | Task already in active list |

### JSON Response Format

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.31.1", "command": "complete"},
  "success": true,
  "noChange": true,
  "message": "Task T042 is already complete"
}
```

### Agent Handling

Agents **SHOULD** treat EXIT_NO_CHANGE (102) as success:
- Do not retry
- Do not report as error
- Operation was valid, state unchanged

---

## Error JSON Response

All errors return structured JSON with the following envelope:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.31.1",
    "command": "add",
    "timestamp": "2025-12-23T10:00:00Z"
  },
  "success": false,
  "error": {
    "code": "E_TASK_NOT_FOUND",
    "message": "Task T999 not found",
    "exitCode": 4,
    "recoverable": false,
    "suggestion": "Use 'cleo list' to see available tasks"
  }
}
```

### Error Code Categories

| Prefix | Category | Example |
|--------|----------|---------|
| `E_TASK_*` | Task operations | `E_TASK_NOT_FOUND`, `E_TASK_INVALID_ID` |
| `E_FILE_*` | File operations | `E_FILE_READ_ERROR`, `E_FILE_PERMISSION` |
| `E_INPUT_*` | Input validation | `E_INPUT_MISSING`, `E_INPUT_INVALID` |
| `E_VALIDATION_*` | Data validation | `E_VALIDATION_SCHEMA`, `E_VALIDATION_REQUIRED` |
| `E_PHASE_*` | Phase operations | `E_PHASE_NOT_FOUND`, `E_PHASE_INVALID` |
| `E_SESSION_*` | Session operations | `E_SESSION_ACTIVE`, `E_SESSION_NOT_ACTIVE` |
| `E_CHECKSUM_*` | Concurrency | `E_CHECKSUM_MISMATCH` |
| `E_ALREADY_*` | Already exists | `E_ALREADY_INITIALIZED` |
| `E_CONFIRMATION_*` | Confirmation required | `E_CONFIRMATION_REQUIRED` |

### Init Command Error Codes

| Code | Exit Code | Description |
|------|-----------|-------------|
| `E_ALREADY_INITIALIZED` | 101 | Project already initialized (use `--force --confirm-wipe`) |
| `E_CONFIRMATION_REQUIRED` | 2 | `--force` requires `--confirm-wipe` for destructive operations |

---

## See Also

- [LLM-AGENT-FIRST-SPEC.md](../specs/LLM-AGENT-FIRST-SPEC.md) - Full specification
- [lib/exit-codes.sh](../../lib/exit-codes.sh) - Exit code constants
- [lib/error-json.sh](../../lib/error-json.sh) - Error code constants
