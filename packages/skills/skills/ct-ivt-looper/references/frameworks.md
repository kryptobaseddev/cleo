# Framework Detection

The IVT loop is project-agnostic. The test framework MUST be detected from the worktree at loop start. This file is the authoritative detection table.

## Detection Priority

The detection walks these signals in order and stops at the first match:

1. `.cleo/project-context.json#testing.framework` — explicit CLEO project hint.
2. Language-specific manifest files (`package.json`, `pyproject.toml`, etc.).
3. CI workflow files (`.github/workflows/*.yml`) — last-ditch signal.
4. Fallback: `.cleo/project-context.json#testing.command` if nothing above matches, mark the framework as `other`.

A project-context hint always wins. If the hint contradicts the manifest (e.g., `testing.framework: vitest` but `package.json` shows jest), the skill respects the hint and treats the discrepancy as a non-blocking warning.

## Per-Framework Detection

### vitest

**Signal**: `package.json` has `vitest` in `devDependencies` or `vitest.config.{js,ts,mjs}` exists.

**Test command**: `pnpm vitest run` (monorepo) or `npx vitest run` (single package). Use `--reporter=json` for structured parsing.

**Edge case**: Projects with both vitest and jest installed (usually mid-migration) MUST be disambiguated by checking which config file exists. If both exist, read `.cleo/project-context.json#testing.framework` or fail with IVT-001.

### jest

**Signal**: `package.json` has `jest` in `devDependencies` or a `jest.config.{js,ts,cjs,mjs}` file, or a `jest` key in `package.json`.

**Test command**: `npx jest --json` for structured output.

**Edge case**: React Native projects sometimes use a jest preset without a top-level config. Detect via the `preset` key inside `package.json#jest`.

### mocha

**Signal**: `package.json` has `mocha` in `devDependencies` or `.mocharc.{js,json,cjs,yml}` exists.

**Test command**: `npx mocha --reporter json`.

**Edge case**: Mocha is often paired with chai/sinon; the test command stays the same. If `nyc` is present, prefer `npx nyc mocha --reporter json` to capture coverage in the same run.

### pytest

**Signal**: `pyproject.toml` has `[tool.pytest.ini_options]`, or a `pytest.ini` / `setup.cfg` with a `[tool:pytest]` section, or `pytest` appears in `requirements*.txt` or `pyproject.toml`'s test dependencies.

**Test command**: `pytest --json-report --json-report-file=/tmp/pytest.json` (requires `pytest-json-report`) or fall back to `pytest -q` and parse the summary line.

**Edge case**: Projects that use `tox` wrap pytest. Prefer `tox -e py` when a `tox.ini` is present and delegate parsing to the wrapped pytest run.

### unittest

**Signal**: No test runner in `pyproject.toml`/`requirements.txt`, but `tests/` contains files matching `test_*.py` with `unittest.TestCase` imports.

**Test command**: `python -m unittest discover -s tests -p 'test_*.py'`.

**Edge case**: unittest has no JSON reporter. The skill parses the stderr summary (`Ran N tests in T — OK` or `FAILED (errors=N)`).

### go-test

**Signal**: `go.mod` file at the repo root and at least one `*_test.go` file.

**Test command**: `go test -json ./...` for structured output.

**Edge case**: Projects that use Bazel (`BUILD.bazel`) wrap go test. Prefer `bazel test //...` when Bazel is present; fall back to `go test -json ./...` otherwise.

### cargo-test

**Signal**: `Cargo.toml` at the repo root.

**Test command**: `cargo test -- --format json -Z unstable-options` (nightly toolchain) or `cargo test --message-format json` and parse the compile + test records.

**Edge case**: Monorepo workspaces use `Cargo.toml` at the root with `[workspace]`. The test command runs all workspace members via `cargo test --workspace`. For single-crate runs, the skill MUST target the specific crate with `--package <name>`.

### rspec

**Signal**: `Gemfile` includes `rspec` or `rspec-rails`, or a `.rspec` file exists.

**Test command**: `bundle exec rspec --format json`.

**Edge case**: Rails projects may split specs across `spec/` and `spec/system/`. The default command covers both; no extra path is needed.

### phpunit

**Signal**: `composer.json` lists `phpunit/phpunit` in `require-dev`, or a `phpunit.xml` / `phpunit.xml.dist` file exists.

**Test command**: `./vendor/bin/phpunit --log-junit /tmp/phpunit.xml` (the skill parses the JUnit XML).

**Edge case**: Laravel projects use `php artisan test`, which wraps phpunit. Prefer the artisan command when `artisan` exists at the repo root.

### bats

**Signal**: `tests/` contains `*.bats` files and `bats-core` is available (`command -v bats`).

**Test command**: `bats --tap tests/` (TAP output, parseable line-by-line).

**Edge case**: BATS projects often use `tests/test_helper/bats-support/` and `bats-assert/`. No special handling is needed — the TAP output is framework-neutral.

### other

**Signal**: None of the above match, but `.cleo/project-context.json#testing.command` is populated.

**Test command**: Run the command from `testing.command` verbatim. Parse stdout + stderr and the exit code. The skill MUST NOT guess at structure — success is exit 0 and nothing else.

**Edge case**: If the command is a shell script that wraps multiple frameworks, the skill treats the wrapper as the framework and records `framework: other` in the manifest.

## Detection Failures

| Failure | Exit Code | Remediation |
|---------|-----------|-------------|
| No framework detected and no `testing.command` hint | 65 (HANDOFF_REQUIRED) | Add `.cleo/project-context.json#testing.framework` or `testing.command` |
| Two conflicting signals (e.g., jest and vitest both present) | 65 | Use the project-context hint to disambiguate |
| Framework detected but command not on PATH (`bats: command not found`) | 65 | Install the missing tool or update CI image |
| Framework detected but tests directory is empty | 65 | Add at least one test before running the loop |

Detection is diagnostic, not speculative. If the skill cannot pick exactly one framework, it exits 65 and lets the human reviewer decide.

## Monorepos

Monorepo detection follows the same table but is scoped per package. The skill reads the task's declared package (from the task metadata) and walks detection from that package's root, not the monorepo root. This prevents a `pyproject.toml` in one package from confusing the detector for a JS package next to it.
