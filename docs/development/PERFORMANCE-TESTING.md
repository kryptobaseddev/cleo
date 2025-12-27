# Performance Testing Guide

> Benchmarking workflow for cleo CLI commands

## Overview

CLI responsiveness directly impacts LLM agent efficiency. When agents execute `cleo` commands hundreds of times per session, even small latency increases compound into significant delays. Performance benchmarking ensures the tool remains fast enough for real-time agent workflows.

**Why this matters:**
- LLM agents pay per-token costs that include waiting time
- Slow commands break the interactive feedback loop
- Performance regressions often go unnoticed until they cause problems
- Benchmarks provide objective data for optimization decisions

## Quick Start

```bash
# Run default benchmarks (100, 500, 1000, 2000 tasks)
./dev/benchmark-performance.sh

# Custom dataset sizes
./dev/benchmark-performance.sh --sizes "100 500 1000 2000"

# More runs for statistical accuracy
./dev/benchmark-performance.sh --runs 5

# JSON output for CI integration
./dev/benchmark-performance.sh --format json

# Save results to file
./dev/benchmark-performance.sh --output benchmark-results.txt
```

## Performance Targets

Targets apply to datasets with 1000+ tasks. Smaller datasets are benchmarked but not evaluated against thresholds.

| Operation | Target | Critical | Notes |
|-----------|--------|----------|-------|
| `list` | < 100ms | < 200ms | Primary filtering command, called frequently |
| `stats` | < 1000ms | < 2000ms | Aggregation command, less frequent |

**Target vs Critical:**
- **Target**: Expected performance under normal conditions
- **Critical**: Maximum acceptable latency before user experience degrades

## Running Benchmarks

### Command Options

| Option | Default | Description |
|--------|---------|-------------|
| `--sizes "N M ..."` | `"100 500 1000 2000"` | Space-separated dataset sizes to test |
| `--runs N` | `3` | Number of iterations per test (for statistical accuracy) |
| `--output FILE` | stdout | Save results to specified file |
| `-f, --format` | auto-detect | Output format: `text` or `json` |
| `--json` | - | Force JSON output |
| `--human` | - | Force human-readable text output |
| `-q, --quiet` | false | Suppress progress indicators |
| `--help` | - | Show usage information |
| `--version` | - | Show script version |

### Format Auto-Detection

The script follows LLM-Agent-First principles:
- **TTY (interactive terminal)**: Defaults to human-readable text
- **Non-TTY (piped/scripted)**: Defaults to JSON for machine parsing

Override with `--json` or `--human` flags.

### Interpreting Results

#### Text Output

```
=========================================
BENCHMARK: 1000 tasks
=========================================

Testing: list command (3 runs)
  Run 1: 45ms
  Run 2: 42ms
  Run 3: 48ms
  Result: mean=45ms min=42ms max=48ms [PASS]

Testing: stats command (3 runs)
  Run 1: 320ms
  Run 2: 315ms
  Run 3: 328ms
  Result: mean=321ms min=315ms max=328ms [PASS]

Summary for 1000 tasks:
  list:  45ms (target: <100ms for 1000+) [PASS]
  stats: 321ms (target: <1000ms for 1000+) [PASS]
```

**Key metrics:**
- **mean**: Average execution time across all runs
- **min/max**: Range showing consistency (large variance suggests environmental noise)
- **PASS/FAIL**: Comparison against target thresholds

#### JSON Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/benchmark-report.schema.json",
  "_meta": {
    "format": "json",
    "command": "benchmark-performance",
    "version": "0.19.1",
    "timestamp": "2025-12-18T12:00:00Z"
  },
  "success": true,
  "config": {
    "datasetSizes": [100, 500, 1000, 2000],
    "runsPerTest": 3,
    "targets": {
      "listMs": 100,
      "statsMs": 1000
    }
  },
  "benchmarks": [
    {
      "taskCount": 1000,
      "runs": 3,
      "list": {
        "meanMs": 45,
        "minMs": 42,
        "maxMs": 48,
        "targetMs": 100,
        "status": "PASS"
      },
      "stats": {
        "meanMs": 321,
        "minMs": 315,
        "maxMs": 328,
        "targetMs": 1000,
        "status": "PASS"
      }
    }
  ],
  "summary": {
    "totalTests": 8,
    "passed": 8,
    "failed": 0,
    "allPassed": true
  }
}
```

**JSON fields:**
- `success`: Overall pass/fail status
- `benchmarks[].list.status` / `benchmarks[].stats.status`: Per-test results
- `summary.allPassed`: Quick check for CI pass/fail

### Identifying Regressions

When a benchmark fails:

1. **Confirm the failure is real** - Run with `--runs 5` or higher to reduce noise
2. **Check for environmental factors** - Other processes, disk I/O, memory pressure
3. **Compare before/after** - Run benchmarks on the previous commit
4. **Isolate the change** - Use `git bisect` to find the regression point

```bash
# Compare current vs previous commit
git stash
./dev/benchmark-performance.sh --format json > after.json
git checkout HEAD~1
./dev/benchmark-performance.sh --format json > before.json
git checkout -
git stash pop

# Compare results
jq -s '.[0].benchmarks[2].list.meanMs, .[1].benchmarks[2].list.meanMs' before.json after.json
```

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| `0` | All benchmarks passed | Success |
| `1` | General error | Check error message |
| `2` | Invalid input | Check command syntax |
| `5` | Missing dependency | Install `jq` and `bc` |
| `21` | Benchmark failed | Performance regression detected |

## CI Integration

### GitHub Actions Example

```yaml
name: Performance Benchmarks

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: sudo apt-get install -y jq bc

      - name: Install cleo
        run: ./install.sh

      - name: Run benchmarks
        run: |
          ./dev/benchmark-performance.sh --format json --output benchmark.json

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: benchmark.json

      - name: Check for regressions
        run: |
          SUCCESS=$(jq -r '.success' benchmark.json)
          if [[ "$SUCCESS" != "true" ]]; then
            echo "Performance regression detected!"
            jq '.benchmarks[] | select(.list.status == "FAIL" or .stats.status == "FAIL")' benchmark.json
            exit 1
          fi
```

### Pre-commit Hook

Add to `.git/hooks/pre-push`:

```bash
#!/bin/bash
# Quick benchmark check before pushing

echo "Running performance benchmarks..."
if ! ./dev/benchmark-performance.sh --sizes "1000" --runs 2 --quiet; then
    echo "Performance regression detected. Push aborted."
    exit 1
fi
```

## Best Practices

### Consistent Environment

- Run on the same hardware for comparable results
- Close resource-intensive applications during benchmarks
- Use `--runs 5` or higher for accurate measurements
- Consider running benchmarks in a container for reproducibility

### Comparing Changes

Always capture baseline measurements before optimization work:

```bash
# Before changes
./dev/benchmark-performance.sh --format json --output baseline.json

# After changes
./dev/benchmark-performance.sh --format json --output optimized.json

# Compare
jq -s 'map(.benchmarks[] | {size: .taskCount, list: .list.meanMs, stats: .stats.meanMs})' \
  baseline.json optimized.json
```

### Statistical Accuracy

- **Minimum 3 runs**: Default provides basic accuracy
- **5+ runs**: Recommended for optimization comparisons
- **10+ runs**: Use when detecting small improvements (<10%)

### Dataset Size Selection

- **100 tasks**: Baseline for minimal overhead measurement
- **500 tasks**: Common small project size
- **1000 tasks**: Target threshold for performance evaluation
- **2000+ tasks**: Stress testing for large projects

## Troubleshooting

### High Variance Between Runs

Large min/max spread indicates environmental noise:

```
Result: mean=150ms min=45ms max=380ms
```

**Solutions:**
- Close background applications
- Increase run count to average out noise
- Run during low system activity
- Check for disk I/O contention

### Benchmark Takes Too Long

Dataset generation is O(n) and can be slow for large sizes:

```bash
# Skip large datasets for quick checks
./dev/benchmark-performance.sh --sizes "100 500 1000"
```

### Missing Dependencies

```
[ERROR] jq is required but not installed
```

Install required tools:

```bash
# Debian/Ubuntu
sudo apt install jq bc

# macOS
brew install jq bc

# Fedora
sudo dnf install jq bc
```

## Related Documentation

- [Architecture Overview](../architecture/ARCHITECTURE.md) - System design context
- [Testing Guide](../testing.md) - Unit and integration testing
- [CI/CD Integration](../ci-cd-integration.md) - Continuous integration setup
