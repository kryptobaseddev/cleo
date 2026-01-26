# graph-rag - Semantic Relationship Discovery

**Library**: `lib/graph-rag.sh`
**Layer**: 2 (Core Services)
**Version**: 0.70.1+

## Overview

The graph-rag library provides semantic relationship discovery for CLEO tasks through the `relates` field. It enables RAG-like task connections via multiple discovery methods including labels, descriptions, files, and hierarchy.

## Discovery Methods

| Method | Description | Signal |
|--------|-------------|--------|
| `labels` | Tasks sharing labels | Jaccard similarity of label sets |
| `description` | Keyword similarity | Jaccard similarity of tokenized text |
| `files` | Shared file attachments | Jaccard similarity of file paths |
| `hierarchy` | Tree proximity (siblings/cousins) | Position in task hierarchy |
| `auto` | All methods combined | Weighted merge with hierarchy boost |

## Hierarchy Discovery (T2190)

The hierarchy method discovers related tasks based on their position in the task tree:

### Relationship Types

| Relationship | Tree Distance | Boost | Description |
|--------------|---------------|-------|-------------|
| Sibling | 2 | +0.15 | Tasks sharing the same parent |
| Cousin | 4 | +0.08 | Tasks sharing the same grandparent |
| Parent/Child | 1 | +0.04 | Direct ancestor relationship |

### Key Functions

```bash
# Find lowest common ancestor of two tasks
_find_lca "T005" "T006"  # Returns parent task ID

# Calculate tree distance between tasks
_tree_distance "T005" "T006"  # Returns: 0=same, 2=siblings, 4=cousins, -1=unrelated

# Get task description with parent context (decay: 0.5/level)
_get_hierarchical_context "T005"  # Returns augmented text

# Discover siblings and cousins
_discover_by_hierarchy "T005"  # Returns JSON array
```

### Score Combination (auto mode)

When using `auto` method, hierarchy boost is applied additively to content scores:

```
final_score = min(1.0, base_score + hierarchy_boost)

where:
  base_score = max(labels_score, description_score, files_score)
  hierarchy_boost = 0.15 (sibling) | 0.08 (cousin) | 0 (unrelated)
```

## Usage

### CLI

```bash
# Discover related tasks
cleo relates T001                       # Default: auto method
cleo relates T001 --method hierarchy    # Hierarchy only
cleo relates T001 --method labels       # Labels only

# Get suggestions above threshold
cleo relates T001 --suggest --threshold 0.5

# Add relationship
cleo relates add T001 T002 relates-to "shared auth context"
```

### Library API

```bash
source lib/graph-rag.sh

# Discover related tasks
discover_related_tasks "T001" "auto"      # All methods
discover_related_tasks "T001" "hierarchy" # Hierarchy only
discover_related_tasks "T001" "labels"    # Labels only

# Get suggestions
suggest_relates "T001" 0.5  # Threshold 0.5

# Add relationship
add_relates_entry "T001" "T002" "relates-to" "reason"
```

## Output Format

All discovery functions return JSON arrays:

```json
[
  {
    "taskId": "T002",
    "type": "relates-to",
    "reason": "sibling (shared parent T001)",
    "score": 0.65,
    "_hierarchyBoost": 0.15,
    "_relationship": "sibling"
  }
]
```

## Configuration

Hierarchy discovery can be configured in `config.json`:

```json
{
  "graphRag": {
    "hierarchyBoost": {
      "enabled": true,
      "sibling": 0.15,
      "cousin": 0.08,
      "ancestor": 0.04,
      "requireContentMatch": true
    },
    "contextPropagation": {
      "enabled": true,
      "maxDepth": 2,
      "decayFactor": 0.5
    },
    "minScore": 0.1
  }
}
```

## Valid Relationship Types

- `relates-to` - General relationship
- `spawned-from` - Task created from another
- `deferred-to` - Work deferred to another task
- `supersedes` - Replaces another task
- `duplicates` - Duplicate of another task

## Performance

- Hierarchy discovery: O(D^2) where D=3 (max depth), effectively O(1)
- Label/file discovery: O(N) where N = number of tasks
- Description similarity: O(N * T) where T = average tokens per task

## See Also

- `docs/commands/relates.md` - CLI command documentation
- `schemas/todo.schema.json` - Task schema with relates field
- `tests/unit/graph-rag-hierarchy.bats` - Test suite
