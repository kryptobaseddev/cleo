<!-- CLEO:START v0.53.4 -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---

# CLEO (Command Line Entity Orchestrator)

**Task management designed for AI coding agents and solo developers.**

## Project Overview

**CLEO** is a specialized task management system built specifically to bridge the gap between human developers and AI coding agents. Its primary goal is to provide a structured, validated, and persistent state for AI agents, mitigating common issues like hallucination and context loss.

*   **Primary Command:** `cleo` (aliased as `ct`)
*   **Core Principles:**
    *   **Agent-First:** Defaults to JSON output for easy parsing by agents.
    *   **Validate Everything:** Every write operation is strictly validated against JSON schemas to prevent "hallucinated" or corrupt data.
    *   **Persist Everything:** Maintains immutable audit trails and session state to solve context window limits.
    *   **Atomic Operations:** Enforces a strict `temp -> validate -> backup -> rename` pattern for all file writes.
    *   **No Time Estimates:** Explicitly prohibits time-based estimation (hours/days) in favor of relative sizing (small/medium/large).

## Architecture

The project is built as a modular Bash CLI application:

*   **`scripts/`**: Contains the user-facing executable scripts for each command (e.g., `add-task.sh`, `complete-task.sh`). These are the entry points.
*   **`lib/`**: Shared library functions (foundation layer) used by scripts.
    *   `validation.sh`: JSON schema and semantic validation.
    *   `file-ops.sh`: Atomic file writing and backup logic.
    *   `logging.sh`: Audit trail logging.
    *   `version.sh`: Version resolution logic.
*   **`schemas/`**: JSON Schema definitions (`todo.schema.json`, `config.schema.json`, etc.) acting as the single source of truth for data integrity.
*   **`tests/`**: Comprehensive test suite using BATS (Bash Automated Testing System).
    *   `unit/`: Tests for individual library functions.
    *   `integration/`: End-to-end command workflow tests.
*   **`dev/`**: Development helper scripts (version bumping, benchmarking).
*   **`templates/`**: Starter templates for project initialization.

## Building and Running

Since this is a Bash-based CLI, there is no "build" step in the traditional compiled sense, but there is an installation/setup process.

### Installation
To install the tool globally (symlinked for development):
```bash
./install.sh
```

### Verification
Verify the installation and data integrity:
```bash
cleo version
cleo --validate
```

### Running Tests
The project uses BATS for testing. Ensure dependencies are met (`./install.sh --check-deps`).

Run all tests:
```bash
./tests/run-all-tests.sh
```

Run specific test suites:
```bash
./tests/test-validation.sh
bats tests/unit/file_ops.bats
```

## Development Conventions

### Agent Interaction Rules (CRITICAL)
When acting as an agent within this codebase or using this tool:
1.  **NEVER edit data files directly**: Do not modify `.cleo/*.json` files manually. ALWAYS use the CLI commands (`cleo add`, `cleo update`, etc.).
2.  **Validate State**: Before assuming the state of tasks, run `cleo list` or `cleo exists <ID>`.
3.  **Check Exit Codes**: Respect non-zero exit codes. They indicate validation failures or system errors.
4.  **No Time Estimates**: Do not accept or generate time estimates (hours/days). Use `size` (small/medium/large).

### Coding Standards (Bash)
*   **Shebang**: `#!/usr/bin/env bash`
*   **Safety**: Always use `set -euo pipefail`.
*   **Variables**: Quote all variable expansions (`"$var"`).
*   **Conditionals**: Use `[[ ... ]]` instead of `[ ... ]`.
*   **Naming**: `snake_case` for functions/variables, `UPPER_SNAKE_CASE` for constants.

### Contribution Workflow
*   **Commit Messages**: Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
*   **Branches**: Use descriptive names (`feature/my-feature`, `fix/bug-id`).
*   **Tests**: All new features must include tests.
*   **Atomic Writes**: If modifying core logic, strictly adhere to the atomic write pattern in `lib/file-ops.sh`.

## Key Files
*   `README.md`: Main entry point and documentation index.
*   `CLAUDE.md`: Specific instructions for Claude/AI agents (highly relevant for understanding intended usage).
*   `AGENTS.md`: Detailed protocol for agent behavior and error handling.
*   `CONTRIBUTING.md`: Detailed contribution guidelines.
*   `schemas/todo.schema.json`: The data model definition.
