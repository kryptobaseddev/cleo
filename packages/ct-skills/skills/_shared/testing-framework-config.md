# Testing Framework Configuration

CLEO supports 16 testing frameworks. Configure your project's testing setup in `.cleo/config.json`:

## Framework Examples

### Node.js with Vitest (TypeScript)
```json
{
  "validation": {
    "testing": {
      "framework": "vitest",
      "command": "vitest run",
      "directory": "tests",
      "testFilePatterns": ["**/*.test.ts"]
    }
  }
}
```

### Node.js with Jest
```json
{
  "validation": {
    "testing": {
      "framework": "jest",
      "command": "jest --passWithNoTests",
      "testFilePatterns": ["**/*.test.js", "**/*.spec.js"]
    }
  }
}
```

### Python with pytest
```json
{
  "validation": {
    "testing": {
      "framework": "pytest",
      "command": "pytest -v",
      "directory": "tests",
      "testFilePatterns": ["**/test_*.py"]
    }
  }
}
```

### Rust with Cargo
```json
{
  "validation": {
    "testing": {
      "framework": "cargo",
      "command": "cargo test"
    }
  }
}
```

### Go
```json
{
  "validation": {
    "testing": {
      "framework": "go",
      "command": "go test ./..."
    }
  }
}
```

## Supported Frameworks

| Framework | Extension | Ecosystem |
|-----------|-----------|-----------|
| bats | .bats | Bash |
| jest, vitest, playwright, cypress, mocha, ava, uvu, tap | .test.js/.ts | Node.js |
| node:test, deno, bun | .test.ts | Runtime built-ins |
| pytest | _test.py | Python |
| go | _test.go | Go |
| cargo | .rs | Rust |
| custom | varies | Any |

## Validation Gates

Enable test validation before releases:
```json
{
  "validation": {
    "testing": {
      "requirePassingTests": true,
      "runOnComplete": true
    }
  }
}
```

## Auto-Detection

Run `cleo init --detect` to automatically configure your project based on manifest files (package.json, Cargo.toml, pyproject.toml, etc.).

```bash
# Preview detection
cleo init --detect --dry-run

# Apply configuration
cleo init --detect
```

See `docs/guides/project-config.mdx` for full documentation.
