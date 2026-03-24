# A2A Protocol Specification Documents

This directory contains reference copies of the official A2A (Agent-to-Agent) Protocol specification documents from the [A2A Project](https://github.com/a2aproject/A2A).

## Purpose

These documents are provided as internal reference for LAFS protocol development. **LAFS documentation should reference these documents rather than duplicating their content.**

## Documents

| File | Source URL | Description |
|------|------------|-------------|
| `specification.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md | Complete A2A protocol specification (Release Candidate v1.0) |
| `agent-discovery.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/topics/agent-discovery.md | Agent Card discovery mechanisms |
| `life-of-a-task.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/topics/life-of-a-task.md | Task lifecycle and state management |
| `extensions.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/topics/extensions.md | Extension system for custom capabilities |
| `streaming-and-async.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/topics/streaming-and-async.md | Streaming and async operations |
| `a2a-and-mcp.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/topics/a2a-and-mcp.md | Comparison of A2A and MCP protocols |
| `whats-new-v1.md` | https://raw.githubusercontent.com/a2aproject/A2A/main/docs/whats-new-v1.md | Changes in A2A v1.0 release |

## Version Information

- **Version:** A2A Protocol Release Candidate v1.0
- **Downloaded:** 2026-02-19
- **Upstream:** https://github.com/a2aproject/A2A

## Usage in LAFS

LAFS integrates with A2A by:

1. **Agent Discovery:** Using A2A Agent Card format at `/.well-known/agent-card.json`
2. **Task Lifecycle:** Supporting A2A task states and operations
3. **Extensions:** Implementing A2A Extensions mechanism
4. **Protocol Bindings:** Supporting JSON-RPC 2.0, HTTP+JSON, and gRPC bindings
5. **Streaming:** Supporting A2A streaming operations

## Updates

To update these documents:

```bash
cd specs/external
./update-a2a-docs.sh
```

Or manually re-download from the source URLs listed above.

## Important Notes

- These are **reference copies** for convenience
- Always check the [official A2A repository](https://github.com/a2aproject/A2A) for the latest version
- LAFS implements A2A v1.0+ specification
- Breaking changes from A2A v0.3 are documented in `whats-new-v1.md`

## License

A2A Protocol specifications are licensed under their respective license. See the upstream repository for details.
