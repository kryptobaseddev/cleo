# ADR-001: Storage Architecture Decision (JSONL vs SQLite+Vectors)

**Task**: T4506
**Epic**: T4498
**Date**: 2026-02-14
**Status**: accepted

## Context

CLEO V2 currently uses JSON files as its storage backend (todo.json, sessions.json, config.json) with JSONL for append-only logs (MANIFEST.jsonl, todo-log.json, COMPLIANCE.jsonl). This ADR evaluates whether to migrate to SQLite (with optional vector extensions) or maintain the current approach.

## Decision Drivers

- Solo developer + AI agent workflow (not multi-user)
- File-based operations with atomic write safety
- Need for audit trails (append-only logs)
- Cross-platform compatibility (macOS, Linux, Windows)
- Zero external dependencies preferred
- Git-trackable state

## Options Evaluated

### Option A: Keep JSONL/JSON (Current)

**Strengths:**
- Zero additional dependencies
- Human-readable, git-diffable
- Works with any text editor for debugging
- Atomic write pattern already proven (temp + validate + backup + rename)
- JSONL append-only pattern is inherently safe
- Cross-platform without native module compilation
- Aligns with LLM-agent-first design (agents read/write JSON natively)

**Weaknesses:**
- Full file reads for queries (O(n) scan)
- No indexing for large task sets
- No relational queries across files
- JSONL files grow unbounded without rotation

### Option B: SQLite

**Strengths:**
- ACID transactions
- Indexed queries
- Single-file database (portable)
- Mature, battle-tested
- FTS5 for full-text search

**Weaknesses:**
- Native module dependency (better-sqlite3 or sql.js)
- Not human-readable without tooling
- Not git-diffable (binary format)
- Compilation issues on some platforms (especially Windows ARM)
- Adds ~4MB to distribution
- Breaks agent-native JSON workflow
- Migration complexity from existing installations

### Option C: SQLite with Vector Extensions (sqlite-vec / sqlite-vss)

**Strengths:**
- All SQLite benefits plus semantic search
- Could enable similarity-based task finding
- Future-proof for AI-enhanced features

**Weaknesses:**
- All SQLite weaknesses amplified
- Vector extension availability varies by platform
- Requires embedding model integration
- Significant complexity increase
- Overkill for task counts under 10,000

## Decision

**Option A: Keep JSONL/JSON.**

## Rationale

1. **Scale**: CLEO manages hundreds to low-thousands of tasks per project. JSON handles this with negligible latency (measured: 235 tests complete in 1.2s including all I/O).

2. **Agent-first**: LLM agents process JSON natively. SQLite would require serialization/deserialization layers that add complexity without benefit.

3. **Git integration**: JSON files are git-trackable, enabling version control of project state. This is a differentiating feature.

4. **Zero dependencies**: No native module compilation issues. Works on all platforms without build tooling.

5. **Debugging**: Users and agents can inspect and manually edit state files when needed.

6. **Performance ceiling**: Even at 10,000 tasks, a full JSON parse takes <50ms on modern hardware. The current codebase uses targeted queries (find, filter) that are efficient for this scale.

## Mitigations for JSON Weaknesses

- **JSONL rotation**: Implement size-based rotation for MANIFEST.jsonl and logs (archive when >1MB)
- **In-memory indexing**: Build indexes at startup if query performance becomes an issue
- **Caching**: Add optional in-memory cache with invalidation for frequently-read files
- **Archive system**: Already implemented - completed tasks move to archive, keeping active set small

## Consequences

- No migration needed for existing installations
- Performance monitoring should track file sizes and query times
- Revisit if task counts exceed 10,000 per project
- Vector search for AI features can be implemented client-side with embedding APIs

## References

- Current atomic write implementation: `src/store/atomic.ts`
- JSON storage layer: `src/store/json.ts`
- Backup system: `src/store/backup.ts`
