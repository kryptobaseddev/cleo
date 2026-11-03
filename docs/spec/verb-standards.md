# CLEO Verb Standards

**Version**: 2026.4.18
**Status**: MANDATORY
**Scope**: All CLEO CLI commands and registry-defined dispatch operations

All operation names MUST use canonical verbs from this document. Violations are bugs.
For the full operation list, see `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.
For the executable source of truth, see `packages/cleo/src/dispatch/registry.ts`.

---

## 1. Disambiguation Rules

These are the highest-value rules — the cases where multiple verbs appear similar.

### 1a. check vs. validate vs. verify
- `check` — liveness and health probing (`admin.health`, `check.coherence.check`)
- `validate` — compliance and schema correctness (`pipeline.stage.validate`, `check.schema`)
- `verify` — artifact gate verification and skill frontmatter (`tools.skill.verify`)

### 1b. store vs. observe vs. add
- `store` — structured, typed append-only write for memory (`memory.pattern.store`). Supports deduplication via running averages. Not user-managed entities.
- `observe` — raw text observation append to brain.db (`memory.observe`). Distinct from structured store.
- `add` — standard CRUD create for user-managed entities (`tasks.add`, `sticky.add`). Never use for memory.

### 1c. find vs. timeline vs. fetch (3-layer retrieval — MUST follow this order)
1. `find` → search index, returns IDs (~50 tokens/hit)
2. `timeline` → chronological context around anchor ID (~200-500 tokens)
3. `fetch` → full details for filtered IDs only (~500 tokens/entry)

`find` is the cross-table search verb everywhere. `fetch` is batch retrieval by ID array. `show` is single-entity by ID (not batch).

### 1d. run — compound-only rule
`run` MUST always be used as part of a compound verb. NEVER use as standalone.
- CORRECT: `check.test.run`, `pipeline.release.gates.run`
- INCORRECT: `run` as an operation name by itself

### 1e. restore — universal scope
`restore` applies to ALL terminal states: archived, cancelled, and completed.
- CORRECT: `tasks.restore` for any terminal-state task
- INCORRECT: `tasks.unarchive`, `tasks.reopen`, `tasks.uncancel`

### 1f. plan vs. compute vs. schedule
- `plan` — composite read aggregating multiple queries into a planning view (`tasks.plan`)
- `compute` — deriving a single value or metric (Reserved — not in registry)
- `schedule` — deferring work to future execution (Reserved — not in registry)

### 1g. convert vs. update vs. promote
- `convert` — change entity type (`sticky.convert` to task or memory)
- `update` — modify properties without changing type (`tasks.update`)
- `promote` — move a subtask to top-level within same type (`tasks.promote`)

### 1h. find (dispatch-wide) vs. memory find --type (CLI subcommand filter)
The CLI uses `find` consistently across all domains. The `memory find` subcommand accepts `--type pattern|learning` to route to `memory.pattern.find` or `memory.learning.find`. There is no `recall` verb.

### 1i. end (session) vs. stop (task work)
- `session.end` — dispatch operation (internal `mutate` tag) reached via `cleo session end`
- `tasks.stop` — dispatch operation reached via `cleo stop`
- `cleo stop` — CLI subcommand that may context-resolve to `session.end` per the CLI handler
Both are CLI subcommands — there is no second protocol surface. These are two distinct dispatch operations sharing the stop/end semantic.

### 1j. sticky domain restrictions
Sticky notes do NOT support `update`, `delete`, or `restore`. Use `convert` to promote to task or memory. Use `archive` for soft removal.

### 1k. attach/detach vs. link/unlink
- `link` / `unlink` — generic relationship association between entities of the same kind (task-to-task dependencies, memory links). Remains canonical for generic association.
- `attach` / `detach` — domain-specific binding of an agent to a project via `conduit.db:project_agent_refs` (ADR-037 §3). Semantically distinct: "attach an agent to this project" is a scoped binding operation, not a generic entity association. Chosen by owner decision in T310 consensus Q6.
- RULE: use `link`/`unlink` for generic entity relationships. Use `attach`/`detach` ONLY for agent-to-project binding in the `admin` domain.

### 1l. export/import vs. backup/restore
- `backup` / `restore` — local snapshot and recovery of individual databases via VACUUM INTO (v2026.4.10+). Operates on raw `.db` files at project or global tier.
- `export` / `import` — portable cross-machine bundle creation and restoration via `.cleobundle.tar.gz` (v2026.4.13+, T311). Includes manifest, checksums, A/B regenerate-and-compare for JSON files.
- `inspect` — read-only examination of a bundle's manifest without extracting or modifying anything.
- `finalize` — apply pending manual resolutions from a prior `import` operation's conflict report (`.cleo/restore-conflicts.md`).
- RULE: use `backup`/`restore` for local snapshots. Use `export`/`import`/`inspect`/`finalize` for the portable bundle lifecycle.

---

## 2. Canonical Verb Matrix

**Status key**: Enforced = live in registry | Reserved = documented, not in registry

| Verb | Replaces | Scope | Status |
|------|----------|-------|--------|
| `add` | `install`, `prepare`, `new` | Create user-managed entities | Enforced |
| `show` | `display`, `view` | Read single entity by ID | Enforced |
| `list` | — | Read filtered collection | Enforced |
| `find` | `search`, `query` (as verb) | Search / semantic retrieval | Enforced |
| `update` | `configure`, `modify`, `edit`, `set` | Modify entity properties | Enforced |
| `delete` | `remove`, `rm`, `uninstall` | Permanently remove entity | Enforced |
| `archive` | — | Soft-remove (reversible) | Enforced |
| `restore` | `unarchive`, `reopen`, `uncancel` | Restore from any terminal state | Enforced |
| `complete` | `end`, `done`, `finish` | Mark task done | Enforced |
| `start` | `focus-set` | Begin working on task | Enforced |
| `stop` | `focus-clear` | Stop working on task (CLI) | Enforced |
| `status` | `show` (for state, not entity) | Check current state | Enforced |
| `validate` | `check` (for compliance) | Schema / protocol compliance | Enforced |
| `record` | `log` (for structured events) | Record lifecycle events | Enforced |
| `resume` | `continue`, `reopen` (session) | Resume paused session | Enforced |
| `suspend` | `pause`, `hibernate` | Pause session | Enforced |
| `reset` | `clear`, `wipe` | Emergency state reset (destructive) | Enforced |
| `init` | `setup`, `bootstrap`, `install` | Initialize project | Enforced |
| `enable` | `activate`, `on` | Enable feature | Enforced |
| `disable` | `deactivate`, `off` | Disable feature | Enforced |
| `backup` | `snapshot`, `save` (for backups) | Create backup | Enforced |
| `migrate` | `upgrade`, `transform` | Schema migration | Enforced |
| `verify` | `check`, `audit` (for artifacts) | Artifact gate / frontmatter verification | Enforced |
| `inject` | `insert`, `load` (for protocols) | Inject protocol content | Enforced |
| `run` | `exec`, `execute` | Execute action (compound-only) | Enforced |
| `end` | — | Terminate session (dispatch op) | Enforced |
| `link` | `connect`, `associate`, `attach` | Associate entities | Enforced |
| `check` | `ping`, `probe`, `test` (for health) | Liveness / health probe | Enforced |
| `sync` | `pull`, `push`, `reconcile` | Synchronize data stores | Enforced |
| `unlink` | `disconnect`, `detach`, `deassociate` | Dissociate entities | Enforced |
| `observe` | `note`, `capture` | Save raw observation to brain.db | Enforced |
| `store` | `add` (memory), `write` (audit) | Append-only structured memory write | Enforced |
| `fetch` | — | Batch retrieve by ID array (3-layer step 3) | Enforced |
| `timeline` | — | Chronological context retrieval (3-layer step 2) | Enforced |
| `plan` | — | Composite multi-query planning view | Enforced |
| `convert` | `transform`, `promote` (type change) | Change entity type | Enforced |
| `purge` | `hard-delete`, `destroy` | Permanently delete and remove from history/archive | Enforced |
| `compute` | `calculate`, `derive`, `eval` | Compute derived values | Reserved |
| `schedule` | `defer`, `queue` | Schedule deferred execution | Reserved |
| `cancel` | `abort`, `kill` | Cancel task (soft terminal state — reversible via restore) | Enforced |
| `repair` | `fix`, `heal`, `correct` | Data integrity repair | Reserved |
| `resolve` | `settle`, `merge` (conflicts) | Resolve conflicts | Reserved |
| `inspect` | `diagnose`, `debug`, `examine` | Examine internal state without modification | Enforced |
| `export` | `dump`, `extract` | Package data for portable transfer | Enforced |
| `import` | `ingest`, `load` (for backup restore) | Restore packaged data from portable bundle | Enforced |
| `finalize` | `commit`, `apply` (for deferred resolutions) | Apply pending resolutions from a prior operation | Enforced |
| `attach` | — | Bind an agent to a project (domain-specific; see §5) | Enforced |
| `detach` | — | Unbind an agent from a project (domain-specific; see §5) | Enforced |

**Deprecated — MUST NOT appear in new operation names**: `create`, `get`, `search`, `query` (as verb), `configure` (standalone)

---

## 3. Naming & Structural Rules

### Domain-Action Pattern
```
{domain}.{action}              → tasks.add, session.start
{domain}.{namespace}.{action}  → check.protocol, pipeline.stage.validate
```

### CLI Multi-Word Commands
Use **kebab-case**: `archive-stats`, `generate-changelog`
Never: `archiveStats`, `generate_changelog`

### LAFS Output Flags (apply to all commands)
| Flag | Purpose |
|------|---------|
| `--json` | JSON output (default) |
| `--human` | Human-readable output |
| `--quiet` | Suppress non-essential output for scripting |

### Commit Convention
All commits referencing a new operation must use the canonical verb in the task reference comment, not in the commit type prefix.

---

## 4. Reserved & Deferred Verbs

### Reserved (Documented, Not Yet in Registry)
| Verb | Intended Domain | Blocking Condition |
|------|-----------------|-------------------|
| `compute` | `orchestrate` | BRAIN Phase 3 (graph tables) required |
| `schedule` | `tasks` | Deferred execution design pending |
| `cancel` | `tasks` | `tasks.cancel` not in registry; `admin.job.cancel` is a different concept |
| `repair` | `admin` | Awaiting `admin.repair` implementation |
| `resolve` | `tools.issue` | Awaiting `tools.issue.resolve` implementation |
| `inspect` | `admin` | Promoted to Enforced in v2026.4.13 for `cleo backup inspect` |

### Deferred (Pending Design Decision)
| Verb | Context | Status |
|------|---------|--------|
| `consolidate` | BRAIN reasoning | Pending Reasoning R&C outcome |
| `predict` | BRAIN predictive | Pending Reasoning R&C outcome |
| `suggest` | BRAIN suggestion | Pending Reasoning R&C outcome |
| `spawn` | Agent orchestration | In registry as `orchestrate.spawn`; verb section deferred |
| `kill` | Agent termination | Pending — may use `stop` |
| `learn` | BRAIN accumulation | Overlaps with `store` — pending clarification |
| `score` | Quality grading | In registry as `admin.grade`; verb section deferred |
| `transfer` | Cross-project task transfer | In registry as `nexus.transfer` (mutate) + `nexus.transfer.preview` (query); T046 |

### Removed from Enforced Matrix
| Verb | Reason | Date |
|------|--------|------|
| `recall` | Originally a CLI wrapper; replaced by `memory find --type pattern|learning` for consistent dispatch addressing. | 2026.3.4 |
| `configure` | Contradicts `update` (which replaces it). Zero standalone ops in registry. | 2026.3.3 |
| `repair` | Not in registry or Constitution §4. Moved to Reserved. | 2026.3.3 |
| `resolve` | Not in registry or Constitution §4. Moved to Reserved. | 2026.3.3 |
| `schedule` | Not in registry or Constitution §4. Moved to Reserved. | 2026.3.3 |
| `cancel` | Promoted to Enforced — `tasks.cancel` now wired. `admin.job.cancel` remains a distinct concept. | 2026.3.4 |
| `inspect` | Promoted to Enforced for `cleo backup inspect` (T311, v2026.4.13). | 2026.4.13 |

---

## 5. Known Verb-Standard Exceptions

These are live operations in the registry that use non-canonical verbs for legacy or design reasons. They are NOT violations — they are documented exceptions. Do not flag these in compliance checks.

| Operation | Non-canonical verb used | Reason | Status |
|-----------|------------------------|--------|--------|
| `nexus.query` | `query` (deprecated as verb) | Legacy operation distinct from `nexus.show` — resolves cross-project `project:taskId` queries | Legacy exception; both `nexus.show` and `nexus.query` exist as separate operations |
| `admin.fix` | `fix` (replaced by `repair`) | Auto-fix for doctor checks; `admin.repair` not yet implemented | Pending rename when `repair` is promoted from Reserved |
| `orchestrate.bootstrap` | `bootstrap` (replaced by `init`) | Orchestration bootstrap info query; `orchestrate.init` conflicts semantically | Pending rename decision |
| `cleo agent attach` | `attach` (canonical is `link`) | Domain-specific: binds a global agent to a project via `conduit.db:project_agent_refs` (ADR-037 §3). `link` is too generic — "attach an agent to this project" is a scoped binding, not a relationship. Owner decision in T310 consensus Q6. | Permanent exception (v2026.4.12+) |
| `cleo agent detach` | `detach` (canonical is `unlink`) | Inverse of `attach`. Sets `enabled=0` on `project_agent_refs` without deleting the row (audit trail preserved per ADR-037 §6). | Permanent exception (v2026.4.12+) |
| `cleo backup export` | `export` (new verb) | Portable cross-machine bundle creation via `.cleobundle.tar.gz` (T311). Distinct from `backup` which creates local VACUUM INTO snapshots. | New verb (v2026.4.13+) |
| `cleo backup import` | `import` (new verb) | Portable bundle restoration with A/B regenerate-and-compare for JSON files (T311). Distinct from `restore` which recovers individual local snapshots. | New verb (v2026.4.13+) |
| `cleo backup inspect` | `inspect` (promoted from Reserved) | Read-only manifest examination of a `.cleobundle` without extraction or modification (T311). | Promoted (v2026.4.13+) |
| `cleo restore finalize` | `finalize` (new verb) | Applies pending manual resolutions from `.cleo/restore-conflicts.md` after a prior `import` (T311). No existing verb covers "commit deferred decisions." | New verb (v2026.4.13+) |

---

## References

- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — all registry-defined operations with canonical names (SSoT)
- `packages/cleo/src/dispatch/registry.ts` — executable registry (registry wins on conflicts)
- RFC 2119 — MUST/SHOULD/MAY definitions
