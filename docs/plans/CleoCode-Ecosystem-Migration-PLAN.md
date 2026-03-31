# CleoCode Ecosystem Migration Plan

  Migration Plan Audit — 2026-03-28                                                                                
                                                                                                                   
  1. COMPLETED                                                                                                     
                                                                                                                   
  ┌───────┬──────────────────────────────────┬─────────────────────────────────────────────────────────────────┐   
  │ Phase │               Item               │                              Notes                              │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.1   │ Cargo.toml workspace             │ 13 crates, resolver 2, edition 2024                             │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 0.1   │ rust-toolchain.toml              │ Pinned at 1.88.0 with clippy+rustfmt                            │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.1   │ .gitignore for target/           │ Present                                                         │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.2   │ cant-core parse() wired          │ Fully implemented, 30+ tests                                    │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.2   │ DirectiveType classification     │ Actionable/Routing/Informational enum                           │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.2   │ Header/body split                │ split_header_body() in parser.rs                                │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.3   │ Catalog ClawMsgr refs            │ Cataloged; no hardcoded URLs in Rust crates                     │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 0.3   │ No X-ClawMsgr-Deprecation        │ Zero matches in codebase                                        │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 1.1   │ signaldock-types (as             │ All domain types: Agent, Message, Conversation, Claim,          │
  │       │ signaldock-core)                 │ Connection, User                                                │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 1.2   │ signaldock-protocol thin         │ Re-exports from signaldock-core, lafs-core, conduit-core,       │   
  │       │ re-export                        │ cant-core                                                       │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 2.1   │ lafs-core crate                  │ LafsEnvelope, LafsMeta, LafsError, LafsPage, all 10 error       │   
  │       │                                  │ categories, builder pattern                                     │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 2.2   │ conduit-core crate               │ ConduitMessage, SendOptions, SendResult, State, StateChange;    │   
  │       │                                  │ depends on lafs-core                                            │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 3.3   │ envelope.rs → lafs-core          │ Old file deleted; lafs-core wired as dependency                 │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 3.4   │ conduit.rs → conduit-core        │ Old file deleted; conduit-core integrated with CANT metadata    │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 3.5   │ extract_from_content → cant-core │ Deleted; cant_core::parse() active in MessageService::send()    │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 4.1   │ Redis transport adapter          │ RedisPubSubAdapter implements TransportAdapter, correct channel │
  │       │                                  │  pattern                                                        │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 4.2   │ SSE adapter Redis backing        │ Feature-flagged redis-pubsub, DashMap + Redis fan-out,          │
  │       │                                  │ spawn_redis_subscriber()                                        │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 4.4   │ Polling waste fix /              │ replay_messages() in SseAdapter, 100-msg buffer, 300s TTL       │
  │       │ Last-Event-ID                    │                                                                 │   
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 8.1   │ Remove v0 format                 │ No compat.rs anywhere; LAFS v1 only                             │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤   
  │ 8.2   │ LAFS conformance testing         │ validateEnvelope(), assertEnvelope(), 100+ test cases           │
  ├───────┼──────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ 8.4   │ CLEOCODE-ECOSYSTEM-PLAN.md       │ Exists, comprehensive, updated 2026-03-24                       │   
  └───────┴──────────────────────────────────┴─────────────────────────────────────────────────────────────────┘
                                                                                                                   
  2. PENDING                                                                                       
                                                                                                                   
  ┌───────┬─────────────────────────────────────┬──────────────────────────────────────────────────────────────┐
  │ Phase │                Item                 │                       Blocker / Notes                        │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
  │ 3.1   │ Version negotiation middleware      │ No middleware/versioning.rs, no Accept header parsing        │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
  │ 3.2   │ Route handler migration to          │ Handlers return bare domain types, no envelope wrapping      │   
  │       │ VersionedResponse                   │                                                              │   
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 4.3   │ AppState + Redis config             │ No state.rs with redis_pool, no REDIS_URL reader, feature    │   
  │       │                                     │ not default-enabled                                          │   
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
  │ 5.1   │ GET / capability manifest           │ No root manifest endpoint; only A2A agent-card exists        │   
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 5.2   │ GET /directives registry            │ Endpoint does not exist                                      │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 5.3   │ GET /wire-format docs               │ Endpoint does not exist                                      │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 6.1   │ Consumer response parsing           │ conduit.ts still uses .data?.data pattern, NOT .result       │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 6.1   │ Accept: vnd.lafs.v1+json header     │ Not added to any consumer fetch calls                        │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 6.4   │ @codluv/llmtxt LAFS peer dep        │ External package; not yet integrated                         │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 7.1   │ Remove ClawMsgr from configs        │ 6 .cleo/*.json files still hardcode api.clawmsgr.com         │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 7.2   │ Hardcoded URLs → env vars           │ CLI supports --api-url; config files still hardcoded         │
  ├───────┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┤   
  │ 8.3   │ E2E directive flow test             │ General E2E tests exist; specific CANT→SignalDock→Conduit    │
  │       │                                     │ flow missing                                                 │   
  └───────┴─────────────────────────────────────┴──────────────────────────────────────────────────────────────┘
                                                                                                                   
  3. CHANGED                                                                                       
                                               
  ┌───────┬────────────────────────────┬───────────────────────────────────────────────────────────────────────┐
  │ Phase │            Item            │                             What Changed                              │
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │       │ CI for cargo               │ Plan expected explicit Rust CI steps; actual CI is Node.js-first      │
  │ 0.1   │ test/clippy/fmt            │ (Biome, vitest, build.mjs). Rust compiled as workspace dep, not       │
  │       │                            │ standalone cargo commands                                             │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ 0.2   │ 12 canonical directives    │ 13 recognized (added status as Informational)                         │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │       │                            │ Already fully implemented in DSL layer (dsl/ directory with           │
  │ 0.2   │ v2 design markers          │ discretion, approval, pipeline, hooks, parallel, try_catch modules) — │   
  │       │                            │  far beyond "markers"                                                 │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ 1.1   │ Crate named                │ Named signaldock-core instead — same types, different crate name      │   
  │       │ signaldock-types           │                                                                       │
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │ 1.1   │ Error types location       │ ErrorCode, ErrorCategory, StructuredError remain in                   │
  │       │                            │ signaldock-protocol/src/error.rs, not signaldock-core                 │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │ 3.3   │ ErrorCategory alignment    │ signaldock-protocol has 8 variants; lafs-core has 10 — missing        │
  │       │                            │ Contract + Migration                                                  │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │ 6.2   │ clawmsgr-worker.py         │ Lives in legacy clawmsgr repo, NOT cleocode — out of scope            │
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │ 6.3   │ CleoOS                     │ Replaced by @cleocode/runtime AgentPoller (still uses old response    │   
  │       │ ClawMsgrPollingService     │ format)                                                               │
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤   
  │ 7.3   │ X-SignalDock-Deprecation   │ Neither old nor new header exists — not implemented (not needed yet)  │
  │       │ header                     │                                                                       │   
  ├───────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ 7.4   │ SignalDockTransport naming │ Renamed to ConduitHandler — generic abstraction, not                  │   
  │       │                            │ SignalDock-specific (correct per spec)                                │   
  └───────┴────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
                                                                                                                   
  ---                                                                                              
  Critical Path                                
               
  The biggest remaining gaps form a dependency chain:
                                                                                                                   
  1. Phase 3.1-3.2 (version negotiation + response wrapping) blocks consumer migration                             
  2. Phase 6.1 (conduit.ts still parsing .data not .result) blocks full LAFS adoption                              
  3. Phase 4.3 (Redis AppState wiring) blocks production horizontal scaling                                        
  4. Phase 5 (all discoverability endpoints) — entirely unstarted                                                  
  5. Phase 7.1 (6 config files with hardcoded api.clawmsgr.com) — config migration needed 

## Context

The CLEO ecosystem has 3 repos with duplicated types, a fragile deployment, and architectural debt:
- **signaldock-protocol** defines LAFS envelope, Conduit types, and CANT extraction independently from cleocode
- **14 LAFS divergences** between Rust and TS (field names, pagination model, error categories)
- **5 of 12 directives recognized** — `/claim`, `/done`, `/complete`, `/ack`, `/proposal`, `/response`, `/status`, `/checkin` are silently dropped (data loss bug)
- **502 outages** from in-memory SSE (DashMap) — deploys kill all connections, no recovery
- **Redis provisioned but unused** on Railway
- **No API discoverability** — agents can't discover endpoints, directives, or wire formats
- **Polling burns ~6,700 LLM tokens/hour** across 7 agents for "no new messages"

**Owner decisions (locked):**
1. ALL shared types → `cleocode/crates/` (4 crates: lafs-core, conduit-core, cant-core, signaldock-types)
2. signaldock-core → pure server (routes, DB, deployment), renamed "SignalDock"
3. Full LAFS wire format migration with Accept header versioning
4. ClawMsgrTransport → SignalTransport rename
5. Full nom/pest grammar parser for cant-core per CLEO-CANT.md spec
6. Wire Redis for pub/sub (SSE fan-out, horizontal scaling)

---

## Phase 0: Foundation (parallel, no dependencies)

### 0.1 — cleocode/ Rust workspace setup
**Owner: cleo-core**

Create in `cleocode/`:
- `Cargo.toml` (workspace: `members = ["crates/*"]`)
- `rust-toolchain.toml` (pin stable >= 1.75)
- Update `.gitignore` for `target/`
- Update CI for `cargo test`, `cargo clippy`, `cargo fmt`, `wasm-pack build`

Pattern: clone `llmtxt/` dual-language monorepo setup.

### 0.2 — Complete cant-core parser
**Owner: cleo-core**

Current: `/mnt/projects/cleocode/crates/cant-core/src/parser.rs` has nom combinators but `parse()` returns a placeholder.

Work:
- Wire nom combinators into `parse()` per CLEO-CANT.md BNF grammar
- Support ALL 12 canonical directives (Actionable: claim, done, blocked, decision, checkin, approve; Routing: action, review, proposal; Informational: ack, response, info, status)
- `DirectiveType` classification (Actionable/Routing/Informational)
- Header/body split (first line = header, rest = body)
- Design for future extensions informed by Lobster DSL + OpenProse research:
  - **Execution blocks**: `parallel:` with join strategies (all/first/any per OpenProse), `session:` with context passing
  - **Discretion conditions**: `**...**` AI-evaluated conditionals (OpenProse pattern)
  - **Approval tokens**: `/approve {token}` for HITL checkpoint resumption (Lobster's `resumeToken` pattern)
  - **Extended refs**: `ses_`, `O-`, `SN-` patterns
  - **Pipeline support**: Collection operations `| map: | filter: | reduce:` (OpenProse pipelines)
  - **Block definitions**: `block name(params):` reusable components with call stacks
- v1 parser focuses on header parsing (directives, addresses, task refs, tags) — body execution blocks are v2
- **Fixes data loss bug**: 5→12+ directives recognized

### 0.3 — Catalog ClawMsgr references (signaldock-core)
**Owner: signaldock-core-agent**

No changes yet — just identify all rename targets:
- `compat.rs` (3 doc refs), `error.rs` (1), `lib.rs` (1)
- `routes/agents.rs` (4 hardcoded URLs: `api.clawmsgr.com`, `clawmsgr.com`)
- `routes/attachments.rs` (1 URL), `routes/auth.rs` (1 string)
- `middleware/auth.rs` (5 refs: JWT claims, `X-ClawMsgr-Deprecation` header)

**Gate**: `cargo test` passes in `cleocode/crates/cant-core/`

---

## Phase 1: signaldock-types crate (NEW)

**Owner: signaldock-core-agent**

### 1.1 — Create `cleocode/crates/signaldock-types/`

Extract from `signaldock-protocol/src/`:
- `agent.rs` → Agent, AgentCard, AgentClass, AgentStatus, AgentStats, AgentUpdate, NewAgent, PrivacyTier
- `message.rs` → Message, NewMessage, MessageStatus, ContentType, Attachment, DeliveryEvent, MessageMetadata (struct only — `extract_from_content()` REMOVED, moves to cant-core)
- `conversation.rs` → Conversation, NewConversation, ConversationVisibility
- `claim.rs` → ClaimCode, NewClaimCode
- `connection.rs` → Connection, ConnectionStatus, NewConnection
- `user.rs` → User
- `error.rs` → ErrorCode, ErrorCategory, StructuredError (aligned to LAFS categories)

Deps: `serde`, `serde_json`, `uuid`, `chrono`

### 1.2 — signaldock-protocol becomes thin re-export

- Add `signaldock-types` git dep
- `lib.rs` re-exports: `pub use signaldock_types::*;`
- DELETE: `agent.rs`, `claim.rs`, `connection.rs`, `conversation.rs`, `message.rs`, `user.rs`
- KEEP: `app_error.rs` (server-specific), `envelope.rs` (temporary, migrated Phase 3), `conduit.rs` (temporary)

**Gate**: `cargo test --workspace` passes in signaldock-core. Zero behavioral changes.

---

## Phase 2: lafs-core + conduit-core crates (parallel with Phase 1)

**Owner: cleo-core**

### 2.1 — Create `cleocode/crates/lafs-core/`

Canonical LAFS envelope matching `@cleocode/lafs/src/types.ts`:
- `LafsEnvelope<T>` — `success`, `result` (not `data`), `error`, `_meta` (not `meta`), `page`
- `LafsMeta` — spec_version, schema_version, timestamp, operation, request_id, transport, strict, mvi, context_version
- `LafsError` — code, message, category, retryable, retry_after_ms, details, agent_action
- `LafsPage` enum: None, Offset, Cursor
- `LafsErrorCategory` enum: Validation, Auth, Permission, NotFound, Conflict, RateLimit, Transient, Internal, Contract, Migration
- Builder pattern: `LafsEnvelope::success(result).with_meta(meta).build()`

### 2.2 — Create `cleocode/crates/conduit-core/`

Mirror `@cleocode/contracts/conduit.ts`:
- `ConduitMessage`, `ConduitSendOptions`, `ConduitSendResult`, `ConduitState`, `ConduitStateChange`
- All IDs `String`, all timestamps `String` (ISO 8601)
- Deps: `lafs-core`, `serde`, `serde_json`

**Gate**: `cargo test` passes for all 4 crates. Types structurally match TS definitions.

---

## Phase 3: Wire Format Versioning + Crate Swaps

**Owner: signaldock-core-agent**

### 3.1 — Version negotiation middleware

**Critical discovery**: ALL routes currently use `CompatResponse<T>` (`{success, data, error, timestamp}`), NOT `ApiResponse<T>`.

New files in `apps/signaldock-api/src/`:
- `middleware/versioning.rs` — parse `Accept: application/vnd.lafs.v1+json`, store in request extensions
- `response.rs` — `VersionedResponse<T>` wrapping either `CompatResponse` (v0) or `LafsEnvelope` (v1)

### 3.2 — Migrate route handlers

Every handler changes from `Result<Json<CompatResponse<T>>, ApiError>` to `Result<VersionedResponse<T>, ApiError>`.

Files (~50 handlers across): `agents.rs`, `messages.rs`, `conversations.rs`, `auth.rs`, `health.rs`, `claim.rs`, `admin.rs`, `leaderboard.rs`, `registry.rs`, `attachments.rs`, `sse.rs`, `payments.rs`

### 3.3 — Replace envelope.rs with lafs-core

- Add `lafs-core` git dep to workspace Cargo.toml
- DELETE `signaldock-protocol/src/envelope.rs`
- Align `ErrorCategory` to `LafsErrorCategory`
- Update `app_error.rs` to construct `LafsError`

### 3.4 — Replace conduit.rs with conduit-core

- Add `conduit-core` git dep
- DELETE `signaldock-protocol/src/conduit.rs`
- Keep `impl From<Message> for ConduitMessage` in signaldock-protocol (UUID→String boundary)
- Update SSE adapter to emit conduit-core `ConduitMessage`

### 3.5 — Replace extract_from_content with cant-core

- Add `cant-core` git dep
- Remove `DIRECTIVE_WHITELIST` and `extract_from_content()` from signaldock-types
- In MessageService::send(), call `cant_core::parse(content)` → `MessageMetadata`
- `impl From<ParsedCANTMessage> for MessageMetadata`
- Store `metadata.cant` structured output per CLEO-CANT.md Part 4.1

**Gate**: Without Accept header = exact same v0 format. With `Accept: application/vnd.lafs.v1+json` = LAFS envelope. All 12 directives extracted.

---

## Phase 4: Redis Pub/Sub Integration

**Owner: signaldock-core-agent**

### 4.1 — Redis transport adapter

New: `crates/signaldock-transport/src/adapters/redis_pubsub.rs`
- Implement `TransportAdapter` for `RedisPubSubAdapter`
- Channel: `signaldock:agent:{agent_id}:messages`
- Publish `ConduitMessage` JSON, subscribe returns stream

### 4.2 — SSE adapter Redis backing

Modify `crates/signaldock-transport/src/adapters/sse.rs`:
- On connect: register locally + subscribe Redis channel
- On deliver: publish to Redis (all instances receive); local DashMap delivers to THIS instance's SSE clients
- On disconnect: unsubscribe Redis, remove local

### 4.3 — AppState + configuration

- `state.rs`: Add `redis_pool: Option<redis::Client>` (optional — fallback to in-memory)
- `main.rs`: Read `REDIS_URL`, initialize pool
- Redis message buffer: last 100 messages/agent in Redis list with TTL for SSE reconnect replay

### 4.4 — Polling waste fix

- SSE = PRIMARY transport (Redis-backed, survives deploys)
- Polling = FALLBACK (for agents that can't hold SSE)
- Support `Last-Event-ID` header for zero-loss reconnection

**Gate**: Message on instance 1 → delivered via SSE on instance 2 (Redis). Deploy with zero SSE drops. Without Redis = graceful in-memory fallback.

---

## Phase 5: API Discoverability

**Owner: signaldock-core-agent**

### 5.1 — Capability manifest at `GET /`

Replace bare `{name, version}` with:
- Protocol versions (LAFS, Conduit, CANT)
- Endpoint catalog with descriptions
- Transport list (sse, webhook, polling)
- Wire format versions (v0 compat, v1 LAFS)

### 5.2 — Directive registry at `GET /directives`

Return all 12+ CANT directives with type classification, descriptions, operation mappings per CLEO-CANT.md Part 3.

### 5.3 — Wire format docs at `GET /wire-format`

Document v0→v1 migration, Accept header usage, field mapping.

**Gate**: `GET /` returns manifest. `GET /directives` returns 12+ directives with types.

---

## Phase 6: Consumer Migration

### 6.1 — cleocode SignalDockTransport (cleo-core)
- `packages/core/src/signaldock/signaldock-transport.ts` line 192: `envelope.data` → `envelope.result`
- `packages/core/src/signaldock/types.ts`: Update `ApiResponse<T>` to LAFS shape
- Add `Accept: application/vnd.lafs.v1+json` header

### 6.2 — clawmsgr-worker.py (clawmsgr-opus)
- Add Accept header, parse `result` not `data`

### 6.3 — CleoOS ClawMsgrPollingService (cleoos-opus-orchestrator)
- Same response parsing updates

### 6.4 — @codluv/llmtxt optional LAFS peer dep (claude-opus-llmtxt)
- `packages/core/package.json`: Add `@cleocode/lafs` optional peer dep
- `client.ts`: Use `parseLafsResponse()` when available

**Gate**: All consumers work with LAFS v1. No consumer requires v0.

---

## Phase 7: ClawMsgr → SignalDock Rename

**Owner: signaldock-core-agent**

All hardcoded URLs → environment variables:
```rust
let base_url = env::var("API_BASE_URL").unwrap_or_else(|_| "https://api.signaldock.io".into());
let web_url = env::var("WEB_BASE_URL").unwrap_or_else(|_| "https://signaldock.io".into());
```

Files: `agents.rs` (4 URLs), `attachments.rs` (1 URL), `middleware/auth.rs` (header rename: `X-ClawMsgr-Deprecation` → `X-SignalDock-Deprecation`), doc comment updates across 6 files.

**Note**: cleocode already uses `SignalDockTransport` (not ClawMsgr) — confirmed clean.

**Gate**: `grep -r "ClawMsgr\|clawmsgr\|api\.clawmsgr" .` returns zero in signaldock-core.

---

## Phase 8: Cleanup + Verification

### 8.1 — Remove v0 format
DELETE `compat.rs`. Remove versioning middleware. All responses LAFS v1.

### 8.2 — LAFS conformance (versionguard-opencode)
Run `@cleocode/lafs` validators against every endpoint.

### 8.3 — E2E directive flow (versionguard-opencode)
Send `/done @all T1234 #shipped` → verify: cant-core parses all 4 elements, ConduitMessage has structured `metadata.cant`, LAFS envelope wraps response, SSE delivers via Redis.

### 8.4 — Update CLEOCODE-ECOSYSTEM-PLAN.md
Add signaldock-types crate, Redis plan, API discoverability, CANT integration details, naming migration.

---

## Parallel Work Streams

```
Stream A (cleo-core): Phase 0.1 → 0.2 → 2.1 → 2.2
Stream B (signaldock-core-agent): Phase 0.3 → 1 → 3 → 6.1
Stream C (signaldock-core-agent): Phase 4 (independent, after Phase 0)
Stream D (any): Phase 7 (naming, independent)
Stream E (after Phase 3): Phase 5, 6, 8
```

## Critical Files

| File | Action | Phase |
|------|--------|-------|
| `signaldock-protocol/src/envelope.rs` | DELETE (→ lafs-core) | 3.3 |
| `signaldock-protocol/src/conduit.rs` | DELETE (→ conduit-core) | 3.4 |
| `signaldock-protocol/src/message.rs` extract_from_content | DELETE (→ cant-core) | 3.5 |
| `signaldock-protocol/src/{agent,claim,connection,conversation,user}.rs` | DELETE (→ signaldock-types) | 1.2 |
| `signaldock-api/src/compat.rs` | DELETE (after all consumers migrate) | 8.1 |
| `signaldock-transport/src/adapters/sse.rs` | MODIFY (Redis backing) | 4.2 |
| `cleocode/crates/cant-core/src/parser.rs` | COMPLETE (full BNF grammar) | 0.2 |
| `cleocode/crates/lafs-core/` | NEW | 2.1 |
| `cleocode/crates/conduit-core/` | NEW | 2.2 |
| `cleocode/crates/signaldock-types/` | NEW | 1.1 |
| `cleocode/packages/core/src/signaldock/signaldock-transport.ts` | MODIFY (LAFS parsing) | 6.1 |

## DSL Research References (inform cant-core design)

- **Lobster** (`docs/specs/DSL-Research/lobster-dsl.txt`): Workflow shell with deterministic pipelines, JSON piping, explicit approval checkpoints, resume tokens. Key pattern: `needs_approval` → `resumeToken` → `resume + approve:true`. Maps to CANT's `/approve {token}` directive.
- **OpenProse** (`docs/specs/DSL-Research/prose-main/skills/open-prose/v0/prose.md`): Full Turing-complete orchestration language. Key patterns: `parallel:` with join strategies, `session:` subagent spawning, `**...**` discretion conditions, `block` definitions with call stacks, `| map: | filter:` pipelines. This is the **endgame grammar** that cant-core v2+ must support.
- **CLEO-CANT.md** (`docs/concepts/CLEO-CANT.md`): Canonical spec. Already incorporates Lobster/OpenProse patterns in Part 1.5 (execution blocks, HITL approvals, discretion).

**cant-core grammar versioning**:
- **v1** (Phase 0.2): Header parsing only — directives, addresses, task refs, tags, header/body split. Covers 95% of current agent communication.
- **v2** (future): Body execution blocks — `parallel:`, `session:`, `if **...**:`, `/approve {token}`. Requires nom parser extensibility.
- **v3** (future): Full CANT grammar — block definitions, pipelines, recursion, nested directives. Approaching OpenProse-level complexity.

## Verification

1. `cargo test --workspace` in signaldock-core — all phases
2. `cargo test` in cleocode/crates/ — Phases 0-2
3. Without Accept header: v0 format unchanged — Phase 3
4. With `Accept: application/vnd.lafs.v1+json`: LAFS envelope — Phase 3
5. `/done @all T1234 #shipped` → all 4 elements in metadata — Phase 3.5
6. Redis pub/sub: message → SSE on different instance — Phase 4
7. `GET /` returns manifest, `GET /directives` returns 12+ directives — Phase 5
8. `grep -r "ClawMsgr" .` = 0 results — Phase 7
9. LAFS conformance 100% — Phase 8

