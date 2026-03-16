# CLEO Sandbox Overview

## What It Is

A Podman container running Fedora Linux with Node.js 20, sqlite3, and SSH access. Used to test CLEO in a clean, isolated environment without affecting the host system.

## Why It Exists

- Test CLEO deployment and builds on a fresh system
- Validate end-to-end workflows in isolation
- Run functional test suites against adapter, memory bridge, and MCP systems
- Reproduce bugs without risking host state

## Files

| File | Purpose |
|------|---------|
| `Containerfile` | Fedora container with Node.js 20, npm, sqlite3, git, SSH |
| `sandbox-manager.sh` | Container lifecycle: build, start, stop, destroy, ssh, exec, deploy, status, logs |
| `adapter-test-runner.sh` | 97 assertions across 12 test suites (adapters, memory bridge, MCP resources, E2E) |
| `test-runner.sh` | Basic workflow tests (init, task CRUD, sessions, multi-project, persistence) |
| `simple-test.sh` | Minimal smoke test |
| `test-docs-examples.sh` | MCP API response validation against documented examples |
| `test-domain-operations.sh` | MCP domain operation tests via JSON-RPC |
| `test-lifecycle-gates.sh` | Lifecycle gate enforcement tests |
| `README.md` | Full reference documentation |
| `QUICKSTART.md` | Three-step quick start |
| `TESTING-GUIDE.md` | Test runner details and how to add tests |
| `STATUS.md` | Current operational status |
| `.gitignore` | Excludes SSH keys |
| `ssh/` | SSH key directory (gitignored) |

## Getting Started

See [QUICKSTART.md](QUICKSTART.md) for a three-step setup: start, deploy, test.
