# cleo compliance

Monitor and report compliance metrics for orchestrator and agent outputs.

**Version**: 0.63.0+

## Synopsis

```bash
cleo compliance <subcommand> [OPTIONS]
```

## Description

The `compliance` command tracks and reports on output compliance metrics across orchestrator sessions and agent work. It helps ensure agents follow established protocols and output standards.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `summary` | Aggregate compliance statistics (default) |
| `violations` | List compliance violations |
| `trend [N]` | Show compliance trend over N days (default: 7) |
| `audit <EPIC_ID>` | Check compliance for specific epic's tasks |
| `sync` | Sync project metrics to global aggregation |

## Options

| Option | Description |
|--------|-------------|
| `--days <N>` | Number of days to include in analysis |
| `--epic <ID>` | Filter to specific epic |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--quiet` | Suppress non-essential output |
| `--help` | Show help message |

## Examples

```bash
# Overall compliance summary
cleo compliance summary

# View compliance violations
cleo compliance violations

# 14-day compliance trend
cleo compliance trend 14

# Audit specific epic
cleo compliance audit T1975

# Sync metrics to global store
cleo compliance sync

# JSON output
cleo compliance summary --json
```

## Compliance Metrics

The command tracks:

- **Output Format Compliance**: JSON schema adherence
- **Required Fields**: Presence of mandatory output fields
- **Error Handling**: Proper error code usage
- **Session Protocol**: Correct session lifecycle
- **Verification Gates**: Task verification completeness

## JSON Output Structure

```json
{
  "summary": {
    "totalChecks": 500,
    "passRate": 0.95,
    "violationCount": 25
  },
  "byType": {
    "outputFormat": { "pass": 490, "fail": 10 },
    "requiredFields": { "pass": 495, "fail": 5 },
    "errorHandling": { "pass": 492, "fail": 8 }
  },
  "trend": [
    { "date": "2026-01-22", "passRate": 0.94 },
    { "date": "2026-01-21", "passRate": 0.96 }
  ]
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid arguments |
| 3 | File access error |
| 4 | Epic/task not found |

## Integration

Part of the Orchestrator Protocol. Works with:

- `cleo orchestrator` - Multi-agent coordination
- Task verification system
- Output schema validation

## Automatic Compliance Tracking (v0.63.0+)

The SubagentStop hook automatically validates compliance after each subagent:

```json
// .claude/settings.json
{
  "hooks": {
    "SubagentStop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/subagent-compliance.sh"
      }]
    }]
  }
}
```

### Programmatic Usage

```bash
source lib/compliance-check.sh

# Score subagent compliance
metrics=$(score_subagent_compliance "$task_id" "$agent_id" "$response")

# Log metrics to COMPLIANCE.jsonl
log_compliance_metrics "$metrics"

# Log violation if needed
log_violation "$epic_id" "$violation_json"
```

## Implementation

| Component | Location |
|-----------|----------|
| Main script | `scripts/compliance.sh` |
| Compliance checks | `lib/compliance-check.sh` |
| Metrics aggregation | `lib/metrics-aggregation.sh` |
| Enum definitions | `lib/metrics-enums.sh` |
| Schema | `schemas/metrics.schema.json` |
| Hook script | `.claude/hooks/subagent-compliance.sh` |

## Metrics Storage

- `claudedocs/research-outputs/COMPLIANCE.jsonl` - Per-subagent metrics
- `claudedocs/research-outputs/VIOLATIONS.jsonl` - Violation log

## See Also

- `cleo orchestrator` - Orchestrator commands
- `cleo validate` - File validation
- `cleo research` - Research manifest management
- [Orchestrator Protocol Guide](../guides/ORCHESTRATOR-PROTOCOL.md)
