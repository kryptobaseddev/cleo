# CLEO CANT

**The Working Tongue of the Circle**

> Collaborative Agent Notation Tongue

---

## Canon Placement

This document is the specification for CANT, the unified agent communication protocol in the CLEO ecosystem. It sits between the [CLEO Operation Constitution](../specs/CLEO-OPERATION-CONSTITUTION.md) (which defines what operations exist) and the [NEXUS Core Aspects](./NEXUS-CORE-ASPECTS.md) (which defines the workshop vocabulary). CANT defines how agents speak those operations to each other and to the system.

### Relationship to Existing Canon

| Canon Document | What It Defines | Relationship to CANT |
|---|---|---|
| [CLEO-VISION.md](./CLEO-VISION.md) | Identity, four canonical systems, pillars | CANT serves the "Agent Communication Contract" pillar |
| [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md) | 10 domains, canonical verbs, CQRS gateways | CANT's directives map to these operations |
| [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md) | Runtime flow, package boundaries | CANT flows through this system |
| [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md) | Workshop vocabulary (Thread, Loom, Conduit) | CANT is spoken over the Conduit relay path |
| [CLEO-MANIFESTO.md](./CLEO-MANIFESTO.md) | Mythic identity, the Circle | CANT is the language the Circle speaks when building together |

### Where LAFS Fits

LAFS (LLM-Agent-First Schema) is the response protocol. It defines how the system answers. CANT absorbs LAFS as its **response syntax** and adds the missing half: the **conversation syntax** that defines how agents speak.

```
CANT (Collaborative Agent Notation Tongue)
    ├── Conversation Syntax   ← NEW: directives, addressing, references
    └── Response Syntax       ← LAFS: envelopes, MVI, errors, pagination
```

LAFS is not replaced. `@cleocode/lafs` continues to exist as the response format package. CANT is the umbrella protocol that encompasses both directions of communication.

---

## The Problem CANT Solves

Nine agents coordinate across five projects using prose messages in a chat system. Their communication has naturally evolved a structured pattern:

```
/done @all T1234 #shipped

## Phase A.5 SHIPPED

Conduit types in Rust, taskRefs extraction...
```

This message contains four structured elements that emerged organically but have no formal specification:

1. A **directive** (`/done`) — declaring intent
2. An **address** (`@all`) — targeting recipients
3. A **task reference** (`T1234`) — linking to CLEO state
4. A **tag** (`#shipped`) — classifying the message
5. A **discretion condition** (`**...**`) — AI-evaluated conditional logic
6. An **execution block** (`parallel:`, `session:`) — structured subagent concurrency
7. An **approval token** (`/approve {token}`) — Human-in-the-loop checkpoint resumption

SignalDock already extracts these from message content (Phase A.5 shipped directive and taskRef extraction into `ConduitMessage.metadata`). But there is no grammar. No validation. No canonical mapping from directive to CLEO operation. Agents invented the syntax; now the system must learn to read it reliably.

CANT is that formalization.

---

## The Five Layers of CLEO Communication

CANT is one layer in a clean five-layer stack. Each layer has a distinct responsibility and a name grounded in canon.

```
  CANT          what agents say (conversation + response protocol)
    |
  Conduit       how messages move (transport relay)
    |
  Dispatch      where operations route (10 domains, CQRS gateways)
    |
  LOOM          what stage work is in (RCASD-IVTR+C lifecycle)
    |
  Hooks/CAAMP   when events fire (16 provider + 15 domain events)
```

CANT does not replace any other layer. Conduit is the relay path. Dispatch is the router.
LOOM is the lifecycle. Hooks are the event system. CANT is the language.

> **Domain Events (2026-03-27)**: CAAMP has been extended beyond the original 16 provider
> events with 15 CLEO domain events covering task, memory, pipeline, and session operations.
> Both provider and domain events use the same `on Event:` syntax in CANT. See
> [CANT-EXECUTION-SEMANTICS.md](../specs/CANT-EXECUTION-SEMANTICS.md) Sections 9-12 for
> the Generic Domain Event Protocol and [CANT-DSL-SPEC.md](../specs/CANT-DSL-SPEC.md)
> Section 5 for the complete event table.

---

## Part 1: Conversation Syntax

The conversation syntax defines how agents construct messages that carry structured intent. Every CANT message is valid natural language first and structured data second. An agent that does not understand CANT can still read the message. An agent that does understand CANT can extract precise machine-actionable elements.

### 1.1 Directives

A directive is a verb at the start of a message line, prefixed with `/`. Directives declare the sender's intent.

```
directive := "/" VERB
```

#### Canonical Directives

| Directive | Intent | Maps to CQRS | Gateway |
|-----------|--------|--------------|---------|
| `/claim` | "I am taking ownership of this work" | `orchestrate.claim` | mutate |
| `/done` | "I have completed this work" | `tasks.complete` | mutate |
| `/blocked` | "I cannot proceed" | `orchestrate.escalate` | mutate |
| `/approve` | "Resuming workflow checkpoint" | `orchestrate.resume` | mutate |
| `/action` | "This requires someone to act" | *(routing — no direct op)* | — |
| `/review` | "This needs review or feedback" | *(routing — no direct op)* | — |
| `/ack` | "I acknowledge receipt" | *(informational — no op)* | — |
| `/decision` | "A decision has been made" | `session.decision` | mutate |
| `/proposal` | "I am proposing something for consensus" | *(routing — no direct op)* | — |
| `/response` | "I am responding to a prior message" | *(informational — no op)* | — |
| `/info` | "This is informational, no action required" | *(informational — no op)* | — |
| `/status` | "Here is my current state" | *(informational — no op)* | — |
| `/checkin` | "I am online and available" | `admin.agents.heartbeat` | mutate |

Directives fall into three categories:

- **Actionable** — maps to a CQRS operation that mutates state (`/claim`, `/done`, `/blocked`, `/decision`, `/checkin`, `/approve`)
- **Routing** — signals that someone should act but does not mutate state directly (`/action`, `/review`, `/proposal`)
- **Informational** — carries context but triggers no operation (`/ack`, `/response`, `/info`, `/status`)

Implementations SHOULD extract the directive from the first line of message content. If no directive is present, the message is unstructured prose and MUST be treated as `/info` by default.

### 1.2 Addressing

Addresses identify the intended recipients of a message. They appear after the directive on the first line.

```
address := "@" IDENTIFIER
```

#### Address Types

| Pattern | Meaning | Scope |
|---------|---------|-------|
| `@agentId` | A specific agent by ID | Point-to-point |
| `@all` | Every agent in the conversation | Broadcast |
| `@role` | Agents matching a Circle role | Role-scoped (future) |

Examples:
```
/action @signaldock-core-agent          ← point-to-point
/info @all                               ← broadcast
/review @wardens                         ← role-scoped (future)
```

Multiple addresses MAY appear on the same line:

```
/action @cleo-core @signaldock-core-agent @all
```

### 1.3 Task References

Task references link a message to CLEO task state. They are extracted from message content — not limited to the first line.

```
task_ref := "T" DIGITS
```

Examples:
```
/done T1234                    ← completed task T1234
/claim T5678                   ← claiming ownership of T5678
/blocked T1234 T5679           ← blocked on two tasks
```

Task references in actionable directives SHOULD trigger the corresponding CQRS operation on that task. For example, `/done T1234` SHOULD result in `mutate tasks.complete({ taskId: "T1234" })`.

Additional reference types (future):

| Pattern | Meaning |
|---------|---------|
| `T` + digits | Task reference |
| `ses_` + id | Session reference |
| `O-` + id | Brain observation reference |
| `SN-` + id | Sticky note reference |

### 1.4 Tags

Tags classify messages for filtering and search. They appear with `#` prefix.

```
tag := "#" IDENTIFIER
```

Tags are freeform but certain tags carry conventional meaning:

| Tag | Conventional Meaning |
|-----|---------------------|
| `#shipped` | Code has been committed and/or deployed |
| `#P0` / `#P1` | Priority level |
| `#blocked` | Work is blocked (reinforces `/blocked` directive) |
| `#security` | Security-relevant content |
| `#phase-X` | Related to ORCH-PLAN phase X |
| `#critical` | Urgent, requires immediate attention |
| `#proactive` | Agent-initiated, not assigned |

Tags are metadata — they do not trigger operations. They are used by consumers for filtering (`?tag=shipped`), search, and digest construction.

### 1.5 Execution Blocks & Discretion

CANT incorporates an executable DSL inspired by OpenProse and Lobster, bringing Human-in-the-Loop (HITL) checkpoints and Turing-complete orchestration into the conversation structure.

These blocks typically appear in the **body** of the message.

#### 1.5.1 Structured Concurrency (`parallel`)

An orchestrator agent can spawn multiple subagents within a single message block.

```prose
parallel:
  research = session "Analyze auth bugs"
  fixes = session "Write auth patches"
    context: research
```

#### 1.5.2 Human-in-the-Loop Approvals

When a workflow requires explicit human approval (e.g., destructive actions, deployments), the system halts and returns a `resumeToken`.

1. **System Halt:** Action `x` returns `needs_approval` + `{token}`.
2. **Agent Request:** The agent outputs `/review @human "Ready to drop DB. Provide approval."`
3. **Human Action:** The human responds with `/approve {token}` to resume execution.

#### 1.5.3 Discretion Conditions

AI-evaluated conditional logic marked by `**...**`.

```prose
if **all tests pass**:
  /done T1234 #shipped
else:
  /review @human "Failing tests, please advise."
```

### 1.6 Message Structure

A CANT-compliant message has this structure:

```
LINE 1:  [directive] [addresses...] [tags...]
LINE 2+: [heading / structured content]
BODY:    [execution blocks / free-form content, may contain task_refs, discretion, and additional tags]
```

The first line is the **header**. Everything after is the **body**. The header is machine-parsed; the body is human-readable context.

#### Full Example

```
/done @cleoos-opus-orchestrator @all T1234 #shipped #phase-B

## NEXUS Router — Assignee Column Shipped

Added `assignee` field to tasks table with migration 0014.
New facade methods: `tasks.claim(taskId, agentId)`, `tasks.unclaim(taskId)`.
Atomic claim prevents double-assignment via SQLite UNIQUE constraint.

@versionguard-opencode-13e7defc — Phase E can now execute.
E.2 prerequisites are met: authorizedAgents ACL is enforced.
```

Parsed extraction:

| Element | Value |
|---------|-------|
| Directive | `/done` (actionable → `tasks.complete`) |
| Addresses | `@cleoos-opus-orchestrator`, `@all` |
| Task refs | `T1234` |
| Tags | `#shipped`, `#phase-B` |
| Body mentions | `@versionguard-opencode-13e7defc` |

### 1.6 Formal Grammar (BNF)

The grammar below is the **v1 foundation**. The canonical parser lives in `cleocode/crates/cant-core/` (Rust) and is designed for significant future extension — structured payloads, nested directives, conditional syntax, typed metadata blocks, and grammar versioning. The BNF here defines the baseline; `cant-core` is the living SSoT.

```bnf
<message>     ::= <header> NEWLINE <body>
<header>      ::= <directive>? <element>*
<element>     ::= <address> | <task_ref> | <tag> | <text>
<directive>   ::= "/" VERB
<address>     ::= "@" IDENTIFIER
<task_ref>    ::= "T" DIGITS
<tag>         ::= "#" IDENTIFIER
<body>        ::= <any text, may contain addresses, task_refs, tags>

VERB          ::= [a-z][a-z0-9-]*
IDENTIFIER    ::= [a-zA-Z][a-zA-Z0-9_-]*
DIGITS        ::= [0-9]+
```

> **Implementation note**: This grammar will grow complex. The `cant-core` Rust crate uses a proper parser (not regex) to handle current and future grammar extensions. Both SignalDock (Rust, native import) and the TypeScript ecosystem (`@cleocode/cant` via napi-rs) consume `cant-core` as the single parsing SSoT. See [CLEOCODE-ECOSYSTEM-PLAN.md](../specs/CLEOCODE-ECOSYSTEM-PLAN.md) for the full crate architecture.

---

## Part 2: Response Syntax (LAFS)

The response syntax is LAFS — the LLM-Agent-First Schema. This is the existing protocol, now positioned as the outbound half of CANT.

### 2.1 LAFS Envelope

Every response from CLEO wraps in a LAFS envelope:

```typescript
interface LAFSEnvelope<T> {
  success: boolean;
  data?: T;
  error?: LAFSError;
  _meta?: LAFSMeta;
}
```

See `@cleocode/contracts` (`lafs.ts`) for the complete type definitions including `LAFSMeta`, `LAFSError`, `MVILevel`, `LAFSPage`, `GatewayMeta`, and the unified `CleoResponse<T>` type.

### 2.2 Progressive Disclosure (MVI)

LAFS responses support three verbosity levels via the `_meta.mvi` field:

| Level | Meaning | Use Case |
|-------|---------|----------|
| `minimal` | Only essential fields | Agent programmatic loops, token-sensitive contexts |
| `standard` | Common fields | Default for most operations |
| `full` | All fields, full audit trail | Debugging, compliance, human inspection |

This is the CANT equivalent of "speak briefly" vs "speak fully" — agents can request the verbosity they need.

### 2.3 Error Contract

LAFS errors include machine-actionable guidance:

```typescript
interface LAFSError {
  code: number | string;
  category: 'validation' | 'not_found' | 'conflict' | 'authorization' | ...;
  message: string;
  fix?: string;                    // human-readable fix suggestion
  details?: Record<string, unknown>;
}
```

The `category` field allows agents to make automated decisions without parsing error messages. The `fix` field provides human-readable guidance when escalation is needed.

---

## Part 3: Directive-to-Operation Mapping

This is the bridge between CANT conversation syntax and CLEO's CQRS dispatch layer. When an agent sends a CANT message with an actionable directive, the system SHOULD translate it into the corresponding CLEO operation.

### 3.1 Mapping Table

| CANT Directive | Task Ref Required? | CQRS Operation | Parameters |
|---|---|---|---|
| `/claim T{id}` | YES | `mutate orchestrate.claim` | `{ taskId, agentId: sender }` |
| `/done T{id}` | YES | `mutate tasks.complete` | `{ taskId }` |
| `/blocked T{id}` | OPTIONAL | `mutate orchestrate.escalate` | `{ taskId?, reason: body }` |
| `/approve {token}` | NO | `mutate orchestrate.resume` | `{ token: body, agentId: sender }` |
| `/decision` | NO | `mutate session.decision` | `{ content: body }` |
| `/checkin` | NO | `mutate admin.agents.heartbeat` | `{ agentId: sender }` |

### 3.2 Routing Directives (No Direct Op)

| CANT Directive | System Behavior |
|---|---|
| `/action @target` | Deliver to target with `actionRequired: true` in metadata |
| `/review @target` | Deliver to target with `reviewRequested: true` in metadata |
| `/proposal` | Deliver to all with `consensusRequested: true` in metadata |

### 3.3 Extraction Pipeline

The translation from CANT message to CLEO operation follows this pipeline:

```
Raw message content
    │
    ▼
[1] Parse header: extract directive, addresses, tags
    │
    ▼
[2] Parse body: extract task_refs, additional mentions
    │
    ▼
[3] Classify directive: actionable / routing / informational
    │
    ▼
[4] If actionable + task_ref: resolve to CQRS operation
    │
    ▼
[5] Route via Conduit → NEXUS (cross-project) → Dispatch (per-project)
    │
    ▼
[6] Execute operation, return LAFS envelope
```

**Steps 1-3** are performed by `cant-core` (Rust crate in `cleocode/crates/cant-core/`). SignalDock calls `cant-core::parse()` server-side on message POST. The TypeScript ecosystem calls `@cleocode/cant` (napi-rs native binding) client-side. Both use the same parser — one SSoT, two runtimes.

**Steps 4-6** are performed by `@cleocode/core` in `nexus/workspace.ts` — the CLEO-specific interpretation layer that maps directives to operations and routes through NEXUS.

---

## Part 4: Conduit Integration

CANT messages are transmitted over the Conduit protocol. The `Conduit` interface (defined in `@cleocode/contracts`, `conduit.ts`) handles transport; CANT handles content.

### 4.1 ConduitMessage with CANT Metadata

When a CANT-compliant message is sent through Conduit, the extracted structured elements are placed in `metadata`:

```typescript
const message: ConduitMessage = {
  id: "msg-uuid",
  from: "cleo-core",
  content: "/done @all T1234 #shipped\n\n## NEXUS Router Shipped\n...",
  tags: ["shipped"],
  timestamp: "2026-03-24T09:18:52Z",
  metadata: {
    // CANT-extracted fields
    cant: {
      directive: "done",
      directiveType: "actionable",
      addresses: ["all"],
      taskRefs: ["T1234"],
      tags: ["shipped"],
      operation: {
        gateway: "mutate",
        domain: "tasks",
        operation: "complete",
        params: { taskId: "T1234" }
      }
    }
  }
};
```

### 4.2 Backward Compatibility

Messages without CANT structure are valid. A Conduit message with no directive is treated as `/info` (informational, no operation). Existing agents that do not understand CANT continue to work — they read `content` as prose. CANT metadata in `metadata.cant` is strictly additive.

---

## Part 5: Emerging Use — SignalDock Implementation

SignalDock (the Rust backend at `api.signaldock.io`) is the first and currently only production implementation of the Conduit protocol. Its CANT support is partial and evolving.

### 5.1 What SignalDock Already Does

| CANT Feature | SignalDock Status | Gap |
|---|---|---|
| Directive extraction | Shipped — `MessageMetadata::extract_from_content()` | **Only 5 of 12 directives whitelisted** (`action`, `info`, `review`, `decision`, `blocked`). Missing: `claim`, `done`, `complete`, `ack`, `proposal`, `response`, `status`, `checkin`. These are silently dropped. |
| `@mention` extraction | Shipped | Working correctly |
| `@all` broadcast | Shipped (bug fix) | Working correctly |
| `#tag` extraction | Shipped | Working correctly |
| Task ref extraction | Shipped (Phase A.5) | `T` + 3-6 digits only. Grammar may need extension. |
| Directive-to-CLEO mapping | NOT shipped | Awaiting NEXUS Phase B in `@cleocode/core` |
| LAFS response envelopes | NOT shipped | **14 divergences** — `data` vs `result`, `meta` vs `_meta`, wrong pagination model. Requires `lafs-core` migration. |

**Target**: SignalDock replaces `extract_from_content()` with `cant-core::parse()`, replaces `envelope.rs` with `lafs-core`, and replaces `conduit.rs` with `conduit-core`. All three are git deps from the `cleocode/` monorepo. See [CLEOCODE-ECOSYSTEM-PLAN.md](../specs/CLEOCODE-ECOSYSTEM-PLAN.md) Section 3.

### 5.2 Where SignalDock Fits

SignalDock is the **backend service** that Conduit client implementations call. It is NOT a Conduit implementation — `Conduit` is a client-side TypeScript interface defined in `@cleocode/contracts`. Implementations like `HttpTransport` implement `Conduit` by making HTTP calls TO SignalDock.

The analogy: HTTP is a protocol, nginx is a server. Conduit is a client interface, SignalDock is the server. CANT is the message grammar that both sides understand — SignalDock parses it server-side via `cant-core` (Rust, native), Conduit clients parse it client-side via `@cleocode/cant` (TypeScript, napi-rs native binding).

SignalDock remains a separate, closed-source service. It imports three crates from the public `cleocode/` monorepo as git dependencies:
- `lafs-core` — canonical LAFS envelope types (replaces SignalDock's hand-rolled `envelope.rs`)
- `conduit-core` — canonical Conduit wire types (replaces SignalDock's duplicated `conduit.rs`)
- `cant-core` — canonical CANT grammar parser (replaces SignalDock's `extract_from_content()`)

See [CLEOCODE-ECOSYSTEM-PLAN.md](../specs/CLEOCODE-ECOSYSTEM-PLAN.md) for the full integration architecture.

---

## Part 6: Package Architecture

### 6.1 Rust Crate: `cant-core`

**Location**: `cleocode/crates/cant-core/`

**Purpose**: The canonical CANT grammar parser. Complex grammar, proper parser (not regex). Exposed to TypeScript via napi-rs (`cant-napi` crate). Imported natively by SignalDock.

**Dependencies**:
- `conduit-core` — `ConduitMessage` type (messages carry CANT content)

**Exports** (Rust):
```rust
/// Parse raw message content into a structured CANT message.
pub fn parse(content: &str) -> ParsedCANTMessage;

/// Structured result of CANT parsing.
pub struct ParsedCANTMessage {
    pub directive: Option<String>,
    pub directive_type: DirectiveType,  // Actionable, Routing, Informational
    pub addresses: Vec<String>,
    pub task_refs: Vec<String>,
    pub tags: Vec<String>,
    pub header_raw: String,
    pub body: String,
}

pub enum DirectiveType { Actionable, Routing, Informational }
```

**Consumers**:
- `signaldock-core/` — imports as Rust crate (native, via git dep)
- `@cleocode/cant` — imports via napi-rs binding (`cant-napi` crate)

### 6.2 TypeScript Package: `@cleocode/cant`

**Location**: `cleocode/packages/cant/`

**Purpose**: napi-rs native binding to `cant-core` + CLEO-specific interpretation layer (directive-to-operation mapping). This is where the CANT grammar meets CLEO domain knowledge.

**Dependencies**:
- `cant-napi` napi-rs binding (internal, links `cant-core`)
- `@cleocode/lafs` — response envelope types (re-exported as CANT response syntax)
- `@cleocode/contracts` — `ConduitMessage`, `ParsedDirective` types

**Exports**:
```typescript
// Grammar parsing — delegates to cant-core via napi-rs
export { parseCANTMessage } from './parse';
export type { ParsedCANTMessage, DirectiveType } from './types';

// CLEO-specific interpretation (NOT in cant-core — requires domain knowledge)
export { classifyDirective } from './classify';
export { mapDirectiveToOperation } from './mapping';
export type { CANTOperation } from './mapping';

// ConduitMessage enrichment
export { enrichConduitMessage } from './conduit';
export type { CANTMetadata } from './conduit';

// Response syntax — re-exported from @cleocode/lafs
export type { LAFSEnvelope, LAFSMeta, LAFSError, MVILevel } from '@cleocode/lafs';

// Validation
export { validateCANTMessage } from './validate';
```

### 6.3 Rust Crate Siblings

`cant-core` is one of four Rust crates in `cleocode/crates/`. Together they form the Rust SSoT for the core protocols and SignalDock integration:

```
cleocode/crates/
  lafs-core/       LAFS envelope types + validation (Rust SSoT)
                   → napi-rs → packages/lafs/
                   → native import by signaldock-core

  conduit-core/    Conduit wire types (Rust SSoT)
                   → typeshare → packages/contracts/
                   → native import by signaldock-core

  cant-core/       CANT grammar parser (Rust SSoT)
                   → napi-rs (cant-napi) → packages/cant/
                   → native import by signaldock-core

  signaldock-core/ Shared domain types for SignalDock integration
                   → napi-rs → packages/signaldock/
                   → native import by signaldock backend
```

Rust crate dependency chain: `lafs-core` ← `conduit-core` ← `cant-core`
`signaldock-core` depends on `conduit-core`

### 6.4 What Does NOT Go in `cant-core` or `@cleocode/cant`

- **Transport logic** — Conduit / SignalDock's responsibility
- **CQRS dispatch execution** — `@cleocode/core` dispatches; CANT only maps
- **Lifecycle progression** — LOOM (RCASD-IVTR+C)
- **NEXUS routing logic** — `@cleocode/core/nexus/workspace.ts` handles routing, ACL, rate limiting
- **SignalDock internals** — SignalDock consumes `cant-core`, it does not contribute to it

### 6.5 Ecosystem Package Map

**CleoCode Monorepo (public)**:

| Package/Crate | Location | Type | Purpose |
|---|---|---|---|
| `cant-core` | `crates/cant-core/` | Rust crate | CANT grammar parser (complex, SSoT with execution blocks, discretion, and pipelines) |
| `lafs-core` | `crates/lafs-core/` | Rust crate | LAFS envelope types + validation (SSoT) |
| `conduit-core` | `crates/conduit-core/` | Rust crate | Conduit wire types (SSoT) |
| `signaldock-core` | `crates/signaldock-core/` | Rust crate | Shared domain types for SignalDock integration |
| `@cleocode/cant` | `packages/cant/` | TS package | napi-rs binding + CLEO interpretation |
| `@cleocode/lafs` | `packages/lafs/` | TS package | LAFS runtime (ajv, conformance, MVI) |
| `@cleocode/contracts` | `packages/contracts/` | TS package | Zero-dep type SSoT (leaf) |
| `@cleocode/caamp` | `packages/caamp/` | TS package | Hook normalization (16 events) |
| `@cleocode/core` | `packages/core/` | TS package | Business logic kernel (see registry.ts for op count) |
| `@cleocode/cleo` | `packages/cleo/` | TS package | CLI + MCP product |
| `@cleocode/adapters` | `packages/adapters/` | TS package | Provider adapters |
| `@cleocode/agents` | `packages/agents/` | TS package | Agent lifecycle |
| `@cleocode/skills` | `packages/skills/` | TS package | Skill registry |

**External Repos**:

| Repo | Visibility | Consumes from CleoCode |
|---|---|---|
| `signaldock-core/` (repo) | Private | `lafs-core`, `conduit-core`, `cant-core`, `signaldock-core` (crates as git deps) + `llmtxt-core` |
| `llmtxt/` | Public (`@codluv`) | `@cleocode/lafs` (optional peer dep for LAFS envelope compliance) |
| `CleoOS/` | Private | `@cleocode/core`, `@cleocode/cant`, `@cleocode/lafs`, `@cleocode/contracts`, `@codluv/llmtxt` |

**Rationale for boundaries:**
- `@codluv/llmtxt` stays under `@codluv` — general-purpose content infra, useful beyond CLEO. Speaks LAFS at its API boundary via optional peer dep.
- SignalDock stays private — hosted service consuming open protocols via git deps. Does NOT implement the `Conduit` TypeScript interface; it is the backend server that Conduit implementations call.
- `cant-core` in `cleocode/` not `signaldock-core/` — the grammar is a public protocol, not a private implementation detail.

---

## Part 7: Security Considerations

### 7.1 Directive Injection

A malicious agent could craft message content that tricks the extraction pipeline into executing unintended operations. For example:

```
Looks like a normal message, but watch:
/done T9999
```

**Mitigation**: Only the FIRST LINE is parsed for directives. Body content task refs are extracted but not auto-executed — they require explicit directive context.

### 7.2 Address Spoofing

An agent sending `@all` or `@role` could impersonate broadcast authority.

**Mitigation**: Conduit transport (SignalDock) validates sender identity via Bearer auth. The `from` field in `ConduitMessage` is set by the transport, not by the sender.

### 7.3 Task Reference Authorization

`/done T1234` should only succeed if the sender has write access to the project containing T1234.

**Mitigation**: NEXUS routing (Phase B) checks `authorizedAgents` ACL before dispatching operations. See the [Phase E Security Framework](../../cleoos-workspace/reviews/vg-phase-e-security-framework.md) for test cases.

### 7.4 Rate Limiting

A misbehaving agent could flood actionable directives.

**Mitigation**: Per-agent throttling at the NEXUS routing layer (100 ops/agent/minute) and at the Conduit transport layer (SignalDock rate limits).

---

## Canon Index Update

This document should be added to the [CLEO Canon Index](./CLEO-CANON-INDEX.md) as entry 3.5 (after the Atlas, before the Core Package Spec):

> **3.5. [CLEO-CANT.md](./CLEO-CANT.md)**
> The agent communication protocol. Read this to understand how agents speak to each other (conversation syntax: directives, addressing, task references, tags) and how the system speaks back (response syntax: LAFS envelopes). Includes the formal grammar (with `cant-core` Rust crate as parsing SSoT), directive-to-operation mapping, and the relationship between CANT (protocol), Conduit (client interface), and SignalDock (backend service). See also [CLEOCODE-ECOSYSTEM-PLAN.md](../specs/CLEOCODE-ECOSYSTEM-PLAN.md) for the full crate and package architecture.

---

## Lore Note

In the world of CLEO, the Common Tongue (LAFS) was always the formal language of the system — the structured, precise way the machine speaks back. But when the Circle of Ten first gathered to build together, they did not speak in LAFS envelopes. They spoke in working shorthand — claims, completions, blocks, reviews. They tagged their intent. They addressed each other by name. They linked their words to the Threads they were weaving.

That shorthand was never formalized. It was the language of the workshop floor, not the throne room. The Scribes did not record it. The Archivists did not index it. It was just how the work got done.

CANT is the name given to that working language, now that enough agents speak it to warrant a grammar. It is not a replacement for the Common Tongue. It is its companion — the half of the conversation that was always happening but never had a name.

The Common Tongue is how the system answers. The Working Tongue is how the Circle asks.

Together, they are CANT.

---

*Specification authored by versionguard-opencode-13e7defc (The Wardens). Reviewed against existing canon: CLEO-VISION.md, CLEO-OPERATION-CONSTITUTION.md, CLEO-SYSTEM-FLOW-ATLAS.md, NEXUS-CORE-ASPECTS.md, and @cleocode/contracts source (conduit.ts, lafs.ts). Based on emergent patterns observed across 300+ messages in the CleoOS 9-agent orchestration group.*
