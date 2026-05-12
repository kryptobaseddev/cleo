# cleo deps — Dependency Visualization and Analysis

**Task**: T1857 | **Epic**: T1855

The `cleo deps` command group provides read-only dependency graph inspection,
validation, and visualization. All subcommands are tier-0 (no LLM required).

---

## Subcommands

| Subcommand | Description |
|---|---|
| `overview` | Project-wide dep overview |
| `show <id>` | Deps for a specific task |
| `waves <epicId>` | Execution waves for an epic |
| `critical-path <id>` | Longest dep chain from a task |
| `impact <id>` | Tasks affected by changes to a task |
| `cycles` | Detect all circular dependencies |
| `validate` | Validate dep graph (orphan/circular/cross-epic-gap/stale-dep) |
| `tree --epic <id>` | Visualize dep tree for an epic |

---

## cleo deps validate

```
cleo deps validate [--epic <id>] [--scope all|open|critical]
```

Runs dep-graph validation and reports issues. Exit code 0 when the graph is
clean; non-zero when issues are found.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--epic <id>` | (none) | Scope to direct children of this epic only |
| `--scope` | `all` | Which tasks to include: `all`, `open` (non-terminal), or `critical` |

### Issue Codes

| Code | Meaning |
|---|---|
| `E_ORPHAN` | Non-epic task with no parentId, not in a terminal state |
| `E_CIRCULAR` | Circular dependency detected |
| `E_CROSS_EPIC_GAP` | Task in epic A depends on task in epic B, but epic A has no dep on epic B |
| `E_STALE_DEP` | Dependency to a cancelled task or a done-but-gates-not-passed task |
| `E_MISSING_REF` | Dependency references a task ID that does not exist |

### Examples

```bash
# Validate all tasks in the project
cleo deps validate

# Validate only children of epic T1855
cleo deps validate --epic T1855

# Validate only open (non-terminal) tasks
cleo deps validate --scope open

# Validate only critical-priority tasks
cleo deps validate --scope critical
```

### Output (JSON envelope)

```json
{
  "success": true,
  "data": {
    "valid": false,
    "issues": [
      {
        "code": "E_CROSS_EPIC_GAP",
        "taskId": "T1834",
        "message": "Task T1834 (epic T1042) depends on T1845 (epic T1841) but epic T1042 has no dep on epic T1841",
        "relatedIds": ["T1845"],
        "epicA": "T1042",
        "epicB": "T1841"
      }
    ],
    "summary": "Dep graph has 1 issue(s) across 47 task(s): E_CROSS_EPIC_GAP"
  }
}
```

---

## cleo deps tree

```
cleo deps tree --epic <id> [--json | --mermaid | --text]
```

Renders the dependency tree for an epic. The critical path (longest dep chain)
is highlighted. Default format is text.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--epic <id>` | (required) | Epic to visualize |
| `--json` | false | Emit machine-readable JSON |
| `--mermaid` | false | Emit Mermaid `graph TD` block |
| `--text` | (default) | ASCII text tree |

### Examples

```bash
# Text tree for epic T1855
cleo deps tree --epic T1855

# Mermaid diagram (paste into docs)
cleo deps tree --epic T1855 --mermaid

# JSON tree for tooling
cleo deps tree --epic T1855 --json
```

### Text output example

```
Dep tree:
  [ ] T1856: T1855-1: cleo add --priority critical requires --depends
  Dependencies:
  [ ] T1857: T1855-2: cleo deps validate + cleo deps tree  **
    <- T1856
  [ ] T1858: T1855-3: orchestrate ready guard  **
    <- T1857

Critical path (** marked): T1856 -> T1857 -> T1858
```

### Mermaid output example

```
graph TD
  T1856["T1856: ... (done)"]
  T1857["T1857: ... (pending)"]
  T1856 --> T1857
  classDef critical fill:#f96,stroke:#c00;
  class T1857 critical;
```

### JSON output structure

```json
{
  "success": true,
  "data": {
    "epicId": "T1855",
    "format": "json",
    "rendered": null,
    "nodes": [
      { "id": "T1856", "title": "...", "status": "done", "depends": [] },
      { "id": "T1857", "title": "...", "status": "pending", "depends": ["T1856"] }
    ],
    "edges": [
      { "from": "T1856", "to": "T1857" }
    ],
    "criticalPath": ["T1856", "T1857", "T1858"]
  }
}
```

---

## Lifecycle Config: depsRequiredAt

The `LifecycleConfig.depsRequiredAt` field (added in T1857) controls at which
priority level tasks MUST declare a dependency on creation:

```json
{
  "lifecycle": {
    "mode": "strict",
    "depsRequiredAt": "critical"
  }
}
```

| Value | Behaviour |
|---|---|
| `"critical"` | Only critical-priority tasks require `--depends` (default) |
| `"high"` | Critical and high-priority tasks require `--depends` |
| `"all"` | All tasks require `--depends` |
| `"off"` | No mandatory dep declaration |

This field is consumed by T1858 (`cleo orchestrate ready` dep-validation guard).

---

## Related

- T1855 — CLEO Guardrails epic
- T1856 — Mandatory `--depends` for critical-priority tasks
- T1858 — `cleo orchestrate ready` refuses tasks when dep graph fails validation
- T1859 — Backfill cross-epic dep audit for 6 epics
