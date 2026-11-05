# Release Task Dependency Pruning

## Overview

Release tasks are **temporary nodes** in the CLEO orchestration graph that exist only during a release lifecycle: preparation → changelog → commit → tag → push → completion. Once a release ships, its child tasks (the work items it shipped) are no longer logically "children" of the release task.

This document describes the **dependency pruning pattern** — how and when to remove the release task's dependencies from the active task graph to keep the orchestration surface clean.

## Problem Statement

Release tasks (e.g., `T820 release v2026.4.42`) have a parent-child relationship with every task they ship. If these dependencies are never pruned, the task graph accumulates stale edges:

```
T820 (release v2026.4.42) ─→ T991 (BRAIN Integrity epic)
                           ├─→ T992 (auto-reconcile)
                           ├─→ T993 (blocklist check)
                           └─→ ... (8 children total)
```

After T820 ships and releases v2026.4.42, keeping these edges active causes:
- Release tasks to appear "not done" when listed with `cleo list --parent`
- False-positive "incomplete parent" warnings during future orchestrations
- Drift between release manifest entries and task graph topology

## Dependency Pruning Pattern

### When to Prune

Pruning occurs **immediately after** `cleo release push` succeeds and the release has been tagged and pushed to npm. This is the final stable state of a release — the work is shipped and the version is immutable.

**Key distinction**: Do NOT prune after `prepare` or `commit`. Only prune after `push`, when the release is irreversible.

### How to Prune

The pruning operation has three variants depending on the release task's parent:

#### Variant 1: Release with Epic Parent

If the release task has a parent epic (example: T820 is a child of T630 RELEASE-OPERATIONS epic):

```bash
# Set the release task's parent to null (remove from epic lineage)
cleo update T820 --parent ""

# Verify the prune
cleo show T820
# Should show: parentId: null
```

#### Variant 2: Release with No Parent

If the release task has no parent (orphaned release task):

```bash
# Confirm the task exists and is completed
cleo show T820

# Mark for deprecation (optional, for audit trail)
cleo update T820 --notes "Released v2026.4.42. Dep pruned post-ship."
```

No parent removal needed; the task simply remains as a historical record in the graph.

#### Variant 3: Batch Pruning via Release Manifest

If pruning multiple release tasks from a single release wave:

```bash
# Query the release manifest for all shipped tasks
cleo release list --status pushed

# For each release task in the manifest:
for RELEASE_TASK_ID in $(cleo release list --status pushed --format json | jq -r '.releases[].id'); do
  cleo update "$RELEASE_TASK_ID" --parent ""
done
```

### Programmatic Pruning (SDK)

The Core SDK exports a `pruneReleaseDependencies()` function for agent-driven pruning. Reference: `packages/core/src/release/release-manifest.ts:pruneReleaseDependencies()`.

**Signature**:

```typescript
export async function pruneReleaseDependencies(
  releaseTaskId: string,
  projectRoot?: string
): Promise<{ pruned: boolean; reason?: string }>
```

**Usage**:

```typescript
import { pruneReleaseDependencies } from '@cleocode/core/internal';

const result = await pruneReleaseDependencies('T820');
if (result.pruned) {
  console.log('Release dependencies pruned successfully.');
} else {
  console.log(`Prune blocked: ${result.reason}`);
}
```

**Blocking conditions** (result.pruned = false):

- Release task is not in `shipped` or `pushed` status
- Release task has uncommitted children (no prune until all children are complete)
- Release task is part of an active epic wave (defer pruning until wave closes)

## Examples

### Example 1: Single Release Prune

```bash
# After v2026.4.100 ships
cleo release push v2026.4.100
git push origin v2026.4.100

# Verify the release is confirmed pushed
cleo release show v2026.4.100
# Status: pushed

# Prune the release task (e.g., T815)
cleo update T815 --parent ""

# Verify
cleo list --parent T815
# Result: 0 children (stale deps removed from active graph)
```

### Example 2: Release Epic Wave Pruning

When a release epic (e.g., T630) ships with 5 child releases:

```bash
# T630 is the parent epic, containing:
# ├─ T815 (release v2026.4.98)
# ├─ T816 (release v2026.4.99)
# ├─ T817 (release v2026.4.100)
# ├─ T818 (release v2026.4.101)
# └─ T819 (release v2026.4.102)

# After all 5 releases are pushed, prune the entire wave:
for tid in T815 T816 T817 T818 T819; do
  cleo update "$tid" --parent "" && echo "Pruned $tid"
done

# Verify T630 now shows 0 children
cleo list --parent T630
# Result: 0 children
```

### Example 3: Audit Trail After Pruning

```bash
# Query pruned releases
cleo find "release.*pruned" --status completed

# Each pruned task still appears in audit logs but with parentId=null
cleo show T815
# Sample output:
# {
#   "id": "T815",
#   "type": "task",
#   "status": "done",
#   "parentId": null,  ← Shows null after pruning
#   "completedAt": "2026-04-20T15:22:33.444Z",
#   "notes": "Released v2026.4.100. Dep pruned post-push."
# }
```

## Lifecycle Diagram

```
┌──────────────────────────────────────────────────┐
│ Release Task Lifecycle                           │
├──────────────────────────────────────────────────┤
│                                                  │
│  1. cleo release prepare                         │
│     Status: draft                                │
│     ParentId: active (e.g., T630)               │
│     ChildTaskIds: [T991, T992, ..., T999]      │
│                                                  │
│  2. cleo release commit                          │
│     Status: committed                            │
│     ParentId: unchanged                          │
│     ChildTaskIds: unchanged                      │
│                                                  │
│  3. cleo release tag                             │
│     Status: tagged                               │
│     ParentId: unchanged                          │
│     ChildTaskIds: unchanged                      │
│                                                  │
│  4. cleo release push                            │
│     Status: pushed                               │
│     ParentId: unchanged                          │
│     ChildTaskIds: unchanged                      │
│     ← FINAL STABLE STATE ←                       │
│                                                  │
│  5. cleo update <id> --parent ""                 │
│     Status: unchanged                            │
│     ParentId: null ← PRUNED                      │
│     ChildTaskIds: unchanged (history preserved)  │
│                                                  │
└──────────────────────────────────────────────────┘
```

## Design Rationale

**Why prune after push, not before?**
- Commits are hashable and immutable. Before push, a release can be rolled back via `cleo release rollback`.
- Pruning before push introduces a recovery hazard: if the push fails, the release task's parents are orphaned with no audit trail.
- Post-push pruning is irreversible but safe — the release is already in the npm registry and git history.

**Why not auto-prune?**
- Release tasks may be part of larger epics that track multiple releases. Auto-pruning could break epic rollup counts.
- Manual pruning gives the orchestrator explicit control and audit trail visibility.
- Release manifests already serve as the canonical record; the task graph can be cleaned separately.

**Why keep the task after pruning?**
- Historical traceability: `cleo show T815` still shows "Released v2026.4.100" with completion timestamp.
- Audit logs remain intact with the task's full state at release time.
- Archive tooling can later export pruned tasks to off-line storage if needed.

## Related Tasks

- **T820** — Release Pipeline (implements `cleo release` commands)
- **T4788** — Release Manifest Drizzle Migration (SQLite-backed release tracking)
- **T630** — Release Operations Epic (bundles multiple releases)

## See Also

- `packages/core/src/release/release-manifest.ts` — Release manifest and pruning SDK
- `packages/cleo/src/dispatch/engines/release-engine.ts` — Release engine CLI dispatch
- `docs/RELEASING.md` — Full release process guide
