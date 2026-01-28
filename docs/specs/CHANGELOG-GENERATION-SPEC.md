# Changelog Generation Specification

**Version**: 1.0.0
**Status**: AUTHORITATIVE
**Created**: 2026-01-28
**Related**: RELEASE-MANAGEMENT-SPEC.md, GITHUB-RELEASE-INTEGRATION-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Preamble

### Purpose

This specification defines the **Changelog Generation Protocol** for CLEO, transforming task metadata into structured CHANGELOG.md entries for release documentation and GitHub Release integration.

### Authority

This specification is **AUTHORITATIVE** for:

- Task-to-changelog transformation algorithm
- Label-based categorization rules
- CHANGELOG.md format and structure
- Task association via hybrid date+label strategy
- Mandatory generation during `cleo release ship`
- Validation gates and error handling

This specification **DEFERS TO**:

- [RELEASE-MANAGEMENT-SPEC.md](RELEASE-MANAGEMENT-SPEC.md) for release lifecycle
- [GITHUB-RELEASE-INTEGRATION-SPEC.md](GITHUB-RELEASE-INTEGRATION-SPEC.md) for extraction
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards

### Consensus Foundation

This specification implements consensus decisions from Wave 1 (T2607, T2608, T2609):

1. **Mandatory generation** (T2607): Changelog generation is REQUIRED in `cleo release ship`
2. **Single source of truth** (T2608): CHANGELOG.md is authoritative for GitHub Release body
3. **Hybrid association** (T2609): Date window + label validation (85-95% accuracy)

### Problem Statement

CLEO needs automated changelog generation that:

1. **Transforms tasks** into human-readable changelog entries
2. **Categorizes changes** by semantic type (feature/fix/docs/etc.)
3. **Associates tasks** with releases automatically
4. **Validates completeness** before release ship
5. **Integrates with** GitHub Release creation

---

## Part 1: Architecture Overview

### 1.1 Pipeline Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                  CHANGELOG GENERATION PIPELINE                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  TASK ASSOCIATION                                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  populate_release_tasks()                                   │  │
│  │  - Date window: prev_release → current_release             │  │
│  │  - Label filter: version/changelog/release                 │  │
│  │  - Epic exclusion: type != "epic"                          │  │
│  │  → release.tasks[] array                                   │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                        │                                          │
│                        ▼                                          │
│  CATEGORIZATION                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  categorize_task()                                          │  │
│  │  - Label matching: feature/fix/docs/refactor/test/breaking │  │
│  │  - Priority order: breaking > feature > fix > ...          │  │
│  │  → category string                                          │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                        │                                          │
│                        ▼                                          │
│  MARKDOWN GENERATION                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  generate_changelog()                                       │  │
│  │  - Header: ## [vX.Y.Z] - YYYY-MM-DD                        │  │
│  │  - Sections: Breaking/Features/Fixes/Docs/Refactor/Tests   │  │
│  │  - Entry format: - Title (T####)                           │  │
│  │  → CHANGELOG.md content                                     │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                        │                                          │
│                        ▼                                          │
│  VALIDATION                                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  validate_release()                                         │  │
│  │  - Entry exists: grep "## \[v$version\]"                   │  │
│  │  - Non-empty: Content after header                         │  │
│  │  - Task IDs valid: All T#### exist                         │  │
│  │  → Success or E_CHANGELOG_GENERATION_FAILED                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Integration Points

| Component | Function | File | Purpose |
|-----------|----------|------|---------|
| **Task Association** | `populate_release_tasks()` | `lib/changelog.sh` | Hybrid date+label discovery |
| **Task Retrieval** | `get_release_tasks()` | `lib/changelog.sh` | Fetch full task objects |
| **Categorization** | `categorize_task_jq()` | `lib/changelog.sh` | Label → category mapping |
| **Generation** | `generate_changelog()` | `lib/changelog.sh` | Tasks → markdown |
| **Validation** | `validate_release()` | `scripts/release.sh` | Pre-ship validation |
| **Invocation** | `cmd_ship()` | `scripts/release.sh` | Mandatory call |

---

## Part 2: Task Association

### 2.1 Hybrid Date + Label Strategy

**Decision**: T2609 consensus - 92% confidence, 85-95% accuracy

#### Algorithm

```bash
populate_release_tasks() {
    local version="$1"
    local todo_file="${2:-$TODO_FILE}"

    # Normalize version
    local version_normalized="${version#v}"
    local version_with_v="v${version_normalized}"

    # Get current and previous release timestamps
    local release_timestamp prev_timestamp
    release_timestamp=$(jq -r --arg v "$version_with_v" '
        .project.releases[] | select(.version == $v) | .releasedAt
    ' "$todo_file")

    prev_timestamp=$(jq -r --arg current_ts "$release_timestamp" '
        [.project.releases[] |
         select(.releasedAt != null) |
         select(.releasedAt < $current_ts)] |
        sort_by(.releasedAt) | .[-1].releasedAt // "1970-01-01T00:00:00Z"
    ' "$todo_file")

    # Find candidate tasks in date window + label filter
    jq -r \
        --arg start "$prev_timestamp" \
        --arg end "$release_timestamp" \
        --arg v1 "$version_normalized" \
        --arg v2 "$version_with_v" \
        '
        [.tasks[] |

         # Filter 1: Must have completion timestamp
         select(.completedAt != null) |

         # Filter 2: Must be in date window
         select(.completedAt >= $start and .completedAt <= $end) |

         # Filter 3: Exclude epics (organizational tasks)
         select(.type != "epic") |

         # Filter 4: Must have relevant label
         select(
            (.labels // []) | (
                index($v1) or index($v2) or
                index("changelog") or index("release")
            )
         ) |

         .id
        ]
    ' "$todo_file"
}
```

### 2.2 Labeling Convention

**REQUIRED labels** (at least ONE):

| Label | Format | Use Case | Example |
|-------|--------|----------|---------|
| Version (normalized) | `0.75.0` | Specific version assignment | `0.75.0` |
| Version (v-prefix) | `v0.75.0` | Specific version assignment | `v0.75.0` |
| Generic changelog | `changelog` | Any release-worthy task | `changelog` |
| Generic release | `release` | Any release-worthy task | `release` |

**Labeling workflow**:

1. **During task creation**: Add `changelog` label if task is release-worthy
2. **During release planning**: Add version label (e.g., `v0.75.0`) to specific tasks
3. **On completion**: Automatic discovery picks up labeled tasks in date window

### 2.3 Epic Handling

**MUST exclude epics** from changelog entries:

```jq
select(.type != "epic")
```

**Rationale**:
- Epics are organizational (high-level grouping)
- Subtasks are actual work (specific deliverables)
- Changelog SHOULD list concrete changes, not epics

**Example**:

```
T2600 (Epic: Authentication System) → EXCLUDED
├── T2601 (Implement OAuth flow) → INCLUDED (if labeled + in window)
├── T2602 (Add session management) → INCLUDED (if labeled + in window)
└── T2603 (Write integration tests) → INCLUDED (if labeled + in window)
```

### 2.4 Edge Cases

#### Edge Case 1: Task Completed After Release Ship

**Scenario**: Task completed 15 minutes AFTER release timestamp

**Solution**: Require explicit version label (date window won't catch it)

**Rationale**: Explicit label enforces intent for post-ship tasks

---

#### Edge Case 2: Missing completedAt

**Scenario**: Task marked done but no `completedAt` timestamp (schema < 2.6.0)

**Fallback**:

```bash
# Include done tasks with version/changelog label even if no completedAt
[.tasks[] |
 select(
   (.completedAt == null and .status == "done") and
   ((.labels // []) | (index($version) or index("changelog")))
 ) |
 .id]
```

---

#### Edge Case 3: Backports and Hotfixes

**Scenario**: Task backported to multiple versions

**Solution**: Multiple version labels

```json
{
  "id": "T2700",
  "labels": ["v0.75.0", "v0.75.1", "backport"]
}
```

**Behavior**: Task included in BOTH release changelogs

---

## Part 3: Categorization

### 3.1 Category Mapping Rules

**MUST use priority-ordered label matching**:

| Category | Priority | Label Matches | Section Header |
|----------|----------|---------------|----------------|
| `breaking` | 1 | `breaking`, `breaking-change` | `### Breaking Changes` |
| `feature` | 2 | `feature`, `feat`, `enhancement` | `### Features` |
| `fix` | 3 | `bug`, `fix`, `bugfix`, `hotfix` | `### Bug Fixes` |
| `docs` | 4 | `docs`, `documentation` | `### Documentation` |
| `refactor` | 5 | `refactor`, `cleanup`, `chore` | `### Refactoring` |
| `test` | 6 | `test`, `testing` | `### Tests` |
| `other` | 7 | (no matching label) | `### Other Changes` |

### 3.2 Categorization Algorithm

**jq filter**:

```jq
def categorize:
    .labels // [] |
    if any(. == "breaking" or . == "breaking-change") then "breaking"
    elif any(. == "feature" or . == "feat" or . == "enhancement") then "feature"
    elif any(. == "bug" or . == "fix" or . == "bugfix" or . == "hotfix") then "fix"
    elif any(. == "docs" or . == "documentation") then "docs"
    elif any(. == "refactor" or . == "cleanup" or . == "chore") then "refactor"
    elif any(. == "test" or . == "testing") then "test"
    else "other"
    end;
```

### 3.3 Multi-Label Handling

**Behavior**: First matching category wins (priority order)

**Example**:

```json
{
  "id": "T2058",
  "labels": ["feature", "breaking"]
}
```

**Result**: Categorized as `breaking` (higher priority)

**SHOULD label tasks** with most specific/impactful category

---

## Part 4: Markdown Generation

### 4.1 Format Structure

**Header format**:

```markdown
## [vX.Y.Z] - YYYY-MM-DD
```

**Section format** (if category has tasks):

```markdown
### <Category Name>
- <Task Title> (<Task ID>)
- <Task Title> (<Task ID>)
```

**Full example**:

```markdown
## [v0.75.0] - 2026-01-28

### Breaking Changes
- Remove deprecated API endpoints (T2501)

### Features
- Add metadata fields to schema (T2058)
- Update validation rules (T2059)

### Bug Fixes
- Fix context alert handling (T2548)

### Documentation
- Update installation guide (T2600)

### Tests
- Add BATS tests for validation (T2601)
```

### 4.2 Section Order

**MUST render sections** in this order:

1. Breaking Changes
2. Features
3. Bug Fixes
4. Documentation
5. Refactoring
6. Tests
7. Other Changes

**MUST omit empty sections** (no tasks in category)

### 4.3 Entry Format

**Entry components**:

```
- <title> (<id>)
  ↑       ↑
  │       └─ Task ID with parentheses (e.g., "(T2058)")
  └─ Task title from task.title field
```

**MUST NOT include**:
- Task description (too verbose)
- Labels (already implied by categorization)
- Status (all tasks are done)
- Timestamps (release date in header)

**MAY include** (future enhancement):
- Task description as collapsible detail
- Links to task details
- Author attribution

### 4.4 Append vs. Overwrite

**Append mode** (prepend to existing CHANGELOG.md):

```bash
append_to_changelog() {
    local version="$1"
    local changelog_content
    changelog_content=$(generate_changelog "$version")

    local temp_file
    temp_file=$(mktemp)

    # Prepend new entry to existing changelog
    {
        echo "$changelog_content"
        echo ""
        cat "$CHANGELOG_FILE"
    } > "$temp_file"

    mv "$temp_file" "$CHANGELOG_FILE"
}
```

**Overwrite mode** (create new CHANGELOG.md):

```bash
write_changelog_file() {
    local version="$1"
    local output_file="${2:-$CHANGELOG_FILE}"

    generate_changelog "$version" > "$output_file"
}
```

**Default behavior**: MUST use **append mode** (preserves history)

---

## Part 5: Validation Gates

### 5.1 Pre-Ship Validation

**MUST validate** before creating git tag:

```bash
validate_release() {
    local version="$1"
    local version_no_v="${version#v}"

    # Check 1: Changelog entry exists
    if ! grep -q "^## \[v\?$version_no_v\]" "$CHANGELOG_FILE"; then
        log_error "No changelog entry found for version $version"
        exit $EXIT_CHANGELOG_GENERATION_FAILED
    fi

    # Check 2: Entry is not empty
    local section_content
    section_content=$(extract_changelog_section "$version")
    if [[ -z "$section_content" || "$section_content" =~ ^[[:space:]]*$ ]]; then
        log_error "Changelog entry for $version is empty"
        exit $EXIT_CHANGELOG_GENERATION_FAILED
    fi

    # Check 3: All task IDs exist
    grep -oP '\(T\d+\)' "$section_content" | while read -r task_id; do
        task_id="${task_id//[()]/}"
        if ! cleo exists "$task_id" &>/dev/null; then
            log_error "Task $task_id in changelog not found in todo.json"
            exit $EXIT_VALIDATION_FAILED
        fi
    done
}
```

### 5.2 Validation Criteria

| Check | Purpose | Error Code |
|-------|---------|------------|
| Entry exists | Ensure section present | `E_CHANGELOG_GENERATION_FAILED` |
| Entry non-empty | Prevent placeholder releases | `E_CHANGELOG_GENERATION_FAILED` |
| Task IDs valid | Prevent orphaned references | `E_VALIDATION_FAILED` |
| Markdown valid | Lint markdown syntax | `E_VALIDATION_FAILED` |

### 5.3 Error Handling

**On validation failure**:

1. **MUST exit** with non-zero code
2. **MUST log** specific error with context
3. **MUST NOT create** git tag or update VERSION
4. **SHOULD suggest** fix command (error.fix field)

**Example error**:

```json
{
  "success": false,
  "error": {
    "code": "E_CHANGELOG_GENERATION_FAILED",
    "message": "No changelog entry found for version v0.75.0",
    "exitCode": 52,
    "fix": "cleo release ship v0.75.0 --write-changelog"
  }
}
```

---

## Part 6: Mandatory Generation

### 6.1 Trigger Point

**Decision**: T2607 consensus - Generate during `cleo release ship`

**Implementation**:

```bash
cmd_ship() {
    local version="$1"

    # Step 1: Validate release exists
    validate_release_exists "$version"

    # Step 2: ALWAYS generate changelog (no flag needed)
    log_info "Generating changelog for $version..."
    if ! generate_changelog "$version"; then
        log_error "Changelog generation failed for $version"
        exit $EXIT_CHANGELOG_GENERATION_FAILED
    fi

    # Step 3: Validate changelog entry
    validate_release "$version"

    # Step 4: Create git tag and push
    # ...
}
```

### 6.2 Flag Removal

**REMOVED**: `--write-changelog` flag (was optional, now mandatory)

**ADDED**: `--skip-changelog` flag (emergency escape hatch)

```bash
# Emergency use only - explicit override
if [[ "$SKIP_CHANGELOG" == "true" ]]; then
    log_warn "SKIPPING changelog generation (--skip-changelog)"
    log_warn "You MUST manually update CHANGELOG.md before release"
else
    generate_changelog "$version"
fi
```

### 6.3 Atomic Operation

**MUST ensure** atomicity:

1. Generate changelog → CHANGELOG.md
2. Validate changelog entry exists
3. Create git tag
4. Push tag to remote

**On failure**:
- No git tag created
- No VERSION bump committed
- User can fix issues and re-run

---

## Part 7: JSON Schema

### 7.1 Changelog Entry Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^v?[0-9]+\\.[0-9]+\\.[0-9]+$",
      "description": "Semantic version with optional 'v' prefix"
    },
    "date": {
      "type": "string",
      "format": "date",
      "description": "Release date in YYYY-MM-DD format"
    },
    "breaking": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "features": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "fixes": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "docs": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "refactoring": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "tests": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    },
    "other": {
      "type": "array",
      "items": {"$ref": "#/definitions/changeEntry"}
    }
  },
  "required": ["version", "date"],
  "definitions": {
    "changeEntry": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^T[0-9]+$",
          "description": "Task ID"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Task title"
        },
        "description": {
          "type": "string",
          "description": "Task description (optional in changelog)"
        }
      },
      "required": ["id", "title"]
    }
  }
}
```

### 7.2 Release Tasks Schema Extension

**Addition to `todo.schema.json` release object**:

```json
{
  "releases": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "version": {"type": "string"},
        "status": {"enum": ["planned", "active", "released"]},
        "tasks": {
          "type": "array",
          "items": {"type": "string", "pattern": "^T[0-9]+$"},
          "description": "Associated task IDs (populated automatically or manually)"
        },
        "changelog": {
          "type": "string",
          "description": "Generated CHANGELOG.md content (cached for reuse)"
        },
        "releasedAt": {"type": "string", "format": "date-time"},
        "targetDate": {"type": "string", "format": "date"}
      },
      "required": ["version", "status", "tasks"]
    }
  }
}
```

---

## Part 8: Exit Codes

### 8.1 Changelog-Specific Codes

| Code | Name | Condition | Recoverable |
|------|------|-----------|-------------|
| 52 | `E_CHANGELOG_GENERATION_FAILED` | Entry not found or empty | Yes - fix and retry |
| 53 | `E_CHANGELOG_VALIDATION_FAILED` | Invalid task IDs or format | Yes - correct and retry |
| 54 | `E_CHANGELOG_WRITE_FAILED` | File I/O error | Maybe - check permissions |

### 8.2 Usage Example

```bash
if ! generate_changelog "$version"; then
    log_error "Changelog generation failed"
    exit $EXIT_CHANGELOG_GENERATION_FAILED
fi
```

---

## Part 9: Implementation Checklist

### 9.1 Required Functions

- [x] `populate_release_tasks()` - Hybrid date+label task discovery
- [x] `get_release_tasks()` - Fetch full task objects
- [x] `categorize_task_jq()` - Label → category mapping
- [x] `generate_changelog()` - Tasks → markdown
- [ ] `extract_changelog_section()` - Version section extraction (T2612)
- [x] `append_to_changelog()` - Prepend to existing file
- [x] `write_changelog_file()` - Create/overwrite file
- [ ] `validate_release()` - Pre-ship validation gate

### 9.2 Integration Points

- [ ] `scripts/release.sh:cmd_ship()` - Make generation mandatory
- [ ] `scripts/release.sh:cmd_ship()` - Add validation gate
- [ ] `scripts/release.sh:cmd_ship()` - Remove `--write-changelog` flag
- [ ] `scripts/release.sh:cmd_ship()` - Add `--skip-changelog` flag
- [ ] `lib/changelog.sh:populate_release_tasks()` - Implement hybrid algorithm
- [ ] `.github/workflows/release.yml` - Use extracted CHANGELOG.md (T2612)

### 9.3 Testing Requirements

**MUST test**:
- [ ] Hybrid date+label task discovery (precision/recall)
- [ ] Epic exclusion behavior
- [ ] Category mapping for all label types
- [ ] Markdown format compliance
- [ ] Validation gate enforcement
- [ ] Edge cases: missing completedAt, backports, post-ship tasks
- [ ] Empty release handling
- [ ] Multi-version labels

**Test files**:
- `tests/unit/changelog.bats` - Unit tests for all functions
- `tests/integration/release.bats` - End-to-end release workflow
- `tests/golden/changelog-format.bats` - Markdown format validation

---

## Part 10: Examples

### 10.1 Full Workflow Example

```bash
# Step 1: Create release
cleo release create v0.75.0 --target-date 2026-02-01

# Step 2: Label release-worthy tasks (during development)
cleo update T2058 --add-label changelog
cleo update T2059 --add-label changelog
cleo update T2548 --add-label changelog

# Step 3: Ship release (changelog auto-generated)
cleo release ship v0.75.0

# Result: CHANGELOG.md updated
## [v0.75.0] - 2026-02-01

### Features
- Add metadata fields to schema (T2058)
- Update validation rules (T2059)

### Bug Fixes
- Fix context alert handling (T2548)
```

### 10.2 Manual Override Example

```bash
# Emergency hotfix without changelog
cleo release ship v0.75.1 --skip-changelog

# Later: Manually update CHANGELOG.md
# Then: Backfill release tasks
cleo release backfill v0.75.1
```

### 10.3 Backfill Example

```bash
# Backfill historical release
cleo release backfill v0.74.0

# Behavior:
# 1. Parse CHANGELOG.md for task IDs
# 2. Validate tasks exist in todo.json
# 3. Update release.tasks[] array
# 4. Re-generate CHANGELOG.md to verify match
```

---

## Part 11: Performance Considerations

### 11.1 Complexity Analysis

| Operation | Complexity | Benchmark (1K tasks) | Acceptable (10K tasks) |
|-----------|------------|----------------------|------------------------|
| Task association | O(n) | 0.2s | <1s |
| Categorization | O(n) | 0.1s | <0.5s |
| Markdown generation | O(n) | 0.1s | <0.5s |
| **Total** | **O(n)** | **0.4s** | **<2s** |

**Optimization**: Pre-filter by `status="done"` to reduce n

### 11.2 Caching Strategy

**MAY cache** generated changelog in `release.changelog` field:

```json
{
  "version": "v0.75.0",
  "changelog": "## [v0.75.0] - 2026-02-01\n### Features\n..."
}
```

**Invalidate cache** when:
- Task added/removed from release
- Task title/labels modified
- Manual CHANGELOG.md edit

---

## Part 12: Future Enhancements

### 12.1 Planned Features

1. **Rich descriptions**: Include task description as collapsible detail
2. **Author attribution**: Credit task creators/completers
3. **Component grouping**: Sub-categorize by component label
4. **Breaking change details**: Migration guide generation
5. **Dependency tracking**: Link related tasks
6. **Automated testing**: Snapshot tests for changelog format

### 12.2 Backwards Compatibility

**MUST maintain** compatibility with existing:
- CHANGELOG.md entries (prior to automation)
- Manual edits to CHANGELOG.md
- Version formats (v-prefix or not)
- Label naming conventions

**Migration path**:
- Existing entries preserved
- New entries auto-generated
- Gradual adoption via labeling

---

## Appendix A: Complete Function Reference

### A.1 populate_release_tasks()

**Signature**: `populate_release_tasks(version, todo_file)`

**Returns**: JSON array of task IDs

**Algorithm**: Hybrid date + label (see §2.1)

---

### A.2 get_release_tasks()

**Signature**: `get_release_tasks(version, todo_file)`

**Returns**: JSON array of full task objects

**Implementation**:

```bash
jq --arg v "$version" '
    (.project.releases // [] | map(select(.version == $v)) | .[0].tasks // []) as $task_ids |
    [.tasks[] | select(.id as $id | $task_ids | index($id))]
' "$todo_file"
```

---

### A.3 generate_changelog()

**Signature**: `generate_changelog(version, release_date, todo_file)`

**Returns**: Markdown string

**Algorithm**: See §4.1

---

### A.4 validate_release()

**Signature**: `validate_release(version)`

**Returns**: Exit code (0 success, non-zero failure)

**Checks**: See §5.1

---

## Appendix B: Label Reference

### B.1 Category Labels

| Category | Labels (any match) |
|----------|-------------------|
| Breaking | `breaking`, `breaking-change` |
| Feature | `feature`, `feat`, `enhancement` |
| Fix | `bug`, `fix`, `bugfix`, `hotfix` |
| Docs | `docs`, `documentation` |
| Refactor | `refactor`, `cleanup`, `chore` |
| Test | `test`, `testing` |

### B.2 Association Labels

| Label | Purpose |
|-------|---------|
| `v0.75.0` | Explicit version assignment |
| `0.75.0` | Normalized version assignment |
| `changelog` | Generic release-worthy marker |
| `release` | Generic release-worthy marker |

---

## Appendix C: Exit Code Reference

| Code | Symbol | Description |
|------|--------|-------------|
| 52 | `EXIT_CHANGELOG_GENERATION_FAILED` | Changelog entry not found or empty |
| 53 | `EXIT_CHANGELOG_VALIDATION_FAILED` | Invalid task IDs or format |
| 54 | `EXIT_CHANGELOG_WRITE_FAILED` | File I/O error |

---

## Appendix D: References

- **Epic**: T2602 (CLEO Changesets)
- **Research**: T2603 (workflow analysis), T2605 (task association), T2606 (backfill)
- **Consensus**: T2607 (trigger), T2608 (GitHub Release body), T2609 (association strategy)
- **Specs**: RELEASE-MANAGEMENT-SPEC.md, GITHUB-RELEASE-INTEGRATION-SPEC.md
- **Implementation**: `lib/changelog.sh`, `scripts/release.sh`

---

**END OF SPECIFICATION**
