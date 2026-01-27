# skills

**Category**: maintenance
**Script**: `scripts/skills.sh`
**Agent Relevance**: medium

## Synopsis

Skill management: list, discover, validate, info, install

## Description

Manages CLEO skills including discovery, validation, and installation. Skills are protocol files that can be injected into cleo-subagent spawns for task-specific behavior.

## Usage

```bash
cleo skills <subcommand> [options]
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all registered skills |
| `discover` | Scan skills/ directory for new skills |
| `validate` | Validate skill against protocol |
| `info <skill>` | Show detailed skill information |
| `install <skill>` | Install skill to agent directory |

## Options

| Flag | Description |
|------|-------------|
| `--format json\|human` | Output format (default: json when piped) |
| `--json` | Force JSON output |
| `--human` | Force human-readable output |
| `--quiet` | Minimal output |
| `--category <cat>` | Filter by category |
| `--tier <0-3>` | Filter by tier level |
| `--global` | Use global skills directory |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 4 | Skill not found |

## Examples

### List all skills

```bash
cleo skills list
```

### List skills by category

```bash
cleo skills list --category research
```

### Discover new skills

```bash
cleo skills discover
```

### Validate a skill

```bash
cleo skills validate ct-research-agent
```

### Show skill info

```bash
cleo skills info ct-orchestrator
```

### Install skill globally

```bash
cleo skills install my-skill --global
```

## JSON Output

```json
{
  "skills": [
    {
      "name": "ct-research-agent",
      "category": "research",
      "tier": 1,
      "path": "skills/ct-research-agent",
      "valid": true
    }
  ],
  "summary": {
    "total": 10,
    "byCategory": {"research": 2, "implementation": 3},
    "byTier": {"0": 1, "1": 4, "2": 3, "3": 2}
  }
}
```

## Related Commands

- `orchestrator spawn` - Spawn subagent with skill injection
- `research` - Run research tasks (uses research skill)

## See Also

- [Skill Development Guide](../guides/skill-development.md)
- [Skill Taxonomy Spec](../specs/SKILL-TAXONOMY-SPEC.md)
