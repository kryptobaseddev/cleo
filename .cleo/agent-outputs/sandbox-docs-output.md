# Sandbox Docs Update -- Agent Output

## Summary

Updated all documentation and test scripts in `/mnt/projects/claude-todo/dev/sandbox/` to reflect the current CLEO architecture. Removed references to deprecated concepts (todo.json, install.sh, legacy BATS, JSON file manipulation) and updated to match the current SQLite-based, TypeScript, dispatch-first system with 10 canonical MCP domains.

## Files Modified

### Documentation (5 files -- complete rewrites)

| File | Lines | Changes |
|------|-------|---------|
| `README.md` | 163 | Rewrote from 413 lines. Removed todo.json, install.sh, BATS, Future Enhancements TODOs. Added deploy command, adapter-test-runner, all test runners, correct file listing. |
| `QUICKSTART.md` | 72 | Rewrote from 385 lines. Removed install.sh bootstrap, todo.json manipulation, session workarounds. Focused three-step: start, deploy, test. |
| `OVERVIEW.md` | 42 | Rewrote from 296 lines. Removed all emoji headings, learning paths, pro tips, version references. Clean file table + pointer to QUICKSTART. |
| `TESTING-GUIDE.md` | 118 | Rewrote from 555 lines. Removed install.sh, BATS, todo.json, CI/CD YAML, advanced topics. Added all 6 test runners, 12-suite breakdown, how to add tests. |
| `STATUS.md` | 30 | Rewrote from 246 lines. Removed old version (v0.80.2), TODO checklists, potential enhancements. Brief status of container, test runners, known constraints. |

### Shell Scripts (4 files -- targeted fixes)

| File | Changes |
|------|---------|
| `test-docs-examples.sh` | Fixed MCP server path (`mcp-server/dist/index.js` -> `dist/mcp/index.js`). Replaced deprecated operations: `get` -> `show`, `exists` -> `find`, `deps` -> `depends`, `lifecycle` domain -> `pipeline` domain. Removed stale doc line references from test names. |
| `test-domain-operations.sh` | Fixed MCP server path (`~/mcp-server/dist/index.js` -> `~/cleo-source/dist/mcp/index.js`). Replaced deprecated domains: `system` -> `admin`, `lifecycle` -> `pipeline`, `research` -> removed, `validate` -> `check`, `release` -> removed. Added `memory` and `admin` domain tests. Fixed deprecated operations: `exists` -> `tree`, `focus-show`/`focus-set` -> `find`/`show`, `config` -> `config.show`, `metrics` -> `stats`. Removed invalid `addPhase` param. Updated summary template. |
| `test-lifecycle-gates.sh` | Complete rewrite. Old version sourced deprecated Bash libraries (`lib/tasks/lifecycle.sh`, `lib/core/config.sh`, `lib/data/file-ops.sh`) and manipulated `todo.json` directly. New version uses CLI commands and sqlite3 queries via sandbox SSH. |
| `simple-test.sh` | No changes needed -- already uses CLI commands with no legacy references. |

### Files Not Modified (correct as-is)

- `Containerfile` -- current and accurate
- `sandbox-manager.sh` -- current and accurate (includes deploy command)
- `adapter-test-runner.sh` -- current and accurate
- `.gitignore` -- correct

## Deprecated References Removed

- `todo.json` (now `tasks.db` SQLite)
- `install.sh` (now `npm install && npm run build`)
- `./install.sh --check-deps` (no longer exists)
- Legacy BATS test framework references
- `lib/tasks/lifecycle.sh`, `lib/core/config.sh`, `lib/data/file-ops.sh` (deprecated Bash)
- `todo-log.jsonl` (now audit_log table in tasks.db)
- `mcp-server/dist/index.js` (now `dist/mcp/index.js`)
- MCP domains: `lifecycle`, `research`, `validate`, `release` (replaced by `pipeline`, `check`, `admin`, `memory`)
- MCP operations: `get` (now `show`), `exists` (removed), `deps` (now `depends`), `focus-show`/`focus-set` (removed)
- Version `0.80.2` (now CalVer 2026.x.x)
- Future enhancement TODO lists
