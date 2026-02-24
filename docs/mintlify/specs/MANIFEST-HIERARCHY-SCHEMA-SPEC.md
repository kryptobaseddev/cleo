# Manifest Hierarchy Schema Extension Specification

**Task**: T4353
**Epic**: T4352 - Manifest Hierarchy + Path Query Engine
**Date**: 2026-02-12
**Status**: complete
**Note**: jq examples in this spec are JSONL query patterns valid for both Bash and TypeScript implementations.

---

## 1. Overview

The MANIFEST.jsonl file currently stores 209+ flat entries with no structural relationship information. Each entry exists independently, making it impossible to answer questions like "show all research for epic T2968" or "what is the total output under this epic?" without scanning linked_tasks across every entry.

This specification adds 5 hierarchy fields to the manifest schema that enable tree-aware operations: subtree queries, rollup aggregation, depth-filtered views, and parent-child navigation. All fields are optional with sensible defaults, preserving full backward compatibility with existing entries.

## 2. Schema Changes

### New Fields

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `parentId` | `string \| null` | `null` | No | ID of the parent manifest entry. Null for root-level entries. |
| `epicId` | `string \| null` | `null` | No | Task ID of the root epic this entry belongs to. Pattern: `^T\d+$`. |
| `path` | `string` | `""` | No | Slash-delimited ancestry path from root epic to this entry's task. |
| `depth` | `integer` | `0` | No | Nesting depth. 0 = root, 1 = direct child of root, 2 = grandchild, etc. Range: 0-10. |
| `childCount` | `integer` | `0` | No | Count of direct child entries referencing this entry as their parent. Range: 0+. |

### JSON Schema Definitions

```json
"parentId": {
  "type": ["string", "null"],
  "description": "Parent manifest entry ID for hierarchy (null for root entries)",
  "default": null
}
```

```json
"epicId": {
  "type": ["string", "null"],
  "description": "Root epic task ID this entry belongs to",
  "pattern": "^T\\d+$",
  "default": null
}
```

```json
"path": {
  "type": "string",
  "description": "Slash-delimited ancestry path from root epic (e.g., 'T2968/T2973/T2997')",
  "default": ""
}
```

```json
"depth": {
  "type": "integer",
  "description": "Nesting depth (0=root, 1=child, 2=grandchild)",
  "minimum": 0,
  "maximum": 10,
  "default": 0
}
```

```json
"childCount": {
  "type": "integer",
  "description": "Number of direct child entries",
  "minimum": 0,
  "default": 0
}
```

### Schema File

Updated in: `schemas/research-manifest.schema.json`

Fields are inserted before the `audit` object property. None are added to the `required` array.

## 3. Backward Compatibility

### Strategy: Optional Fields with Defaults

All 5 new fields are optional and have defaults that represent "no hierarchy information available":

- `parentId: null` -- entry is a root (no parent)
- `epicId: null` -- no epic association known
- `path: ""` -- no path computed
- `depth: 0` -- treated as root level
- `childCount: 0` -- no children tracked

### Implications

- **Existing 209 entries**: Valid without modification. Missing fields resolve to defaults.
- **New entries**: Writers SHOULD populate hierarchy fields when the parent task relationship is known.
- **Queries**: MUST handle entries with and without hierarchy fields. Absent fields = root-level defaults.
- **Schema validation**: `additionalProperties: true` is already set, so no schema breakage.

### Migration Path

After backfill (T4355), all entries will have explicit hierarchy fields. At that point:
1. Fields MAY be promoted to `required` in a future schema version
2. Writers MUST populate hierarchy fields for all new entries (enforced by T4354)

## 4. Path Format

### Specification

The `path` field contains a slash-delimited string of task IDs representing the ancestry from the root epic to the current entry's linked task.

### Format Rules

1. Path segments are CLEO task IDs (format: `T\d+`)
2. Segments are separated by `/` (forward slash)
3. The first segment is always the root epic task ID (matches `epicId`)
4. The last segment is the task most directly linked to this manifest entry
5. Empty string (`""`) indicates no path information (pre-backfill or orphan entries)
6. Path does NOT include the manifest entry `id` itself -- it tracks task lineage

### Examples

| Entry | epicId | path | depth | Description |
|-------|--------|------|-------|-------------|
| Root epic research | `T2968` | `T2968` | 0 | Entry directly under the epic |
| Task-level research | `T2968` | `T2968/T2973` | 1 | Entry for a child task of the epic |
| Subtask research | `T2968` | `T2968/T2973/T2997` | 2 | Entry for a subtask |
| Orphan (pre-backfill) | `null` | `""` | 0 | No hierarchy info yet |

### Path Derivation Algorithm

```
Given a manifest entry with linked_tasks = [T_epic, T_task]:
1. Find the epic ID from the task hierarchy (walk parentId up to root)
2. Build path by collecting task IDs from epic down to the entry's primary task
3. Set epicId = first segment of path
4. Set depth = count of "/" separators in path
```

## 5. Invariants

The following invariants MUST be maintained by all writers (T4354) and validated by invariant checks (T4356):

### INV-1: Parent Reference Integrity

If `parentId` is not null, an entry with `id == parentId` MUST exist in MANIFEST.jsonl.

### INV-2: Depth Consistency

`depth` MUST equal the number of `/` separators in `path`.

```
depth == 0 when path == "" or path has no "/"
depth == 1 when path has exactly 1 "/"
depth == N when path has exactly N "/" separators
```

### INV-3: Child Count Accuracy

`childCount` MUST equal the count of entries whose `parentId` equals this entry's `id`.

### INV-4: Path-Epic Consistency

If `epicId` is set and `path` is non-empty, `path` MUST start with the value of `epicId`.

### INV-5: No Cycles

Following `parentId` references MUST NOT create a cycle. Every chain of parentId references MUST terminate at an entry with `parentId: null`.

### INV-6: Depth Bound

`depth` MUST NOT exceed 10 (enforced by schema `maximum: 10`). This reflects the CLEO task hierarchy limit of epic -> task -> subtask (3 levels) with additional room for finer-grained manifest decomposition.

## 6. Query Patterns Enabled

These query patterns become possible with hierarchy fields and are the target for T4361/T4363/T4364:

### Subtree Query

All entries belonging to an epic:

```bash
jq 'select(.epicId == "T2968")' MANIFEST.jsonl
```

All entries under a specific path prefix:

```bash
jq 'select(.path | startswith("T2968/T2973"))' MANIFEST.jsonl
```

### Direct Children

Entries that are immediate children of a given entry:

```bash
jq 'select(.parentId == "T2968-research")' MANIFEST.jsonl
```

### Rollup Aggregation

Count and aggregate across a subtree:

```bash
# Count entries per epic
jq -s 'group_by(.epicId) | map({epicId: .[0].epicId, count: length})'

# Sum findings across an epic's subtree
jq -s '[.[] | select(.epicId == "T2968")] | map(.key_findings | length) | add'
```

### Depth Filter

Root-level entries only (executive summary view):

```bash
jq 'select(.depth == 0)' MANIFEST.jsonl
```

Leaf entries only (no children):

```bash
jq 'select(.childCount == 0)' MANIFEST.jsonl
```

### Tree Reconstruction

Build full tree for display:

```bash
jq -s 'group_by(.depth) | map({depth: .[0].depth, entries: map(.id)})' MANIFEST.jsonl
```

## 7. Migration Strategy

### Phase 1: Schema Extension (this task, T4353)

- Add 5 optional fields to `schemas/research-manifest.schema.json`
- No changes to existing data
- All existing entries remain valid with default values

### Phase 2: Writer Implementation (T4354)

- Update manifest append logic to populate hierarchy fields for new entries
- Derive parentId, epicId, path, depth from task hierarchy at write time
- Set childCount = 0 for new entries (incremented when children are added)

### Phase 3: Backfill (T4355)

- Process all 209 existing entries
- For each entry with `linked_tasks`:
  1. Resolve the primary task's epic via CLEO task hierarchy
  2. Build the ancestry path
  3. Set parentId by matching linked_tasks to other manifest entry IDs
  4. Compute depth from path
  5. After all entries processed, compute childCount for each entry
- Entries without resolvable hierarchy get explicit defaults: `parentId: null, epicId: null, path: "", depth: 0, childCount: 0`

### Phase 4: Invariant Validation (T4356)

- Add validation functions that check all 6 invariants
- Integrate into `cleo --validate` health check
- Run after backfill to verify data integrity

## 8. Relationship to Existing Fields

| Existing Field | Relationship to New Fields |
|----------------|---------------------------|
| `linked_tasks` | Source for deriving `epicId` and `path`. Preserved as-is (broader scope: can link to any task). |
| `id` | Referenced by `parentId` in child entries. No change to format. |
| `audit.provenance_chain` | Complementary. Provenance tracks lifecycle stages; hierarchy tracks structural nesting. |

## References

- Epic: T4352 - Manifest Hierarchy + Path Query Engine
- Readiness Report: `claudedocs/agent-outputs/track-b-readiness-2026-02-12.md`
- Schema: `schemas/research-manifest.schema.json`
- Prior Research: T2748 unified recommendations
- Prior Consensus: T2746 folder reorg consensus
