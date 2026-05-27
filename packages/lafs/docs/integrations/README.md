# Integration Overview

**What you'll learn:** How LAFS integrates with different protocols and transport mechanisms.

## Protocol integrations

LAFS is designed to work alongside existing protocols, not replace them.

### LAFS + MCP

[MCP (Model Context Protocol)](mcp.md) defines how tools are discovered and invoked. LAFS defines the shape of tool responses.

**Use when:** Building MCP tool servers that return structured data to LLM hosts.

```
LLM Host ──► MCP Server ──► Tool ──► LAFS Envelope ──► MCP Server ──► LLM Host
```

**Key benefit:** LLM hosts can parse all tool responses with the same logic.

### LAFS + A2A

[A2A (Agent-to-Agent)](a2a.md) defines how autonomous agents communicate. LAFS standardizes the artifacts and results agents produce.

**Use when:** Building multi-agent systems where agents exchange structured data.

```
Agent A ──► A2A Protocol ──► Agent B ──► LAFS Envelope ──► Agent A
```

**Key benefit:** Agents can understand each other's responses without custom parsers.

### LAFS + REST

[REST APIs](rest.md) can wrap responses in LAFS envelopes for agent-friendly structured responses.

**Use when:** Building HTTP APIs that will be consumed by LLM agents.

```
Agent ──► HTTP Request ──► API ──► LAFS Envelope ──► Agent
```

**Key benefit:** Standard error handling and pagination across all endpoints.

## Choosing an integration

| If you are... | Use | Integration |
|---------------|-----|-------------|
| Building tools for LLMs | MCP + LAFS | [MCP Guide](mcp.md) |
| Building autonomous agents | A2A + LAFS | [A2A Guide](a2a.md) |
| Building traditional APIs | REST + LAFS | [REST Guide](rest.md) |
| Mixing protocols | Any combination | All guides |

## Common patterns

### Protocol detection

Your service can support multiple protocols:

```typescript
// Detect protocol from request
function detectProtocol(req): 'mcp' | 'a2a' | 'rest' {
  if (req.headers['mcp-version']) return 'mcp';
  if (req.headers['a2a-version']) return 'a2a';
  return 'rest';
}

// Wrap response appropriately
function wrapResponse(protocol, envelope) {
  switch (protocol) {
    case 'mcp':
      return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    case 'a2a':
      return { artifacts: [{ name: 'result', parts: [{ type: 'text', text: JSON.stringify(envelope) }] }] };
    case 'rest':
    default:
      return envelope;
  }
}
```

### Transport agnosticism

LAFS envelopes work over any transport:

- **HTTP**: Direct JSON response
- **gRPC**: Message field containing envelope JSON
- **WebSocket**: Message payload
- **stdio**: Line-delimited JSON
- **Message queue**: Message body

## Next steps

- **[MCP Integration](mcp.md)** — Build MCP tools with LAFS
- **[A2A Integration](a2a.md)** — Multi-agent communication
- **[REST Integration](rest.md)** — HTTP API integration
- **[Getting started](../getting-started.mdx)** — Get started in 5 minutes
