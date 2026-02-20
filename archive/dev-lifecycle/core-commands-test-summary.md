# Core Commands Test Suite - Implementation Summary

## Overview

Created comprehensive BATS test suites for core claude-todo commands following the existing test infrastructure patterns.

## Test Files Created

### 1. tests/unit/add-task.bats (590 lines)

Comprehensive tests for add-task.sh covering:

**Basic Functionality:**
- Task creation with title only
- Default values (status: pending, priority: medium)
- Unique ID generation
- Valid JSON structure generation

**Options Testing - Long Flags:**
- --priority (critical, high, medium, low)
- --description
- --labels
- --phase
- --depends
- --notes
- --files
- --acceptance
- --status
- --quiet

**Options Testing - Short Flags:**
- -p (priority)
- -d (description)
- -l (labels)
- -D (depends)
- -s (status)
- -q (quiet)

**Special Characters & Unicode:**
- Quotes in title
- Dollar signs
- Backticks
- Special chars in description
- Unicode characters (émojis, CJK)

**Label Deduplication:**
- Duplicate labels are deduped
- Mixed duplicates keep unique ones

**Error Cases:**
- Missing title
- Empty title
- Invalid priority/status/phase
- Invalid dependency ID
- Non-existent dependencies
- Invalid label format
- Uppercase labels fail
- Missing todo.json
- Title too long (>120 chars)

**Validation:**
- JSON validity
- Checksum updates
- lastUpdated timestamp
- Active task constraint (only ONE active)
- Blocked task requires description
- Circular dependency prevention

**Quiet Mode:**
- Outputs only task ID
- Valid T### format

**Integration:**
- Multiple tasks increment IDs correctly
- Files option
- Acceptance criteria

### 2. tests/unit/update-task.bats (618 lines)

Comprehensive tests for update-task.sh covering:

**Single Field Updates:**
- Title
- Status
- Priority
- Description
- Phase

**Short Flags:**
- -s (status)
- -p (priority)
- -t (title)
- -d (description)
- -n (notes)

**Multiple Field Updates:**
- Simultaneous field changes

**Array Operations - Labels:**
- Append labels (--labels)
- Replace labels (--set-labels)
- Clear labels (--clear-labels)
- Short flag (-l)

**Array Operations - Files:**
- Append files
- Replace files (--set-files)
- Clear files (--clear-files)

**Array Operations - Acceptance:**
- Append criteria
- Replace criteria (--set-acceptance)
- Clear criteria (--clear-acceptance)

**Array Operations - Dependencies:**
- Append dependencies
- Replace dependencies (--set-depends)
- Clear dependencies (--clear-depends)

**Notes:**
- Add notes (timestamped)
- Multiple notes append
- -n short flag

**Blocked By:**
- --blocked-by sets status to blocked
- Stores blocker reason

**Error Cases:**
- Non-existent task
- Missing task ID
- Invalid task ID format
- Invalid status/priority/phase
- Invalid label format
- Invalid dependency
- Self-dependency
- Status to "done" (must use complete-task)
- Cannot update completed tasks
- Active task constraint
- No updates specified
- Missing todo.json

**Circular Dependency Prevention:**
- Direct circular
- Indirect circular via intermediate

**Validation:**
- Valid JSON output
- lastUpdated timestamp
- Checksum updates

**Output:**
- Shows changes made
- Shows task ID

**Edge Cases:**
- Empty title fails
- Title too long
- Special characters
- Unicode characters

**Integration:**
- Preserves other fields
- Doesn't affect other tasks

### 3. tests/unit/list-tasks.bats (743 lines)

Comprehensive tests for list-tasks.sh covering:

**Basic Listing:**
- List all tasks
- Empty todo shows message
- Displays task titles

**Status Filtering:**
- --status pending/active/blocked/done (long flags)
- -s status (short flags)

**Priority Filtering:**
- --priority critical/high/medium/low (long flags)
- -p priority (short flags)

**Label Filtering:**
- --label filter (long flag)
- -l label (short flag)

**Combined Filters:**
- Multiple filters simultaneously

**Output Formats - JSON:**
- --format json (long)
- -f json (short)
- Valid JSON structure
- Required keys: tasks, _meta, summary
- Metadata includes version
- Summary includes counts
- Empty tasks JSON format

**Output Formats - Markdown:**
- --format markdown
- Task headers (## T001)
- Task details (**Status:**, **Priority:**)

**Output Formats - JSONL:**
- --format jsonl
- Each line valid JSON
- First line: metadata (_type: meta)
- Last line: summary (_type: summary)

**Output Formats - Table:**
- --format table
- ASCII table with borders (╔, ║)
- Headers: ID, Title, Status

**Invalid Format Validation (NEW - T142):**
- Invalid format fails
- Shows valid options
- Typos fail (e.g., "josn")

**Compact Mode:**
- --compact one line per task
- -c short flag

**Verbose Mode:**
- --verbose shows all details
- -v short flag
- Shows timestamps

**Quiet Mode:**
- --quiet suppresses headers
- -q short flag
- Still shows task data

**Display Options:**
- --notes shows task notes
- --files shows associated files
- --acceptance shows criteria

**Sorting:**
- --sort priority/status/createdAt/title
- --reverse reverses order

**Limit:**
- --limit N shows first N tasks

**Date Filtering:**
- --since filters by creation date
- --until filters by creation date
- Combined date range

**Archive:**
- --all includes archived tasks

**Grouping:**
- --flat disables grouping
- Default groups by priority

**Error Handling:**
- Missing todo.json
- Unknown option

**NO_COLOR Compliance:**
- Respects NO_COLOR environment
- Still shows content without colors
- No ANSI escape codes

**Unicode/ASCII Fallback:**
- LANG=C uses ASCII
- Default supports unicode

**Dependencies Display:**
- Shows blocked tasks with reason
- Shows task dependencies

**Edge Cases:**
- Tasks with no optional fields
- Tasks with all optional fields
- Very long task titles

**Integration:**
- JSON output can be piped to jq
- Correct count summary
- Filtered count accuracy

### 4. tests/unit/session.bats (253 lines - existing file)

Session management tests already existed with coverage for:

**Session Start:**
- Creates active session
- Generates session ID
- Sets timestamp
- Logs to todo-log
- Shows context information
- Shows focus if exists
- Shows last session note
- Shows next action

**Session End:**
- Clears active session
- Safe without active session
- Logs completion
- Accepts --note option

**Session Status:**
- Shows active session
- Shows no active session
- Shows duration

**Session Lifecycle:**
- Complete workflow: start → status → end
- Prevents duplicate start
- Multiple sessions

**Validation:**
- Maintains valid JSON
- Creates log file if missing

## Test Infrastructure

All tests follow the established patterns:

### Setup/Teardown
```bash
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup
}

teardown() {
    common_teardown
}
```

### Fixture Usage
- `create_empty_todo` - Empty todo.json
- `create_independent_tasks` - T001, T002, T003 with no dependencies
- `create_linear_chain` - T001 ← T002 ← T003
- `create_blocked_tasks` - Tasks with blocked status
- `create_tasks_with_completed` - Mix of done and pending tasks

### Custom Assertions
- `assert_shows_help` - Validates help output
- `assert_valid_json` - JSON validation
- `assert_task_exists` - Task presence
- `assert_task_status` - Status verification
- `assert_task_depends_on` - Dependency check
- `assert_task_count` - Count validation
- `assert_markdown_output` - Markdown format check

## Test Coverage Summary

| Command | Test File | Lines | Test Cases | Coverage Areas |
|---------|-----------|-------|------------|----------------|
| add-task.sh | add-task.bats | 590 | 56 | All options, validation, edge cases, errors |
| update-task.sh | update-task.bats | 618 | 58 | Field updates, arrays, validation, errors |
| list-tasks.sh | list-tasks.bats | 743 | 76 | Filters, formats, display, validation |
| session.sh | session.bats | 253 | 24 | Lifecycle, logging, validation |

**Total:** 2,204 lines, **214 test cases**

## Key Testing Patterns

1. **Help Testing:** Every command tests --help and -h flags
2. **Short/Long Flags:** Both flag variants tested where applicable
3. **Error Cases:** Comprehensive invalid input testing
4. **Edge Cases:** Special characters, unicode, boundary values
5. **JSON Validation:** All commands verify JSON integrity
6. **NO_COLOR Compliance:** Color output respects environment variables
7. **Integration:** Tests verify commands work together correctly

## Running the Tests

```bash
# Run all core command tests
bats tests/unit/add-task.bats
bats tests/unit/update-task.bats
bats tests/unit/list-tasks.bats
bats tests/unit/session.bats

# Run specific test
bats tests/unit/add-task.bats --filter "add task with unicode"

# Run all unit tests
bats tests/unit/

# Run with TAP output
bats --tap tests/unit/add-task.bats
```

## Verification

All test files:
- Follow existing test structure
- Use DRY helper functions
- Have proper setup/teardown
- Test both success and failure cases
- Validate JSON where applicable
- Include edge cases and special characters
- Test NO_COLOR compliance where relevant

## Next Steps

1. Run full test suite to verify all tests pass
2. Add any missing edge cases discovered during testing
3. Update test coverage reports
4. Consider adding performance benchmarks
5. Document any test failures and create bug reports

## Files Modified

- `/mnt/projects/claude-todo/tests/unit/add-task.bats` (NEW - 590 lines)
- `/mnt/projects/claude-todo/tests/unit/update-task.bats` (NEW - 618 lines)
- `/mnt/projects/claude-todo/tests/unit/list-tasks.bats` (NEW - 743 lines)
- `/mnt/projects/claude-todo/tests/unit/session.bats` (EXISTS - 253 lines)

All tests use existing test helpers and fixtures from:
- `tests/test_helper/common_setup.bash`
- `tests/test_helper/assertions.bash`
- `tests/test_helper/fixtures.bash`
