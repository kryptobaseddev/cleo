# CLEO Roadmap

This roadmap reflects current implementation reality from `docs/concepts/vision.md`, active task state, and shipped changes through `2026.3.8`.

## Current Reality

### Shipped

- BRAIN foundation in `.cleo/brain.db` with retrieval (`memory find`, `memory timeline`, `memory fetch`) and write (`memory observe`).
- NEXUS dispatch domain handler wired with 12 operations in registry and test coverage.
- SQLite-vec extension loading support and PageIndex graph table schema (`brain_page_nodes`, `brain_page_edges`).
- Shared-core architecture with MCP-first contract and CLI parity.

### In Progress

- **T5241**: BRAIN/NEXUS cognitive infrastructure completion epic (critical).
- **T5152**: Advanced search completion wave (depends complete; child tasks partially complete).
- **T5153**: Reasoning and session integration phase.
- **T5154**: Memory lifecycle and retirement phase.

### Pending Critical Gaps

- **T5145**: Full claude-mem retirement automation (hooks + injection replacement) is not complete.
- **T5158/T5159**: Embedding generation and vector similarity pipeline not complete.
- **T5161**: PageIndex traversal/query API not complete.

## Active Roadmap Tracks

### Track A - BRAIN Completion (near-term)

- Complete vector pipeline (`T5158`, `T5159`) on top of shipped sqlite-vec loading.
- Complete PageIndex query/traversal API (`T5161`) on top of shipped graph tables.
- Complete reasoning and session integration (`T5153` children).

### Track B - Retirement and Automation

- Complete native hook-based memory automation and remove runtime dependency on claude-mem plugin (`T5145`).
- Align session-start/session-end/tool-use memory capture with BRAIN-native flow.

### Track C - NEXUS Maturation

- Evolve from JSON-backed registry toward dedicated `nexus.db` target architecture.
- Expand cross-project retrieval quality and federated memory workflows.

## Verification Policy

Any roadmap item moves from planned to shipped only when:

- Implementation is merged.
- Tests pass in the canonical suite.
- Documentation is synchronized (`vision`, `README`, specs, and changelog).

No time estimates are used in roadmap reporting. Scope is tracked via task status, dependencies, and verification evidence.
