# Configuration System Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Effective**: v0.18.0+
**Last Updated**: 2025-12-19

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines the configuration system for claude-todo, including global and project-level configuration, priority resolution, environment variable integration, and the `config` command interface.

> **Authority**: This specification is AUTHORITATIVE for configuration system behavior.
> Implementation status is tracked separately in [CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md](CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md).

---

## Executive Summary

The claude-todo configuration system provides:
- **Global Configuration**: User preferences at `~/.claude-todo/config.json`
- **Project Configuration**: Project-specific settings at `.claude/todo-config.json`
- **Priority Resolution**: Deterministic override hierarchy
- **Environment Variables**: Runtime overrides via `CLAUDE_TODO_*` variables
- **Config Command**: LLM-agent-friendly interface for reading/modifying settings

---

## Part 1: Configuration Hierarchy

### 1.1 Priority Resolution Order

Configuration values MUST be resolved in this priority order (highest to lowest):

| Priority | Source | Description |
|----------|--------|-------------|
| 1 (Highest) | CLI Flags | Command-line arguments |
| 2 | Environment Variables | `CLAUDE_TODO_*` variables |
| 3 | Project Config | `.claude/todo-config.json` |
| 4 | Global Config | `~/.claude-todo/config.json` |
| 5 (Lowest) | Defaults | Schema-defined defaults |

### 1.2 Resolution Behavior

- The system MUST check each source in priority order
- The system MUST return the first non-null value found
- The system MUST fall back to schema defaults if no value is found
- The system MUST NOT merge partial objects across sources

---

## Part 2: Global Configuration

### 2.1 Location

- Global config MUST be stored at `~/.claude-todo/config.json`
- Global config MUST be created during installation if not present
- Global config MUST use the template at `templates/global-config.template.json`

### 2.2 Scope

Global config SHOULD contain only user preferences that apply across all projects:

| Section | Purpose |
|---------|---------|
| `output` | Output formatting preferences |
| `display` | UI display preferences |
| `cli` | CLI behavior (aliases, debug) |
| `defaults` | Default values for new tasks |

Global config MUST NOT contain project-specific settings such as:
- Archive thresholds
- Validation rules
- Session configuration
- Backup settings

### 2.3 Schema

Global config MUST validate against `schemas/global-config.schema.json`.

---

## Part 3: Project Configuration

### 3.1 Location

- Project config MUST be stored at `.claude/todo-config.json`
- Project config MUST be created during `ct init` if not present
- Project config MUST use the template at `templates/config.template.json`

### 3.2 Scope

Project config MAY contain all configuration sections:

| Section | Purpose |
|---------|---------|
| `output` | Output formatting |
| `archive` | Auto-archive behavior |
| `logging` | Audit log settings |
| `session` | Session management |
| `validation` | Data validation rules |
| `defaults` | Default task values |
| `display` | Display preferences |
| `cli` | CLI settings |
| `backup` | Backup configuration |

### 3.3 Schema

Project config MUST validate against `schemas/config.schema.json`.

---

## Part 4: Environment Variables

### 4.1 Naming Convention

Environment variables MUST follow this pattern:
```
CLAUDE_TODO_{SECTION}_{KEY}
```

Where:
- `SECTION` is the config section in SCREAMING_SNAKE_CASE
- `KEY` is the config key in SCREAMING_SNAKE_CASE

### 4.2 Mapping

| Environment Variable | Config Path |
|---------------------|-------------|
| `CLAUDE_TODO_FORMAT` | `output.defaultFormat` (special case) |
| `CLAUDE_TODO_OUTPUT_DEFAULT_FORMAT` | `output.defaultFormat` |
| `CLAUDE_TODO_OUTPUT_SHOW_COLOR` | `output.showColor` |
| `CLAUDE_TODO_OUTPUT_SHOW_UNICODE` | `output.showUnicode` |
| `CLAUDE_TODO_OUTPUT_DATE_FORMAT` | `output.dateFormat` |
| `CLAUDE_TODO_ARCHIVE_ENABLED` | `archive.enabled` |
| `CLAUDE_TODO_ARCHIVE_DAYS_UNTIL_ARCHIVE` | `archive.daysUntilArchive` |
| `CLAUDE_TODO_LOGGING_ENABLED` | `logging.enabled` |
| `CLAUDE_TODO_VALIDATION_STRICT_MODE` | `validation.strictMode` |

### 4.3 Type Conversion

- Boolean values: `"true"`, `"1"`, `"yes"` → `true`; `"false"`, `"0"`, `"no"` → `false`
- Numeric values: MUST be valid integers or floats
- String values: MUST be used as-is

---

## Part 5: Config Command

### 5.1 Subcommands

The `config` command MUST support these subcommands:

| Subcommand | Purpose |
|------------|---------|
| `show [PATH]` | Display configuration value(s) |
| `get PATH` | Get single value (JSON output for scripting) |
| `set PATH VALUE` | Update a configuration value |
| `list` | List all configuration keys with values |
| `reset [SECTION]` | Reset to defaults |
| `edit` | Interactive menu editor |
| `validate` | Validate configuration against schema |

### 5.2 Flags

| Flag | Purpose |
|------|---------|
| `--global` | Target global config instead of project |
| `--format json\|text` | Output format |
| `--dry-run` | Preview changes without applying |
| `--quiet` | Suppress output (for scripting) |

### 5.3 JSON Output Format

JSON output MUST follow the standard envelope format:

```json
{
  "$schema": "https://claude-todo.dev/schemas/output.schema.json",
  "_meta": {
    "command": "config",
    "subcommand": "set",
    "timestamp": "2025-12-19T00:00:00Z"
  },
  "success": true,
  "scope": "project|global",
  "path": "output.defaultFormat",
  "value": "json",
  "previous": "text"
}
```

### 5.4 Path Notation

Configuration paths MUST use dot notation:
- `output.defaultFormat`
- `archive.daysUntilArchive`
- `cli.aliases.ls`

---

## Part 6: Interactive Editor

### 6.1 Menu Structure

The interactive editor (`config edit`) SHOULD provide:
- Main menu with numbered section choices
- Sub-menus for each configuration section
- Field-level editing with type validation
- Save/discard workflow

### 6.2 Input Validation

The editor MUST:
- Validate input types (boolean, number, string, enum)
- Validate against schema constraints
- Preview changes before saving
- Confirm before applying changes

---

## Part 7: Library Integration

### 7.1 Core Library

The library `lib/config.sh` MUST provide:

| Function | Purpose |
|----------|---------|
| `get_config_value PATH` | Get value with priority resolution |
| `set_config_value PATH VALUE` | Update config with validation |
| `get_effective_config` | Merge global + project configs |
| `resolve_env_override PATH` | Check environment override |
| `validate_config FILE` | Validate against schema |

### 7.2 Script Integration

All scripts that read configuration SHOULD:
- Source `lib/config.sh`
- Use `get_config_value()` instead of direct file reads
- Respect the priority hierarchy

---

## Part 8: Error Handling

### 8.1 Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Operation completed |
| 1 | `EXIT_GENERAL_ERROR` | Unspecified error |
| 3 | `EXIT_VALIDATION_ERROR` | Schema validation failed |
| 4 | `EXIT_NOT_FOUND` | Config path not found |

### 8.2 Error Messages

Error messages MUST include:
- The config path that failed
- The reason for failure
- Suggested remediation (when applicable)

---

## Part 9: Backward Compatibility

### 9.1 Migration

- Existing projects without config MUST use defaults
- Missing config files MUST be auto-created on first write
- Schema upgrades MUST preserve existing values

### 9.2 Deprecated Settings

Deprecated settings:
- MUST still be read for backward compatibility
- SHOULD emit deprecation warnings
- MUST be migrated to new equivalents when possible

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Defines JSON output requirements |
| [CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md](CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md) | Tracks implementation status |
| `schemas/config.schema.json` | Project config schema |
| `schemas/global-config.schema.json` | Global config schema |

---

## Appendix A: Configuration Sections Reference

### A.1 Output Section

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultFormat` | enum | `"text"` | Default output format |
| `showColor` | boolean | `true` | Enable colored output |
| `showUnicode` | boolean | `true` | Enable Unicode characters |
| `showProgressBars` | boolean | `true` | Enable progress bars |
| `dateFormat` | enum | `"iso8601"` | Date formatting style |

### A.2 Archive Section

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable auto-archiving |
| `daysUntilArchive` | integer | `7` | Days before archiving |
| `maxCompletedTasks` | integer | `100` | Max completed tasks before archive |
| `preserveRecentCount` | integer | `10` | Keep N recent completed |

### A.3 Logging Section

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable audit logging |
| `maxEntries` | integer | `1000` | Max log entries |
| `rotateOnArchive` | boolean | `true` | Rotate log during archive |

### A.4 Validation Section

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `strictMode` | boolean | `false` | Enforce strict validation |
| `warnOnIssues` | boolean | `true` | Show validation warnings |
| `autoFix` | boolean | `false` | Auto-fix validation issues |

---

## Appendix B: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-19 | Initial specification |

---

*End of Specification*
