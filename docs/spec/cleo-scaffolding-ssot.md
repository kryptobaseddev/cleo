# CLEO Scaffolding SSoT Specification

**Status**: DRAFT
**Task**: T687
**ADR**: ADR-045

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Purpose

This specification is the single source of truth (SSoT) for where CLEO artifacts live:
what `cleo init` and `cleo upgrade` scaffold, where each kind of document goes, and
which state lives in the store rather than in files. It implements ADR-045.

Data lives in one `cleo.db` per scope. The project store is `<project>/.cleo/cleo.db`.
The global store is `<cleoHome>/cleo.db`, where `cleoHome` is `~/.local/share/cleo` on
Linux and `~/Library/Application Support/cleo` on macOS, and `CLEO_HOME` overrides it.
See [database-architecture.md](database-architecture.md).

---

## 2. What `cleo init` scaffolds

### 2.1 Project `.cleo/` directories

`ensureCleoStructure()` (`packages/core/src/scaffold/ensure-dirs.ts:38`) creates `.cleo/`
and every entry of `REQUIRED_CLEO_SUBDIRS` (lines 22-29):

| Directory | Purpose |
|-----------|---------|
| `.cleo/backups/operational/` | Operational backups |
| `.cleo/backups/safety/` | Pre-migration safety copies |
| `.cleo/agent-outputs/` | Legacy ad-hoc agent output directory (see §3.4) |
| `.cleo/logs/` | CLI and migration logs |
| `.cleo/rcasd/` | Legacy lifecycle stage files (see §3.1) |
| `.cleo/adrs/` | Retired ADR mirror. It is still created, but ADRs publish to `docs/adr/` (see §3.2). |

It refuses to scaffold a project inside the global CLEO home (lines 40-46).

### 2.2 Other project files and steps

`initProject` in `packages/core/src/init.ts` also does the following (each step's
result appears in the `created` list it returns):

- `config.json`, `.cleo/.gitignore` (from `packages/core/templates/cleo-gitignore`) and
  `<project>/.worktreeinclude`, the canonical location (`scaffold/ensure-config.ts:106-111`).
  The legacy `.cleo/worktree-include` is still read for one deprecation cycle and is
  migrated by `cleo doctor --migrate-worktree-include`.
- The project store. The task, brain and conduit domains all open the project
  `cleo.db` (`init.ts:1520-1555`). The output still labels these steps `tasks.db`,
  `brain.db` and `conduit.db`; those labels are leftover names, not separate files.
- The isolated checkpoint repo `.cleo/checkpoint.git` (`CHECKPOINT_GIT_DIRNAME`,
  `packages/core/src/store/checkpoint-git-dir.ts:59`), and an empty initial commit when
  the project has no `HEAD`. A legacy `.cleo/.git` is migrated to it by
  `migrateCheckpointGitDir`.
- The legacy `claudedocs/` → `.cleo/agent-outputs/` migration
  (`packages/core/src/migration/agent-outputs.ts`).
- Git hooks, `.github/ISSUE_TEMPLATE/*` and `.github/pull_request_template.md`.
- `project-info.json` and the tracked identity files `.cleo/project.json` and
  `.cleo/project-id` (ADR-094, ADR-096). The id is write-once.
- `project-context.json`, `memory-bridge.md`, the instruction injection, and NEXUS
  registration.
- The starter CANT bundle in `.cleo/cant/` (`team.cant` plus `.cleo/cant/agents/`), which
  is deployed only when `.cleo/cant/` has no `.cant` files yet (`init.ts:2130-2176`).
  Project-tier worker templates are registered in the global agent registry.
- Seeding of the models catalog and the builtin providers in the global store.

`cleo init` no longer scaffolds the CleoOS hub (`pi-extensions/`, `cant-workflows/`,
`global-recipes/`) under ADR-098 (`init.ts`, T13994 comment). `cleo admin scaffold-hub`
is deprecated and hidden.

### 2.3 `cleo upgrade`

`cleo upgrade` (`packages/core/src/upgrade.ts`) re-runs the store setup: the project
store, the global agent registry, `ensureConduitDb()` at line 1135, and
`memory-bridge.md`. Its file-level checks in `diagnoseUpgrade()` still look for the
legacy files `.cleo/signaldock.db` and `.cleo/conduit.db` (lines 1961-1995). Those files
are no longer created, so these checks are stale.

### 2.4 Global home

`ensureGlobalHome()` (`packages/core/src/scaffold/global-scaffold.ts`), called from
`bootstrapGlobalCleo()` (`packages/core/src/bootstrap.ts:123`), creates `cleoHome` with
`REQUIRED_GLOBAL_SUBDIRS`: `logs`, `templates`, `global-recipes`, `pi-extensions`,
`cant-workflows` and `agents` (lines 27-34). The three hub directories are created empty;
hub templates are seeded only by the deprecated `cleo admin scaffold-hub`. It writes
`config.json` from `global-config.template.json` when it is missing. It removes the
`STALE_GLOBAL_ENTRIES` (lines 39-54), which include `adrs`, `rcasd`, `agent-outputs`,
`backups` and `tasks.db`.

### 2.5 Tracking rules (`.cleo/.gitignore`)

The template ignores everything, then allows only a short list
(`packages/core/templates/cleo-gitignore`):

- Tracked: `.gitignore`, `project-context.json`, `project.json`, `project-id`,
  `owner-settings.json`, `setup-otel.sh`, `DATA-SAFETY-IMPLEMENTATION-SUMMARY.md`,
  `adrs/**`, `agent-outputs/**`, `worktree-include`.
- Never tracked: `*.db` and their `-shm`/`-wal`/`-journal` sidecars, `config.json`,
  `project-info.json`, `nexus-link.json`, `backups/`, `metrics/`, `sync/`, `quarantine/`,
  `session-journals/`, and the logs and caches listed in the template.
- `.cleo/rcasd/` is not allowed (T14277). New files there stay ignored. Legacy files
  that git already tracks stay tracked.

---

## 3. Where documents go

Canonical documents are stored in the docs store and published to `docs/<kind>/`. The
routing registry is `.cleo/canon.yml`. Create a doc with `cleo docs add --type <kind>`,
change one with `cleo docs update <slug>`, and write the mirror with `cleo docs publish`.
`cleo check canon docs` fails on a new raw `*.md` file under a kind's blocked paths. Every
`docs/**.md` name and slug MUST be lowercase kebab-case, at most 64 characters, with no
task id, session id or date (`packages/core/src/docs/doc-name-rule.ts`). The full
procedure is [cleo-documentation-sop.md](../guide/cleo-documentation-sop.md).

### 3.1 RCASD lifecycle stages

A lifecycle stage is a row in `tasks_lifecycle_stages` in the project `cleo.db`, and the
row is the record. `recordStageProgress` (`packages/core/src/lifecycle/index.ts:786-790`)
writes a stage file only when the caller passes real artifact content. When it does,
`ensureStageArtifact` (`packages/core/src/lifecycle/stage-artifacts.ts:94`) writes:

```
.cleo/rcasd/{epicId}/{stageSubdir}/{epicId}-{stageSlug}.md
```

and stores the relative path in `tasks_lifecycle_stages.output_file`.

`{stageSlug}` is the stage name with `_` replaced by `-`. `{stageSubdir}` comes from
`STAGE_SUBDIRS` in `packages/core/src/lifecycle/rcasd-paths.ts` (lines 16-23). A stage
not in that map uses its own name:

| Stage | Subdir | Slug |
|-------|--------|------|
| `research` | `research` | `research` |
| `consensus` | `consensus` | `consensus` |
| `architecture_decision` | `architecture` | `architecture-decision` |
| `specification` | `specification` | `specification` |
| `decomposition` | `decomposition` | `decomposition` |
| `implementation` | `implementation` | `implementation` |
| `validation` | `validation` | `validation` |
| `testing` | `testing` | `testing` |
| `release` | `release` | `release` |
| `contribution` | `contributions` | `contribution` |

Stage research and other narrative content belong in the docs store
(`cleo docs add --type research`). `.cleo/canon.yml` lists `.cleo/rcasd/` as a blocked
raw path for the `research` kind.

### 3.2 Architecture Decision Records

ADRs are `adr`-kind docs. They are stored in the docs store and published to
`docs/adr/adr-NNN-<slug>.md`. `.cleo/adrs/` is a retired legacy mirror, and raw writes
to it are blocked (`.cleo/canon.yml`, `adr` kind).

`cleo adr` reads `docs/adr/`:

- `cleo adr list`, `cleo adr show <id>`, `cleo adr find`: browse ADRs.
- `cleo adr validate`: check ADR frontmatter.
- `cleo adr sync`: sync `docs/adr/` into the `tasks_architecture_decisions` table
  (`packages/core/src/store/schema/cleo-project/audit.ts:257`).

`packages/caamp/docs/adrs/` holds CAAMP's package-internal ADRs and is out of scope here.

### 3.3 Specifications and plans

| Kind | Published path | Create with |
|------|----------------|-------------|
| `spec` | `docs/spec/<kebab-name>.md` | `cleo docs add --type spec` |
| `plan` | `docs/plan/<kebab-name>.md` | `cleo docs add --type plan` |

The plural directories `docs/specs/` and `docs/plans/` are retired; the singular names
are canonical (`.cleo/canon.yml`). A published spec is distinct from an RCASD
specification stage record (§3.1).

### 3.4 Agent outputs and the manifest

- The `{{OUTPUT_DIR}}` token still defaults to `.cleo/agent-outputs`
  (`packages/core/src/skills/injection/token.ts:83`). However, `.cleo/canon.yml` lists
  `.cleo/agent-outputs/` as a blocked raw path for the `note` kind, so a new raw `*.md`
  file there fails `cleo check canon docs`. Record output with
  `cleo docs add --type note` (or `research`) instead.
- The `{{MANIFEST_PATH}}` token is retired and empty (`token.ts:84-85`, ADR-027). Write
  manifest entries with `cleo manifest append`, which writes the
  `docs_pipeline_manifest` table in the project `cleo.db`
  (`packages/core/src/store/schema/cleo-project/docs.ts:235`).
- `claudedocs/agent-outputs/` and `claudedocs/research-outputs/` are legacy. `cleo init`
  and `cleo upgrade` migrate them into `.cleo/agent-outputs/`.

### 3.5 Other `.cleo/` paths written at runtime

| Path | Writer |
|------|--------|
| `.cleo/backups/sqlite/` | Rotating `VACUUM INTO` snapshots from `cleo session end` and `cleo backup add` (ADR-013) |
| `.cleo/audit/` | Audit JSONL logs, for example `worktree-lifecycle.jsonl`, `docs-versioning.jsonl`, `docs-new-because.jsonl` |
| `.cleo/metrics/` | Grade and compliance JSONL (`GRADES.jsonl`, `COMPLIANCE.jsonl`). Not tracked. |
| `.cleo/snapshots/` | `cleo snapshot` exports (`packages/core/src/snapshot/index.ts:214`) |
| `.cleo/agent-events/` | Agent event bus file transport (`packages/core/src/events/event-bus.ts`) |
| `.cleo/session-journals/` | Session journals. Not tracked. |
| `.cleo/quarantine/` | Rows and stores moved aside by repairs. Not tracked. |
| `.cleo/cant/` | Project-tier CANT team and agent files (§2.2) |

`.cleo/agents/` is the default output of `cleo cant migrate --write`
(`packages/cant/src/migrate/converter.ts:49`, written at
`packages/cleo/src/cli/commands/cant.ts:228`), so files there may be current migration
output. `migrate-agents-v2` also reads it as a legacy location
(`packages/cleo/src/cli/commands/migrate-agents-v2.ts:321`). Agents installed with
`cleo agent install` go to `.cleo/cant/agents/` instead.

---

## 4. Store vs filesystem

### 4.1 In the store only

- Tasks, sessions, lifecycle stage state and gate results, provenance, and playbooks
  (`tasks_*`, project `cleo.db`).
- Project memory: decisions, patterns, learnings and observations (`brain_*`, project
  `cleo.db`).
- Canonical document bytes and history (`docs_*` and the conduit docs-history tables,
  project `cleo.db`).
- ADR metadata (`tasks_architecture_decisions`), synced from `docs/adr/`.
- Agent identities and credentials (`agent_registry_*`, global `cleo.db`).

### 4.2 Files

- Published doc mirrors under `docs/<kind>/`, written by `cleo docs publish`.
- Legacy RCASD stage files under `.cleo/rcasd/`, written only when real content is
  supplied (§3.1).

### 4.3 Store row that points at a file

- `tasks_lifecycle_stages.output_file` points at `.cleo/rcasd/{epicId}/{stageSubdir}/*.md`.
- `tasks_architecture_decisions.file_path` points at the ADR's file under `docs/adr/`.

---

## 5. Rules for agents

1. Agents MUST NOT create files under `claudedocs/`, `.cleo/research/`, `.cleo/adrs/`,
   `.cleo/consensus/`, `.cleo/specs/`, `.cleo/decomposition/`, `docs/specs/`, `docs/plans/`
   or `docs/handoffs/`.
2. For lifecycle stages, read state with `cleo lifecycle show <epicId>` and record
   progress with `cleo lifecycle start|complete|skip <epicId> <stage>`. Put stage content
   in the docs store, not in a raw file.
3. For canonical docs, find the existing doc first (`cleo docs query "<topic>"`) and
   update it. Otherwise use `cleo docs add --type <kind>` and `cleo docs publish`. Never
   write raw markdown to a kind's publish path.
4. For manifest entries, use `cleo manifest append`.

---

## 6. Related documents

- [ADR-045: .cleo/ Scaffolding SSoT](../adr/adr-045-cleo-scaffolding-ssot.md)
- [ADR-014: RCASD Rename and Protocol Output Validation](../adr/adr-014-rcasd-rename-and-protocol-validation.md)
- [ADR-013: Data Integrity and Checkpoint Architecture](../adr/adr-013-data-integrity-checkpoint-architecture.md)
- [cleo-documentation-sop.md](../guide/cleo-documentation-sop.md): the documentation layout
- [database-architecture.md](database-architecture.md): the store layout
- `packages/core/src/scaffold/ensure-dirs.ts`: the project directory scaffold
- `packages/core/src/scaffold/global-scaffold.ts`: the global home scaffold
- `packages/core/src/lifecycle/rcasd-paths.ts`: RCASD path helpers
- `packages/core/src/lifecycle/stage-artifacts.ts`: stage artifact writer
- `packages/core/src/migration/agent-outputs.ts`: the legacy `claudedocs/` migration
- `.cleo/canon.yml`: doc kind routing
