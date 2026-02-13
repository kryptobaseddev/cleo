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
   echo "Initialized: $(test -f .cleo/todo.json && echo 'yes' || echo 'no')"
   ```
3. Include the **full error output** (JSON responses, stderr, exit codes)
4. Mark the issue as agent-filed in the template dropdown

### Submitting PRs with an AI Agent

1. Make sure your agent reads `CLAUDE.md` and this file first
2. Run all tests before submitting: `./tests/run-all-tests.sh`
3. Run syntax checks: `bash -n scripts/*.sh lib/*.sh`
4. Fill out the PR template completely - it has a section for AI agent disclosure
5. Use conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

### What Your Agent Should Know

- CLEO is a **Bash CLI tool** - all scripts use `#!/usr/bin/env bash`
- All writes must be **atomic** (temp file -> validate -> backup -> rename)
- **Never estimate time** - use scope/complexity descriptions instead
- Error responses are **structured JSON** with exit codes
- Tests use the **BATS** framework (`tests/unit/*.bats`, `tests/integration/*.bats`)

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

- **Bash 4.0+**: `bash --version`
- **jq 1.5+**: `jq --version`
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

Install for development (uses symlinks so changes are reflected immediately):

```bash
# Install in dev mode
./install.sh --dev

# Verify installation
cleo version

# Create a test project directory
mkdir /tmp/test-project
cd /tmp/test-project
cleo init
```

### Initialize Test Dependencies

```bash
# Pull BATS helper libraries
git submodule update --init --recursive
```

### Running Tests

```bash
# Run all tests
./tests/run-all-tests.sh

# Run specific test types
bats tests/unit/*.bats           # Unit tests
bats tests/integration/*.bats    # Integration tests

# Run with verbose output
CLEO_LOG_LEVEL=debug ./tests/run-all-tests.sh
```

### Project Structure

```
cleo/
├── scripts/           # CLI command entrypoints (user-facing commands ONLY)
├── lib/               # Shared library functions
│   ├── core/          #   Foundation: exit codes, error handling, logging
│   ├── validation/    #   Schema validation, protocol enforcement
│   ├── session/       #   Session lifecycle, context monitoring
│   ├── tasks/         #   Task mutations, dependency graphs
│   ├── skills/        #   Skill discovery, agent registry
│   ├── data/          #   Atomic writes, file ops, backup, cache
│   ├── ui/            #   CLI flags, command registry
│   ├── metrics/       #   Token estimation, OpenTelemetry
│   └── release/       #   Release lifecycle, artifacts
├── schemas/           # JSON Schema definitions
├── templates/         # Template files for new projects
├── tests/             # BATS test suite
│   ├── unit/          #   Unit tests
│   ├── integration/   #   Integration tests
│   ├── golden/        #   Output format tests
│   └── fixtures/      #   Test data
├── docs/              # User-facing documentation
├── .github/           # Issue templates, PR template, CI workflows
└── mcp-server/        # MCP server for AI agent integration
```

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

Tests use the [BATS](https://github.com/bats-core/bats-core) framework. Place tests in the appropriate directory:

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
# Run all tests
./tests/run-all-tests.sh

# Validate JSON schemas
cleo --validate

# Check scripts for syntax errors
bash -n scripts/*.sh lib/*.sh
```

## Submitting a Pull Request

### Before Submitting

1. All tests pass: `./tests/run-all-tests.sh`
2. No syntax errors: `bash -n scripts/*.sh lib/*.sh`
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

- [ ] Tests pass (`./tests/run-all-tests.sh`)
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

### Shell Script Conventions

```bash
#!/usr/bin/env bash
# Use bash, not sh

# Enable strict mode
set -euo pipefail

# Constants in UPPER_SNAKE_CASE
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Functions in snake_case
my_function() {
    local arg1="$1"
    local arg2="${2:-default}"
    # Implementation
}

# Quote all variable expansions
echo "$variable"

# Use [[ ]] for conditionals (not [ ])
if [[ -f "$file" ]]; then
    # ...
fi

# Use $() for command substitution (not backticks)
result=$(command)
```

### JSON Conventions

- Keys: `camelCase`
- Indentation: 2 spaces
- No trailing commas
- Must pass JSON Schema validation

### Key Rules

- **4 spaces** for indentation (no tabs)
- **Always quote** variable expansions
- **Atomic writes** for all file operations (temp -> validate -> backup -> rename)
- **Error JSON** with proper exit codes for all failures
- **No time estimates** anywhere in the codebase

## Architecture Guidelines

### Core Principles

1. **Anti-Hallucination First**: All data modifications must be validated
2. **Atomic Operations**: Use temp file -> validate -> backup -> rename pattern
3. **Single Source of Truth**: `todo.json` is authoritative
4. **Immutable History**: Log entries are append-only
5. **Fail-Safe**: Always provide rollback capability

### Adding New Commands

1. Create script in `scripts/` following naming convention
2. Add help text with `--help` support
3. Use library functions from `lib/`
4. Add to CLI wrapper routing
5. Write tests
6. Update documentation

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
