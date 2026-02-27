# CAAMP Handoff: CLEO Channel Integration Requirements

**Status**: handoff draft
**Owner**: CLEO -> CAAMP
**Tasks**: T4887, T4888

---

## 1. Objective

Make CLEO first-class in CAAMP by supporting one-command installation and management of CLEO MCP profiles across providers for `stable`, `beta`, and `dev` channels.

## 2. Functional Requirements

1. CAAMP SHALL support CLEO channel selection: `stable|beta|dev`.
2. CAAMP SHALL install provider MCP profiles using canonical server names:
   - `cleo` (stable)
   - `cleo-beta` (beta)
   - `cleo-dev` (dev)
3. CAAMP SHALL support non-interactive command usage for agent automation.
4. CAAMP SHALL support interactive TUI flow for human users.
5. CAAMP SHALL support update and uninstall operations per channel/profile.
6. CAAMP SHALL support side-by-side profiles (stable + beta + dev) when provider allows multiple servers.
7. CAAMP SHALL own optional Claude alias utility workflows previously considered in CLEO installer (`setup-claude-aliases`).

## 3. Command/API Contract Requirements

### Non-interactive CLI

- `caamp mcp install cleo --channel stable --provider <provider>`
- `caamp mcp install cleo --channel beta --provider <provider>`
- `caamp mcp install cleo --channel dev --provider <provider> --command <local-command>`
- `caamp mcp update cleo --channel <channel> --provider <provider>`
- `caamp mcp uninstall cleo --channel <channel> --provider <provider>`
- `caamp mcp show cleo --provider <provider>`
- `caamp alias claude setup --provider <provider> [--shell <shell>]` (optional utility)

### API

Expose equivalent operations through CAAMP API endpoints already used by provider integration flows, returning:

- target provider
- installed server name
- command and args
- env map (including optional `CLEO_DIR`)
- channel metadata
- validation status

## 4. TUI Requirements

1. Select provider(s)
2. Select CLEO channel
3. Preview resulting MCP profile diff
4. Confirm apply
5. Validate install (provider config parse + command reachability check)
6. Offer rollback if validation fails

## 5. Dev Channel Requirements

1. Dev profile MUST allow custom command path and args.
2. Dev profile SHOULD default `CLEO_DIR=~/.cleo-dev` unless user overrides.
3. Dev install MUST NOT replace stable profile unless explicitly requested.
4. Dev profile SHOULD default to command naming with `-dev` suffix where provider allows explicit naming.

## 6. Validation and UX Requirements

1. Clear status output showing installed server name and channel.
2. Explicit warnings for conflicting server names.
3. Actionable recovery steps when provider config write fails.
4. Dry-run mode for install/update/uninstall where provider supports preview.

## 7. Acceptance Criteria

1. A user can install stable CLEO MCP into a supported provider in one command.
2. A user can install beta alongside stable without collisions.
3. A contributor can install dev profile with isolated data directory.
4. TUI supports full install path and rollback.
5. API and CLI outputs are consistent for automation.
6. Optional alias utility can be executed by CAAMP without requiring CLEO installer to call dev-path scripts.
