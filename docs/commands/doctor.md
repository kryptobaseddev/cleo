# doctor - System Health Diagnostics

**Purpose**: Comprehensive health checks for CLEO installation and projects

**Version**: 0.63.0+

---

## Usage

```bash
cleo doctor [OPTIONS]
```

## Options

| Flag | Purpose | Output |
|------|---------|--------|
| (none) | Full health check | Text report |
| `--global` | Skip project checks | Global only |
| `--fix` | Auto-repair with confirmation | Interactive |
| `--prune` | Clean orphaned projects | Removes missing |
| `--format json` | JSON output | Structured data |
| `--verbose, -v` | Detailed diagnostics | Extended info |
| `--detail` | Show all projects | Include healthy |
| `--clean-temp` | Remove temp projects | Cleanup registry |

## Progress Indicators (v0.63.0+)

When running in human format with a TTY, doctor displays progress:

```
Checking CLEO installation...
  Checking CLI installation...
  Checking CLI version...
  Checking documentation...
  Checking agent configs...
Validating project registry...
  Validating project 1/3: homeschool-base...
  Validating project 2/3: claude-todo...
  Validating project 3/3: svelte-saas-starter...

CLEO Health Check
=================
...
```

Progress writes to stderr and is cleared before final output.

## Project Display (v0.63.0+)

All registered projects now appear in the table with status indicators:

```
📋 REGISTERED PROJECTS:
PROJECT NAME         STATUS     PATH                          ISSUES
⚠ homeschool-base    warning    /mnt/projects/homeschool-base Outdated schemas: todo
✓ claude-todo        healthy    /mnt/projects/claude-todo     -
⚠ svelte-saas-starter warning   /mnt/projects/svelte-saas     Outdated schemas: todo
```

Status symbols: `✓` healthy, `⚠` warning, `✗` failed/orphaned

## Exit Codes

Graduated severity for CI/CD integration:

| Code | Severity | Meaning | Action |
|:----:|----------|---------|--------|
| 0 | OK | All checks passed | Continue |
| 50 | Warning | Minor version drift | Review |
| 51 | Issue | Fixable problems | Run --fix |
| 52 | Critical | Corrupted install | Manual repair |
| 100 | Special | No agent config (not error) | Optional setup |

## Checks Performed

### Global Checks (8)
1. **CLI installation**: `~/.cleo/` exists
2. **CLI version**: Valid semver
3. **Docs accessibility**: TODO_Task_Management.md readable
4. **Agent config exists**: Config files present
5. **Agent config version**: Version match vs CLI
6. **Agent config registry**: Registry valid
7. **@ reference resolution**: Import paths work
8. **Registered projects**: Global registry validation

### Project Registry Validation
For each registered project:
- **Path exists**: Orphan detection
- **Validation**: Runs `validate.sh` in project
- **Schema versions**: Compares with current CLI
- **Injection status**: Checks CLAUDE.md, AGENTS.md, GEMINI.md

Health status: `healthy | warning | failed | orphaned`

## Examples

```bash
# Quick health check
cleo doctor

# Check only global (skip projects)
cleo doctor --global

# Auto-repair issues
cleo doctor --fix

# Clean orphaned projects from registry
cleo doctor --prune

# CI/CD integration
cleo doctor --format json
if [[ $? -ge 52 ]]; then
  echo "Critical issues detected"
  exit 1
fi
```

## Output Structure (JSON)

```json
{
  "_meta": {...},
  "success": true,
  "severity": "ok|warning|failed",
  "summary": {
    "totalChecks": 8,
    "passed": 5,
    "warnings": 3,
    "failed": 0
  },
  "checks": [
    {
      "id": "cli_installation",
      "category": "installation",
      "status": "passed|warning|failed",
      "message": "...",
      "details": {...},
      "fix": "command to fix issue"
    }
  ],
  "projects": {
    "total": 2,
    "healthy": 1,
    "warnings": 1,
    "failed": 0,
    "orphaned": 0,
    "projects": [...]
  }
}
```

## Fix Modes

### Auto-Fixable Issues
- **Outdated agent configs**: Runs `cleo setup-agents --update`
- **Orphaned projects**: Calls `prune_registry()` from lib
- **Missing agent configs**: Runs `cleo setup-agents`

### Manual Fixes
- Corrupted installations
- Schema version mismatches (use `cleo upgrade`)
- Permission issues

## Integration

**With upgrade**:
```bash
cleo upgrade --status  # Shows agent config warnings
cleo doctor           # Detailed health report
```

**With validate**:
```bash
cleo validate         # Project-level validation
cleo doctor          # System-level validation
```

## Implementation

| Component | Location |
|-----------|----------|
| Main script | `scripts/doctor.sh` |
| Global checks | `lib/doctor-checks.sh` |
| Registry utils | `lib/project-registry.sh` |
| Output schema | `schemas/doctor-output.schema.json` |

---

**Schema**: `schemas/doctor-output.schema.json`
**Epic**: T1429
**See also**: `validate`, `upgrade`, `setup-agents`
