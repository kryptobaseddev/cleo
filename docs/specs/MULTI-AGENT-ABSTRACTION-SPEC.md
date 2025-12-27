# Multi-Agent Abstraction Specification

**Version**: 1.0.0
**Status**: DRAFT
**Effective**: v1.0.0+
**Last Updated**: 2025-12-22

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines the requirements for abstracting the cleo CLI to support multiple AI coding agents. The goal is to transform a Claude Code-specific tool into an agent-agnostic CLI that works with Claude Code, Gemini CLI, Codex CLI, Kimi CLI, and future agents.

> **Implementation Status**: See [MULTI-AGENT-ABSTRACTION-IMPLEMENTATION-REPORT.md](../../claudedocs/rebrand/MULTI-AGENT-ABSTRACTION-IMPLEMENTATION-REPORT.md)

---

## Executive Summary

### Mission

Enable cleo to operate as an agent-agnostic task management CLI while maintaining full backwards compatibility with existing Claude Code installations.

### Core Principles

1. **Backwards Compatibility**: Existing installations MUST continue to work without modification
2. **Agent Agnosticism**: The CLI MUST NOT assume a specific AI agent is running
3. **Graceful Degradation**: Unknown agents MUST receive functional (if limited) support
4. **Clean Separation**: Agent-specific behavior MUST be isolated in adapter modules

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Brand Name | `cleo` | Short (4 chars), memorable, no package conflicts |
| Backwards Compat | Full support | Zero migration friction for existing users |
| Agent Detection | Env vars + heuristics | Reliable, extensible |
| Sync Protocol | Adapter pattern | Agent-specific with generic fallback |

---

## Part 1: Naming and Branding

### 1.1 Brand Identity

The rebranded CLI SHALL be named `cleo` (CLI for Ephemeral Operations).

| Aspect | Requirement |
|--------|-------------|
| CLI command | MUST be `cleo` |
| Alias | SHOULD support `ct` as shorthand |
| Package name | MUST be `cleo` (npm, brew, etc.) |
| Environment prefix | MUST be `CLEO_` |

### 1.2 Backwards Compatibility Aliases

The system MUST support legacy naming during transition:

| Legacy | New | Support Level |
|--------|-----|---------------|
| `cleo` | `cleo` | MUST work with deprecation warning |
| `ct` | `ct` | MUST continue working (no change) |
| `CLEO_*` | `CLEO_*` | MUST work with deprecation warning |

---

## Part 2: Environment Variable Abstraction

### 2.1 Variable Resolution

The system MUST resolve environment variables in priority order:

1. New variable (e.g., `CLEO_HOME`)
2. Legacy variable (e.g., `CLEO_HOME`)
3. Default value

### 2.2 Core Variables

| New Variable | Legacy Variable | Default | Purpose |
|--------------|-----------------|---------|---------|
| `CLEO_HOME` | `CLEO_HOME` | `$HOME/.cleo` | Global installation directory |
| `CLEO_VERSION` | `CLEO_VERSION` | (from VERSION file) | CLI version |
| `CLEO_DIR` | `CLEO_DIR` | `$(pwd)/.cleo` | Project data directory |
| `CLEO_DATA` | `CLAUDE_DIR` | `.cleo` | Data directory basename |
| `CLEO_FORMAT` | `CLEO_FORMAT` | `text` | Output format |
| `CLEO_DEBUG` | `CLEO_DEBUG` | `0` | Debug mode |

### 2.3 Configuration Variables

The system MUST support these optional configuration variables:

| New Variable | Legacy Variable | Type | Default |
|--------------|-----------------|------|---------|
| `CLEO_COLOR` | `CLEO_OUTPUT_SHOW_COLOR` | boolean | `1` |
| `CLEO_UNICODE` | `CLEO_OUTPUT_SHOW_UNICODE` | boolean | `1` |
| `CLEO_STRICT_MODE` | `CLEO_VALIDATION_STRICT_MODE` | boolean | `0` |
| `CLEO_ARCHIVE_ENABLED` | `CLEO_ARCHIVE_ENABLED` | boolean | `1` |
| `CLEO_LOGGING_ENABLED` | `CLEO_LOGGING_ENABLED` | boolean | `1` |

### 2.4 Deprecation Behavior

When a legacy variable is used:
- The system MUST emit a deprecation warning to stderr (once per session)
- The system MUST use the legacy value
- The system MUST NOT fail

---

## Part 3: Path Abstraction

### 3.1 Installation Paths

| Path Type | New Path | Legacy Path |
|-----------|----------|-------------|
| Global install | `~/.cleo/` | `~/.cleo/` |
| Scripts | `~/.cleo/scripts/` | `~/.cleo/scripts/` |
| Libraries | `~/.cleo/lib/` | `~/.cleo/lib/` |
| Templates | `~/.cleo/templates/` | `~/.cleo/templates/` |
| Schemas | `~/.cleo/schemas/` | `~/.cleo/schemas/` |
| Plugins | `~/.cleo/plugins/` | `~/.cleo/plugins/` |

### 3.2 Project Data Paths

| Path Type | New Path | Legacy Path |
|-----------|----------|-------------|
| Data directory | `.cleo/` | `.cleo/` |
| Todo file | `.cleo/todo.json` | `.cleo/todo.json` |
| Archive file | `.cleo/todo-archive.json` | `.cleo/todo-archive.json` |
| Log file | `.cleo/todo-log.json` | `.cleo/todo-log.json` |
| Config file | `.cleo/config.json` | `.cleo/config.json` |
| Backups | `.cleo/backups/` | `.cleo/backups/` |
| Sync state | `.cleo/sync/` | `.cleo/sync/` |

### 3.3 Path Resolution Requirements

The system MUST resolve paths as follows:

1. **Installation Path**:
   - Check `$CLEO_HOME` if set
   - Check `$CLEO_HOME` if set (with deprecation warning)
   - Check if `~/.cleo/` exists
   - Check if `~/.cleo/` exists (legacy support)
   - Default to `~/.cleo/`

2. **Project Data Path**:
   - Check if `.cleo/` exists in project root
   - Check if `.cleo/` exists in project root (legacy support)
   - Default to `.cleo/` for new projects

### 3.4 Migration Requirements

The system SHOULD provide a migration command:
- `cleo migrate` MUST detect legacy installations
- `cleo migrate --check` MUST report migration status without changes
- `cleo migrate --global` MUST migrate `~/.cleo/` to `~/.cleo/`
- `cleo migrate --project` MUST migrate `.cleo/` to `.cleo/`
- Migration MUST create backups before modifying files

---

## Part 4: Agent Detection

### 4.1 Detection Methods

The system MUST detect the running AI agent using these methods in priority order:

1. **Explicit Override**: `$CLEO_AGENT` environment variable
2. **Agent-Specific Markers**: Known environment variables per agent
3. **Process Heuristics**: Parent process name analysis
4. **Default**: `unknown`

### 4.2 Supported Agents

| Agent ID | Detection Markers | Vendor |
|----------|-------------------|--------|
| `claude` | `$CLAUDE_CODE`, `$ANTHROPIC_API_KEY` | Anthropic |
| `gemini` | `$GEMINI_CLI`, `$GOOGLE_AI_API_KEY` | Google |
| `codex` | `$CODEX_CLI`, `$OPENAI_API_KEY` | OpenAI |
| `kimi` | `$KIMI_CLI`, `$MOONSHOT_API_KEY` | Moonshot |
| `unknown` | (fallback) | N/A |

### 4.3 Agent Detection Contract

- Detection MUST complete in under 10ms
- Detection MUST NOT make network calls
- Detection MUST be deterministic within a session
- Detection result SHOULD be cached for the session duration

### 4.4 Agent-Specific Behavior

The system MAY provide agent-specific behavior for:
- Documentation file names (e.g., `CLAUDE.md`, `GEMINI.md`)
- Sync protocol adapters
- Output formatting preferences

---

## Part 5: Sync Protocol Abstraction

### 5.1 Protocol Architecture

The system MUST implement a sync adapter pattern:

```
┌─────────────────────────────────────────────────────────┐
│                    Sync Interface                        │
│  inject(tasks) → agent_format                           │
│  extract(agent_state) → tasks                           │
│  status_map(cleo_status) → agent_status                 │
└─────────────────────┬───────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │TodoWrite│   │ Gemini  │   │ Generic │
   │ Adapter │   │ Adapter │   │ Adapter │
   └─────────┘   └─────────┘   └─────────┘
```

### 5.2 Adapter Interface

Each sync adapter MUST implement:

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `inject` | cleo tasks JSON | agent-format JSON | Prepare for agent |
| `extract` | agent state JSON | cleo tasks JSON | Parse agent state |
| `status_map` | cleo status | agent status | Map status values |
| `status_unmap` | agent status | cleo status | Reverse map status |

### 5.3 TodoWrite Adapter (Claude Code)

The TodoWrite adapter MUST:
- Embed task IDs as `[T###]` prefix in content field
- Convert titles to activeForm using grammar transformation
- Map status: `pending`→`pending`, `active`→`in_progress`, `blocked`→`pending`, `done`→`completed`
- Preserve round-trip capability via ID prefix parsing

### 5.4 Generic Adapter (Fallback)

The generic adapter MUST:
- Use a simple JSON format with explicit `id` field
- Support basic status mapping
- Work without agent-specific features

### 5.5 Adapter Selection

The system MUST select adapters based on detected agent:

| Agent | Adapter | Protocol |
|-------|---------|----------|
| `claude` | TodoWrite | `todowrite` |
| `gemini` | Generic (or Gemini-specific when available) | `generic` |
| `codex` | Generic (or Codex-specific when available) | `generic` |
| `kimi` | Generic (or Kimi-specific when available) | `generic` |
| `unknown` | Generic | `generic` |

---

## Part 6: Compatibility Layer

### 6.1 Core Compatibility Module

The system MUST provide `lib/agent-compat.sh` that:
- Resolves environment variables with backwards compatibility
- Resolves paths with legacy fallback
- Detects the running agent
- Selects appropriate sync adapter

### 6.2 Script Integration

Every script MUST:
- Source `lib/agent-compat.sh` early in execution
- Use resolved variables instead of hardcoded values
- Support both new and legacy paths

### 6.3 Error Handling

When encountering legacy configurations:
- The system MUST NOT fail
- The system SHOULD emit deprecation warnings
- The system MUST continue with backwards-compatible behavior

---

## Part 7: Data Format Compatibility

### 7.1 File Format Stability

The following data formats MUST remain unchanged:
- `todo.json` schema
- `todo-archive.json` schema
- `todo-log.json` schema
- `config.json` schema (renamed to `config.json`)

### 7.2 Schema Location

Schema files MUST be available at:
- `$CLEO_HOME/schemas/` (global)
- `.cleo/schemas/` (project-local, optional)

---

## Part 8: Documentation Abstraction

### 8.1 Agent Documentation Files

The system SHOULD support agent-specific documentation injection:

| Agent | Documentation File |
|-------|-------------------|
| `claude` | `CLAUDE.md` |
| `gemini` | `GEMINI.md` |
| `codex` | `CODEX.md` |
| `kimi` | `KIMI.md` |
| `unknown` | `AGENT.md` |

### 8.2 Template Naming

| Legacy Template | New Template |
|-----------------|--------------|
| `CLAUDE-INJECTION.md` | `CLEO-INJECTION.md` |
| `CLAUDE.todo.md` | `CLEO.todo.md` |

### 8.3 Injection Behavior

The `init` command MUST:
- Detect the running agent
- Use the appropriate documentation template
- Fall back to generic template for unknown agents

---

## Part 9: Acceptance Criteria

### 9.1 Backwards Compatibility

- [ ] Existing `CLEO_*` environment variables work
- [ ] Existing `~/.cleo/` installations work
- [ ] Existing `.cleo/` project directories work
- [ ] No data loss during operation
- [ ] Deprecation warnings are emitted for legacy usage

### 9.2 Multi-Agent Support

- [ ] Agent detection returns correct agent ID
- [ ] Unknown agents receive generic adapter
- [ ] Sync protocol works for detected agent
- [ ] Documentation injection uses correct template

### 9.3 Migration

- [ ] `cleo migrate --check` reports accurate status
- [ ] `cleo migrate --global` successfully migrates installation
- [ ] `cleo migrate --project` successfully migrates project data
- [ ] Backups are created before migration
- [ ] Migration is reversible

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Defines agent-first design principles |
| [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) | Defines configuration system |
| [MULTI-AGENT-ABSTRACTION-IMPLEMENTATION-REPORT.md](../../claudedocs/rebrand/MULTI-AGENT-ABSTRACTION-IMPLEMENTATION-REPORT.md) | Tracks implementation status |

---

## Appendix A: Environment Variable Complete Mapping

| Legacy Variable | New Variable | Default |
|-----------------|--------------|---------|
| `CLEO_HOME` | `CLEO_HOME` | `$HOME/.cleo` |
| `CLEO_VERSION` | `CLEO_VERSION` | (VERSION file) |
| `CLEO_DIR` | `CLEO_DIR` | `$(pwd)/.cleo` |
| `CLAUDE_DIR` | `CLEO_DATA` | `.cleo` |
| `CLEO_FORMAT` | `CLEO_FORMAT` | `text` |
| `CLEO_DEBUG` | `CLEO_DEBUG` | `0` |
| `CLEO_OUTPUT_SHOW_COLOR` | `CLEO_COLOR` | `1` |
| `CLEO_OUTPUT_SHOW_UNICODE` | `CLEO_UNICODE` | `1` |
| `CLEO_OUTPUT_SHOW_PROGRESS_BARS` | `CLEO_PROGRESS_BARS` | `1` |
| `CLEO_OUTPUT_DEFAULT_FORMAT` | `CLEO_DEFAULT_FORMAT` | `text` |
| `CLEO_OUTPUT_DATE_FORMAT` | `CLEO_DATE_FORMAT` | `%Y-%m-%d` |
| `CLEO_ARCHIVE_ENABLED` | `CLEO_ARCHIVE_ENABLED` | `1` |
| `CLEO_ARCHIVE_DAYS_UNTIL_ARCHIVE` | `CLEO_ARCHIVE_DAYS` | `7` |
| `CLEO_ARCHIVE_MAX_COMPLETED_TASKS` | `CLEO_ARCHIVE_MAX` | `100` |
| `CLEO_VALIDATION_STRICT_MODE` | `CLEO_STRICT_MODE` | `0` |
| `CLEO_VALIDATION_REQUIRE_DESCRIPTION` | `CLEO_REQUIRE_DESCRIPTION` | `0` |
| `CLEO_VALIDATION_CHECKSUM_ENABLED` | `CLEO_CHECKSUM_ENABLED` | `1` |
| `CLEO_SESSION_WARN_ON_NO_FOCUS` | `CLEO_SESSION_WARN_NO_FOCUS` | `1` |
| `CLEO_SESSION_TIMEOUT_HOURS` | `CLEO_SESSION_TIMEOUT` | `8` |
| `CLEO_LOGGING_ENABLED` | `CLEO_LOGGING_ENABLED` | `1` |
| `CLEO_LOGGING_LEVEL` | `CLEO_LOGGING_LEVEL` | `info` |
| `CLEO_LOGGING_RETENTION_DAYS` | `CLEO_LOG_RETENTION` | `30` |

---

## Appendix B: Audit Summary

This specification is based on audit data collected from the cleo codebase:

| Pattern | Occurrences | Scope |
|---------|-------------|-------|
| `CLEO_HOME` | 214 | 40+ scripts/libs |
| `CLEO_VERSION` | 40 | 30+ scripts |
| `CLEO_DIR` | 23 | 15+ scripts |
| `CLAUDE_DIR` | 22 | 10 scripts |
| Other `CLAUDE_*` vars | ~40 | Various |
| `.cleo` paths | 150+ | 50+ files |
| `.cleo/` paths | 200+ | 60+ files |

---

## Appendix C: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| Brand name `cleo` | `agentodo`, `aitodo`, `todo-cli` | Short, memorable, no conflicts |
| Full backwards compat | Clean break, migration period | Zero friction for existing users |
| Env var resolution order | New-only, legacy-only | Graceful transition |
| Adapter pattern for sync | Monolithic, plugins | Clean separation, testable |
| Process heuristics for detection | Config-only, API calls | Works without configuration |

---

*End of Specification*
