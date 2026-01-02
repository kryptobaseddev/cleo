# cleo roadmap

Generate a roadmap from pending epics and CHANGELOG history.

## Synopsis

```bash
cleo roadmap [OPTIONS]
```

## Description

The `roadmap` command generates a roadmap document from existing CLEO data:

- **Pending epics** from `todo.json` grouped by priority and phase
- **Release history** parsed from `CHANGELOG.md`
- **Current version** from `VERSION` file
- **Progress tracking** showing task completion per epic

## Options

| Option | Description |
|--------|-------------|
| `--format, -f FORMAT` | Output format: `text`, `json`, `markdown` (default: auto-detect) |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `-o, --output PATH` | Write output to file instead of stdout |
| `--include-history` | Include release history from CHANGELOG |
| `--upcoming-only` | Only show upcoming releases (pending epics) |
| `-h, --help` | Show help message |

## Output Formats

### Text (default for TTY)

```
ROADMAP
═══════════════════════════════════════════════════════════════════

Current Version: v0.43.2

UPCOMING
───────────────────────────────────────────────────────────────────

T982: EPIC: RCSD Python Agent Implementation
  Phase: core         Priority: critical
  Progress: [--------------------]   0% (0/10 tasks)

T542: EPIC: Smart Analyze Command v2.0
  Phase: core         Priority: high
  Progress: [############--------]  63% (7/11 tasks)
```

### JSON (default when piped)

```json
{
  "success": true,
  "currentVersion": "v0.43.2",
  "upcoming": {
    "count": 14,
    "epics": [
      {
        "id": "T982",
        "title": "EPIC: RCSD Python Agent Implementation",
        "priority": "critical",
        "phase": "core",
        "progress": {"total": 10, "done": 0, "percent": 0}
      }
    ]
  }
}
```

### Markdown

```markdown
# Roadmap

> Auto-generated from CLEO task data. Current version: v0.43.2

## Upcoming

### Critical Priority

#### T982: RCSD Python Agent Implementation

**Phase**: core | **Progress**: 0% (0/10 tasks)
```

## Examples

### View roadmap in terminal

```bash
cleo roadmap
```

### Generate ROADMAP.md file

```bash
cleo roadmap -o docs/ROADMAP.md
```

### Generate with release history

```bash
cleo roadmap --include-history -o docs/ROADMAP.md
```

### Get JSON for scripting

```bash
cleo roadmap --json | jq '.upcoming.epics[:3]'
```

### Pipe markdown to file

```bash
cleo roadmap --format markdown > ROADMAP.md
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 3 | CLEO not initialized |

## Data Sources

| Source | Data Extracted |
|--------|----------------|
| `.cleo/todo.json` | Pending epics, task progress |
| `CHANGELOG.md` | Release history (with `--include-history`) |
| `VERSION` | Current version number |

## Notes

- Epics are grouped by priority (critical → high → medium → low)
- Progress bars show child task completion percentage
- When using `-o`, format defaults to markdown unless specified
- Release history shows the 15 most recent releases

## See Also

- [phases](phases.md) - Phase management
- [analyze](analyze.md) - Task analysis and recommendations
- [dash](dash.md) - Project dashboard
