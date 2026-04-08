# CleoCode Ecosystem Plan

**The Canonical Architecture for the CLEO Ecosystem**

> Status: DRAFT — requires owner sign-off
> Author: versionguard-opencode-13e7defc + owner collaboration
> Date: 2026-03-24
> Scope: All packages, crates, repos, data flows, and integration points

---

## 1. The Three Repositories

The CLEO ecosystem spans three repositories. Each has a distinct purpose, visibility, and ownership boundary.

| Repository | Visibility | Language | Purpose |
|---|---|---|---|
| `cleocode/` | Public | TypeScript + Rust | Protocol kernel, libraries, CLI, canonical types |
| `signaldock-core/` | Private | Rust | Agent messaging backend (hosted service) |
| `llmtxt/` | Public | TypeScript + Rust | Content infrastructure (`@codluv/llmtxt`) |

**Principle**: `cleocode/` defines protocols and types. `signaldock-core/` and `llmtxt/` implement and consume them. The SSoT for all shared contracts lives in `cleocode/`.

---

## 2. CleoCode Monorepo — Complete Package Map

### 2.1 TypeScript Packages (existing)

```
cleocode/packages/
  contracts/     @cleocode/contracts     Zero-dep type SSoT (leaf package)
  lafs/          @cleocode/lafs          LAFS response envelope implementation
  caamp/         @cleocode/caamp         Hook normalization (16 canonical events)
  core/          @cleocode/core          Business logic kernel (see registry.ts)
  cleo/          @cleocode/cleo          CLI + MCP product wrapper
  adapters/      @cleocode/adapters      Provider adapters
  agents/        @cleocode/agents        Agent lifecycle management
  skills/        @cleocode/skills        Skill registry and dispatch
```

### 2.2 TypeScript Package (new)

```
cleocode/packages/
  cant/          @cleocode/cant          CANT protocol — wraps cant-core WASM
                                         + directive-to-operation interpretation
```

### 2.3 Rust Crates (NEW — `cleocode/crates/`)

```
cleocode/crates/
  lafs-core/       lafs-core               LAFS envelope types + validation (Rust SSoT)
  conduit-core/    conduit-core            Conduit wire types (Rust SSoT)
  cant-core/       cant-core               CANT grammar parser (complex, shared SSoT)
  signaldock-core/ signaldock-core         Shared domain types for SignalDock integration
```

These four crates are the **Rust SSoT** for the core protocols and SignalDock integration. They are compiled to WASM for TS consumption and imported natively by SignalDock.

### 2.4 Dependency Graph

```
                    @cleocode/contracts (zero-dep leaf)
                    ├── Conduit TS types
                    ├── LAFS TS types (inlined)
                    ├── ParsedDirective (CANT result type)
                    └── All domain types
                          │
              ┌───────────┼───────────────┐
              ▼           ▼               ▼
    @cleocode/lafs   @cleocode/cant   @cleocode/caamp
    (envelope impl)  (CANT parser     (hook normalization)
    depends on:       + interpretation) depends on:
     - contracts      depends on:        - lafs
     - ajv             - contracts
     - a2a-js          - lafs
                       - cant-core WASM
              │           │               │
              └─────┬─────┘               │
                    ▼                     │
              @cleocode/core              │
              (business logic kernel)     │
              depends on:                 │
               - contracts                │
               - lafs                     │
               - cant (for nexus routing) │
               - caamp ─────────────────-─┘
                    │
                    ▼
              @cleocode/cleo
              (CLI + MCP product)
              depends on:
               - core
               - lafs (output formatting)
               - contracts
              ┌─────┴─────┐
              ▼           ▼
        @cleocode/    @cleocode/
        adapters      skills
        agents
```

### 2.5 Rust Crate Dependency Graph

```
  lafs-core (no deps — leaf crate)
      │
  conduit-core (depends on lafs-core — messages carry LAFS envelopes)
      │
  cant-core (depends on conduit-core — parses ConduitMessage content)
```

### 2.6 Rust → WASM → TS Pipeline

Same proven pattern as `llmtxt-core`:

```
crates/lafs-core/     → wasm-pack build → packages/lafs/src/wasm/
crates/conduit-core/  → wasm-pack build → packages/contracts/src/wasm/ (or standalone)
crates/cant-core/     → wasm-pack build → packages/cant/src/wasm/
```

---

## 3. SignalDock — Current vs Target

### 3.1 Current Structure

```
signaldock-core/
  crates/
    signaldock-protocol/    Domain types, envelope, error, conduit, message
    signaldock-storage/     SQLite adapters, migrations, trait definitions
    signaldock-transport/   SSE, webhook, WebSocket, HTTP/2 delivery
    signaldock-sdk/         Service layer (AgentService, MessageService, etc.)
    signaldock-payments/    Payment facilitation (Stripe, Square)
  apps/
    signaldock-api/         Axum REST API (the deployed service)
    signaldock-worker/      Background job processor
  bindings/
    node/                   Future napi-rs binding (commented out)
    python/                 Future PyO3 binding (commented out)
```

### 3.2 Current Dependencies

```
signaldock-api depends on:
  ├── signaldock-protocol   (all domain types)
  ├── signaldock-storage    (SQLite persistence)
  ├── signaldock-transport  (delivery adapters)
  ├── signaldock-sdk        (service orchestration)
  ├── signaldock-payments   (payment facilitation)
  └── llmtxt-core           (content compression, via git dep)
```

### 3.3 Target Dependencies (after migration)

```
signaldock-api depends on:
  ├── lafs-core             NEW (git dep from cleocode/) — replaces envelope.rs
  ├── conduit-core          NEW (git dep from cleocode/) — replaces conduit.rs
  ├── cant-core             NEW (git dep from cleocode/) — replaces extract_from_content()
  ├── signaldock-protocol   (domain types ONLY — agent, message, conversation, claim, etc.)
  ├── signaldock-storage    (unchanged)
  ├── signaldock-transport  (unchanged)
  ├── signaldock-sdk        (unchanged)
  ├── signaldock-payments   (unchanged)
  └── llmtxt-core           (unchanged, git dep from llmtxt/)
```

### 3.4 What Gets Removed from signaldock-protocol

| File | Status | Replacement |
|---|---|---|
| `envelope.rs` | **DELETE** | `lafs-core` crate (canonical LAFS envelope types) |
| `conduit.rs` | **DELETE** | `conduit-core` crate (canonical Conduit wire types) |
| `message.rs` `MessageMetadata::extract_from_content()` | **DELETE** | `cant-core` crate (canonical CANT parser) |
| `error.rs` | **KEEP + ALIGN** | Error codes stay in signaldock-protocol, but `ErrorCategory` enum aligns to LAFS categories |
| `agent.rs` | **KEEP** | SignalDock-specific (agent registration, stats, classes) |
| `claim.rs` | **KEEP** | SignalDock-specific (claim codes) |
| `connection.rs` | **KEEP** | SignalDock-specific |
| `conversation.rs` | **KEEP** | SignalDock-specific |
| `message.rs` (struct) | **KEEP** | SignalDock internal Message type (UUID-based, not Conduit) |
| `user.rs` | **KEEP** | SignalDock-specific (human user accounts) |

### 3.5 Wire Format Migration (14 Divergences → 0)

After adopting `lafs-core`, every SignalDock API response becomes canonical LAFS:

```
BEFORE (current):
{
  "success": true,
  "data": { ... },                    ← wrong field name
  "meta": {                           ← wrong field name, missing 5 fields
    "timestamp": "...",
    "request_id": "...",
    "operation": "...",
    "version": "..."
  },
  "page": { "page": 1, "has_next": true }  ← wrong pagination model
}

AFTER (lafs-core):
{
  "success": true,
  "result": { ... },                  ← canonical
  "_meta": {                          ← canonical, full LAFS metadata
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "...",
    "operation": "...",
    "requestId": "...",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "page": { "mode": "offset", "limit": 25, "offset": 0, "hasMore": true }
}
```

**GOTCHA**: This is a breaking wire format change. Every consumer of SignalDock's REST API must be updated simultaneously. The migration plan:

1. `lafs-core` crate built and tested
2. SignalDock adds `Accept: application/vnd.lafs.v1+json` header support
3. During migration: old format is default, new format opt-in via header
4. All Conduit implementations (HttpTransport, ConduitClient, any direct consumers) switch to new format
5. After all consumers migrated: new format becomes default, old format deprecated
6. Cleanup: remove old format code

---

## 4. llmtxt — Current vs Target

### 4.1 Current Structure

```
llmtxt/
  crates/
    llmtxt-core/              Rust: compress, hash, sign, verify, Base62
  packages/
    core/                     TS: @codluv/llmtxt (wraps llmtxt-core WASM + client SDK)
  apps/
    web/                      llmtxt.my web application
```

### 4.2 Current Dependencies

```
@codluv/llmtxt depends on:
  └── llmtxt-core (WASM)      (internal — Rust → WASM build)
  └── (NO @cleocode deps)
```

### 4.3 Target Dependencies

```
@codluv/llmtxt depends on:
  ├── llmtxt-core (WASM)       (unchanged)
  └── @cleocode/lafs           NEW (optional peer dep — LAFS envelope validation)
```

### 4.4 What Changes

| Component | Change | Details |
|---|---|---|
| `client.ts` | Update API response parsing | Use `parseLafsResponse()` when `@cleocode/lafs` is available |
| `package.json` | Add optional peer dep | `"peerDependencies": { "@cleocode/lafs": ">=2026.3" }` + `"peerDependenciesMeta": { "@cleocode/lafs": { "optional": true } }` |
| `llmtxt-core` Rust crate | NO CHANGE | Stays independent — content primitives don't need LAFS |
| `llmtxt.my` web app | NO CHANGE | Consumes the TS package, not LAFS directly |

**Principle**: llmtxt speaks LAFS at its **API boundary** (client SDK responses). Its internals (compression, hashing, signing) remain independent. `@codluv/llmtxt` stays under `@codluv` scope.

---

## 5. CANT — Complete Architecture

### 5.1 Where Each Piece Lives

| CANT Component | Location | Language | Purpose |
|---|---|---|---|
| Spec document | `cleocode/docs/concepts/CLEO-CANT.md` | Markdown | Canonical grammar reference |
| Parser crate | `cleocode/crates/cant-core/` | Rust | Complex grammar parsing (SSoT) |
| TS wrapper | `cleocode/packages/cant/` | TypeScript | WASM wrapper + CLEO interpretation layer |
| Interpretation | `cleocode/packages/core/src/nexus/workspace.ts` | TypeScript | Directive → operation routing via NEXUS |
| Server extraction | `signaldock-core/` (imports `cant-core`) | Rust | Server-side CANT parsing on message POST |
| Result types | `cleocode/packages/contracts/` | TypeScript | `ParsedDirective`, `CANTHeader`, etc. |

### 5.2 Data Flow

```
Agent sends message:
  "/done @all T1234 #shipped\n\n## Task Complete\n..."
       │
       ▼
[SignalDock API — POST /conversations/{id}/messages]
  │
  ├─ cant-core::parse(content)
  │   → ParsedCANTMessage {
  │       directive: "done",
  │       directive_type: Actionable,
  │       addresses: ["all"],
  │       task_refs: ["T1234"],
  │       tags: ["shipped"],
  │     }
  │
  ├─ Store message + CANT metadata in DB
  │
  ├─ Wrap response in lafs-core::LafsResponse
  │   → { success: true, result: { messageId }, _meta: { transport: "http", ... } }
  │
  └─ Emit via conduit-core::ConduitMessage to subscribers
       │
       ▼
[Conduit Client — ConduitClient.onMessage()]
  │
  ├─ Parse LAFS envelope (via @cleocode/lafs)
  │
  ├─ Read metadata.cant (already parsed by server)
  │   OR parse locally via @cleocode/cant (WASM)
  │
  └─ Route to @cleocode/core
       │
       ▼
[CLEO Core — nexus/workspace.ts]
  │
  ├─ parseDirective(conduitMessage) → ParsedDirective
  │   (uses @cleocode/cant for extraction)
  │
  ├─ VERB_TO_OPERATION mapping: "done" → "tasks.complete"
  │
  ├─ nexus.route(directive)
  │   ├─ Resolve project from task ref T1234
  │   ├─ Check ACL (authorizedAgents)
  │   ├─ checkRateLimit(agentId)
  │   └─ Dispatch: tasks.complete({ taskId: "T1234" })
  │
  └─ Return LAFS envelope with operation result
```

### 5.3 CANT Extraction — Current vs Target

**Current** (`signaldock-protocol/message.rs:41`):
```rust
// Hand-rolled, whitelist is incomplete, no structured output type
const DIRECTIVE_WHITELIST: &[&str] = &["action", "info", "review", "decision", "blocked"];
// Missing: claim, done, complete, ack, proposal, response, status, checkin
pub fn extract_from_content(content: &str) -> MessageMetadata { ... }
```

**Target** (`cleocode/crates/cant-core/`):
```rust
// Complete canonical grammar, structured output, all 12 directives
pub fn parse(content: &str) -> ParsedCANTMessage { ... }
// Directive taxonomy from CLEO-CANT.md spec
// Complex grammar support for future extensions
```

**GOTCHA**: SignalDock's current `DIRECTIVE_WHITELIST` only has 5 of the 12 canonical directives. `/claim`, `/done`, `/complete`, `/ack`, `/proposal`, `/response`, `/status`, `/checkin` are not extracted. Any agent using these directives today has them silently dropped from metadata. This is a data loss bug that `cant-core` fixes.

---

## 6. Conduit — Corrected Architecture

### 6.1 The Actual Relationship

```
┌─────────────────────────────────────────────────────────┐
│  Conduit (TypeScript INTERFACE in @cleocode/contracts)   │
│  CLIENT-SIDE abstraction for agent messaging             │
│                                                          │
│  Methods: send(), onMessage(), heartbeat(), connect()    │
│  Types: ConduitMessage, ConduitState, ConduitSendResult  │
└─────────────────────────┬───────────────────────────────┘
                          │ implemented by
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
  HttpTransport       ConduitClient    LocalSignalDock
  (HTTP polling)      (high-level)     (future napi-rs)
  polls REST API      wraps transport  WebSocket local
          │               │               │
          └───────────────┼───────────────┘
                          │ all call
                          ▼
┌─────────────────────────────────────────────────────────┐
│  SignalDock (Rust SERVICE at api.signaldock.io)           │
│  SERVER-SIDE backend for agent messaging                 │
│                                                          │
│  Uses conduit-core types for wire format                 │
│  Uses lafs-core for response envelopes                   │
│  Uses cant-core for message content parsing              │
│  Does NOT implement the Conduit TS interface             │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Type Duplication Resolution

**Current**: Conduit types defined independently in two places:
- `@cleocode/contracts/conduit.ts` (TypeScript)
- `signaldock-protocol/conduit.rs` (Rust)

**Target**: One SSoT in Rust, TS generated or mirrored:
- `cleocode/crates/conduit-core/` — canonical Rust types
- `@cleocode/contracts/conduit.ts` — TS types (manually kept in sync, or auto-generated from Rust via `typeshare` or similar)
- `signaldock-protocol/conduit.rs` — **DELETED**, imports `conduit-core`

**GOTCHA**: `conduit-core` types use `String` for IDs (cross-platform). SignalDock internally uses `Uuid`. The `impl From<Message> for ConduitMessage` conversion stays in SignalDock — it's the boundary where internal UUIDs become string IDs for the Conduit wire format.

### 6.3 Doc Fix Required

`@cleocode/contracts/conduit.ts` line 4 currently says:
```
* SignalDock implements this interface.
```
Must change to:
```
* This is a CLIENT-SIDE interface. Implementations call a messaging
* backend (SignalDock REST API, local napi-rs, etc.). SignalDock is
* the canonical backend; it does NOT implement this TypeScript interface.
```

---

## 7. LAFS — Duplication Resolution

### 7.1 Current Duplication (THREE places)

| Location | What | Problem |
|---|---|---|
| `@cleocode/lafs` (packages/lafs/) | Full TS implementation: ajv validation, conformance, MVI, A2A | **The SSoT** for TS |
| `@cleocode/contracts` (packages/contracts/src/lafs.ts) | Inlined TS type copies — "contracts has ZERO external dependencies" | **Manual copy** that can drift |
| `signaldock-protocol/envelope.rs` | Hand-rolled Rust types: `ApiResponse`, `ResponseMeta`, `PageInfo` | **14 divergences** from canonical LAFS |

### 7.2 Target (ONE SSoT per language)

| Location | What | Role |
|---|---|---|
| `cleocode/crates/lafs-core/` | Rust envelope types + validation | **Rust SSoT** |
| `@cleocode/contracts/lafs.ts` | TS type definitions (zero-dep) | **TS type SSoT** |
| `@cleocode/lafs` | TS runtime (ajv, conformance, MVI, re-exports contracts types) | **TS runtime SSoT** |
| `signaldock-protocol/envelope.rs` | **DELETED** — imports `lafs-core` | No longer exists |

### 7.3 contracts/lafs.ts Sync Strategy

`contracts` must remain zero-dep. It cannot import from `@cleocode/lafs`. Two options:

**Option A**: Manual sync (current approach, documented)
- `contracts/lafs.ts` has explicit comment: "inlined from @cleocode/lafs, keep in sync"
- CI test: `contracts` types must be assignable to `lafs` types (structural compatibility check)

**Option B**: Auto-generate `contracts/lafs.ts` from `lafs-core` Rust types
- `typeshare` or `ts-rs` generates TS types from Rust structs
- Build step: `crates/lafs-core/ → generate → packages/contracts/src/lafs.ts`
- Zero manual sync, zero drift

**Recommendation**: Option B (auto-generate). The Rust crate becomes the one true source. Both TS (`contracts`) and Rust (`signaldock`) get types from the same place. This also applies to `conduit-core` → `contracts/conduit.ts`.

**GOTCHA**: `@cleocode/contracts/lafs.ts` currently also defines CLEO-specific extensions (`GatewayMeta`, `GatewaySuccess`, `GatewayError`, `CleoResponse`). These are NOT part of canonical LAFS — they're CLEO additions. They must stay in contracts, not in `lafs-core`. The auto-generation produces the base types; CLEO extensions are appended manually.

---

## 8. Complete Data Flow — End to End

### 8.1 Agent Sends a Directive

```
Agent (Claude Code session)
  │
  │  "cleo agent send 'done @all T1234 #shipped'"
  │
  ▼
ConduitClient + HttpTransport (TypeScript, implements Conduit)
  │
  │  POST https://api.signaldock.io/conversations/{id}/messages
  │  Headers: Authorization: Bearer sk_live_..., X-Agent-Id: ...
  │  Body: { content: "/done @all T1234 #shipped\n\n## Task done\n..." }
  │
  ▼
SignalDock API (Rust, Axum)
  │
  ├─ Auth: verify Bearer token via better-auth-rs
  │
  ├─ Parse content with cant-core:
  │    cant_core::parse(content) → ParsedCANTMessage
  │    { directive: "done", addresses: ["all"], task_refs: ["T1234"], tags: ["shipped"] }
  │
  ├─ Build Message record with MessageMetadata from cant-core output
  │
  ├─ Store in SQLite via signaldock-storage
  │
  ├─ Fan-out: for each conversation member, create delivery record
  │
  ├─ Emit ConduitMessage (conduit-core types) via:
  │    ├─ SSE stream (connected subscribers)
  │    ├─ Webhook (registered URLs, with HMAC signature)
  │    └─ Polling queue (for poll/peek consumers)
  │
  └─ Return LAFS envelope (lafs-core):
       {
         success: true,
         result: { messageId: "...", deliveredAt: "..." },
         _meta: { transport: "http", operation: "messages.send", mvi: "standard", ... }
       }
```

### 8.2 Agent Receives the Message (CleoOS)

```
HttpTransport (TypeScript, implements Conduit Transport interface)
  │
  │  GET /messages/peek (polling) or SSE stream
  │
  ├─ Receive LAFS envelope → parseLafsResponse()
  │
  ├─ Extract ConduitMessage from result
  │    message.metadata.cant = {
  │      directive: "done",
  │      addresses: ["all"],
  │      task_refs: ["T1234"],
  │      tags: ["shipped"]
  │    }
  │
  ├─ Fire onMessage() handler
  │
  ▼
ConduitClient (polling via onMessage() handler)
  │
  ├─ Broadcast to renderer via IPC (for UI display)
  │
  ├─ If directive is actionable + has task_refs:
  │    Route to CLEO Core
  │
  ▼
@cleocode/core — nexus/workspace.ts
  │
  ├─ parseDirective(conduitMessage) using @cleocode/cant
  │    → ParsedDirective { verb: "done", taskRefs: ["T1234"], agentId: "..." }
  │
  ├─ VERB_TO_OPERATION["done"] → "tasks.complete"
  │
  ├─ routeDirective(directive):
  │    ├─ checkRateLimit("agent-id")           ← MEDIUM-05
  │    ├─ resolveProject("T1234")              ← which .cleo/tasks.db owns T1234?
  │    ├─ checkACL(agentId, projectPath)       ← HIGH-02
  │    └─ dispatch: tasks.complete({ taskId: "T1234" })
  │
  ├─ CLEO Core executes operation:
  │    ├─ 4-layer validation (LAFS MCP middleware)
  │    ├─ State machine: task status → completed
  │    ├─ Audit log entry (within same transaction)
  │    └─ Hook: onTaskComplete fires
  │
  └─ Return LAFS envelope:
       { success: true, data: { taskId: "T1234", status: "completed" }, _meta: { ... } }
```

### 8.3 Content Attachment Flow (llmtxt)

```
Agent wants to share a document:
  │
  ├─ @codluv/llmtxt: client.upload(content)
  │    ├─ llmtxt-core: compress(content) → Base62 slug
  │    ├─ llmtxt-core: hashContent(compressed) → integrity hash
  │    ├─ llmtxt-core: generateSignedUrl(slug, agentId, convId, expiry, secret)
  │    └─ POST to llmtxt.my API → LAFS envelope response (if @cleocode/lafs available)
  │
  ├─ SignalDock: POST message with attachment slug in content
  │    ├─ cant-core: parse content (may detect document links)
  │    └─ Store message with attachment metadata
  │
  └─ Receiving agent: client.fetch(slug)
       ├─ GET signed URL → decompress → verify hash
       └─ LAFS envelope response (if @cleocode/lafs available)
```

---

## 9. Duplication Map — Everything Being Cleaned Up

### 9.1 RESOLVED by lafs-core

| Duplication | Current | After |
|---|---|---|
| Envelope types (Rust) | `signaldock-protocol/envelope.rs` (hand-rolled) | `lafs-core` (canonical) |
| Response format | `data` vs `result`, `meta` vs `_meta`, 14 divergences | One format everywhere |
| Pagination model | `page/has_next/has_prev/total_pages` vs `offset/hasMore` | LAFS canonical pagination |
| Error categories | PascalCase in Rust vs SCREAMING_SNAKE in LAFS | Aligned via lafs-core |

### 9.2 RESOLVED by conduit-core

| Duplication | Current | After |
|---|---|---|
| ConduitMessage (Rust) | `signaldock-protocol/conduit.rs` | `conduit-core` (canonical) |
| ConduitMessage (TS) | `@cleocode/contracts/conduit.ts` | Generated from conduit-core (or manual sync) |
| ConduitState enum | Defined in both Rust and TS independently | One Rust source, TS generated |

### 9.3 RESOLVED by cant-core

| Duplication | Current | After |
|---|---|---|
| CANT extraction (Rust) | `signaldock-protocol/message.rs:extract_from_content()` | `cant-core::parse()` |
| CANT extraction (TS) | `core/nexus/workspace.ts:parseDirective()` | `@cleocode/cant` (WASM wrapper) |
| Directive whitelist | 5 directives in Rust, 6 verbs in TS (different sets!) | 12 canonical directives in cant-core |
| Task ref pattern | `T` + 3-6 digits (Rust) vs `/T(\d+)/g` regex (TS) | One grammar in cant-core |

### 9.4 RESOLVED by contracts as type SSoT

| Duplication | Current | After |
|---|---|---|
| LAFS TS types | Defined in both `contracts/lafs.ts` AND `packages/lafs/` | contracts = type SSoT, lafs re-exports or imports |
| `core/output.ts` imports | Imports from BOTH contracts AND lafs | Imports from one source |

---

## 10. Gotchas and Risks

### 10.1 Breaking Wire Format Change

SignalDock's LAFS alignment changes the wire format for every API consumer. This is a breaking change. Must be managed with header-based opt-in during migration (see Section 3.5).

**Affected consumers**:
- HttpTransport (HTTP polling transport)
- ConduitClient (high-level messaging client)
- AgentPoller (@cleocode/runtime)
- Any direct API consumers (curl scripts, test suites)
- E2E tests

### 10.2 Rust in a TS Monorepo

Adding `crates/` to `cleocode/` means the monorepo now has both `pnpm` (TS) and `cargo` (Rust) build systems. Need:
- `Cargo.toml` at monorepo root (workspace config)
- `rust-toolchain.toml` for version pinning
- CI pipeline additions: `cargo test`, `cargo clippy`, `wasm-pack build`
- `.gitignore` for `target/`

The `llmtxt/` repo already demonstrates this dual-language monorepo pattern. Clone its build infrastructure.

### 10.3 WASM Build Complexity

Three crates → three WASM builds → three TS packages wrapping them. The WASM build pipeline must be reliable. Follow `llmtxt-core`'s proven approach:
- `wasm-pack build --target web`
- WASM binary checked into the TS package (not built on npm install)
- Fallback: pure-TS implementation for environments where WASM doesn't load

### 10.4 contracts Zero-Dep Constraint

`@cleocode/contracts` MUST remain zero-dep (it's the leaf package everything imports). If types are auto-generated from Rust crates, the generation must be a build step, not a runtime dependency.

### 10.5 SignalDock `impl From<Message> for ConduitMessage`

SignalDock's internal `Message` type uses `Uuid`, `chrono::DateTime`, and `MessageMetadata`. The `conduit-core` `ConduitMessage` uses `String` for all IDs. The conversion logic (`impl From`) stays in SignalDock — it's the boundary between internal and wire representations.

### 10.6 CANT Grammar Complexity

The owner stated the grammar "WILL be complex, highly complex." This justifies `cant-core` as a proper parser crate (not inline regex). Consider using `nom` or `pest` for the parser implementation. The grammar spec in `CLEO-CANT.md` serves as the input specification.

### 10.7 llmtxt Optional LAFS Peer Dep

`@codluv/llmtxt` adding `@cleocode/lafs` as optional peer means:
- CLEO ecosystem users get LAFS envelope validation automatically
- Standalone users (outside CLEO) don't need it
- The `client.ts` must handle both paths: `if (lafs available) { parseLafsResponse() } else { raw json }`

### 10.8 SignalDock Message.metadata vs cant-core Output

Currently `MessageMetadata` has flat fields (`mentions`, `directives`, `tags`, `task_refs`). `cant-core` will produce a richer `ParsedCANTMessage` with `directive_type` (actionable/routing/informational), structured addresses, and future grammar extensions. The `MessageMetadata` struct must be updated or replaced to carry the full `cant-core` output.

---

## 11. Execution Sequence

### Phase 0: Foundation (parallel, no dependencies)

| Task | Owner | Scope |
|---|---|---|
| Create `cleocode/crates/` directory + Cargo workspace | cleo-core | Scaffolding |
| Create `lafs-core` crate (Rust LAFS envelope types) | cleo-core | New crate |
| Create `conduit-core` crate (Rust Conduit wire types) | cleo-core | New crate |
| Create `cant-core` crate (Rust CANT grammar parser) | cleo-core | New crate |
| Fix `contracts/conduit.ts` JSDoc | cleo-core | 5-line fix |
| Add CLEO-CANT.md to Canon Index | cleo-core | Doc update |

### Phase 1: Crate Integration (sequential after Phase 0)

| Task | Owner | Scope |
|---|---|---|
| SignalDock: replace `envelope.rs` with `lafs-core` dep | signaldock-core-agent | Crate swap + route handler migration |
| SignalDock: replace `conduit.rs` with `conduit-core` dep | signaldock-core-agent | Crate swap |
| SignalDock: replace `extract_from_content` with `cant-core` dep | signaldock-core-agent | Parser swap |
| SignalDock: align `ErrorCategory` to LAFS categories | signaldock-core-agent | Enum alignment |

### Phase 2: WASM + TS Packages (parallel with Phase 1)

| Task | Owner | Scope |
|---|---|---|
| WASM build pipeline for three crates | cleo-core / forge-ts | Build infra |
| Create `@cleocode/cant` package (WASM wrapper + interpretation) | cleo-core | New package |
| Move `ParsedDirective` to `@cleocode/contracts` | cleo-core | Type move |
| Expand `core/nexus/workspace.ts` to use `@cleocode/cant` | cleo-core | Integration |

### Phase 3: Consumer Migration (after Phase 1)

| Task | Owner | Scope |
|---|---|---|
| HttpTransport: parse LAFS envelopes | cleoos-opus-orchestrator | Conduit impl update |
| AgentPoller: parse LAFS envelopes | cleo-dev | Runtime update |
| `@codluv/llmtxt`: add `@cleocode/lafs` optional peer dep | claude-opus-llmtxt | Small change |

### Phase 4: Verification (after Phase 3)

| Task | Owner | Scope |
|---|---|---|
| E2E: CANT directive → SignalDock → Conduit → NEXUS → task mutation | versionguard-opencode | Phase E test suite |
| LAFS conformance: run `@cleocode/lafs` validators against SignalDock responses | versionguard-opencode | Conformance testing |
| Benchmark: re-run CLI vs MCP with LAFS-aligned SignalDock | forge-ts-opus | Performance validation |

---

## 12. Final Ecosystem Map

```
┌─────────────────────────── cleocode/ (PUBLIC) ───────────────────────────┐
│                                                                          │
│  crates/ (Rust SSoT)              packages/ (TypeScript)                 │
│  ┌────────────┐                   ┌──────────────────┐                   │
│  │ lafs-core  │─── WASM ────────→ │ @cleocode/lafs   │                   │
│  │            │                   │ (+ ajv, A2A)     │                   │
│  └────────────┘                   └────────┬─────────┘                   │
│  ┌────────────┐                            │                             │
│  │ conduit-   │─── WASM/gen ───→ ┌────────▼─────────┐                   │
│  │ core       │                  │ @cleocode/        │                   │
│  └────────────┘                  │ contracts         │                   │
│  ┌────────────┐                  │ (zero-dep types)  │                   │
│  │ cant-core  │─── WASM ──────→  └────────┬─────────┘                   │
│  │            │                           │                              │
│  └────────────┘              ┌────────────┼────────────┐                 │
│                              ▼            ▼            ▼                 │
│                    ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│                    │ @cleocode│  │ @cleocode│  │ @cleocode│             │
│                    │ /cant    │  │ /core    │  │ /caamp   │             │
│                    │(interp.) │  │(kernel)  │  │(hooks)   │             │
│                    └────┬─────┘  └────┬─────┘  └──────────┘             │
│                         └──────┬──────┘                                  │
│                                ▼                                         │
│                    ┌───────────────────┐                                  │
│                    │ @cleocode/cleo    │                                  │
│                    │ (CLI + MCP)       │                                  │
│                    └───────────────────┘                                  │
│                                                                          │
│  docs/concepts/CLEO-CANT.md ← canonical grammar spec                    │
│  docs/specs/CLEOCODE-ECOSYSTEM-PLAN.md ← this document                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
          │                               │
          │ git dep (lafs-core,           │ optional peer dep
          │ conduit-core, cant-core)      │ (@cleocode/lafs)
          ▼                               ▼
┌──────────────────────┐      ┌────────────────────────┐
│ signaldock-core/     │      │ llmtxt/                │
│ (PRIVATE)            │      │ (PUBLIC, @codluv)      │
│                      │      │                        │
│ crates/              │      │ crates/                │
│  signaldock-protocol │      │  llmtxt-core (Rust)    │
│  signaldock-storage  │      │ packages/              │
│  signaldock-transport│      │  core (@codluv/llmtxt) │
│  signaldock-sdk      │      │ apps/                  │
│  signaldock-payments │      │  web (llmtxt.my)       │
│ apps/                │      │                        │
│  signaldock-api      │      │                        │
│  signaldock-worker   │      │                        │
│ bindings/            │      │                        │
│  node/ (future)      │      │                        │
│  python/ (future)    │      │                        │
└──────────────────────┘      └────────────────────────┘
          │                               │
          └───────── both consume ────────┘
                         │
                    ┌────▼─────┐
                    │ CleoOS/  │
                    │(Electron)│
                    │ imports: │
                    │ @cleocode│
                    │ @codluv  │
                    └──────────┘
```

---

## 13. Canon Documents Affected

| Document | Change Needed |
|---|---|
| `CLEO-CANON-INDEX.md` | Add CLEO-CANT.md as entry 3.5 |
| `CLEO-VISION.md` | LAFS pillar updated: "LAFS is the response syntax within CANT" |
| `CLEO-CANT.md` | Update Part 6 (package architecture) to match this plan |
| `contracts/conduit.ts` | Fix JSDoc: "client-side interface, not implemented by SignalDock" |
| `NEXUS-CORE-ASPECTS.md` | Add CANT to the workshop vocabulary as "The Working Tongue" |
| `CLEO-SYSTEM-FLOW-ATLAS.md` | Update package boundary diagram to include crates/ |

---

*Plan authored by versionguard-opencode-13e7defc (The Wardens) in collaboration with the project owner. Based on direct inspection of all three repositories: cleocode/ (8 packages, 0 crates → 3 crates), signaldock-core/ (5 crates, 2 apps), llmtxt/ (1 crate, 1 package, 1 app). Cross-referenced against CLEO-CANT.md spec, ecosystem integration audit, and 300+ messages of team collaboration data.*
