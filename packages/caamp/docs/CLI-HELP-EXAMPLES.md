# CLI Help Examples

Use `--help` on any command to inspect flags and usage.

## Top-level

```bash
caamp --help
```

## Providers

```bash
caamp providers --help
caamp providers list --help
caamp providers detect --help
caamp providers show --help
```

### Provider capabilities

```bash
caamp providers skills-map --help
caamp providers hooks --help
caamp providers capabilities --help
```

Query skills precedence across providers:

```bash
caamp providers skills-map --human
caamp providers skills-map --provider codex --json
```

Query hook support:

```bash
caamp providers hooks --human
caamp providers hooks --event onToolComplete --json
caamp providers hooks --common
```

Full capability matrix:

```bash
caamp providers capabilities --human
caamp providers capabilities --filter spawn.supportsSubagents --json
```

## Skills

```bash
caamp skills --help
caamp skills install --help
caamp skills remove --help
caamp skills list --help
caamp skills find --help
caamp skills check --help
caamp skills update --help
caamp skills init --help
caamp skills validate --help
caamp skills audit --help
```

### Skills recommendation flow

Human mode (ranked list + CHOOSE line):

```bash
caamp skills find "docs quality" --recommend --top 3 --must-have docs --prefer markdown
# ...
# [1] @owner/skill-a ...
# [2] @owner/skill-b ...
# [3] @owner/skill-c ...
# CHOOSE: 1,2,3
```

JSON mode (LAFS envelope + recommendation payload):

```bash
caamp skills find "docs quality" --recommend --json --top 3 --details
```

Criteria flags:

```bash
--must-have <term>   # repeatable and comma-delimited
--prefer <term>      # repeatable and comma-delimited
--exclude <term>     # repeatable and comma-delimited
--select <index>     # selects ranked item by 1-based index
--details            # expanded score evidence in JSON
```

Canonical LAFS spec: https://github.com/kryptobaseddev/lafs/blob/main/lafs.md

## MCP

```bash
caamp mcp --help
caamp mcp install --help
caamp mcp remove --help
caamp mcp list --help
caamp mcp detect --help
caamp mcp cleo --help
caamp mcp cleo install --help
caamp mcp cleo update --help
caamp mcp cleo uninstall --help
caamp mcp cleo show --help
```

### CLEO MCP channel workflows

Install stable channel to one provider:

```bash
caamp mcp install cleo --channel stable --provider claude-code --json
```

Install beta channel alongside stable:

```bash
caamp mcp install cleo --channel beta --provider claude-code --json
```

Install dev channel with isolated CLEO_DIR:

```bash
caamp mcp install cleo --channel dev --provider claude-code --command ./dist/mcp/index.js --arg --stdio --env CLEO_DIR=~/.cleo-dev --json
```

Update/uninstall/show compatibility commands:

```bash
caamp mcp update cleo --channel beta --provider claude-code --json
caamp mcp uninstall cleo --channel dev --provider claude-code --json
caamp mcp show cleo --provider claude-code --json
```

Interactive human flow (bridge TUI for CLEO installs):

```bash
caamp mcp cleo install --interactive --human
```

## Instructions

```bash
caamp instructions --help
caamp instructions inject --help
caamp instructions check --help
caamp instructions update --help
```

## Config and Doctor

```bash
caamp config --help
caamp config show --help
caamp config path --help
caamp doctor --help
```

## Advanced

```bash
caamp advanced --help
caamp advanced providers --help
caamp advanced batch --help
caamp advanced conflicts --help
caamp advanced apply --help
caamp advanced instructions --help
caamp advanced configure --help
```
