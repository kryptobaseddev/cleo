# Release Configuration Guide

**Version**: v0.77.3+
**Epic**: T2666 (Release System v2)
**Schema**: config.schema.json v2.10.0+

This guide covers CLEO's release configuration system for project-agnostic CI/CD integration.

## Overview

CLEO's release system uses **validation gates** to ensure quality before version releases. The system is project-agnostic and supports any testing framework, build system, or validation tooling.

### Core Concepts

- **Release Gates**: Pre-release validation commands that must pass before versioning
- **Project Detection**: Automatic framework and tooling detection via `cleo init --detect`
- **Config Inheritance**: Share release policies across projects via `extends`
- **Gate Types**: Required (blocks release) vs. optional (warnings only)

---

## Configuration Sections

### release.gates

**Path**: `config.json → release.gates`
**Type**: Array of gate objects
**Default**: `[]` (no gates)

Validation gates executed before release operations. Each gate runs a shell command that must exit with code 0 to pass.

#### Schema

```json
{
  "release": {
    "gates": [
      {
        "name": "test_suite",
        "command": "npm test",
        "required": true,
        "description": "Run full test suite before release"
      }
    ]
  }
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Unique gate identifier (snake_case or kebab-case) |
| `command` | string | ✓ | Shell command to execute (exit 0 = pass, non-zero = fail) |
| `required` | boolean | | If `true`, failure blocks release. If `false`, failure logs warning (default: `true`) |
| `description` | string | | Human-readable description of gate purpose |

#### Name Pattern

Gate names must match: `^[a-z][a-z0-9_-]*$`

**Valid**: `test_suite`, `lint-check`, `build_prod`, `security-scan`
**Invalid**: `TestSuite`, `lint check`, `1-tests`, `_private`

---

## Project Type Examples

### Node.js (npm/pnpm/yarn)

```json
{
  "release": {
    "gates": [
      {
        "name": "install_deps",
        "command": "npm ci",
        "required": true,
        "description": "Clean install dependencies"
      },
      {
        "name": "lint",
        "command": "npm run lint",
        "required": true,
        "description": "ESLint code quality checks"
      },
      {
        "name": "type_check",
        "command": "npm run type-check",
        "required": true,
        "description": "TypeScript type checking"
      },
      {
        "name": "test_unit",
        "command": "npm run test:unit",
        "required": true,
        "description": "Run unit tests"
      },
      {
        "name": "test_integration",
        "command": "npm run test:integration",
        "required": false,
        "description": "Run integration tests (warning only)"
      },
      {
        "name": "build",
        "command": "npm run build",
        "required": true,
        "description": "Production build verification"
      }
    ]
  }
}
```

**With pnpm**:
```json
{
  "release": {
    "gates": [
      {
        "name": "install_deps",
        "command": "pnpm install --frozen-lockfile",
        "required": true
      },
      {
        "name": "test",
        "command": "pnpm test",
        "required": true
      }
    ]
  }
}
```

### Python (pytest/poetry)

```json
{
  "release": {
    "gates": [
      {
        "name": "install_deps",
        "command": "poetry install --no-interaction",
        "required": true,
        "description": "Install dependencies via Poetry"
      },
      {
        "name": "lint",
        "command": "poetry run ruff check .",
        "required": true,
        "description": "Ruff linting"
      },
      {
        "name": "format_check",
        "command": "poetry run black --check .",
        "required": true,
        "description": "Black formatting check"
      },
      {
        "name": "type_check",
        "command": "poetry run mypy src/",
        "required": true,
        "description": "MyPy type checking"
      },
      {
        "name": "test",
        "command": "poetry run pytest -v --cov",
        "required": true,
        "description": "Run pytest with coverage"
      },
      {
        "name": "security",
        "command": "poetry run safety check",
        "required": false,
        "description": "Security vulnerability scan (warning only)"
      }
    ]
  }
}
```

### Go

```json
{
  "release": {
    "gates": [
      {
        "name": "format_check",
        "command": "test -z \"$(gofmt -l .)\"",
        "required": true,
        "description": "Go formatting check"
      },
      {
        "name": "lint",
        "command": "golangci-lint run",
        "required": true,
        "description": "Go linting"
      },
      {
        "name": "vet",
        "command": "go vet ./...",
        "required": true,
        "description": "Go vet analysis"
      },
      {
        "name": "test",
        "command": "go test -race -coverprofile=coverage.out ./...",
        "required": true,
        "description": "Run tests with race detector"
      },
      {
        "name": "build",
        "command": "go build -v ./...",
        "required": true,
        "description": "Verify build"
      }
    ]
  }
}
```

### Rust (Cargo)

```json
{
  "release": {
    "gates": [
      {
        "name": "format_check",
        "command": "cargo fmt --check",
        "required": true,
        "description": "Rustfmt formatting check"
      },
      {
        "name": "clippy",
        "command": "cargo clippy -- -D warnings",
        "required": true,
        "description": "Clippy linting (deny warnings)"
      },
      {
        "name": "test",
        "command": "cargo test --all-features",
        "required": true,
        "description": "Run all tests with all features"
      },
      {
        "name": "build_release",
        "command": "cargo build --release",
        "required": true,
        "description": "Release build verification"
      },
      {
        "name": "audit",
        "command": "cargo audit",
        "required": false,
        "description": "Security audit (warning only)"
      }
    ]
  }
}
```

### Bash/Shell (BATS)

```json
{
  "release": {
    "gates": [
      {
        "name": "shellcheck",
        "command": "shellcheck scripts/*.sh lib/*.sh",
        "required": true,
        "description": "ShellCheck static analysis"
      },
      {
        "name": "syntax_check",
        "command": "bash -n scripts/*.sh lib/*.sh",
        "required": true,
        "description": "Bash syntax validation"
      },
      {
        "name": "test_unit",
        "command": "bats tests/unit/*.bats",
        "required": true,
        "description": "Unit tests"
      },
      {
        "name": "test_integration",
        "command": "bats tests/integration/*.bats",
        "required": true,
        "description": "Integration tests"
      },
      {
        "name": "version_sync",
        "command": "./dev/validate-version.sh",
        "required": true,
        "description": "Verify version consistency"
      }
    ]
  }
}
```

---

## Auto-Detection with cleo init

CLEO can automatically detect your project type and configure appropriate release gates:

### Detection Command

```bash
# Preview detection results
cleo init --detect --dry-run

# Apply detected configuration
cleo init --detect
```

### Detection Logic

CLEO analyzes your project directory for:

1. **Package managers**: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`
2. **Testing frameworks**: Test directories, config files, dependencies
3. **Build tools**: Scripts, build configs, CI files
4. **Linters**: Config files for ESLint, Ruff, Clippy, etc.

### Auto-Generated Gates

When detection succeeds, CLEO generates gates based on:

| Detected | Generated Gates |
|----------|----------------|
| `package.json` + `jest` | `npm ci`, `npm test`, `npm run build` |
| `pyproject.toml` + `pytest` | `poetry install`, `poetry run pytest` |
| `Cargo.toml` | `cargo fmt --check`, `cargo clippy`, `cargo test` |
| `go.mod` | `go vet`, `go test ./...`, `go build` |
| BATS tests | `shellcheck`, `bats tests/` |

### Manual Overrides

After detection, customize in `.cleo/config.json`:

```bash
# Edit config
vim .cleo/config.json

# Validate changes
cleo config validate
```

---

## Configuration Inheritance

Share release policies across projects using `extends`:

### Global Release Policy

**File**: `~/.cleo/config.json`

```json
{
  "_meta": {
    "schemaVersion": "2.10.0"
  },
  "release": {
    "gates": [
      {
        "name": "security_check",
        "command": "npm audit --audit-level=high",
        "required": false,
        "description": "Security audit (global default)"
      }
    ]
  }
}
```

### Project Config

**File**: `.cleo/config.json`

```json
{
  "_meta": {
    "schemaVersion": "2.10.0"
  },
  "extends": "~/.cleo/config.json",
  "release": {
    "gates": [
      {
        "name": "test",
        "command": "npm test",
        "required": true
      }
    ]
  }
}
```

### Merge Behavior

- **Arrays**: Concatenate (project gates + global gates)
- **Objects**: Deep merge (last wins for primitives)
- **Resolution order**: Global → Extended configs → Project

**Result**:
```json
{
  "release": {
    "gates": [
      {
        "name": "security_check",
        "command": "npm audit --audit-level=high",
        "required": false
      },
      {
        "name": "test",
        "command": "npm test",
        "required": true
      }
    ]
  }
}
```

### Multiple Inheritance

```json
{
  "extends": [
    "~/.cleo/config.json",
    "./shared/ci-config.json",
    "@myorg/cleo-config"
  ]
}
```

**Processing**: Left-to-right, last wins for conflicts.

---

## Integration with Release Workflow

### Release Command

```bash
# Full release workflow with gate validation
cleo release ship patch
cleo release ship minor
cleo release ship major
cleo release ship 1.2.3
```

### Gate Execution

When `cleo release ship` runs:

1. **Pre-flight checks**: Validate config, check git status
2. **Gate execution**: Run each gate in order
3. **Required gate failure**: Abort release with exit code 70
4. **Optional gate failure**: Log warning, continue
5. **All gates pass**: Proceed with version bump, changelog, commit, tag

### Gate Output

```
→ Running release gates...
✓ install_deps (npm ci)
✓ lint (npm run lint)
✓ test (npm test)
⚠ security_check (npm audit) - FAILED (optional, continuing)
✓ build (npm run build)

→ All required gates passed. Proceeding with release.
```

### Exit Codes

| Code | Status | Action |
|------|--------|--------|
| 0 | All gates passed | Continue release |
| 70 | Required gate failed | Abort release |
| 71 | Gate command not found | Abort release |
| 72 | Gate timeout | Abort release |

---

## Advanced Patterns

### Conditional Gates

Use shell logic for environment-specific gates:

```json
{
  "release": {
    "gates": [
      {
        "name": "e2e_tests",
        "command": "[ \"$CI\" = \"true\" ] && npm run test:e2e || echo 'Skipping E2E (local)'",
        "required": false,
        "description": "E2E tests (CI only)"
      }
    ]
  }
}
```

### Multi-Step Gates

Combine commands with `&&`:

```json
{
  "release": {
    "gates": [
      {
        "name": "build_and_verify",
        "command": "npm run build && npm run verify-bundle",
        "required": true,
        "description": "Build and verify bundle size"
      }
    ]
  }
}
```

### Timeout Protection

Use `timeout` command:

```json
{
  "release": {
    "gates": [
      {
        "name": "slow_integration_tests",
        "command": "timeout 300 npm run test:integration",
        "required": false,
        "description": "Integration tests (5min timeout)"
      }
    ]
  }
}
```

### Custom Scripts

Reference project scripts:

```json
{
  "release": {
    "gates": [
      {
        "name": "custom_validation",
        "command": "./scripts/pre-release-checks.sh",
        "required": true,
        "description": "Custom validation script"
      }
    ]
  }
}
```

---

## Troubleshooting

### Gate Failures

**Issue**: Gate fails but should pass

```bash
# Run gate manually to debug
npm test

# Check exit code
echo $?

# Verbose output
cleo release ship patch --verbose
```

**Issue**: Gate command not found

```bash
# Verify command exists
which npm

# Check PATH
echo $PATH

# Use absolute path in gate
{
  "command": "/usr/local/bin/npm test"
}
```

### Config Validation

**Issue**: Invalid gate configuration

```bash
# Validate config against schema
cleo config validate

# Check schema version
jq '._meta.schemaVersion' .cleo/config.json

# View effective config (after inheritance)
cleo config show release
```

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid gate name` | Name doesn't match pattern | Use snake_case or kebab-case |
| `Duplicate gate name` | Same name used twice | Ensure unique names |
| `Missing required field` | Missing `name` or `command` | Add required fields |
| `Gate timeout` | Command runs too long | Add timeout or optimize command |

---

## Migration from Old Config

### v0.76.x → v0.77.0+

**Old path**: `validation.releaseGates`
**New path**: `release.gates`

**Old path**: `orchestrator.validation.customGates`
**New path**: `release.gates`

#### Migration Steps

1. **Backup config**:
```bash
cp .cleo/config.json .cleo/config.json.backup
```

2. **Update manually**:
```json
// Old (deprecated)
{
  "validation": {
    "releaseGates": [...]
  }
}

// New (v0.77.0+)
{
  "release": {
    "gates": [...]
  }
}
```

3. **Validate**:
```bash
cleo config validate
```

4. **Test**:
```bash
cleo release ship patch --dry-run
```

#### Backward Compatibility

Old paths still work but show deprecation warnings:

```
⚠ DEPRECATED: validation.releaseGates is deprecated.
  Use release.gates instead.
  See: docs/guides/release-configuration.md
```

---

## Best Practices

### 1. Required vs. Optional Gates

**Required** (`required: true`):
- Unit tests
- Type checking
- Security critical checks
- Build verification

**Optional** (`required: false`):
- Integration tests (slow)
- Security audits (may have false positives)
- Performance benchmarks
- Documentation checks

### 2. Gate Order

Order gates by:
1. **Fast failures first**: Lint before tests
2. **Dependencies**: Install before build
3. **Incremental validation**: Syntax → Lint → Type → Test

### 3. Gate Naming

Use consistent naming:
- `install_deps` not `install-dependencies`
- `test_unit` not `unit_tests`
- `build_prod` not `production-build`

### 4. Command Isolation

Ensure gates are:
- **Idempotent**: Safe to run multiple times
- **Independent**: Don't rely on side effects from other gates
- **Deterministic**: Same input → same output

### 5. Version Control

**Commit** `.cleo/config.json` to share release policy:

```bash
git add .cleo/config.json
git commit -m "chore: Configure release gates"
```

**Don't commit** temporary overrides (use environment variables).

---

## Examples by Use Case

### Minimal (Quick Iterations)

```json
{
  "release": {
    "gates": [
      {
        "name": "test",
        "command": "npm test",
        "required": true
      }
    ]
  }
}
```

### Standard (Recommended)

```json
{
  "release": {
    "gates": [
      {
        "name": "lint",
        "command": "npm run lint",
        "required": true
      },
      {
        "name": "type_check",
        "command": "npm run type-check",
        "required": true
      },
      {
        "name": "test",
        "command": "npm test",
        "required": true
      },
      {
        "name": "build",
        "command": "npm run build",
        "required": true
      }
    ]
  }
}
```

### Comprehensive (Production)

```json
{
  "release": {
    "gates": [
      {
        "name": "install_deps",
        "command": "npm ci",
        "required": true
      },
      {
        "name": "lint",
        "command": "npm run lint",
        "required": true
      },
      {
        "name": "format_check",
        "command": "npm run format:check",
        "required": true
      },
      {
        "name": "type_check",
        "command": "npm run type-check",
        "required": true
      },
      {
        "name": "test_unit",
        "command": "npm run test:unit",
        "required": true
      },
      {
        "name": "test_integration",
        "command": "npm run test:integration",
        "required": true
      },
      {
        "name": "test_e2e",
        "command": "npm run test:e2e",
        "required": false,
        "description": "E2E tests (warning only)"
      },
      {
        "name": "security_audit",
        "command": "npm audit --audit-level=high",
        "required": false
      },
      {
        "name": "build_prod",
        "command": "npm run build:prod",
        "required": true
      },
      {
        "name": "bundle_check",
        "command": "npm run analyze:bundle",
        "required": false
      },
      {
        "name": "license_check",
        "command": "npm run check:licenses",
        "required": false
      }
    ]
  }
}
```

---

## See Also

- [Config Schema Reference](/api/configuration) - Full schema documentation
- [Release Command](/commands/release) - CLI reference
- [Project Configuration](/guides/project-config) - Testing frameworks
- [CI/CD Integration](/guides/ci-cd-integration) - Automation workflows
- [T2666 Epic](https://github.com/yourusername/claude-todo/issues/2666) - Release System v2 design

---

**Created**: 2026-02-01
**Task**: T2846
**Epic**: T2666
**Schema Version**: 2.10.0
