# CLEO Sandbox Testing Guide

## Available Test Runners

| Runner | Assertions | What It Tests |
|--------|-----------|---------------|
| `adapter-test-runner.sh` | 97 | Adapter system, memory bridge, MCP resources, contracts, shared package, E2E workflows |
| `test-runner.sh` | ~15 | Project init, task CRUD, sessions, multi-project isolation, error handling, SQLite persistence |
| `simple-test.sh` | 6 | Smoke test: create project, add tasks, list, complete |
| `test-docs-examples.sh` | 8 | MCP server JSON-RPC responses match documented API |
| `test-domain-operations.sh` | ~35 | MCP operations across tasks, session, system, orchestrate, pipeline, check domains |
| `test-lifecycle-gates.sh` | ~10 | RCASD-IVTR+C lifecycle gate enforcement modes |

## adapter-test-runner.sh (12 Suites)

The most comprehensive test runner. Requires `deploy` before running.

```bash
./sandbox-manager.sh start
./sandbox-manager.sh deploy
./adapter-test-runner.sh
```

### Suite Descriptions

| Suite | Name | Key Assertions |
|-------|------|----------------|
| 1 | Build & Version | Node.js, npm, sqlite3 installed; CLEO CalVer version; dist files exist |
| 2 | Adapter Discovery | Adapter manifests (claude-code, opencode, cursor) exist and parse; AdapterManager exports |
| 3 | Memory Bridge | Module loads; generateMemoryBridgeContent, refreshMemoryBridge, writeMemoryBridge exported |
| 4 | MCP Resources | 4 resource URIs (recent, learnings, patterns, handoff); readMemoryResource; token truncation |
| 5 | Error Catalog | ERROR_CATALOG map; getErrorDefinition; CleoError.toProblemDetails RFC 9457 shape |
| 6 | Contracts Package | packages/contracts/dist/index.js loads; barrel exports |
| 7 | Shared Package | packages/shared exports: shouldSkipTool, formatObservation, CleoCli, dispatchHookEvent |
| 8 | Session Provider | Sessions table has provider_id column; session start/end lifecycle |
| 9 | Routing Table | ROUTING_TABLE 50+ entries; getPreferredChannel works; entry shape validation |
| 10 | Legacy Cleanup | .claude-plugin/ deleted; old spawn adapters deleted; no dangling imports |
| 11 | E2E Workflow | Full task lifecycle: init, add, list, show, session start, start task, done, end session |
| 12 | Error Paths | Non-existent task, outside project, duplicate completion, invalid command |

### Running Individual Suites

```bash
./adapter-test-runner.sh build        # Suite 1 only
./adapter-test-runner.sh adapter      # Suite 2 only
./adapter-test-runner.sh e2e          # Suite 11 only
./adapter-test-runner.sh errorpaths   # Suite 12 only
```

## test-runner.sh (Basic Workflows)

Tests fundamental CLEO operations using the CLI inside the sandbox.

```bash
./test-runner.sh                  # All scenarios
./test-runner.sh workflow         # Task CRUD + sessions
./test-runner.sh persistence      # SQLite data persistence
```

### Scenarios

1. **fresh** -- Verifies `cleo` command is available and returns version
2. **workflow** -- Init project, add tasks, start session, start/complete task, end session
3. **multi** -- Create two projects, verify tasks do not leak between them
4. **errors** -- Invalid task ID, operations outside a CLEO project
5. **persistence** -- Verifies `.cleo/tasks.db` exists and contains data via `sqlite3`

## test-docs-examples.sh

Sends JSON-RPC requests to the MCP server and validates response structure. Tests system version, task find, task show, session status, task exists, dependencies, and error format.

```bash
./test-docs-examples.sh
```

## test-domain-operations.sh

Tests MCP operations across multiple domains (tasks, session, system, orchestrate, pipeline, check) via JSON-RPC, verifying that responses contain `_meta` envelopes.

```bash
./test-domain-operations.sh
```

## test-lifecycle-gates.sh

Tests the RCASD-IVTR+C lifecycle gate enforcement system. Verifies that gates block invalid transitions, allow valid ones, and respect enforcement modes (strict, advisory, off).

```bash
./test-lifecycle-gates.sh
```

## How to Add New Tests

### Adding to adapter-test-runner.sh

1. Create a new function following the pattern `test_your_suite()`.
2. Use the assertion helpers: `assert_contains`, `assert_success`, `assert_fails`, `assert_file_exists`, `assert_file_missing`.
3. Add your function to the `main()` runner and the `case` statement for individual suite selection.

Example:

```bash
test_my_feature() {
    echo -e "\n========================================="
    echo "Suite N: My Feature"
    echo "========================================="

    assert_success "Feature module loads" \
        "cd $CLEO && node -e \"import('./dist/core/my-feature.js').then(() => process.exit(0))\""

    assert_contains "Feature returns expected value" "expected" \
        "cd $CLEO && node -e \"import('./dist/core/my-feature.js').then(m => console.log(m.doThing()))\""
}
```

### Adding to test-runner.sh

1. Add a new function `test_your_scenario()`.
2. Use `run_in_sandbox "description" "command"` for assertions.
3. Add to `main()` and the `case` dispatch.

## Prerequisites

All test runners require the sandbox to be running. The comprehensive suites (`adapter-test-runner.sh`) also require `deploy`:

```bash
./sandbox-manager.sh start
./sandbox-manager.sh deploy    # Required for adapter-test-runner.sh
```
