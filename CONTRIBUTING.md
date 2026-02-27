# Contributing to CLEO

Thank you for your interest in contributing to CLEO! This guide is written for contributors of all experience levels, including those using AI coding agents (Claude Code, Cursor, etc.) to help with their contributions.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [License and Contributions](#license-and-contributions)
- [Quick Start for AI Agent Users](#quick-start-for-ai-agent-users)
- [Reporting Issues](#reporting-issues)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Code Style](#code-style)
- [Architecture Guidelines](#architecture-guidelines)
- [Getting Help](#getting-help)

## Code of Conduct

This project follows a simple code of conduct: be respectful, be constructive, and be helpful. We welcome contributors of all experience levels.

## License and Contributions

By contributing to CLEO, you agree that your contributions will be licensed under
the same license as the project:

- **Business Source License 1.1 (BSL 1.1)** during the commercial period
- Automatically converting to **Apache License 2.0** on January 26, 2029

This means:

- You grant CodLuv LLC the right to use, modify, and redistribute your contribution
  as part of CLEO
- CodLuv LLC may offer CLEO under a commercial license during the BSL period
- Your contribution will eventually be available under Apache 2.0 when the
  Change Date is reached

If you do not agree to these terms, please do not submit a contribution.

## Quick Start for AI Agent Users

Many CLEO contributors use AI coding agents to help with their work. Here's how to work effectively:

### Filing Issues with an AI Agent

1. Use the [issue templates](https://github.com/kryptobaseddev/cleo/issues/new/choose) - they have structured fields your agent can fill in
2. **Always include diagnostics** - have your agent run this command and paste the output:
   ```bash
   echo "--- CLEO Diagnostics ---" && \
   echo "CLEO version: $(cleo version 2>/dev/null || echo 'not installed')" && \
   echo "Install location: $(which cleo 2>/dev/null || echo 'not found')" && \
   echo "Bash version: ${BASH_VERSION:-unknown}" && \
   echo "jq version: $(jq --version 2>/dev/null || echo 'not installed')" && \
   echo "OS: $(uname -srm 2>/dev/null || echo 'unknown')" && \
   echo "Shell: $SHELL" && \
   echo "CLEO_HOME: ${CLEO_HOME:-not set}" && \
   echo "Initialized: $(test -f .cleo/tasks.db && echo 'yes' || echo 'no')"
   ```
3. Include the **full error output** (JSON responses, stderr, exit codes)
4. Mark the issue as agent-filed in the template dropdown

### Submitting PRs with an AI Agent

1. Make sure your agent reads `CLAUDE.md` and this file first
2. Run tests before submitting: `npm test`
3. Run type-check: `npm run build:check`
4. Fill out the PR template completely - it has a section for AI agent disclosure
5. Use conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

### What Your Agent Should Know

- CLEO is a **TypeScript/Node.js CLI and MCP server** (`src/` is canonical)
- All writes must be **atomic** (temp file -> validate -> backup -> rename)
- **Never estimate time** - use scope/complexity descriptions instead
- Error responses are **structured JSON** with exit codes
- Tests use **Vitest** (BATS remains legacy coverage)

## Reporting Issues

We use GitHub Issue templates to collect the right information. Choose the right template:

| Template | Use when... |
|----------|-------------|
| [Bug Report](https://github.com/kryptobaseddev/cleo/issues/new?template=bug_report.yml) | Something is broken or behaving unexpectedly |
| [Feature Request](https://github.com/kryptobaseddev/cleo/issues/new?template=feature_request.yml) | You want a new feature or improvement |
| [Help / Question](https://github.com/kryptobaseddev/cleo/issues/new?template=help_question.yml) | You need help using CLEO |

### What Makes a Good Bug Report

1. **Diagnostic output** - Run the diagnostic command above and paste the result
2. **Exact commands** - Copy-paste the commands you ran, in order
3. **Full error output** - Include the complete JSON error response
4. **Expected vs actual** - What you expected to happen vs what happened
5. **Minimal reproduction** - The fewest steps needed to trigger the bug

### What Makes a Good Feature Request

1. **Problem first** - Describe the problem you're solving, not just the solution
2. **Example commands** - Show how you'd use the proposed feature
3. **Alternatives tried** - What workarounds you've attempted
4. **Scope estimate** - Small (single flag) / Medium (multiple files) / Large (new subsystem)

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- **Node.js 24+**: `node -v`
- **npm**: `npm -v`
- **Git**: For version control
- **A Unix-like environment**: Linux, macOS, or WSL2

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR-USERNAME/cleo.git
   cd cleo
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/kryptobaseddev/cleo.git
   ```

## Development Setup

### Local Installation

Install for development with channel isolation (`cleo-dev`):

```bash
# Install in dev mode (canonical isolated contributor setup)
./install.sh --dev

# Verify installation
cleo-dev env info --json

# Create a test project directory
mkdir /tmp/test-project
cd /tmp/test-project
cleo-dev init
```

Important caveat:

- Raw `npm link` follows package bin mappings and may expose `cleo`/`ct`.
- Use `./install.sh --dev` when you need strict `cleo-dev`/`cleo-mcp-dev` behavior.

### Initialize Test Dependencies

```bash
# Pull BATS helper libraries
git submodule update --init --recursive
```

### Running Tests

```bash
# Run primary test suite (Vitest)
npm test

# Type-check without emit
npm run build:check

# Legacy BATS (optional, migration in progress)
./tests/run-all-tests.sh
```

### Project Structure

```
cleo/
├── src/               # TypeScript source (canonical)
│   ├── core/          # Business logic and contracts
│   ├── cli/           # CLI commands and renderers
│   ├── mcp/           # MCP gateways/domains/engine
│   ├── dispatch/      # Canonical operation routing
│   └── store/         # SQLite/data access
├── schemas/           # JSON Schema definitions
├── templates/         # Template files for new projects
├── tests/             # Test suites (Vitest primary, BATS legacy)
├── docs/              # User-facing documentation
├── .github/           # Issue templates, PR template, CI workflows
└── installer/         # Channel-aware installer
```

## Versioning

CLEO uses **Calendar Versioning (CalVer)** with the format `YYYY.MM.PATCH`:

| Segment | Meaning | Example |
|---------|---------|---------|
| `YYYY` | Calendar year | `2026` |
| `MM` | Calendar month (no zero-padding) | `2` |
| `PATCH` | Sequential patch number within the month | `6` |

Example: `2026.2.6` = 6th release in February 2026.

When a new month starts, the patch resets to `1`. Version bumps are managed via `cleo release ship <version> --bump-version` or direct `package.json` edits.

## Making Changes

### Branch Naming

Create a feature branch from `main`:

```bash
git checkout main
git pull upstream main
git checkout -b feature/your-feature-name
```

Branch naming conventions:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `test/` - Test additions or fixes
- `refactor/` - Code refactoring

### Commit Messages

Use conventional commit format:

```
<type>: <short summary>

<optional detailed description>

<optional footer>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `refactor`: Code refactoring
- `chore`: Maintenance tasks

Example:
```
feat: Add multi-label filtering to list command

Supports comma-separated labels with AND logic:
  cleo list --labels "bug,priority-high"

Closes #42
```

## Testing

### Test Requirements

- Every new feature must have tests
- Bug fixes should include regression tests
- Tests must pass before submitting PR
- Use fixtures for test data (`tests/fixtures/`)

### Writing Tests

Primary tests use Vitest (`npm test`). Legacy bash coverage still uses BATS where needed.

Vitest conventions:

- `*.test.ts` for unit tests
- `*.integration.test.ts` for integration tests
- co-located tests in `src/**/__tests__/` or under `tests/`

Legacy BATS (optional):

- `tests/unit/` - Test individual functions in isolation
- `tests/integration/` - Test command workflows end-to-end
- `tests/golden/` - Test output formatting

Naming convention: `feature-name.bats`

```bash
#!/usr/bin/env bats

setup() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR"
    # Initialize test environment
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "feature should do expected thing" {
    run cleo add "Test task"
    [ "$status" -eq 0 ]
    # Additional assertions
}
```

### Running Validation Before Submitting

```bash
# Run tests
npm test

# Type-check
npm run build:check

# Optional: legacy test suite
./tests/run-all-tests.sh
```

## Submitting a Pull Request

### Before Submitting

1. Tests pass: `npm test`
2. Type-check passes: `npm run build:check`
3. Branch is up to date with `main`
4. Commit messages follow conventions

### Creating the PR

1. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```
2. Open a Pull Request on GitHub
3. **Fill out the PR template completely** - it includes:
   - Summary of changes
   - Change type classification
   - Testing details
   - CLEO-specific checklist (atomic operations, validation, etc.)
   - AI agent disclosure

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Type-check passes (`npm run build:check`)
- [ ] Code follows style guidelines (see below)
- [ ] Documentation updated (if applicable)
- [ ] Commit messages use conventional format
- [ ] No merge conflicts with `main`
- [ ] PR template filled out completely
- [ ] Contributor agrees to BSL 1.1 license terms

### Review Process

1. Maintainers will review your PR
2. Address any feedback with new commits (don't force-push during review)
3. Once approved, a maintainer will merge

## Code Style

### TypeScript Conventions

- ESM imports/exports, strict mode enabled
- 2-space indentation
- `camelCase` for variables/functions, `PascalCase` for types
- Exported functions should have explicit return types
- Add/update Vitest coverage for behavior changes

### JSON Conventions

- Keys: `camelCase`
- Indentation: 2 spaces
- No trailing commas
- Must pass JSON Schema validation

### Key Rules

- **2 spaces** for indentation
- **Atomic writes** for all file operations (temp -> validate -> backup -> rename)
- **Error JSON** with proper exit codes for all failures
- **No time estimates** anywhere in the codebase

## Architecture Guidelines

### Core Principles

1. **Anti-Hallucination First**: All data modifications must be validated
2. **Atomic Operations**: Use temp file -> validate -> backup -> rename pattern
3. **Single Source of Truth**: SQLite (`.cleo/tasks.db`) is authoritative
4. **Immutable History**: Log entries are append-only
5. **Fail-Safe**: Always provide rollback capability

### Adding New Commands

1. Add command implementation in `src/cli/commands/`
2. Route through dispatch/core layers (MCP-first + shared core)
3. Add tests (Vitest)
4. Update command docs/help text
5. Update operation registry if needed

### Modifying Schemas

Schema changes require:
1. Update schema file in `schemas/`
2. Update version number
3. Add migration if breaking change
4. Update `schema-reference.md`
5. Test with existing data

## Getting Help

- **Built-in help**: `cleo help`, `cleo help <command>`
- **Documentation**: Check `docs/` directory
- **Issues**: [Search existing issues](https://github.com/kryptobaseddev/cleo/issues) or create a new one
- **Discussions**: Use [GitHub Discussions](https://github.com/kryptobaseddev/cleo/discussions) for questions

## Recognition

Contributors will be recognized in:
- CHANGELOG.md for their contributions
- README.md contributors section (for significant contributions)

Thank you for contributing to CLEO!
