# ADR-016: Installation Channels and Dev Runtime Isolation

**Date**: 2026-02-25
**Status**: accepted
**Accepted**: 2026-02-25
**Related Tasks**: T4881, T4882, T4883, T4884, T4885, T4886, T4887, T4888
**Related ADRs**: ADR-008, ADR-011, ADR-015
**Summary**: Defines three CLEO installation channels (npm global, npm local, dev symlink) and establishes runtime isolation between dev and production instances. Prevents the dev source tree from affecting production .cleo/ data.
**Keywords**: installation, channels, npm, global, local, dev, symlink, runtime-isolation, npm-link
**Topics**: admin, tools, security

---

## 1. Context

CLEO currently has channel ambiguity between source code, globally installed npm package binaries, and provider MCP configurations. This ambiguity causes dogfooding failures where contributors edit source but execute an older global binary.

We need a canonical channel model that supports three modes without collisions:

1. Production stable installs for end users
2. Beta prerelease installs for early adopters
3. Contributor-local dev runtime in parallel with stable installs

Provider-specific MCP config management is delegated to CAAMP.

---

## 2. Decision

CLEO SHALL standardize on three runtime channels:

### 2.1 Stable Channel (`stable`)

- Package source: `@cleocode/cleo@latest`
- MCP runtime command: `npx -y @cleocode/cleo@latest mcp`
- Default MCP server name: `cleo`
- Optional global CLI install: `npm i -g @cleocode/cleo`
- Default data root: `~/.cleo`

### 2.2 Beta Channel (`beta`)

- Package source: `@cleocode/cleo@beta` (or exact `x.y.z-beta.n`)
- MCP runtime command: `npx -y @cleocode/cleo@beta mcp`
- Recommended MCP server name: `cleo-beta`
- Optional global CLI install: `npm i -g @cleocode/cleo@beta`
- Default data root: `~/.cleo` unless explicitly isolated

### 2.3 Contributor Dev Channel (`dev`)

- Runtime source: local repository build output
- CLI alias: `cleo-dev`
- MCP server name: `cleo-dev`
- Default dev data root: `~/.cleo-dev`
- Dev runtime MUST NOT overwrite stable global `cleo` unless explicitly requested
- Dev runtime MUST NOT create `ct` alias
- Dev runtime MUST NOT create `cleo` symlink by default

---

## 3. Channel Isolation Rules

1. Binary identity, MCP server name, and data root SHALL be treated as separate concerns.
2. `dev` runtime SHALL default to isolated data storage (`~/.cleo-dev`).
3. `dev` runtime SHALL expose only `cleo-dev` command surface; legacy `ct` alias is excluded.
4. Installer link creation SHALL be centralized in `installer/lib/link.sh` with channel-aware mapping.
5. Duplicate ad-hoc symlink logic in other installer entry points SHOULD be removed.
6. Provider MCP profiles SHALL be installed and managed by CAAMP (not by ad-hoc manual snippets in CLEO docs).
7. CLEO docs SHALL publish channel contract semantics, while CAAMP docs/commands SHALL publish provider-specific configuration details.
8. Archived/dev-only scripts MUST NOT be referenced by production install paths.

---

## 4. Rationale

- Prevents source-vs-runtime confusion for contributors.
- Enables side-by-side stable/beta/dev usage with clear rollback.
- Keeps provider integration logic centralized in CAAMP, which already owns provider config surface area and APIs.
- Preserves low-friction stable installation for end users.

---

## 5. Consequences

### Positive

- Deterministic channel behavior for support and troubleshooting
- Reduced dogfooding regressions caused by wrong binary execution
- Clean separation of responsibilities between CLEO and CAAMP

### Tradeoffs

- Slightly more onboarding detail for contributors
- Additional CI/test matrix surface for channel verification

---

## 6. Implementation Scope

- CLEO: channel contract docs, dev runtime guidance, channel-aware diagnostics
- CAAMP: provider install/uninstall/update flows for `stable|beta|dev`, plus TUI and non-interactive CLI/API controls

## 7. Installer Policy

### 7.1 Mode-aware command/link mapping

- `stable`: `cleo`, `ct` (compat), `cleo-mcp`, server `cleo`
- `beta`: `cleo-beta`, optional `ct-beta`, `cleo-mcp-beta`, server `cleo-beta`
- `dev`: `cleo-dev`, `cleo-mcp-dev`, server `cleo-dev`, no `ct`

### 7.2 Production-path script policy

- Production installer MUST NOT reference scripts under `/dev` or `/dev/archived`.
- Existing `setup-claude-aliases` behavior is removed from CLEO installer flow and delegated to CAAMP as optional utility tooling.

### 7.3 npm bin caveat

`package.json` may expose compatibility bins (`ct`) for package installs. Channel-aware installer behavior still defines which links are created per mode, and `dev` mode excludes `ct`.

### 7.4 Contributor `npm link` caveat

- Raw `npm link` uses package `bin` mappings and can expose `cleo`/`ct` names.
- Contributors requiring strict dev isolation MUST use the channel-aware installer dev flow (`./install.sh --dev`) so `cleo-dev` / `cleo-mcp-dev` are configured.
- Diagnostics (`cleo env info` / `admin.runtime`) SHOULD warn when dev channel is invoked via `cleo` instead of `cleo-dev`.
