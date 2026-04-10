# `.cantz` Agent Package Standard

**Status**: DRAFT
**Date**: 2026-04-09
**Epic**: T438 -- CleoOS Agent Platform
**Reference**: CLEO-ULTRAPLAN.md Section 2.4, SKILL-PACKAGE-STANDARD.md

---

## 1. Overview

The `.cantz` format is a distribution artifact for CANT agent packages.
It mirrors the `.skill` archive convention defined in
`SKILL-PACKAGE-STANDARD.md` but targets agent personas, team
configurations, expertise references, and skill bindings rather than
provider-facing skill directories.

The standard separates two concerns:

- **Open standard**: the agent directory structure containing
  `persona.cant` and supporting files.
- **Archive convention**: how to ship that directory as a single
  `.cantz` file.

Runtimes discover **directories containing `persona.cant`**, not
`.cantz` archives directly. The archive is a packaging and distribution
artifact.

## 2. Agent Directory Structure

An agent package is a directory named after the agent that contains a
`persona.cant` entrypoint plus optional supporting files.

### 2.1 Required Structure

```
<agent-name>/
  persona.cant          -- REQUIRED: agent persona definition
```

The `persona.cant` file MUST be a valid CANT document with
`kind: agent` in its frontmatter.

### 2.2 Optional Structure

```
<agent-name>/
  persona.cant          -- REQUIRED
  manifest.json         -- package metadata (name, version, author, etc.)
  team-config.cant      -- team composition this agent participates in
  expertise/            -- domain expertise reference documents
    *.md
  skills/               -- skill references bundled with the agent
    <skill-name>/
      SKILL.md
  protocols/            -- protocol definitions specific to this agent
    *.cant
```

### 2.3 `manifest.json` Schema

The `manifest.json` file carries metadata for the packaged agent. All
fields are optional except `name`.

```json
{
  "name": "backend-dev",
  "version": "1.0.0",
  "author": "CLEO Platform Team",
  "description": "Backend development specialist for APIs, databases, and infrastructure",
  "license": "MIT",
  "dependencies": {
    "skills": ["ct-typescript", "ct-drizzle-orm"],
    "agents": []
  },
  "cant": {
    "minVersion": "2",
    "tier": "mid",
    "role": "worker"
  },
  "repository": "https://github.com/example/cleo-agents"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | YES | Agent identifier (kebab-case, must match directory name) |
| `version` | string | no | Semantic version of the package |
| `author` | string | no | Package author or team |
| `description` | string | no | Human-readable description |
| `license` | string | no | SPDX license identifier |
| `dependencies.skills` | string[] | no | Required skill names |
| `dependencies.agents` | string[] | no | Required companion agents |
| `cant.minVersion` | string | no | Minimum CANT grammar version |
| `cant.tier` | string | no | Declared agent tier (low/mid/high) |
| `cant.role` | string | no | Agent role (orchestrator/lead/worker) |
| `repository` | string | no | Source repository URL |

## 3. `.cantz` Archive Convention

### 3.1 Format

- File extension: `.cantz`
- Archive format: ZIP
- The archive MUST contain exactly one top-level directory
- The top-level directory name MUST match the agent `name`
- The top-level directory MUST contain `persona.cant` at its root

### 3.2 Example

```
backend-dev.cantz
  backend-dev/
    persona.cant
    manifest.json
    expertise/
      api-patterns.md
      database-design.md
    skills/
      ct-typescript/
        SKILL.md
```

### 3.3 Excluded Content

Archives MUST NOT contain:

- `.git/` directories
- `node_modules/` directories
- Runtime databases (`*.db`, `*.db-wal`, `*.db-shm`)
- CI configuration files
- Workspace manifests
- Secret or credential files

## 4. Installation Targets

### 4.1 Global Installation

```
~/.local/share/cleo/cant/agents/<agent-name>/
```

Global agents are available to all projects via the global tier of the
3-tier CANT hierarchy (see `CANT-HIERARCHY-SPEC.md`).

### 4.2 Project Installation

```
<cwd>/.cleo/cant/agents/<agent-name>/
```

Project agents are scoped to the current project and override global
agents with the same basename during discovery.

### 4.3 Tier Selection

- Default: project installation (`.cleo/cant/agents/`)
- `--global` flag: global installation (`~/.local/share/cleo/cant/agents/`)

## 5. CLI Commands

### 5.1 `cleo agent pack <dir>`

Package an agent directory into a `.cantz` archive.

**Usage:**
```bash
cleo agent pack ./my-agent
cleo agent pack .cleo/cant/agents/backend-dev
```

**Behavior:**
1. Validate that `<dir>` exists and contains `persona.cant`
2. Validate that `persona.cant` has valid CANT frontmatter (`kind: agent`)
3. ZIP the directory as `<dirname>.cantz`
4. Output the path to the created archive

**Output (LAFS envelope):**
```json
{
  "success": true,
  "data": {
    "archive": "backend-dev.cantz",
    "agent": "backend-dev",
    "files": 5,
    "size": 12345
  }
}
```

**Error cases:**
- `E_VALIDATION`: directory does not contain `persona.cant`
- `E_NOT_FOUND`: directory does not exist

### 5.2 `cleo agent install <path> [--global]`

Install an agent from a `.cantz` archive or a directory.

**Usage:**
```bash
cleo agent install ./backend-dev.cantz
cleo agent install ./backend-dev.cantz --global
cleo agent install ./my-agent/          # directory install
```

**Behavior:**
1. If path ends with `.cantz`: extract ZIP to a temporary directory
2. Validate that `persona.cant` exists in the extracted/source directory
3. Determine target tier:
   - `--global`: `~/.local/share/cleo/cant/agents/<name>/`
   - Default: `.cleo/cant/agents/<name>/`
4. Copy the agent directory to the target tier
5. Register the agent in signaldock.db via the existing
   `cleo agent register` flow (best-effort, non-fatal if registry
   unavailable)

**Output (LAFS envelope):**
```json
{
  "success": true,
  "data": {
    "agent": "backend-dev",
    "tier": "project",
    "path": ".cleo/cant/agents/backend-dev/",
    "registered": true
  }
}
```

**Error cases:**
- `E_VALIDATION`: no `persona.cant` found in archive or directory
- `E_NOT_FOUND`: path does not exist
- `E_VALIDATION`: archive contains zero or multiple top-level directories

## 6. Runtime Model

The runtime flow follows the same pattern as `.skill` packages:

1. Author an agent directory containing `persona.cant`
2. Optionally package it as `<name>.cantz`
3. Install via `cleo agent install` (extracts to target tier)
4. The CANT bridge discovers `persona.cant` during 3-tier scan at
   `session_start`

The `.cantz` archive is a shipping format. The extracted agent directory
is the runtime loading format.

## 7. Validation Rules

| ID | Rule | Level |
|----|------|-------|
| CANTZ-001 | Archive MUST contain exactly one top-level directory | MUST |
| CANTZ-002 | Top-level directory MUST contain `persona.cant` | MUST |
| CANTZ-003 | `persona.cant` MUST have `kind: agent` frontmatter | MUST |
| CANTZ-004 | Directory name MUST match `manifest.json` `name` field if both exist | MUST |
| CANTZ-005 | Archive MUST NOT contain `.git/` or `node_modules/` | MUST |
| CANTZ-006 | `manifest.json` `name` field MUST use kebab-case | SHOULD |
| CANTZ-007 | Archive size SHOULD be under 1 MB | SHOULD |

## 8. Comparison with `.skill`

| Aspect | `.skill` | `.cantz` |
|--------|----------|----------|
| Entrypoint | `SKILL.md` | `persona.cant` |
| Archive format | ZIP | ZIP |
| Extension | `.skill` | `.cantz` |
| Install target | Provider skill directory | CANT tier directory |
| Metadata sidecar | `manifest.json` | `manifest.json` |
| Packaging command | `zip -r name.skill name/` | `cleo agent pack <dir>` |
| Install command | `caamp skills install` | `cleo agent install` |

## 9. References

| Document | Path |
|----------|------|
| SKILL Package Standard | `docs/specs/SKILL-PACKAGE-STANDARD.md` |
| CANT Hierarchy Spec | `docs/specs/CANT-HIERARCHY-SPEC.md` |
| CLEO-ULTRAPLAN.md Section 2.4 | `docs/plans/CLEO-ULTRAPLAN.md` |
| XDG path resolution | `packages/cleo-os/src/xdg.ts` |
| CANT bridge | `packages/cleo-os/extensions/cleo-cant-bridge.ts` |
| Agent commands | `packages/cleo/src/cli/commands/agent.ts` |
