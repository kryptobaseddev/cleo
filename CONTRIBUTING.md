# Contributing to CLEO

Thank you for your interest in contributing to CLEO! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Documentation](#documentation)
- [Issue Guidelines](#issue-guidelines)

## Code of Conduct

This project follows a simple code of conduct: be respectful, be constructive, and be helpful. We welcome contributors of all experience levels.

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
   git clone https://github.com/kryptobaseddev/cleo.git
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
# Install globally
./install.sh

# Verify installation
cleo version

# Create a test project directory
mkdir /tmp/test-project
cd /tmp/test-project
cleo init
```

### Running Tests

```bash
# Run all tests
./tests/run-all-tests.sh

# Run specific test suite
./tests/test-validation.sh
./tests/test-archive.sh
./tests/test-add-task.sh

# Run with verbose output
CLEO_LOG_LEVEL=debug ./tests/run-all-tests.sh
```

### Project Structure

```
cleo/
├── scripts/           # Main CLI scripts (add, complete, list, etc.)
├── lib/               # Shared library functions
│   ├── validation.sh  # Schema and semantic validation
│   ├── logging.sh     # Audit trail logging
│   ├── file-ops.sh    # Atomic file operations
│   └── grammar.sh     # Grammar transformation for TodoWrite
├── schemas/           # JSON Schema definitions
├── templates/         # Template files for new projects
├── tests/             # Test suite
│   └── fixtures/      # Test data files
├── docs/              # Documentation
└── archive/           # Development history (reference only)
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

Write clear, descriptive commit messages:

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
feat: Add export command for TodoWrite format

Implements export.sh with support for TodoWrite, JSON, and Markdown formats.
Includes grammar transformation for activeForm field generation.

Closes #42
```

## Testing

### Writing Tests

Tests go in `tests/` directory. Follow existing patterns:

```bash
#!/usr/bin/env bash
# tests/test-your-feature.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/validation.sh"

# Setup
setup_test_env() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR"
    # Initialize test environment
}

# Cleanup
cleanup_test_env() {
    cd /
    rm -rf "$TEST_DIR"
}

# Test cases
test_your_feature() {
    echo "Testing your feature..."
    # Test implementation
    if [[ some_condition ]]; then
        echo "  ✓ Test passed"
        return 0
    else
        echo "  ✗ Test failed"
        return 1
    fi
}

# Run tests
main() {
    setup_test_env
    trap cleanup_test_env EXIT

    local failures=0

    test_your_feature || ((failures++))

    echo ""
    if [[ $failures -eq 0 ]]; then
        echo "All tests passed!"
        exit 0
    else
        echo "$failures test(s) failed"
        exit 1
    fi
}

main "$@"
```

### Test Requirements

- Every new feature must have tests
- Bug fixes should include regression tests
- Tests must pass before submitting PR
- Use fixtures for test data (`tests/fixtures/`)

### Running Validation

Before submitting, validate your changes:

```bash
# Run all tests
./tests/run-all-tests.sh

# Validate JSON files
cleo validate

# Check scripts for syntax errors
bash -n scripts/*.sh lib/*.sh
```

## Submitting Changes

### Pull Request Process

1. Ensure all tests pass
2. Update documentation if needed
3. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```
4. Create a Pull Request on GitHub
5. Fill out the PR template
6. Wait for review

### PR Requirements

- [ ] Tests pass (`./tests/run-all-tests.sh`)
- [ ] Code follows style guidelines
- [ ] Documentation updated (if applicable)
- [ ] Commit messages are clear
- [ ] No merge conflicts with `main`

### Review Process

1. Maintainers will review your PR
2. Address any feedback
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
readonly DEFAULT_VALUE="something"

# Functions in snake_case
my_function() {
    local arg1="$1"
    local arg2="${2:-default}"

    # Implementation
}

# Variables in snake_case
local_variable="value"

# Quote all variable expansions
echo "$variable"
command "$arg"

# Use [[ ]] for conditionals
if [[ -f "$file" ]]; then
    # ...
fi

# Use $() instead of backticks
result=$(command)
```

### JSON Conventions

```json
{
  "camelCase": "for keys",
  "arrays": [
    "consistent indentation",
    "trailing comma NOT allowed in JSON"
  ],
  "nested": {
    "objects": "use 2-space indent"
  }
}
```

### Documentation Style

- Use Markdown for all documentation
- Include code examples where helpful
- Keep line length reasonable (~100 chars)
- Use ATX-style headers (`#`, `##`, `###`)
- Include table of contents for long documents

## Documentation

### When to Update Docs

Update documentation when you:
- Add new features
- Change existing behavior
- Add new configuration options
- Fix bugs that affect usage

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | Project overview and quick start |
| `docs/usage.md` | Comprehensive usage guide |
| `docs/configuration.md` | Configuration reference |
| `docs/schema-reference.md` | JSON schema documentation |
| `docs/troubleshooting.md` | Common issues and solutions |
| `CHANGELOG.md` | Version history |

### Adding to CHANGELOG

When your PR is merged, add an entry:

```markdown
## [Unreleased]

### Added
- New feature description (#PR-number)

### Changed
- Changed behavior description (#PR-number)

### Fixed
- Bug fix description (#PR-number)
```

## Issue Guidelines

### Reporting Bugs

Include:
1. **Description**: Clear description of the bug
2. **Steps to Reproduce**: Minimal steps to trigger the bug
3. **Expected Behavior**: What should happen
4. **Actual Behavior**: What actually happens
5. **Environment**: OS, Bash version, jq version
6. **Logs/Output**: Relevant error messages

### Feature Requests

Include:
1. **Problem**: What problem does this solve?
2. **Solution**: Proposed solution
3. **Alternatives**: Other approaches considered
4. **Use Case**: Real-world scenario

### Questions

- Check documentation first
- Search existing issues
- Use clear, specific titles

## Architecture Guidelines

### Core Principles

1. **Anti-Hallucination First**: All data modifications must be validated
2. **Atomic Operations**: Use temp file → validate → backup → rename pattern
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

- **Documentation**: Check `docs/` directory
- **Issues**: Search existing issues or create new one
- **Discussions**: Use GitHub Discussions for questions

## Recognition

Contributors will be recognized in:
- CHANGELOG.md for their contributions
- README.md contributors section (for significant contributions)

Thank you for contributing to CLEO!
