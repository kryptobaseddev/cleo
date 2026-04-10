# T484 — Check Domain CLI Runtime Verification

**Date**: 2026-04-10
**Agent**: CLI Runtime Verifier
**Task**: T484 (parent: T443)
**Status**: complete

---

## Command Execution Matrix

All commands exited 0 unless noted. Output routed to dispatch layer confirmed by `meta.operation` field.

| Command | Exit | Operation (`meta.operation`) | Notes |
|---------|------|------------------------------|-------|
| `cleo check schema` | 0 | `check.schema` | No type arg → shows usage |
| `cleo check schema todo` | 0 | `check.schema` | Returns `data: {}` (empty ok) |
| `cleo check coherence` | 0 | `check.coherence` | Live data — found 4 T443/T483/T484 issues |
| `cleo check task <id>` | 0 | — | Shows usage (requires `<taskId>`) |
| `cleo check protocol <type>` | 0 | `check.protocol` | Requires `--task-id` or `--manifest-file` |
| `cleo check output <file>` | 0 | `check.output` | Requires `<filePath>` arg |
| `cleo check chain-validate <file>` | 0 | `check.chain.validate` | Requires `<file>` arg |
| `cleo compliance summary` | 0 | `check.compliance.summary` | `total: 0` — no compliance records yet |
| `cleo compliance record --help` | 0 | — | `compliance record <taskId> <result>` |
| `cleo compliance sync` | 0 | `check.compliance.sync` | `synced: 0` — no data |
| `cleo verify --help` | 0 | — | View/modify verification gates for a task |
| `cleo grade --help` | 0 | — | Grade agent behavior for a session |
| `cleo archive-stats` | 0 | `check.archive.stats` | 30 archived, 0 in last 30 days |
| `cleo validate` | 0 | `check.schema` | **Duplicate** — see analysis below |
| `cleo testing validate <id>` | 0 | `check.manifest` | **Routing anomaly** — see analysis |
| `cleo testing status` | 0 | `check.test` | BATS/dispatch tests not available |
| `cleo stats` | 0 | `admin.stats` | **Duplicate of `cleo admin stats`** |
| `cleo stats compliance` | 0 | `check.workflow.compliance` | WF-001 through WF-005, score: F (0.566) |
| `cleo consensus validate <id>` | 0 | `check.protocol` | Alias — see analysis |
| `cleo contribution validate <id>` | 0 | `check.protocol` | Alias — see analysis |
| `cleo decomposition validate <id>` | 0 | `check.protocol` | Alias — see analysis |
| `cleo implementation validate <id>` | 0 | `check.protocol` | Alias — see analysis |
| `cleo specification validate <id>` | 0 | `check.protocol` | Alias — see analysis |

All commands operational. No failures or non-zero exits.

---

## Coherence Check Live Findings

`cleo check coherence` found 4 real issues in the current task graph:

- **T443 is `done` but T483 (`W3-final`) is `pending`** — severity: error
- **T443 is `done` but T484 (this task) is `pending`** — severity: error
- **T483 is `pending` but parent T443 is `done`** — status inconsistency
- **T484 is `pending` but parent T443 is `done`** — status inconsistency

These are real data integrity issues to address after T483 and T484 complete.

---

## Duplicate Analysis

### 1. `cleo validate` vs `cleo check schema` — CONFIRMED DUPLICATE

Both dispatch to `check.schema` with `type: 'todo'`.

Source evidence (`validate.ts` line 22-28):
```ts
await dispatchFromCli('query', 'check', 'schema', { type: 'todo', strict: opts['strict'] }, ...)
```

Difference: `cleo check schema <type>` accepts a TYPE argument (todo, config, archive, log, sessions). `cleo validate` hard-codes `type: 'todo'` and adds a `--strict` flag.

**Verdict**: `cleo validate` is a convenience alias for the most common schema check type. Not identical — the `--strict` flag and hardcoded `type` make it slightly specialized. Low consolidation priority; it does serve a distinct ergonomic purpose. Worth documenting clearly.

---

### 2. Protocol-specific aliases vs `cleo check protocol --type X` — CONFIRMED ALIASES, NOT DUPLICATES

All five domain-specific wrappers (`consensus validate`, `contribution validate`, `decomposition validate`, `implementation validate`, `specification validate`) route to `check.protocol` with the protocolType pre-filled:

```ts
// consensus.ts
protocolType: 'consensus', mode: 'task', taskId, ...
```

`cleo check protocol consensus --task-id <id>` is the canonical form.

Key difference: the aliases take `<taskId>` as a **positional argument**, while `check protocol` requires `--task-id <id>` as a named option. This means the aliases are more ergonomic for interactive agent use and follow the pattern of the rest of the CLI (positional task IDs).

Additionally, some aliases expose protocol-specific options with shorter names:
- `consensus validate --voting-matrix` vs `check protocol --voting-matrix-file`
- `decomposition validate --epic` vs `check protocol --epic-id`
- `specification validate --spec-file` vs `check protocol --spec-file` (same)

**Verdict**: Not true duplicates — they are ergonomic thin wrappers that improve discoverability and ergonomics. Worth keeping. The canonical form (`cleo check protocol <type>`) should be preferred in docs for the full flag surface.

**Missing aliases**: `research`, `architecture-decision`, `validation`, `release`, `artifact-publish`, `provenance` — these 6 protocol types have no top-level alias and require the `cleo check protocol` form.

---

### 3. `cleo testing validate` vs `cleo check protocol testing` — ROUTING ANOMALY (BUG)

This is the most significant finding.

| Command | Operation | What it does |
|---------|-----------|-------------|
| `cleo testing validate <id>` | `check.manifest` | Validates the MANIFEST.jsonl for testing entries |
| `cleo check protocol testing --task-id <id>` | `check.protocol` | Validates IVT loop compliance via protocol-validators |

These are **semantically different operations** dispatched to **different engines**. `testing validate` validates MANIFEST.jsonl entry format (check.manifest), NOT the testing protocol (check.protocol). This is a routing bug or a naming confusion.

An agent running `cleo testing validate T484` expecting protocol compliance validation gets manifest validation instead. The description ("Validate testing protocol compliance for a task") implies protocol validation, but the implementation runs `check.manifest`.

**Verdict**: BUG. `testing validate` should route to `check.protocol` with `protocolType: 'testing'`. The current behavior (manifest validation) already has a correct home at `testing check <manifestFile>`.

---

### 4. `cleo stats` vs `cleo admin stats` — CONFIRMED DUPLICATE

Both dispatch to `admin.stats` with identical parameters and return identical data (verified by matching `requestId`-independent field-by-field comparison).

Source evidence (`stats.ts` line 21-29):
```ts
await dispatchFromCli('query', 'admin', 'stats', { period: ... }, { operation: 'admin.stats' })
```

`cleo stats --period <n>` and `cleo admin stats --period <n>` are identical.

**Verdict**: `cleo stats` is a top-level shortcut alias for `cleo admin stats`. Acceptable for ergonomics (frequently used command). Should be documented as an alias, not a separate command. The `cleo stats compliance` subcommand has no `admin` equivalent, making `cleo stats` a necessary parent.

---

### 5. `cleo testing status` vs `cleo check test` — SAME OPERATION, DIFFERENT SURFACE

| Command | Operation | Notes |
|---------|-----------|-------|
| `cleo testing status` | `check.test` | `format: 'status'` |
| No `cleo check test` subcommand | — | Not exposed under `check` group |

`check.test` is only reachable via `cleo testing status` and `cleo testing coverage`. There is no `cleo check test` subcommand — the check command group lists only: schema, coherence, task, output, chain-validate, protocol.

**Verdict**: Not a duplicate — no overlap. `check.test` is exclusively surfaced through `testing status/coverage`. The check group does not expose test status. This is a surfacing gap, not a duplicate.

---

## Summary Table

| Pair | Type | Verdict |
|------|------|---------|
| `cleo validate` vs `cleo check schema` | Alias (hardcoded type, adds --strict) | Keep as convenience alias; document clearly |
| `cleo {domain} validate` vs `cleo check protocol <type>` | Ergonomic aliases (positional taskId) | Keep all 5; add missing 6 |
| `cleo testing validate` vs `cleo check protocol testing` | Bug — wrong operation dispatched | Fix `testing validate` to route to `check.protocol` |
| `cleo stats` vs `cleo admin stats` | Exact alias | Keep as shortcut; document as alias |
| `cleo testing status` vs `cleo check test` | No overlap — different surfaces | No action needed |

---

## Actionable Findings

1. **BUG**: `cleo testing validate <id>` routes to `check.manifest` instead of `check.protocol` with `protocolType: 'testing'`. Fix `testing.ts` validate action to match other domain validate aliases.

2. **GAP**: Six protocol types (`research`, `architecture-decision`, `validation`, `release`, `artifact-publish`, `provenance`) have no ergonomic top-level alias. Consider adding them consistent with the existing 5.

3. **DATA**: `cleo check coherence` reports 4 live errors (T443 done but T483/T484 still pending) — should be resolved once T483 and T484 complete.

4. **DATA**: MANIFEST.jsonl has 44/46 invalid entries (missing required fields: agent_type, topics, actionable). This predates the schema additions and needs a backfill pass.

5. **DATA**: Workflow compliance score is F (0.566). WF-005 (session binding on create) is 0% — every task fails it because session binding was introduced after existing tasks were created.
