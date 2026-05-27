---
epic: T10402
stage: consensus
task: T10402
related:
  - type: saga
    id: T10402
  - type: research
    path: ../research/T10402-research.md
created: 2026-05-27
updated: 2026-05-27
---

# Consensus (T10402) — SG-COCKPIT-HARNESS

## Decisions Ratified

### D-T10402-1: Rust Crate Location
**Decision**: Cockpit lives at `crates/cockpit/` as a standalone Rust binary crate, NOT a library.

**Rationale**: The Cockpit is a separate process per envelope-first doctrine. It consumes the daemon over IPC, never in-process. A binary crate with `[[bin]]` target matches this model. It joins the existing Cargo workspace alongside `cant-core`, `lafs-core`, `cleo-conduit-core`, etc.

**Alternatives considered**:
- In-process Rust via NAPI-RS: Rejected — violates envelope-first doctrine; Cockpit MUST be crash-isolated from daemon
- Separate Cargo workspace: Rejected — adds complexity; sharing `lafs-core` and `cleo-conduit-core` types is valuable

### D-T10402-2: IPC Transport Architecture
**Decision**: Dual transport — HTTPS (via T10409 gateway) for control plane REQ/REP, ZeroMQ PUB/SUB for data plane streaming.

**Rationale**: Aligns with North Star Decision D2 (HYBRID transport). HTTPS gives us REST semantics, auth, and standard tooling. ZeroMQ gives us high-volume unidirectional streaming (worker stdout, brain pulses) without backpressure overhead.

**Alternatives considered**:
- Pure ZeroMQ: Rejected — no auth, no REST ecosystem, harder to debug
- Pure HTTPS with SSE/WS: Rejected — SSE per-connection overhead for dozens of PTY streams is prohibitive; ZeroMQ PUB/SUB is the right tool for firehose data

### D-T10402-3: Multiplexer Strategy
**Decision**: ADOPT `rmux` (github.com/helvesec/rmux) as PTY multiplexer — GATED by T10420 council review. Fallback: hand-rolled PTY + ratatui pane grid.

**Rationale**: rmux has native ratatui integration matching our stack exactly. SG-WORKTRUNK-OWN vendor pattern applies. Council gate ensures license compatibility and upstream health.

**Alternatives considered**:
- Hand-rolled exclusively: Higher risk, more code to maintain, duplicates proven OSS
- tmux/screen integration: Rejected — external dependency, no ratatui integration, wrong abstraction level

### D-T10402-4: TUI Layout Strategy
**Decision**: 4-quadrant layout as specified in Harness Arch §6. Left sidebar (HUD), Right sidebar (Pipeline), Center top (Orchestrator), Center bottom (PTY Isolation Zone). Resizable via ratatui `Constraint::Ratio`.

**Rationale**: This is the canonical layout from the Harness Architecture doc. It cleanly separates monitoring (left), task management (right), communication (center top), and execution (center bottom).

**Alternatives considered**:
- Tabbed interface: Rejected — operator needs simultaneous visibility of all surfaces
- Floating windows (Zed-style): Rejected — ratatui has no native window manager; adds unnecessary complexity

### D-T10402-5: Wave Sequencing
**Decision**: Two implementation waves:
- **Wave 1** (this decomposition): Crate scaffold, IPC client, TUI layout, all 4 panels with live daemon data, PTY isolation
- **Wave 2** (follow-up saga): Living Brain visualization (Braille Canvas + Semantic Ledger), Dream state palette shifts, advanced keybinding chord system

**Rationale**: Living Brain visualization depends on T10405 (PSYCHE) and T10406 (Four-Bus Integration) which are sequenced AFTER T10402 in the North Star (§4). Wave 1 delivers a fully functional Cockpit; Wave 2 adds the cognitive visualization layer.

### D-T10402-6: LAFS Envelope Transport Extension
**Decision**: Extend `LafsTransport` enum in `crates/lafs-core` to include `Zmq` variant for ZeroMQ data plane.

**Rationale**: The existing `Cli | Http | Grpc | Sdk` variants don't cover ZeroMQ PUB/SUB. Adding `Zmq` is a minor, backward-compatible extension that accurately reflects Cockpit's transport.

**Alternatives considered**:
- Abuse `Sdk` variant: Rejected — semantically wrong; Cockpit is not a library consumer
- Use `Http` for everything: Rejected — ZeroMQ PUB/SUB is fundamentally different from HTTP request/response

## Open Decisions (TBD by T10420 Council)

| ID | Decision | Owner |
|----|----------|-------|
| D8 | RMUX adoption confirmed/rejected | T10420 council |
| D9 | OpenCode 3-facet outcomes | T10420 council |
| D10 | T1806 Web UI placement (T10402 vs T10401 vs T10419) | T10420 council |

## Consensus Verdict

All 6 architecture decisions are ratified. Proceed to specification and decomposition. The only unknowns (RMUX approval, OpenCode findings, T1806 placement) are gated by T10420 Wave 0 competitive intel, which runs in parallel and does not block Cockpit scaffolding and IPC work.
