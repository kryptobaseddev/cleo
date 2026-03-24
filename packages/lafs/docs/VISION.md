# LAFS Vision

**What you'll learn:** The core problem LAFS solves, why it matters for LLM agents, and how it makes building multi-service agent workflows dramatically simpler.

## The Problem

Every API, tool, and agent returns responses in a different shape. A REST endpoint wraps data in `{ data, error }`. An MCP tool returns plain objects. An A2A agent sends back its own bespoke format. The result: every LLM agent writes ad-hoc parsing and error-handling glue for every integration.

In LLM-driven systems this problem compounds. Agents chain tool calls across services. Each service speaks a different response dialect, which means:

- **Brittle parsing logic** at every integration boundary — your agent needs different code for each service
- **Inconsistent error handling** that breaks multi-step workflows — some services return HTTP errors, others return error objects, some throw exceptions
- **Context loss** between chained operations — no standard way to track state across agent turns
- **Token-heavy payloads** that waste budget on structural noise — verbose responses fill up context windows unnecessarily

## What LAFS provides for agents

LAFS is a **standard response envelope contract**. It defines the shape of what comes back — a common response language that any API, tool, or agent can speak:

- **A standard response envelope and error model** — one parser works everywhere
- **Strict JSON-default semantics** — predictable, machine-parseable responses
- **Context preservation** — track state across multi-step agent workflows
- **MVI (Minimum Viable Information) defaults** — token-efficient payloads that save context window space
- **Progressive disclosure** — request more detail only when needed
- **Conformance schemas** — validate responses programmatically, not by trial and error

### Before LAFS

Your agent handles three different response formats:

```typescript
// Service A
const resA = await fetch('/api/a');
const dataA = await resA.json();
// { data: {...}, status: "ok", meta: {...} }

// Service B (MCP tool)
const resB = await mcpClient.callTool('toolB', args);
// Plain object: { result: {...} }

// Service C (A2A agent)
const resC = await a2aClient.sendTask(task);
// { artifacts: [{ parts: [{ text: "..." }] }] }

// Different parsing for each
const resultA = dataA.data;
const resultB = resB.result;
const resultC = JSON.parse(resC.artifacts[0].parts[0].text);
```

### After LAFS

All services return LAFS envelopes:

```typescript
// Service A, B, and C all return LAFS envelopes
const envelopeA = await fetch('/api/a').then(r => r.json());
const envelopeB = await mcpClient.callTool('toolB', args).then(r => JSON.parse(r.content[0].text));
const envelopeC = await a2aClient.sendTask(task).then(r => JSON.parse(r.artifacts[0].parts[0].text));

// Same parsing logic works for all
const resultA = parseLafsResponse(envelopeA);
const resultB = parseLafsResponse(envelopeB);
const resultC = parseLafsResponse(envelopeC);
```

## Who LAFS is for

LAFS is designed for **teams building LLM-powered systems**:

- **Agent developers** who integrate multiple services and need consistent response handling
- **API designers** who want their services to be agent-friendly
- **Tool builders** creating MCP servers or A2A agents
- **Platform teams** standardizing response formats across services

If you've ever written a wrapper to normalize responses from three different services so your agent can reason over them, LAFS eliminates that wrapper.

## Design principles

1. **MVI (Minimum Viable Information)** — Responses carry only what the consumer needs by default. Less noise, fewer tokens, faster processing.

2. **Progressive disclosure** — Need more detail? Ask for it. Default responses are lean; expanded data is one parameter away.

3. **Transport agnosticism** — LAFS defines the envelope shape, not how it's delivered. HTTP, gRPC, CLI, message queues — the contract is the same.

4. **Schema-first design** — The spec is machine-verifiable. JSON Schemas define the contract; conformance is validated, not assumed.

## Boundary model

LAFS defines the response contract. Consumer projects define how they adopt it.

- The LAFS repository owns normative protocol semantics and conformance artifacts
- Consumer repositories own mappings, evidence, and local implementation profiles
- Consumer repositories MUST reference LAFS protocol docs and MUST NOT redefine protocol semantics

## Next steps

- **[Quick start](../getting-started/quickstart.md)** — Get started with LAFS in 5 minutes
- **[Positioning](POSITIONING.md)** — Where LAFS fits in the AI protocol stack
- **[Envelope basics](../getting-started/envelope-basics.md)** — Learn the envelope structure

## Complementary positioning

LAFS does not replace MCP, A2A, or any transport protocol. It complements them.

- **MCP** defines how tools are discovered and invoked. **LAFS** defines the shape of what those tools return.
- **A2A** defines how agents communicate and delegate. **LAFS** defines the response contract those agents honor.
- **REST/gRPC/CLI** define transport mechanics. **LAFS** defines the envelope that rides on any transport.

Think of it this way: MCP and A2A are the roads. LAFS is the standard shipping container that travels on them. You don't need to rebuild the road — you just need every package to fit the same container.

## Design principles

1. **MVI (Minimum Viable Information)** — Responses carry only what the consumer needs by default. Less noise, fewer tokens, faster processing.
2. **Progressive disclosure** — Need more detail? Ask for it. Default responses are lean; expanded data is one request away.
3. **Transport agnosticism** — LAFS defines the envelope shape, not how it's delivered. HTTP, gRPC, CLI, message queues — the contract is the same.
4. **Schema-first design** — The spec is machine-verifiable. JSON Schemas define the contract; conformance is validated, not assumed.

## Boundary model

LAFS defines the response contract. Consumer projects define how they adopt it.

- The LAFS repository owns normative protocol semantics and conformance artifacts.
- Consumer repositories (e.g., CAAMP) own mappings, evidence, and local implementation profiles.
- Consumer repositories MUST reference LAFS protocol docs and MUST NOT redefine protocol semantics.
