---
name: ct-library-implementer-bash
description: Bash library development with focus on creating well-structured lib/*.sh files following shell best practices. Implements reusable functions, utility modules, and shared helpers with proper documentation, error handling, and dependency management. Use when creating new lib/ modules, implementing shared functions, or adding utility libraries. Triggers on library implementation tasks, bash module creation, or utility function needs.
---

# Library Implementer (Bash) Context Injection

**Protocol**: @protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for Bash library implementation tasks spawned via cleo-subagent. Provides domain expertise for creating well-structured bash library files with reusable functions following shell best practices.

---

## Capabilities

1. **Function Libraries** - Create lib/*.sh files with related functions
2. **Utility Functions** - Implement shared helper functions
3. **Module Design** - Organize functions into cohesive modules
4. **Documentation** - Document function signatures and usage

---

## Bash Library Architecture

### Directory Structure

```
lib/
├── exit-codes.sh       # Exit code constants
├── output-format.sh    # JSON/human output formatting
├── validation.sh       # Input validation functions
├── file-ops.sh         # Atomic file operations
├── logging.sh          # Audit trail logging
├── config.sh           # Configuration management
└── {new-module}.sh     # Your new library
```

### Library Template

```bash
#!/usr/bin/env bash
# lib/{module-name}.sh - Brief description of module purpose
#
# Functions:
#   function_name()     - Brief description
#   another_function()  - Brief description

# Guard against multiple sourcing
[[ -n "${_MODULE_NAME_LOADED:-}" ]] && return 0
readonly _MODULE_NAME_LOADED=1

# Dependencies (source other libs if needed)
# source "${LIB_DIR:-./lib}/dependency.sh"

# ==============================================================================
# CONSTANTS
# ==============================================================================

readonly MODULE_CONSTANT="value"

# ==============================================================================
# FUNCTIONS
# ==============================================================================

# Brief description of what this function does
#
# Arguments:
#   $1 - arg_name: Description
#   $2 - arg_name: Description (optional, default: value)
#
# Returns:
#   0 on success, non-zero on failure
#
# Output:
#   Writes result to stdout (JSON or text)
#
# Example:
#   result=$(function_name "arg1" "arg2")
#
function_name() {
  local arg1="$1"
  local arg2="${2:-default}"

  # Implementation
}

# Another function with similar documentation
another_function() {
  local input="$1"

  # Implementation
}
```

---

## Function Design Guidelines

### Naming Conventions

```bash
# Public functions: lowercase_with_underscores
get_task_by_id()
validate_json_schema()

# Private/internal functions: prefix with underscore
_internal_helper()
_parse_config()

# Module-specific prefix for clarity
rm_get_entry()        # research-manifest module
orc_build_prompt()    # orchestrator module
```

### Input Validation

```bash
function_name() {
  local required_arg="$1"
  local optional_arg="${2:-default}"

  # Validate required arguments
  if [[ -z "$required_arg" ]]; then
    echo "ERROR: required_arg is required" >&2
    return 1
  fi

  # Implementation
}
```

### Error Handling

```bash
function_name() {
  local file="$1"

  # Check preconditions
  if [[ ! -f "$file" ]]; then
    echo "ERROR: File not found: $file" >&2
    return "${EXIT_FILE_ERROR:-4}"
  fi

  # Use set -e locally if needed
  local result
  if ! result=$(risky_operation 2>&1); then
    echo "ERROR: Operation failed: $result" >&2
    return 1
  fi

  echo "$result"
}
```

### JSON Output

```bash
# Functions that produce output should support JSON
get_data() {
  local id="$1"
  local format="${2:-json}"

  local data
  data=$(fetch_data "$id")

  if [[ "$format" == "json" ]]; then
    jq -nc --arg id "$id" --arg data "$data" \
      '{"id": $id, "data": $data}'
  else
    echo "ID: $id"
    echo "Data: $data"
  fi
}
```

---

## Module Organization

### Single Responsibility

Each library should have ONE clear purpose:

```bash
# GOOD: lib/research-manifest.sh
# - All functions related to research manifest operations

# BAD: lib/utils.sh
# - Grab bag of unrelated functions
```

### Dependency Management

```bash
# At top of file, source dependencies
source "${LIB_DIR:-./lib}/exit-codes.sh"
source "${LIB_DIR:-./lib}/output-format.sh"

# Or check for required functions
if ! declare -f required_function &>/dev/null; then
  echo "ERROR: required_function not available" >&2
  return 1
fi
```

### Avoid Circular Dependencies

```
Layer 0: exit-codes.sh (no deps)
Layer 1: output-format.sh (deps: exit-codes)
Layer 2: validation.sh (deps: exit-codes, output-format)
Layer 3: Your module (deps: layers 0-2)
```

---

## Testing Library Functions

```bash
# In tests/unit/{module}.bats

@test "function_name returns expected result" {
  source lib/{module}.sh

  result=$(function_name "input")

  assert_equal "$result" "expected"
}

@test "function_name handles missing input" {
  source lib/{module}.sh

  run function_name ""

  assert_failure
  assert_output --partial "required"
}
```

---

## Output Location

Libraries go in: `lib/{{MODULE_NAME}}.sh`

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}` (if not already set by orchestrator)
3. Create library file in lib/
4. Verify syntax: `bash -n lib/{module}.sh`
5. Append manifest entry to `{{MANIFEST_PATH}}`
6. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
7. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST create library file in lib/
2. MUST verify syntax: `bash -n lib/{module}.sh`
3. MUST append ONE line to: `{{MANIFEST_PATH}}`
4. MUST return ONLY: "Implementation complete. See MANIFEST.jsonl for summary."
5. MUST NOT return full library content in response

### Manifest Entry Format

```json
{"id":"lib-{{MODULE}}-{{DATE}}","file":"{{DATE}}_lib-{{MODULE}}.md","title":"Library: {{MODULE}}","date":"{{DATE}}","status":"complete","agent_type":"implementation","topics":["library","bash","{{DOMAIN}}"],"key_findings":["Created lib/{{MODULE}}.sh with N functions","Functions: function1, function2, function3","Dependencies: list or 'none'","Syntax check passed"],"actionable":false,"needs_followup":["{{TEST_TASK_IDS}}"],"linked_tasks":["{{TASK_ID}}"]}
```

---

## Completion Checklist

- [ ] Task focus set via `{{TASK_FOCUS_CMD}}` (if not already set)
- [ ] Library file created in lib/
- [ ] Guard against multiple sourcing included
- [ ] Functions documented with signatures
- [ ] Input validation implemented
- [ ] Error handling with proper exit codes
- [ ] Syntax check passed (`bash -n`)
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only
