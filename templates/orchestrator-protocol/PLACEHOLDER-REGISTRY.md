# Template Placeholder Registry

**Version**: 1.0.0
**Status**: Active
**Updated**: 2026-01-19

Canonical registry for all template placeholders used in orchestrator protocol templates.

---

## Universal Placeholders (all templates)

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{TASK_ID}` | string | T1234 | CLEO task ID |
| `{DATE}` | string | 2026-01-19 | ISO date (YYYY-MM-DD) |
| `{OUTPUT_DIR}` | path | claudedocs/agent-outputs | Output directory path |
| `{SESSION_ID}` | string | session_20260119_143500_abc123 | Current CLEO session ID |
| `{EPIC_ID}` | string | T1000 | Parent epic ID |
| `{EPIC_TITLE}` | string | Authentication System | Parent epic title |

---

## Context-Specific Placeholders

### RESEARCH-AGENT Template

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{TOPIC_SLUG}` | string | auth-token-rotation | Slugified topic name (lowercase, hyphenated) |
| `{RESEARCH_ID}` | string | auth-token-2026-01-19 | Research entry ID for manifest |
| `{TOPIC_TITLE}` | string | Authentication Token Rotation | Human-readable topic name |

### EPIC-ARCHITECT Template

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{FEATURE_SLUG}` | string | user-authentication | Slugified feature name (lowercase, hyphenated) |
| `{FEATURE_NAME}` | string | User Authentication | Human-readable feature name |
| `{FEATURE_DESCRIPTION}` | string | Implement JWT-based authentication... | Full description from epic |

### TASK-EXECUTOR Template

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{TASK_TITLE}` | string | Implement login endpoint | Task title from CLEO |
| `{TASK_DESCRIPTION}` | string | Create POST /api/login... | Task description from CLEO |
| `{DEPENDS_LIST}` | string | T1001, T1002 | Comma-separated dependency IDs |

### VALIDATOR Template

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{TEST_SCOPE}` | string | unit\|integration\|e2e | Test scope to execute |
| `{TARGET_PATH}` | path | src/auth/ | Path to validate |

---

## Manifest Entry Placeholders

Used when constructing MANIFEST.jsonl entries:

| Placeholder | Type | Example | Description |
|-------------|------|---------|-------------|
| `{MANIFEST_ID}` | string | topic-2026-01-19 | Unique manifest entry ID |
| `{MANIFEST_FILE}` | string | 2026-01-19_topic-slug.md | Output filename |
| `{MANIFEST_TITLE}` | string | Research on Topic | Entry title |
| `{MANIFEST_STATUS}` | enum | complete\|partial\|blocked | Entry status |
| `{MANIFEST_TOPICS}` | array | ["auth", "security"] | Topic tags |
| `{MANIFEST_FINDINGS}` | array | ["Finding 1", "Finding 2"] | Key findings (3-7 items) |
| `{LINKED_TASKS}` | array | ["T1234", "T1235"] | Related CLEO task IDs |
| `{NEEDS_FOLLOWUP}` | array | ["T1236"] | Tasks requiring follow-up |

---

## Placeholder Resolution

### CLI Auto-Resolution

The `cleo orchestrator spawn` command auto-resolves placeholders:

```bash
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
```

Resolves `{TASK_ID}` to `T1586`, `{DATE}` to current date, etc.

### Manual Resolution

When building prompts manually:

```bash
# Get task details
cleo show T1586 --format json

# Get session ID
cleo session status --format json | jq -r '.sessionId'

# Get epic context
cleo show $(cleo show T1586 --format json | jq -r '.parentId') --format json
```

---

## Placeholder Conventions

### Naming Rules

- **ALL_CAPS** with underscores for multi-word names
- Enclosed in **curly braces** `{PLACEHOLDER}`
- Descriptive names that indicate content type

### Type Constraints

| Type | Format | Validation |
|------|--------|------------|
| string | Any UTF-8 text | Non-empty |
| date | YYYY-MM-DD | ISO 8601 |
| path | Unix path | Valid path characters |
| enum | Pipe-separated | Exact match required |
| array | JSON array | Valid JSON |

### Default Values

| Placeholder | Default |
|-------------|---------|
| `{DATE}` | Current date |
| `{OUTPUT_DIR}` | `claudedocs/agent-outputs` |
| `{MANIFEST_STATUS}` | `complete` |
| `{NEEDS_FOLLOWUP}` | `[]` (empty array) |

---

## Adding New Placeholders

When creating new templates:

1. Check this registry for existing placeholders
2. Reuse existing placeholders when semantically equivalent
3. Add new placeholders to appropriate section above
4. Document type, example, and description
5. Update `cleo orchestrator spawn` if auto-resolution needed

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-19 | Initial registry |
