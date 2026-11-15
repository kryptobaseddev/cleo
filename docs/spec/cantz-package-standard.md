# `.cantz` Agent Package Standard

**Status**: Implemented — `cleo agent create`, `cleo agent pack` and `cleo agent install`
**Implementation**: `packages/core/src/agents/install-pipeline.ts`,
`packages/core/src/store/agent-install.ts`, `packages/core/src/agents/scaffold.ts`,
`packages/cleo/src/cli/commands/agent.ts`

---

## 1. Overview

The `.cantz` format is a distribution artifact for CANT agent packages: a ZIP
archive of one agent directory whose entrypoint is `persona.cant`.

The standard separates two concerns:

- **Agent directory**: a directory named after the agent, containing
  `persona.cant` and optional supporting files.
- **Archive convention**: how to ship that directory as a single `.cantz` file.

The `.cantz` archive is a shipping format only. Installation reduces a package
to a single `<agentId>.cant` file in a tier directory (section 4); that file is
what CLEO resolves at runtime.

## 2. Agent Directory Structure

### 2.1 Required structure

```
<agent-name>/
  persona.cant          -- REQUIRED: agent persona definition
```

`persona.cant` MUST contain a top-level `agent <id>:` declaration. Installation
reads the agent id from that declaration, not from frontmatter
(`agent-install.ts` `parseCantAgent`, which strips any `---` frontmatter before
matching `agent <id>:`).

The `<id>` MUST equal the directory name and MUST be kebab-case
(`[a-z][a-z0-9-]*`); `installAgentFromCant` rejects a mismatch or a
non-kebab-case id.

Scaffolded personas also carry `kind: agent` frontmatter
(`scaffold.ts` persona templates). Installation does not check it.

### 2.2 Optional structure

```
<agent-name>/
  persona.cant          -- REQUIRED
  manifest.json         -- package metadata
  team-config.cant      -- team membership (written by `cleo agent create --team`)
  expertise/            -- domain reference documents
    mental-model-seed.md  (written by `cleo agent create --seed-brain`)
  skills/               -- bundled skill references
  protocols/            -- agent-specific protocol definitions
```

These files travel inside the archive, but **`cleo agent install` installs only
`persona.cant`**. The pipeline copies `persona.cant` to a temp file named
`<agentId>.cant` and installs that one file (`install-pipeline.ts`
`resolveAgentCantPath`). Other files in the package are not copied to the tier
directory.

### 2.3 `manifest.json`

`manifest.json` is package metadata. Neither `pack` nor `install` reads it.

`cleo agent create` writes this shape (`scaffold.ts` `generateManifest`):

```json
{
  "name": "backend-dev",
  "version": "1.0.0",
  "description": "Worker agent for APIs and databases",
  "cant": {
    "minVersion": "1",
    "tier": "mid",
    "role": "worker"
  },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Written by `create` | Description |
|-------|---------------------|-------------|
| `name` | yes | Agent identifier (kebab-case; same as the directory name) |
| `version` | yes (`1.0.0`) | Package version |
| `description` | yes | Derived from role and `--domain` |
| `cant.minVersion` | yes (`"1"`) | Minimum CANT grammar version |
| `cant.tier` | yes | `low`, `mid` or `high` |
| `cant.role` | yes | `orchestrator`, `lead` or `worker` (`docs-worker` is written as `worker`) |
| `createdAt` | yes | ISO-8601 timestamp |

Authors MAY add further fields (for example `author`, `license`,
`repository`, `dependencies`); CLEO does not read them.

## 3. `.cantz` Archive Convention

### 3.1 Format

- File extension: `.cantz`
- Archive format: ZIP (created with the `zip` binary, extracted with `unzip`;
  both must be on `PATH`)
- The archive MUST contain exactly one top-level directory
- That directory MUST contain `persona.cant` at its root
- The directory name is the agent id and MUST match the `agent <id>:`
  declaration in `persona.cant`

### 3.2 Example

```
backend-dev.cantz
  backend-dev/
    persona.cant
    manifest.json
    expertise/
      api-patterns.md
```

### 3.3 Excluded content

Archives SHOULD NOT contain `.git/`, `node_modules/`, runtime databases
(`*.db`, `*.db-wal`, `*.db-shm`), or secret or credential files.

`cleo agent pack` does not filter these: it runs `zip -r` over the whole
directory. Remove them before packing.

## 4. Installation Targets

`cleo agent install` writes one file, `<agentId>.cant`
(`agent-install.ts` `resolveDestinationPath`):

| Tier | Flag | Destination |
|------|------|-------------|
| Project (default) | none | `<projectRoot>/.cleo/cant/agents/<agentId>.cant` |
| Global | `--global` | `<cleoHome>/agents/<agentId>.cant` (`getCleoGlobalAgentsDir()`, `packages/core/src/paths.ts`) |

`<cleoHome>` is `~/.local/share/cleo` on Linux and
`~/Library/Application Support/cleo` on macOS; `CLEO_HOME` overrides it.

**Known path inconsistency.** Three global-tier paths disagree in the current
source:

- `cleo agent install --global` writes to `<cleoHome>/agents/`
  (`getCleoGlobalAgentsDir`).
- `cleo agent create --global` scaffolds into `<cleoHome>/cant/agents/<name>/`
  (`scaffold.ts` `resolveTargetRoot`).
- The persona resolver scans `<cleoHome>/cant/agents/` for the global tier
  (`orchestration/registry-resolver.ts`, `getCleoGlobalCantAgentsDir`).

The `--global` help text of `install` and `create` names
`~/.local/share/cleo/cant/agents/`.

## 5. CLI Commands

### 5.1 `cleo agent create`

Scaffolds an agent directory in the project tier (`.cleo/cant/agents/<name>/`)
or, with `--global`, under `<cleoHome>/cant/agents/<name>/`.

Required: `--name` (kebab-case) and `--role` (`orchestrator`, `lead`, `worker`
or `docs-worker`). Optional: `--tier` (`low`/`mid`/`high`, inferred from
role), `--team`, `--domain`, `--parent`, `--global`, `--seed-brain`.

It writes `persona.cant` and `manifest.json`, plus `team-config.cant` with
`--team` and `expertise/mental-model-seed.md` with `--seed-brain`. It refuses
an existing directory.

### 5.2 `cleo agent pack <dir>`

Packages an agent directory into a `.cantz` archive.

```bash
cleo agent pack ./my-agent
cleo agent pack .cleo/cant/agents/backend-dev
```

Behavior (`agent.ts` `packCommand`):

1. Check that `<dir>` exists and is a directory; otherwise `E_NOT_FOUND`
   (exit 4).
2. Check that `<dir>/persona.cant` exists; otherwise `E_VALIDATION` (exit 6).
   The file's content is not validated.
3. Run `zip -r` from the parent directory, so the archive's single top-level
   directory is `<dirname>/`. The archive is written to `<dirname>.cantz` in
   the current working directory. A `zip` failure returns `E_PACK` (exit 1).

Output:

```json
{
  "success": true,
  "data": {
    "archive": "/abs/path/backend-dev.cantz",
    "agent": "backend-dev",
    "files": 5,
    "size": 12345
  }
}
```

`files` counts the files in the source directory; `size` is the archive size
in bytes.

### 5.3 `cleo agent install <path>`

Installs an agent from a `.cant` file, a `.cantz` archive or an agent
directory.

```bash
cleo agent install ./backend-dev.cant
cleo agent install ./backend-dev.cantz
cleo agent install ./backend-dev.cantz --global
cleo agent install ./backend-dev/
```

Flags: `--global` (global tier), `--strict` (fail on pipeline warnings such as
unknown skill slugs), `--attach` (after a global install, attach the agent to
the current project), `--force` (overwrite an existing row and file),
`--resync` (delete the existing registry row, keep the file, reinstall).

Behavior:

1. A missing path returns `E_NOT_FOUND` (exit 4).
2. `resolveAgentCantPath` normalizes the input:
   - `<id>.cant`: used as-is.
   - `<pkg>.cantz`: extracted with `unzip` to a temp directory; exactly one
     top-level directory is required, and it must contain `persona.cant`,
     which is copied to `<dirname>.cant`.
   - directory: must contain `persona.cant`, copied to `<dirname>.cant` in a
     temp directory.
   - Any failure here returns `E_VALIDATION` (exit 6).
3. `installAgentFromCant` parses the `agent <id>:` declaration (id, `role`,
   `parent`, `skills`), checks the id against the file name and kebab-case, and
   copies the file to the tier destination (section 4). In one SQLite
   transaction it writes the agent row (`agent_registry_agents`) and its
   skill junctions (`agent_registry_agent_skills`) in the global `cleo.db`.
4. An existing agent without `--force`/`--resync` fails with
   `E_AGENT_ALREADY_INSTALLED`; `--strict` with warnings fails with
   `E_VALIDATION` (exit 6); other failures return `E_INSTALL` (exit 1).
5. The temp directory is removed in all cases (`cleanupInstallTempDir`).

Output:

```json
{
  "success": true,
  "data": {
    "agentId": "backend-dev",
    "tier": "project",
    "cantPath": "/abs/project/.cleo/cant/agents/backend-dev.cant",
    "cantSha256": "…",
    "inserted": true,
    "skillsAttached": ["ct-task-executor"],
    "warnings": [],
    "attached": false
  }
}
```

## 6. Runtime Model

1. Author an agent directory containing `persona.cant` (or scaffold one with
   `cleo agent create`).
2. Optionally package it with `cleo agent pack`.
3. Install with `cleo agent install`, which writes `<agentId>.cant` to a tier
   directory and registers the agent.
4. The persona resolver (`packages/core/src/orchestration/registry-resolver.ts`)
   walks tiers in order: project (`<projectRoot>/.cleo/cant/agents/*.cant`),
   global (`<cleoHome>/cant/agents/*.cant`), then a packaged
   `agents/seed-agents/` directory when one is found next to the core package
   (`resolvePackagedSeedDir`). The first match wins. This repository has no
   `packages/agents/`; its tracked seed agents live in
   `packages/cleo-os/seed-agents/`, which that lookup does not search.

See section 4 for the global-tier path inconsistency.

## 7. Validation Rules

| ID | Rule | Level | Enforced by |
|----|------|-------|-------------|
| CANTZ-001 | Archive MUST contain exactly one top-level directory | MUST | `install` (`resolveAgentCantPath`) |
| CANTZ-002 | Top-level directory MUST contain `persona.cant` | MUST | `pack` and `install` |
| CANTZ-003 | `persona.cant` MUST contain a top-level `agent <id>:` declaration | MUST | `install` (`installAgentFromCant`) |
| CANTZ-004 | The agent id MUST equal the directory name | MUST | `install` (id is checked against `<dirname>.cant`) |
| CANTZ-005 | The agent id MUST be kebab-case | MUST | `install`; `create` checks `--name` |
| CANTZ-006 | Archive SHOULD NOT contain `.git/` or `node_modules/` | SHOULD | not enforced |
| CANTZ-007 | `manifest.json` `name`, when present, SHOULD equal the directory name | SHOULD | not enforced (`manifest.json` is not read) |

## 8. Comparison with skill packages

| Aspect | Skill | `.cantz` agent |
|--------|-------|----------------|
| Entrypoint | `SKILL.md` | `persona.cant` |
| Install command | `caamp skills install` | `cleo agent install` |
| Installed form | Skill directory | One `<agentId>.cant` file in a CANT tier directory |
| Packaging command | none in CLEO | `cleo agent pack <dir>` |

## 9. References

| Document | Path |
|----------|------|
| CANT DSL spec | `docs/spec/cant-dsl.md` |
| CANT reference | `docs/reference/cant.md` |
| Creating custom agents | `docs/guide/creating-custom-agents.md` |
| Install pipeline | `packages/core/src/agents/install-pipeline.ts` |
| Install + registry write | `packages/core/src/store/agent-install.ts` |
| Scaffold | `packages/core/src/agents/scaffold.ts` |
| Tier paths | `packages/core/src/paths.ts` (`getCleoGlobalAgentsDir`, `getCleoGlobalCantAgentsDir`) |
| Persona resolver | `packages/core/src/orchestration/registry-resolver.ts` |
| Agent commands | `packages/cleo/src/cli/commands/agent.ts` |
