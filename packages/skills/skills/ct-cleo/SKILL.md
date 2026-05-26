---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.3.0
  lastReviewed: 2026-05-24
  stability: stable
---

# CLEO Protocol Guide

<!-- thin-pointer: full protocol is in CLEO-INJECTION.md (T9148) -->
Full protocol content lives in `~/.cleo/templates/CLEO-INJECTION.md`.
Emit any section with: `cleo briefing inject --section <name>`

Supported sections: `session-start` · `work-loop` · `triggers` · `task-creation`
· `task-discovery` · `session-commands` · `memory` · `nexus` · `orchestration`
· `playbooks` · `documents` · `error-handling` · `pre-complete-gate`
· `spawn-tiers` · `rules` · `memory-jit` · `escalation`

## Quick Reference

| Need | Command |
|------|---------|
| Start session | `cleo session status` → `cleo briefing` |
| Find work | `cleo next` → `cleo show <id>` |
| Search tasks | `cleo find "query"` |
| Complete task | `cleo verify T### --gate ... --evidence "..."` → `cleo complete T###` |
| Save memory | `cleo memory observe "..." --title "..."` |
| Spawn subagent | `cleo orchestrate spawn <taskId> --tier 2` |
| Create a Saga (above-Epic group, ADR-073) | `cleo saga create --title "..." --acceptance "..."` |
| Link Epic to Saga | `cleo saga add <sagaId> <epicId>` |
| List Saga members | `cleo saga members <sagaId>` |

## Skill-Specific Extensions

### Task Hierarchy (canonical source: ADR-073 §1)

CLEO has 4 tiers. Each defined by scope-of-change + agent ownership. All IDs stored as `T####`;
`type` column discriminates; prefixes (`SG-`, `E-`, `T-`) are display + import-mapping only.

| Tier    | Prefix | Scope-of-change                                | Owner (ADR-070)     |
|---------|--------|-------------------------------------------------|----------------------|
| Saga    | `SG-`  | ≥2 Epics across ≥2 releases (themed grouping)   | Orchestrator (read)  |
| Epic    | `E-`   | One releasable slice; ≥1 PR to `main`           | Orchestrator (HITL)  |
| Task    | `T-`   | One atomic PR-sized change; single wave         | Phase Lead           |
| Subtask | (none) | One commit; ≤2 files; rolls up to Task's PR     | Worker (leaf)        |

**I8 — Subtask-to-PR aggregation:** A Task ships as exactly ONE PR. Subtasks contribute commits
to that single PR; Subtasks never own a PR. Promote a Subtask to a sibling Task if it warrants
its own PR.

Full charter (8 invariants + lifecycle decision table + prefix registry) lives in
`.cleo/adrs/ADR-073-above-epic-naming.md` §1–§2. CLI commands for Sagas: see
CLEO-INJECTION.md `task-creation` section (`cleo briefing inject --section task-creation`).

For full decision trees and operation reference tables, emit sections above.

## Human Render Contract (ADR-077)

Every CLI command emits a typed `RenderableEnvelope<T>` from `@cleocode/contracts`.
Agents can route their own rendering off `envelope.data.kind` without re-parsing
the payload shape. Canonical patterns:

| Goal | Command |
|------|---------|
| Show one task (typed envelope; human render via core registry) | `cleo show T<id>` |
| Force human render when JSON is the default | `cleo show T<id> --human` |
| Generic hierarchy walker from any root (B9 / T10134) | `cleo tree T<id>` |

`cleo tree <id>` walks both `parent` and `task_relations.relation_type='groups'`
edges to full depth — useful for Saga → Epic → Task → Subtask snapshots from
any starting node.

### `RenderableEnvelope<T>` discriminator

`envelope.data.kind` is one of:

| `kind` | Payload shape | Renderer family |
|--------|---------------|-----------------|
| `'tree'` | `TreeResponse<T>` (flat-node form) | `renderTree` |
| `'table'` | `TableResponse<T>` (rows + schema) | `renderTable` |
| `'list'` | `ListResponse<T>` | `renderList` |
| `'grouped-list'` | `GroupedListResponse<T>` | `renderGroupedList` |
| `'section'` | `{icon, header, items}` | `renderSection` |
| `'single'` | single-record detail | per-command renderer |
| `'generic'` | fallback `Record<string, unknown>` | kv-block helper |

### Where the rendering lives

All rendering logic — registry, families, primitives — lives under
`packages/core/src/render/`. `packages/cleo/src/cli/renderers/index.ts` is a
~20-LOC thin dispatcher. Static UI primitives (Tree, Table, Section, Badge,
Legend) live under `packages/animations/render/`. Typed icon enums
(`StatusIcon`, `KindIcon`, `BadgeIcon`, `RelationIcon`) live in
`@cleocode/contracts/render/icon.ts`. Family renderers self-register at
module load via `registerRenderer(command, kind, fn)` — importing
`@cleocode/core/render` populates every slot via side-effect re-exports.

Full architecture + invariants: see `cleo docs fetch adr-077-human-render-contract`.

## Decomposing an epic into N tasks

When you need to bulk-create child tasks under an epic, use `cleo add-batch`. It inserts all
tasks in a single atomic transaction — if ANY task fails validation, ALL inserts are rolled back.
This is the canonical pattern for epic decomposition; prefer it over N sequential `cleo add` calls.

### Canonical command

```bash
cleo add-batch --file tasks.json --parent <epicId>
```

### Minimal JSON example

Create a `tasks.json` file. The top-level JSON MUST be an array of task objects,
not an object wrapper like `{ "tasks": [...] }`:

```json
[
  {
    "title": "Research: survey add-batch prior art",
    "acceptance": "Written summary of 3+ prior approaches|Coverage of rollback semantics"
  },
  {
    "title": "Implement: add-batch CORE op with atomic semantics",
    "acceptance": "All tasks inserted or none|Returns IDs of created tasks"
  },
  {
    "title": "TF: teach add-batch in ct-cleo SKILL.md + CLEO-INJECTION",
    "acceptance": "SKILL.md contains Decomposing an epic section|INJECTION Task Creation table includes add-batch row"
  }
]
```

Every object in the array supports the same fields as `cleo add` (`title`, `acceptance`,
`kind`, `priority`, `size`, `labels`, `depends`). The `--parent` flag applies to all items.
Use a pipe-separated `acceptance` string for multiple acceptance criteria.

### Flags

| Flag | Description |
|------|-------------|
| `--file <path>` | Path to JSON file (array of task objects) |
| `-` | Read JSON array from stdin (`echo '[...]' \| cleo add-batch --file - --parent <id>`) |
| `--parent <id>` | Parent epic/task ID. All created tasks become direct children. |
| `--dry-run` | Validate and preview all tasks without inserting. Shows predicted counts (`count`, `wouldCreate`, `wouldAffect`) while `insertedCount` remains `0`. |

### Rollback semantic

```
ANY task fails → ALL inserts rolled back (zero partial state)
```

Run `--dry-run` first to catch validation errors (missing `acceptance`, title too long, etc.)
before committing the batch. In the projected mutation envelope, `--dry-run` reports the
number of tasks that would be created via `/data/count` and `/data/wouldCreate`; it does
not mean rows were inserted. Use `/data/insertedCount` when you need the actual write count
(`0` for dry-run).

### Meta-dogfood: how T9813 itself was decomposed

The Epic T9813 (`add-batch` feature saga) used this exact pattern to create its child tasks
(T9814–T9819) in a single call. Use the task decomposition from your epic planning as the
input JSON — `cleo show <epicId>` acceptance criteria → tasks array → `cleo add-batch`.

### Related

- Saga/Epic workflow: `cleo briefing inject --section task-creation`
- Single task: `cleo add --type task --parent <id> --acceptance "..." --title "..."`

---

## Worktree-Aware CLI Routing (T10389 / ADR-068 amendment §3.1)

Two CLI verbs auto-route their writes back to the canonical project
root when invoked from inside an agent-spawned worktree:

- `cleo docs add <ownerId> <file> --type <kind> --slug <slug>` — the
  blob lands in the MAIN repo's `tasks.db`. The file path is resolved
  against the WORKTREE cwd (not the canonical root) before dispatch,
  so relative paths like `docs/note.md` work as expected from inside
  the worktree.
- `cleo changeset add --slug <slug> --tasks <ids> --kind <kind> --summary <text>` —
  dual-writes to `<canonical-root>/.changeset/<slug>.md` AND the SSoT
  blob store. The `.changeset/` file lands in the MAIN repo, never
  the worktree.

Both verbs detect stray `.cleo/tasks.db` inside the worktree
(pre-T9803 leak or rogue write) and emit `E_STRAY_WORKTREE_DB` with a
clear `rm -rf <worktree>/.cleo` remediation BEFORE the deeper DB
chokepoint guard fires.

```bash
# from ~/.local/share/cleo/worktrees/<hash>/T10389/
cleo docs add T10389 ./investigation.md --type research --slug t10389-research
# stderr: [T10389] routing SSoT write from worktree cwd ... → canonical project root ...
# row lands in main repo's tasks.db, retrievable via `cleo docs fetch t10389-research`
```

If you see `E_PATH_TRAVERSAL`, `E_FILE_ERROR: Cannot read file`, or
`E_WT_DB_ISOLATION_VIOLATION` when calling either verb, update to a
build that ships the T10389 fix-pack (closes T10353 + T10354 + T10294
+ T10365). Suppress the routing log with `CLEO_QUIET=1` for clean
stderr in automation.

---

## CLI Output Contract (ADR-086 / Epic T9927 / E9 of Saga T9855)

`cleo` stdout is now **envelope-only**. NEVER pipe `cleo` output through
`tail`/`jq`/`python` — every common shape has a first-class flag.

| Need | Flag | Example |
|------|------|---------|
| Scalar extract (no jq) | `--field <jsonpointer>` | `cleo add 'X' --acceptance "..." --field /data/created/0` |
| ID-only pipeline | `--output id` | `cleo list --parent EPIC --output id \| while read c; do …; done` |
| Affected count | `--output count` | `cleo list --parent EPIC --status pending --output count` |
| TSV (no header) | `--output table` | `cleo list --parent EPIC --output table` |
| Silent (exit code only) | `--output silent` | `cleo update T123 --status done --output silent` |
| 1-line per record | `--summary` | `cleo list --parent EPIC --summary` |
| Suppress stderr noise | `--quiet` | `id=$(cleo add 'X' --acceptance "..." --quiet --field /data/created/0)` |
| Full record (legacy) | `--full` | `cleo show T123 --full` |

### Defaults

- **Read ops** (`show`, `list`, `find`) — return the full LAFS envelope.
- **Mutate ops** (`add`, `add-batch`, `update`, `complete`, `delete`) — return a
  minimal contract-backed envelope `{success, data: {count, created[], updated[], deleted[], ids[]}}`
  (T9931). Prefer operation-specific field paths (`/data/created/0`, `/data/updated/0`,
  `/data/deleted/0`, `/data/count`). `ids[]` remains only as a deprecated compatibility alias.
  Use `--full` to opt back into the full record set.
- **stdout** carries exactly ONE LAFS envelope terminated by a single
  newline. Sub-step logs/progress/warnings route through Pino → stderr.
  This is regression-locked by CI gates `lint-stdout-discipline` (T10135)
  and `lint-stdout-write-allowlist` (T9924).

### Canonical agent patterns

```bash
# Scalar extract — no jq needed; mutations use projection-backed paths.
id=$(cleo add 'Title' --type task --parent T9927 --acceptance "..." \
       --field /data/created/0)

# Batch creation returns an array of created IDs; keep the top-level JSON input an array.
cleo add-batch --file tasks.json --parent T9927 --quiet --output id

# Dry-run validates without writes: /data/count mirrors wouldCreate, insertedCount stays 0.
would_create=$(cleo add-batch --file tasks.json --parent T9927 --dry-run --field /data/count)
inserted=$(cleo add-batch --file tasks.json --parent T9927 --dry-run --field /data/insertedCount)

# Update/complete use updated[]; delete uses deleted[].
updated=$(cleo update T123 --status active --field /data/updated/0)

# ID-only pipeline — no JSON parsing.
cleo list --parent T9927 --output id | while read child; do
  cleo verify "$child" --gate qaPassed --evidence "tool:lint;tool:typecheck"
done

# Count-only check.
remaining=$(cleo list --parent T9927 --status pending --output count)

# Fully clean pipeline — stdout has IDs, stderr is empty unless error.
cleo add-batch --file tasks.json --parent T9927 --quiet --output id
```

### Anti-patterns (REJECTED — these are CLI bugs if they appear post-E9)

- ❌ `cleo show T123 | tail -1 | jq -r .data.task.id` → use read-op `--field` paths from that command's contract
- ❌ `cleo list --parent E1 | jq -r '.data.tasks[].id'` → use `--output id`
- ❌ `cleo show T123 | python3 -c 'import json,sys; …'` → use `--field`
- ❌ `cleo add 'X' 2>&1 | grep -oE 'T[0-9]+'` → use `--field /data/created/0`

Full contract + RFC 2119 invariants: `cleo docs fetch adr-086-cli-output-contract-e9`.
