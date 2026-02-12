# lib/ Directory Structure

Shared Bash library functions organized into semantic subdirectories.

## Directory Map

| Directory | Files | Purpose |
|-----------|-------|---------|
| `core/` | 11 | Foundation: exit codes, error handling, logging, config, paths, platform compat |
| `validation/` | 11 | Schema validation, protocol enforcement, compliance checks, doctor diagnostics |
| `session/` | 8 | Session lifecycle, context monitoring, lock detection, HITL warnings |
| `tasks/` | 17 | Task mutations, dependency graphs, hierarchy, lifecycle, phase tracking |
| `skills/` | 17 | Skill discovery/dispatch, agent registry, orchestrator, subagent injection |
| `data/` | 17 | Atomic writes, file ops, backup, cache, migration, nexus, import/export |
| `ui/` | 9 | CLI flags, command registry, injection system, changelog, MCP config |
| `metrics/` | 6 | Token estimation, metrics aggregation, A/B testing, OpenTelemetry |
| `release/` | 5 | Release lifecycle, artifacts, CI integration, provenance |
| `rcsd/` | - | RCSD pipeline stages (already hierarchical, unchanged) |

## Layer Architecture

```
Layer 0: core/exit-codes.sh, core/platform-compat.sh
Layer 1: data/atomic-write.sh, core/logging.sh, core/config.sh
Layer 2: data/file-ops.sh, validation/validation.sh, core/error-json.sh
Layer 3: Everything else (services, commands, protocols)
```

Lower layers must not depend on higher layers.

## Sourcing Convention

All library files resolve their own dependencies using `_LIB_DIR` pointing to `lib/`:

```bash
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$_LIB_DIR/core/exit-codes.sh"
source "$_LIB_DIR/data/file-ops.sh"
```

Scripts in `scripts/` use `$LIB_DIR` set relative to the script directory:

```bash
LIB_DIR="$SCRIPT_DIR/../lib"
source "$LIB_DIR/core/logging.sh"
```

## Adding New Files

1. Choose the appropriate subdirectory based on the file's primary responsibility
2. Set `_LIB_DIR` to point to `lib/` (parent), not the subdirectory
3. Source dependencies using `$_LIB_DIR/category/filename.sh`
4. Add a source guard at the top of the file
5. Update this README if adding a new subdirectory
