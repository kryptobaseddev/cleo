# CLEO Install Channels Specification

**Status**: draft (aligned to ADR-016)
**Owner**: CLEO core
**Task**: T4884

---

## Goal

Define a canonical installation and runtime model for CLEO across stable, beta, and contributor-dev channels.

## Channel Contract

### stable

- Package: `@cleocode/cleo@latest`
- MCP entrypoint: `npx -y @cleocode/cleo@latest mcp`
- CLI (optional): `npm i -g @cleocode/cleo`
- Server name: `cleo`
- Data root: `~/.cleo`

### beta

- Package: `@cleocode/cleo@beta` or exact prerelease
- MCP entrypoint: `npx -y @cleocode/cleo@beta mcp`
- CLI (optional): `npm i -g @cleocode/cleo@beta`
- Server name: `cleo-beta`
- Data root: `~/.cleo` by default (or isolated by operator policy)

### dev

- Source: local repo
- CLI alias: `cleo-dev`
- MCP server name: `cleo-dev`
- Data root: `~/.cleo-dev`
- Dev mode SHALL be parallel-safe with stable installs by default.
- Dev mode SHALL NOT expose `ct`.
- Dev mode SHALL NOT install `cleo` symlink by default.

## Contributor Workflow (Canonical)

1. Clone repo and install dependencies
2. Build once (or run watch build)
3. Use dev-specific command alias (`cleo-dev`)
4. Verify runtime path before testing with `which cleo-dev` and `cleo-dev env`

## Installer Architecture Requirements

1. Link and alias behavior MUST be implemented through `installer/lib/link.sh` as the single link manager.
2. Installer mode detection MUST determine command names and MCP server names.
3. Production install paths MUST NOT call scripts under `/dev` or `/dev/archived`.
4. Any legacy duplicate symlink logic outside `link.sh` SHOULD be removed.

## Install Matrix (Contract)

- `stable`: commands `cleo`, `ct`; MCP via `cleo mcp`; server `cleo`; data `~/.cleo`
- `beta`: commands `cleo-beta`, optional `ct-beta`; MCP via `cleo-beta mcp`; server `cleo-beta`; data `~/.cleo-beta` recommended
- `dev`: commands `cleo-dev`; MCP via `cleo-dev mcp`; server `cleo-dev`; data `~/.cleo-dev`; no `ct`

## `npm link` Contributor Caveat

- Raw `npm link` follows `package.json` bin mappings and may expose `cleo`/`ct`.
- For strict dev isolation, contributors MUST run `./install.sh --dev` so channel-aware links are created (`cleo-dev`).
- `npm link` remains valid for local testing of package bins, but it is not the canonical isolated dev-channel setup.

## Operational Requirements

1. CLEO MUST expose runtime diagnostics to identify binary path and channel assumptions.
2. CLEO docs MUST separate channel contracts from provider-specific MCP setup.
3. CAAMP MUST be the source of truth for provider MCP profile installation and updates.
4. CLEO installer MUST auto-detect platform/shell and apply profile changes safely across Linux/macOS/Windows shell environments.
5. `npx` usage MUST be documented as ephemeral execution, not equivalent to persistent global install.

## Non-Goals

- This document does not define provider file formats.
- This document does not redefine CAAMP internal architecture.
- This document does not retain `setup-claude-aliases` in core installer flow.
