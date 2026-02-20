# Error Codes Reference

**Version**: 1.0.0

---

## Overview

CLEO uses structured exit codes to classify errors and enable programmatic error handling. All errors include actionable fix suggestions.

### Error Response Format

```json
{
  "_meta": {
    "gateway": "cleo_mutate",
    "domain": "tasks",
    "operation": "add",
    "version": "1.0.0",
    "timestamp": "2026-02-04T08:24:05Z"
  },
  "success": false,
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "details": {
      "field": "description",
      "value": "Same as title",
      "constraint": "must differ from title"
    },
    "fix": "Provide a unique description that differs from the title",
    "alternatives": [
      {
        "action": "Use generated description",
        "command": "cleo_mutate tasks create --title \"...\" --description \"Implementation of ...\""
      }
    ]
  }
}
```

---

## Exit Code Ranges

| Range | Category | Retryable | Description |
|-------|----------|-----------|-------------|
| 0 | Success | N/A | Operation completed successfully |
| 1-9 | General errors | Some (7) | Common errors |
| 10-19 | Hierarchy errors | No | Task hierarchy violations |
| 20-29 | Dependency errors | Yes | Dependency issues |
| 30-39 | Session errors | No | Session management errors |
| 40-49 | Gate errors | No | Verification gate failures |
| 50-59 | Context errors | Yes | Context budget warnings |
| 60-70 | Protocol violations | Some (60-63) | RCSD-IVTR protocol violations |
| 75-79 | Lifecycle errors | No | Lifecycle gate failures |
| 100+ | Special codes | N/A | Non-error status codes |

---

## General Errors (1-9)

### E_GENERAL (1)

**Description**: Unspecified error

**Common Causes**:
- Unexpected internal error
- Command execution failure
- Unknown state

**Fix**: Check logs for details, retry operation

**Retryable**: No

---

### E_INVALID_INPUT (2)

**Description**: Invalid input parameters

**Common Causes**:
- Missing required parameters
- Invalid parameter types
- Malformed data

**Example**:
```json
{
  "error": {
    "code": "E_INVALID_INPUT",
    "exitCode": 2,
    "message": "Invalid task ID format: must match ^T[0-9]+$",
    "details": {
      "field": "taskId",
      "value": "TASK123",
      "pattern": "^T[0-9]+$"
    },
    "fix": "Use valid task ID format (e.g., T2908)"
  }
}
```

**Retryable**: No (fix input first)

---

### E_FILE_ERROR (3)

**Description**: File read/write error

**Common Causes**:
- Missing file
- Permission denied
- Disk full
- File locked

**Fix**: Check file permissions and disk space

**Retryable**: Sometimes (depends on cause)

---

### E_NOT_FOUND (4)

**Description**: Resource not found

**Common Causes**:
- Task doesn't exist
- Session not found
- Invalid ID reference

**Example**:
```json
{
  "error": {
    "code": "E_NOT_FOUND",
    "exitCode": 4,
    "message": "Task not found: T9999",
    "fix": "Verify task ID with: cleo_query tasks exists {taskId: \"T9999\"}",
    "alternatives": [
      {
        "action": "List all tasks",
        "command": "cleo_query tasks list"
      },
      {
        "action": "Search tasks",
        "command": "cleo_query tasks find {query: \"...\"}"
      }
    ]
  }
}
```

**Retryable**: No (resource doesn't exist)

---

### E_DEPENDENCY (5)

**Description**: Missing dependency

**Common Causes**:
- Required CLI tool not installed
- Missing library function
- Environment not configured

**Fix**: Install missing dependencies

**Retryable**: No (install dependencies first)

---

### E_VALIDATION (6)

**Description**: Validation failed

**Common Causes**:
- Schema validation failure
- Business rule violation
- Data integrity check failed

**Subcodes**:
- `E_VALIDATION_FAILED` - General validation failure
- `E_VALIDATION_TITLE_DESC_SAME` - Title and description identical
- `E_VALIDATION_DUPLICATE` - Duplicate content detected

**Example**:
```json
{
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "details": {
      "rule": "anti-hallucination",
      "field": "description",
      "constraint": "must differ from title"
    },
    "fix": "Provide a more detailed description"
  }
}
```

**Retryable**: No (fix validation issues first)

---

### E_RETRYABLE (7)

**Description**: Transient error, safe to retry

**Common Causes**:
- File lock conflict
- Network timeout
- Temporary resource unavailable

**Fix**: Retry with exponential backoff

**Retryable**: Yes (with backoff)

**Retry Strategy**:
```typescript
async function retryOperation(operation, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error.exitCode !== 7 || attempt === maxAttempts) {
        throw error;
      }
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

---

## Hierarchy Errors (10-19)

### E_PARENT_NOT_FOUND (10)

**Description**: Parent task does not exist

**Example**:
```json
{
  "error": {
    "code": "E_PARENT_NOT_FOUND",
    "exitCode": 10,
    "message": "Parent task not found: T2900",
    "fix": "Verify parent exists: cleo_query tasks exists {taskId: \"T2900\"}",
    "alternatives": [
      {
        "action": "Create parent first",
        "command": "cleo_mutate tasks create {title: \"Parent\", description: \"...\"}"
      },
      {
        "action": "Create without parent",
        "command": "cleo_mutate tasks create {title: \"...\", description: \"...\"}"
      }
    ]
  }
}
```

**Retryable**: No

---

### E_DEPTH_EXCEEDED (11)

**Description**: Maximum hierarchy depth (3) exceeded

**Hierarchy Limits**:
- Level 0: Root
- Level 1: Epic
- Level 2: Task
- Level 3: Subtask (maximum)

**Example**:
```json
{
  "error": {
    "code": "E_DEPTH_EXCEEDED",
    "exitCode": 11,
    "message": "Maximum hierarchy depth (3) exceeded",
    "details": {
      "currentDepth": 3,
      "maxDepth": 3,
      "parent": "T2910",
      "parentDepth": 3
    },
    "fix": "Create task at shallower level or promote parent"
  }
}
```

**Retryable**: No

---

### E_SIBLING_LIMIT (12)

**Description**: Maximum siblings (7) per parent exceeded

**Example**:
```json
{
  "error": {
    "code": "E_SIBLING_LIMIT",
    "exitCode": 12,
    "message": "Cannot add task: parent T2900 already has 7 children",
    "details": {
      "parent": "T2900",
      "currentSiblings": 7,
      "maxSiblings": 7
    },
    "fix": "Create a new parent task to group related work",
    "alternatives": [
      {
        "action": "List siblings",
        "command": "cleo_query tasks list {parent: \"T2900\"}"
      },
      {
        "action": "Create new epic",
        "command": "cleo_mutate tasks create {title: \"New Epic\", description: \"...\"}"
      }
    ]
  }
}
```

**Retryable**: No

---

### E_CIRCULAR_DEP (13)

**Description**: Circular dependency detected

**Example**:
```json
{
  "error": {
    "code": "E_CIRCULAR_DEP",
    "exitCode": 13,
    "message": "Circular dependency detected: T2905 → T2908 → T2905",
    "details": {
      "cycle": ["T2905", "T2908", "T2905"]
    },
    "fix": "Remove circular dependency"
  }
}
```

**Retryable**: No

---

## Session Errors (30-39)

### E_FOCUS_REQUIRED (38)

**Description**: Operation requires focused task

**Example**:
```json
{
  "error": {
    "code": "E_FOCUS_REQUIRED",
    "exitCode": 38,
    "message": "No task focused. Set focus before continuing.",
    "fix": "Set focus: cleo_mutate tasks start {taskId: \"T2908\"}",
    "alternatives": [
      {
        "action": "Start session with auto-focus",
        "command": "cleo_mutate session start {scope: \"epic:T2900\", autoStart: true}"
      }
    ]
  }
}
```

**Retryable**: No (set focus first)

---

### E_SESSION_DISCOVERY (100)

**Description**: Session scope discovery mode (NOT an error)

**Explanation**: When starting a session without `--auto-focus`, CLEO enters discovery mode. This is a special status code (100+) indicating the user should run `cleo session list` to discover existing sessions.

**Example**:
```json
{
  "exitCode": 100,
  "message": "Multiple sessions exist. Run cleo session list to see options.",
  "action": "discovery",
  "fix": "Add --scope epic:T#### to start command"
}
```

**Retryable**: N/A (informational)

---

## Protocol Violations (60-70)

### E_PROTOCOL_RESEARCH (60)

**Description**: Research protocol violation

**Common Violations**:
- Missing `key_findings` array
- Code modifications in research task
- No manifest entry
- Missing sources/citations

**Example**:
```json
{
  "error": {
    "code": "E_PROTOCOL_RESEARCH",
    "exitCode": 60,
    "message": "Research protocol violation: missing key_findings",
    "details": {
      "rule": "RSCH-006",
      "level": "MUST",
      "requirement": "Include 3-7 key findings in manifest"
    },
    "fix": "Add key_findings array to manifest entry"
  }
}
```

**Retryable**: Yes (after fixing violations)

**See**: [Protocols Reference](protocols.md#research-protocol)

---

### E_PROTOCOL_CONSENSUS (61)

**Description**: Consensus protocol violation

**Common Violations**:
- Missing voting matrix
- Invalid confidence scores
- Threshold not met
- Missing escalation

**Retryable**: Yes (after fixing violations)

---

### E_PROTOCOL_SPECIFICATION (62)

**Description**: Specification protocol violation

**Common Violations**:
- Missing RFC 2119 keywords (MUST/SHOULD/MAY)
- No version number
- Missing conformance criteria

**Retryable**: Yes (after fixing violations)

---

### E_PROTOCOL_DECOMPOSITION (63)

**Description**: Decomposition protocol violation

**Common Violations**:
- MECE principle violated
- Time estimates included
- Circular dependencies
- Too many siblings (>7)

**Retryable**: Yes (after fixing violations)

---

### E_PROTOCOL_IMPLEMENTATION (64)

**Description**: Implementation protocol violation

**Common Violations**:
- Missing `@task` provenance tags
- Tests not passing
- Code style violations

**Retryable**: No (fix implementation first)

---

### E_PROTOCOL_CONTRIBUTION (65)

**Description**: Contribution protocol violation

**Common Violations**:
- Missing provenance tags
- Invalid commit message format
- Validation gates not passed

**Retryable**: No

---

### E_PROTOCOL_RELEASE (66)

**Description**: Release protocol violation

**Common Violations**:
- Invalid semver
- Missing changelog entry
- Git tag mismatch
- Tests not passing

**Retryable**: No

---

### E_PROTOCOL_GENERIC (67)

**Description**: Generic protocol violation

**Retryable**: Sometimes

---

### E_PROTOCOL_VALIDATION (68)

**Description**: Validation protocol violation

**Common Violations**:
- Output doesn't match spec
- Test suite not executed
- Protocol compliance not checked

**Retryable**: No

---

### E_TESTS_SKIPPED (69)

**Description**: Tests not run or incomplete

**Retryable**: No (run tests first)

---

### E_COVERAGE_INSUFFICIENT (70)

**Description**: Test coverage below threshold

**Retryable**: No (add more tests)

---

## Lifecycle Errors (75-79)

### E_LIFECYCLE_GATE_FAILED (75)

**Description**: Lifecycle prerequisites not met

**Example**:
```json
{
  "error": {
    "code": "E_LIFECYCLE_GATE_FAILED",
    "exitCode": 75,
    "message": "SPAWN BLOCKED: Lifecycle prerequisites not met",
    "details": {
      "targetStage": "implementation",
      "missingPrerequisites": ["research", "specification"],
      "epicId": "T2900"
    },
    "fix": "Complete missing stages: research, specification",
    "alternatives": [
      {
        "action": "Check RCSD state",
        "command": "jq . .cleo/rcsd/T2900/_manifest.json"
      },
      {
        "action": "Skip stage (if optional)",
        "command": "cleo_mutate lifecycle skip {taskId: \"T2900\", stage: \"consensus\", reason: \"...\"}"
      }
    ]
  }
}
```

**Retryable**: No (complete prerequisites first)

**Enforcement Modes**:
- `strict`: Blocks spawn (default)
- `advisory`: Warns but proceeds
- `off`: Skips all checks (emergency only)

**See**: [Lifecycle Reference](lifecycle.md)

---

## Error Handling Best Practices

### 1. Check Success Field First

```typescript
const result = await cleo_query({...});

if (!result.success) {
  // Handle error
  console.error(result.error.message);
  console.error('Fix:', result.error.fix);
  return;
}

// Process result.data
```

### 2. Use Exit Codes for Flow Control

```typescript
try {
  await cleo_mutate({...});
} catch (error) {
  switch (error.exitCode) {
    case 4:  // E_NOT_FOUND
      // Resource doesn't exist
      break;
    case 7:  // E_RETRYABLE
      // Retry with backoff
      await retryOperation();
      break;
    case 75:  // E_LIFECYCLE_GATE_FAILED
      // Complete prerequisites
      break;
    default:
      throw error;
  }
}
```

### 3. Use Fix Suggestions

```json
{
  "error": {
    "fix": "cleo_mutate tasks start {taskId: \"T2908\"}",
    "alternatives": [...]
  }
}
```

Copy-paste fix commands directly - they're tested and validated.

### 4. Implement Retry Logic

```typescript
async function retryableOperation(operation, maxAttempts = 3) {
  const retryableCodes = [7, 20, 21, 22, 60, 61, 62, 63];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isRetryable = retryableCodes.includes(error.exitCode);
      const isLastAttempt = attempt === maxAttempts;

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    }
  }
}
```

---

## Next Steps

- **Protocol Reference**: [Protocols](protocols.md)
- **Lifecycle Reference**: [Lifecycle](lifecycle.md)
- **Troubleshooting**: [Troubleshooting Guide](../guides/troubleshooting.md)
