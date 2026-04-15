# CLEO Memory Architecture

**Version**: 2.0 | **Updated**: 2026-04-15 | **Task**: T629

## Overview

CLEO stores all persistent memory in `brain.db` — a provider-neutral SQLite database. Memory is read and written exclusively via the CLEO CLI, making it available in any LLM runtime: Claude Code, OpenCode, Pi, Cursor, or any other harness.

## Single Source of Truth

```
brain.db (SQLite, project-local: .cleo/brain.db)
├── observations      — facts, discoveries, decisions, features, changes
├── brain_decisions   — architectural decisions with rationale
├── brain_patterns    — workflow/blocker/success/failure patterns
├── brain_learnings   — lessons learned with confidence scores
└── brain_page_nodes  — PageIndex knowledge graph nodes + edges
```

All memory reads go through:
```bash
cleo memory find "query"           # FTS5 search across all tables
cleo memory fetch <id>             # Full details for specific entry
cleo memory timeline <anchor>      # Chronological context
cleo memory search-hybrid "query"  # FTS5 + vector + graph
```

All memory writes go through:
```bash
cleo memory observe "text" --title "title" --type discovery|feature|change
cleo memory decision-store --decision "..." --rationale "..."
cleo memory store --type learning --content "..." --confidence 0.85
cleo memory store --type pattern --content "..." --context "..."
```

## Provider-Neutral by Design

The `.cleo/memory-bridge.md` file is a **read-only cache** auto-generated from brain.db. It enables `@`-reference injection in providers that support it (Claude Code, OpenCode, Cursor). Generation happens automatically on:
- `cleo session end`
- `cleo complete <taskId>`
- `cleo refresh-memory` (manual)

The memory bridge is a convenience layer — it is never the source of truth. All writes go to brain.db.

### Session Startup (Any Provider)

```bash
cleo briefing                    # Surfaces last handoff, current task, memory hits
cleo memory find "topic"         # JIT context loading
cleo memory timeline <id>        # Chronological context around a specific entry
```

This pattern works identically in Claude Code, Pi, Cursor, or any other runtime.

## Legacy: Claude Code MEMORY.md Files

Prior to T629, agents stored memory as flat markdown files under `~/.claude/projects/*/memory/`. These are:

- **Claude Code-specific** — only readable when running inside Claude Code
- **Write-only by convention** — no structured retrieval, no dedup, no expiry
- **Superseded** by brain.db in v2026.4.60+

### Migration

To migrate existing MEMORY.md artifacts to brain.db:

```bash
# Dry run first (see what would be imported)
cleo memory import --dry-run

# Import from default location (~/.claude/projects/-mnt-projects-cleocode/memory)
cleo memory import

# Import from a custom directory
cleo memory import --from /path/to/memory/dir

# As JSON (for scripting)
cleo memory import --json
```

The import command:
- Skips `MEMORY.md` (the index — not a memory artifact)
- Maps frontmatter types: `feedback` → learning, `project` → observation/feature, `reference` → observation/discovery, `user` → observation/change
- Deduplicates via SHA-256 content hash (stored in `.cleo/migrate-memory-hashes.json`)
- Is safe to re-run — already-imported entries are skipped
- Never deletes source files

For batch migration across all projects, use the standalone script:
```bash
pnpm dlx tsx scripts/migrate-memory-md-to-brain.ts [--dry-run] [--dir <path>]
```

### Deprecation Timeline

| State | When |
|-------|------|
| Deprecated as writer | v2026.4.60 (T629) |
| MEMORY.md files retained as read-only legacy | Indefinitely |
| `@.cleo/memory-bridge.md` in provider configs | Retained (generated from brain.db) |
| Direct writes to MEMORY.md files | STOP — use `cleo memory observe/store/decision-store` |

## Agent Bootstrap Pattern

Recommended session start sequence for any harness:

```
1. cleo session status          (~200 tokens) — resume existing?
2. cleo briefing                (~500 tokens) — last handoff + active task + memory hits
3. cleo memory find "topic"     (~200 tokens) — JIT context for specific domain
4. cleo current                 (~100 tokens) — active task?
```

The `cleo briefing` command internally calls:
- Last handoff note from sessions
- Recent decisions (last 5)
- Active observations (last 3)
- Current task + next suggested tasks

No flat file reading required. Fully provider-neutral.

## Brain.db Architecture Reference

See `docs/architecture/erd-brain-db.md` for the full schema.

Key tables:
- `observations` — high-volume event log; FTS5 indexed
- `brain_decisions` — low-volume, high-signal architectural choices
- `brain_patterns` — recurring workflow patterns; typed (workflow/blocker/success/failure)
- `brain_learnings` — lessons learned with confidence decay (half-life: 90 days)
- `brain_page_nodes` / `brain_page_edges` — PageIndex knowledge graph

Memory quality decays over time:
```
effectiveConfidence = confidence × 0.5^(ageDays / 90)
```
Entries below 0.6 effective confidence are soft-evicted during consolidation.

## Provider Adapter Integration

Each provider adapter injects `@.cleo/memory-bridge.md` into the agent's instruction file via `INSTRUCTION_REFERENCES` in the adapter's `install.ts`. This provides a token-budget-aware snapshot at spawn time.

For real-time memory retrieval during a session, agents call `cleo memory find` directly.

ADR reference: ADR-039 (LAFS envelope), T629 (provider-agnostic memory migration).
