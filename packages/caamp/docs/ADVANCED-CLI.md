# Advanced CLI Wrappers (LAFS-compliant)

This document defines the CLI wrappers for CAAMP advanced orchestration APIs.

These commands consume LAFS via `@cleocode/lafs`.

- Canonical protocol: `https://github.com/kryptobaseddev/lafs/blob/main/lafs.md`
- CAAMP mapping and compliance scope: `docs/LAFS-COMPLIANCE.md`

## Command group

All wrappers are under:

```bash
caamp advanced <subcommand>
```

## Output contract

Output envelopes for advanced commands follow the canonical LAFS schema and error registry from `@cleocode/lafs`.

## Subcommands

### `advanced providers`

Filter providers by minimum tier using the same ranking logic as the advanced API.

```bash
caamp advanced providers --min-tier medium
```

Options:

- `-a, --agent <name>` repeatable provider filter
- `--all` use full provider registry instead of detected providers
- `--min-tier <tier>` one of `high`, `medium`, `low` (default `low`)
- `--details` include full provider objects

---

### `advanced batch`

Run rollback-capable batch installation for MCP servers and skills.

```bash
caamp advanced batch \
  --mcp-file ./mcp-batch.json \
  --skills-file ./skills-batch.json \
  --min-tier medium
```

Options:

- `-a, --agent <name>` repeatable provider filter
- `--all` use full provider registry instead of detected providers
- `--min-tier <tier>` one of `high`, `medium`, `low` (default `low`)
- `--mcp-file <path>` JSON array of `McpBatchOperation`
- `--skills-file <path>` JSON array of `SkillBatchOperation`
- `--project-dir <path>` project root override
- `--details` include full batch result

Input schema (`mcp-batch.json`):

```json
[
  {
    "serverName": "filesystem",
    "config": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    },
    "scope": "project"
  }
]
```

Input schema (`skills-batch.json`):

```json
[
  {
    "sourcePath": "/tmp/my-skill",
    "skillName": "my-skill",
    "isGlobal": true
  }
]
```

---

### `advanced conflicts`

Preflight MCP conflict detection before any mutation.

```bash
caamp advanced conflicts --mcp-file ./mcp-batch.json --min-tier medium
```

Options:

- `--mcp-file <path>` required, JSON array of `McpBatchOperation`
- `-a, --agent <name>` repeatable provider filter
- `--all` use full provider registry instead of detected providers
- `--min-tier <tier>` one of `high`, `medium`, `low` (default `low`)
- `--project-dir <path>` project root override
- `--details` include full conflict list

---

### `advanced apply`

Apply MCP operations with a conflict policy.

```bash
caamp advanced apply --mcp-file ./mcp-batch.json --policy skip
```

Options:

- `--mcp-file <path>` required, JSON array of `McpBatchOperation`
- `--policy <policy>` one of `fail`, `skip`, `overwrite` (default `fail`)
- `-a, --agent <name>` repeatable provider filter
- `--all` use full provider registry instead of detected providers
- `--min-tier <tier>` one of `high`, `medium`, `low` (default `low`)
- `--project-dir <path>` project root override
- `--details` include full apply result

---

### `advanced instructions`

Single-operation update for instruction files across providers, independent of JSON/YAML/TOML config differences.

```bash
caamp advanced instructions --content-file ./AGENT-BLOCK.md --scope project
```

Options:

- `-a, --agent <name>` repeatable provider filter
- `--all` use full provider registry instead of detected providers
- `--min-tier <tier>` one of `high`, `medium`, `low` (default `low`)
- `--scope <scope>` `project` or `global` (default `project`)
- `--content <text>` inline injection content
- `--content-file <path>` file-based injection content
- `--project-dir <path>` project root override
- `--details` include full file action details

---

### `advanced configure`

Configure both global and project settings for one provider in one operation.

```bash
caamp advanced configure \
  -a claude-code \
  --global-mcp-file ./global-mcp.json \
  --project-mcp-file ./project-mcp.json \
  --instruction-file ./agent-block.md
```

Options:

- `-a, --agent <name>` required provider ID or alias
- `--global-mcp-file <path>` JSON array for global MCP writes
- `--project-mcp-file <path>` JSON array for project MCP writes
- `--instruction <text>` shared instruction content for both scopes
- `--instruction-file <path>` shared instruction content file for both scopes
- `--instruction-global <text>` global-only instruction content
- `--instruction-global-file <path>` global-only instruction content file
- `--instruction-project <text>` project-only instruction content
- `--instruction-project-file <path>` project-only instruction content file
- `--project-dir <path>` project root override
- `--details` include full configure result

## Error codes

Common stable error codes used by these wrappers:

- `E_ADVANCED_PROVIDER_NOT_FOUND`
- `E_ADVANCED_NO_TARGET_PROVIDERS`
- `E_ADVANCED_VALIDATION_PRIORITY`
- `E_ADVANCED_VALIDATION_SCOPE`
- `E_ADVANCED_VALIDATION_NO_OPS`
- `E_ADVANCED_VALIDATION_MCP_ARRAY`
- `E_ADVANCED_VALIDATION_MCP_ITEM`
- `E_ADVANCED_VALIDATION_MCP_NAME`
- `E_ADVANCED_VALIDATION_MCP_CONFIG`
- `E_ADVANCED_VALIDATION_SKILL_ARRAY`
- `E_ADVANCED_VALIDATION_SKILL_ITEM`
- `E_ADVANCED_VALIDATION_SKILL_SOURCE`
- `E_ADVANCED_VALIDATION_SKILL_NAME`
- `E_ADVANCED_INPUT_JSON`
- `E_ADVANCED_INPUT_TEXT`
- `E_ADVANCED_BATCH_FAILED`
- `E_ADVANCED_CONFLICTS_BLOCKING`
- `E_ADVANCED_APPLY_WRITE_FAILED`
- `E_ADVANCED_CONFIGURE_FAILED`

## Progressive disclosure

Use default output for MVI summaries. Add `--details` only when full payloads are needed for debugging or follow-up automation.
