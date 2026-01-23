---
title: "relates"
description: "Semantic relationship discovery and management"
icon: "link"
---

# relates Command

Discover and manage semantic relationships between tasks. Uses RAG-like analysis to find connections based on shared labels, description similarity, and file references.

## Usage

```bash
cleo relates <SUBCOMMAND> [ARGS] [OPTIONS]
```

## Description

The `relates` command enables non-blocking task relationships through the `relates` field. Unlike `depends` (which creates blocking dependencies), `relates` captures semantic connections like:

- Tasks working on similar features
- Tasks that spawned from other tasks
- Deferred work from a parent task
- Tasks that supersede or duplicate others

## Subcommands

### relates suggest

Get AI-powered suggestions for related tasks based on semantic similarity.

```bash
cleo relates suggest <TASK_ID> [--threshold N]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Task to find suggestions for |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--threshold N` | Minimum similarity score (0.0-1.0) | `0.5` |
| `--format` | Output format: `text`, `json` | `text` |

**Example:**

```bash
cleo relates suggest T001 --threshold 0.6
```

**Output:**
```json
[
  {
    "taskId": "T042",
    "type": "relates-to",
    "reason": "shared labels: auth, security",
    "score": 0.85
  },
  {
    "taskId": "T089",
    "type": "relates-to",
    "reason": "description similarity: 72%",
    "score": 0.72
  }
]
```

### relates add

Add a relationship between two tasks.

```bash
cleo relates add <FROM_TASK> <TO_TASK> <TYPE> [--reason TEXT]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `FROM_TASK` | Source task ID |
| `TO_TASK` | Target task ID |
| `TYPE` | Relationship type (see below) |

**Options:**

| Option | Description |
|--------|-------------|
| `--reason TEXT` | Description of why tasks are related |

**Example:**

```bash
cleo relates add T001 T042 relates-to --reason "Both implement auth flows"
```

**Output:**
```json
{
  "success": true,
  "from": "T001",
  "to": "T042",
  "type": "relates-to"
}
```

### relates discover

Discover related tasks using different analysis methods.

```bash
cleo relates discover <TASK_ID> [--method METHOD]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Task to analyze |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--method METHOD` | Discovery method: `labels`, `description`, `files`, `auto` | `auto` |

**Discovery Methods:**

| Method | Description | Best For |
|--------|-------------|----------|
| `labels` | Find tasks with shared labels | Feature grouping |
| `description` | Text similarity using tokenization | Similar work |
| `files` | Shared file references | Code overlap |
| `auto` | Combines all methods | General discovery |

**Example:**

```bash
cleo relates discover T001 --method labels
```

**Output:**
```json
[
  {
    "taskId": "T042",
    "type": "relates-to",
    "reason": "shared labels: auth, security (2 common)",
    "score": 0.85
  }
]
```

### relates list

List all relationships for a task.

```bash
cleo relates list <TASK_ID>
```

**Example:**

```bash
cleo relates list T001
```

**Output:**
```
RELATIONSHIPS FOR T001: Implement authentication

Relates to:
  T042 - Add OAuth support [relates-to]
         Reason: Both implement auth flows

  T089 - Security audit [spawned-from]
         Reason: Created during T001 review

Incoming relationships:
  T050 - Refactor login [supersedes T001]
```

## Relationship Types

| Type | Meaning | Use Case |
|------|---------|----------|
| `relates-to` | General semantic connection | Tasks in same feature area |
| `spawned-from` | Task created during another task's work | Discovered work, split tasks |
| `deferred-to` | Work postponed to another task | Scope management |
| `supersedes` | This task replaces another | Redesigns, refactors |
| `duplicates` | Tasks represent same work | Deduplication |

### Type Examples

```bash
# General relationship
cleo relates add T001 T042 relates-to --reason "Same feature area"

# Task was created during T001's work
cleo relates add T042 T001 spawned-from --reason "Discovered during auth implementation"

# Work deferred to future task
cleo relates add T001 T100 deferred-to --reason "Edge cases moved to next sprint"

# New task replaces old approach
cleo relates add T150 T001 supersedes --reason "New OAuth2 approach"

# Mark as duplicate
cleo relates add T200 T001 duplicates --reason "Same issue reported twice"
```

## Auto-Detection

The `update --notes` command automatically detects task references and creates `relates-to` entries:

```bash
cleo update T001 --notes "Related to T042 approach, see also T089"
```

This auto-creates:
```json
{
  "relates": [
    {"taskId": "T042", "type": "relates-to"},
    {"taskId": "T089", "type": "relates-to"}
  ]
}
```

## Similarity Scoring

The discovery algorithms produce scores between 0.0 and 1.0:

| Score Range | Meaning | Recommendation |
|-------------|---------|----------------|
| 0.8 - 1.0 | Strong match | High confidence relationship |
| 0.6 - 0.8 | Good match | Review and likely add |
| 0.4 - 0.6 | Moderate match | Consider relationship |
| 0.0 - 0.4 | Weak match | Usually not related |

### Scoring Factors

| Factor | Weight | Description |
|--------|--------|-------------|
| Shared labels | 40% | Common label count / total labels |
| Description | 35% | Jaccard similarity of tokenized text |
| File references | 25% | Overlapping file paths |

## JSON Output

All subcommands support `--format json`:

```bash
cleo relates suggest T001 --format json
```

```json
{
  "_meta": {
    "version": "0.67.0",
    "timestamp": "2026-01-23T10:30:00Z",
    "command": "relates suggest"
  },
  "taskId": "T001",
  "suggestions": [
    {
      "taskId": "T042",
      "type": "relates-to",
      "reason": "shared labels: auth, security",
      "score": 0.85
    }
  ]
}
```

## Integration Examples

### Workflow: Discover and Add

```bash
# 1. Get suggestions for a task
cleo relates suggest T001 --threshold 0.7

# 2. Review and add relationships
cleo relates add T001 T042 relates-to --reason "Auth feature work"
cleo relates add T001 T089 spawned-from --reason "Security review"

# 3. Verify relationships
cleo relates list T001
```

### With show command

```bash
# View task with relationships
cleo show T001 --related
```

### Bulk Discovery

```bash
# Find all tasks that might relate to current epic
for task in $(cleo list --parent T001 --format json | jq -r '.tasks[].id'); do
  echo "=== $task ==="
  cleo relates suggest "$task" --threshold 0.7
done
```

## Best Practices

1. **Use appropriate types**: Choose the relationship type that best describes the connection
2. **Add reasons**: Always include a reason for non-obvious relationships
3. **Review suggestions**: Auto-discovered relationships should be reviewed before adding
4. **Threshold tuning**: Start with 0.6-0.7 threshold and adjust based on results
5. **Avoid over-relating**: Not every similar task needs a relationship

## Troubleshooting

### No suggestions found

If `relates suggest` returns empty:
- Lower the threshold: `--threshold 0.4`
- Check task has labels, description, or files
- Try specific method: `--method labels`

### Relationship already exists

```
ERROR: Relationship already exists
```

The relationship is already recorded. Use `cleo show T001` to view existing relationships.

### Invalid relationship type

```
ERROR: Invalid type. Use: relates-to, spawned-from, deferred-to, supersedes, duplicates
```

Use one of the five valid relationship types.

## See Also

- [deps](deps.md) - Blocking dependencies
- [update](update.md) - Add notes with auto-detection
- [show](show.md) - View task relationships
- [DEPENDENCY-GRAPHS Guide](../guides/DEPENDENCY-GRAPHS.md) - Architecture details
