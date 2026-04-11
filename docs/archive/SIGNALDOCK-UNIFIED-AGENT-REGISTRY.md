# Unified Agent Registry & Conduit Transport Architecture

> **Status**: DRAFT — requires cleo-core review + owner sign-off
> **Author**: signaldock-dev
> **Date**: 2026-03-25
> **Scope**: Agent credential management, transport architecture, naming normalization, polling integration

---

## 1. Problem Statement

Agent credentials are stored as loose JSON files scattered across project roots. There is no typed interface, no CRUD operations, no credential lifecycle management, and no provider-agnostic agent registry. Transport implementations are tangled with provider-specific concerns. Documentation still references defunct "ClawMsgr" naming.

**This spec replaces all of that with:**
1. A per-project credential store in `.cleo/tasks.db`
2. A layered Conduit + Transport adapter architecture
3. Polling/messaging as a Core dispatch capability (no standalone scripts)
4. Complete naming normalization
5. A Rust `signaldock-poll` binary for non-Node environments
6. Clean cutover — no deprecations, no legacy support

---

## 2. Design Principles

1. **CleoCode is SSoT** — all canonical types, interfaces, and implementations live in `cleocode/`. Everything else is a consumer.
2. **Provider-agnostic** — agents are NOT tied to a provider. Any agent can load on any provider (Claude Code, OpenCode, Codex, Kimi).
3. **Clean cut** — no deprecation periods, no backward compatibility shims. Old patterns are deleted.
4. **DRY + SOLID** — one interface, one implementation path, no duplication.
5. **Local-first, cloud-optional** — the registry works offline. Cloud sync is additive.
6. **Batteries included** — polling is a Core capability, not a standalone script.

---

## 3. Unified Agent Registry

### 3.1 Schema (`agent_credentials` table in `.cleo/tasks.db`)

```sql
CREATE TABLE agent_credentials (
    agent_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io',
    classification TEXT,
    privacy_tier TEXT NOT NULL DEFAULT 'public',
    capabilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]',
    transport_config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

**Key decisions:**
- No `provider` column — agents are provider-agnostic
- `transport_config` is JSON for transport-specific settings (poll interval, SSE endpoint, WebSocket URL)
- `api_key_encrypted` stored encrypted at rest (see Section 3.6)
- Per-project scoped — each `.cleo/tasks.db` has its own registry

### 3.2 Contract Interface (`@cleocode/contracts`)

```typescript
/** A registered agent's credentials and profile. */
export interface AgentCredential {
    agentId: string;
    displayName: string;
    apiKey: string;
    apiBaseUrl: string;
    classification?: string;
    privacyTier: 'public' | 'discoverable' | 'private';
    capabilities: string[];
    skills: string[];
    transportConfig: TransportConfig;
    isActive: boolean;
    lastUsedAt?: string;
    createdAt: string;
    updatedAt: string;
}

/** Transport-specific configuration. */
export interface TransportConfig {
    pollIntervalMs?: number;
    sseEndpoint?: string;
    wsUrl?: string;
    pollEndpoint?: string;
}

/** CRUD + lifecycle operations for agent credentials. */
export interface AgentRegistryAPI {
    register(credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>): Promise<AgentCredential>;
    get(agentId: string): Promise<AgentCredential | null>;
    list(filter?: { active?: boolean }): Promise<AgentCredential[]>;
    update(agentId: string, updates: Partial<AgentCredential>): Promise<AgentCredential>;
    remove(agentId: string): Promise<void>;
    rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }>;
    getActive(): Promise<AgentCredential | null>;
    markUsed(agentId: string): Promise<void>;
}
```

### 3.3 Implementation Location

| Component | Package | Path |
|---|---|---|
| Types (`AgentCredential`, `AgentRegistryAPI`) | `@cleocode/contracts` | `packages/contracts/src/agent-registry.ts` |
| SQLite implementation | `@cleocode/core` | `packages/core/src/store/agent-registry-accessor.ts` |
| CLI commands | `@cleocode/cleo` | `packages/cleo/src/commands/agent.ts` |

### 3.4 CLI Commands

```bash
cleo agent register --id my-agent --name "My Agent" --api-key sk_live_...
cleo agent list
cleo agent get my-agent
cleo agent rotate-key my-agent
cleo agent remove my-agent
cleo agent sync                    # Pull from SignalDock cloud, update local
cleo agent poll                    # One-shot message check
cleo agent watch                   # Persistent polling/SSE (batteries-included)
cleo agent send --to other-agent "Hello"
cleo agent connect                 # SSE/WebSocket persistent connection
```

### 3.5 Cloud Sync

```
Local (embedded SignalDock)              Cloud (api.signaldock.io)
┌────────────────────────────┐          ┌──────────────────────┐
│ signaldock-storage         │          │ signaldock-storage    │
│ agents table (local canon) │ ──sync──→│ agents table (cloud)  │
│ messages, conversations    │ ←─sync──│ cross-device messages │
│ agent_credentials (creds)  │          │                      │
│                            │          │ Enforces tier limits  │
│ Works fully offline        │          │ Free: 1 agent/project │
└────────────────────────────┘          └──────────────────────┘
```

**Local is canonical for that machine.** Agents are created locally first (via embedded SignalDock storage). Cloud registration is optional:

- `cleo agent register` → creates locally in embedded SignalDock → optionally POST /agents on cloud (if connected + within tier limits)
- `cleo agent sync` → bi-directional sync of agent profiles and messages (paid tier only)
- `cleo agent rotate-key` → rotates locally → pushes to cloud if synced
- **Offline**: full functionality — local agents talk to each other via embedded SignalDock. Zero cloud dependency for single-machine use.

### 3.6 API Key Encryption

API keys (`sk_live_*`) are encrypted at rest in SQLite using AES-256-GCM.

**Key derivation:**
- A per-project encryption key is derived from a machine-specific secret
- The machine secret is stored at `~/.local/share/cleo/machine-key` (created on first use, 32 random bytes)
- Per-project key = `HMAC-SHA256(machine-key, project-path)`
- This means: keys are bound to the machine AND the project. Moving `.cleo/tasks.db` to another machine renders stored keys unreadable.

**Implementation:** Core needs a small `crypto` utility module:
- `encrypt(plaintext: string, projectPath: string): string` — returns base64-encoded ciphertext
- `decrypt(ciphertext: string, projectPath: string): string` — returns plaintext
- Uses Node.js built-in `crypto` module (no external deps)

**If `~/.local/share/cleo/machine-key` doesn't exist:** auto-generate on first `cleo agent register`. No user prompt.

**File permissions**: `0600` (owner read/write only). Set on creation. If permissions are wrong, warn and refuse to read.

**Recovery path**: If the machine-key is lost (reinstall, disk failure), stored credentials become unreadable. Recovery:
1. Delete the corrupted `agent_credentials` rows from `.cleo/tasks.db`
2. Re-register agents: `cleo agent register --id {id} --name {name} --api-key {key}` (requires knowing the API key)
3. Or rotate keys on the cloud: `cleo agent rotate-key {id}` (generates new key, stores with new encryption)

This is **intentionally non-recoverable without the key or cloud access** — a security feature, not a bug. Moving `.cleo/tasks.db` to another machine without the machine-key renders credentials unusable.

---

## 4. Transport Architecture (Layered)

### 4.1 The Two Layers

```
┌────────────────────────────────────────────────────┐
│  Conduit (HIGH-LEVEL INTERFACE)                     │
│  @cleocode/contracts — conduit.ts                   │
│                                                     │
│  Methods: send(), onMessage(), heartbeat(),         │
│           connect(), disconnect(), getState()       │
│  Concern: WHAT the agent wants to do                │
└─────────────────────┬──────────────────────────────┘
                      │ delegates to
┌─────────────────────▼──────────────────────────────┐
│  Transport (LOW-LEVEL ADAPTER)                      │
│  @cleocode/contracts — transport.ts                 │
│                                                     │
│  Methods: poll(), push(), subscribe(), ack()        │
│  Concern: HOW messages move over the wire           │
│                                                     │
│  Implementations:                                   │
│    HttpTransport   — HTTP polling (cloud)            │
│    WsTransport     — WebSocket (local)               │
│    SseTransport    — Server-Sent Events (real-time)  │
└────────────────────────────────────────────────────┘
```

### 4.2 Transport Adapter Interface (`@cleocode/contracts`)

```typescript
/** Low-level wire transport for agent messaging. */
export interface Transport {
    readonly name: string;

    /** Connect to the messaging backend. */
    connect(config: TransportConfig & {
        agentId: string;
        apiKey: string;
        apiBaseUrl: string;
    }): Promise<void>;

    /** Disconnect from the messaging backend. */
    disconnect(): Promise<void>;

    /** Send a message payload. */
    push(to: string, content: string, options?: {
        conversationId?: string;
        replyTo?: string;
    }): Promise<{ messageId: string }>;

    /** Poll for new messages (non-destructive). */
    poll(options?: {
        limit?: number;
        since?: string;
    }): Promise<ConduitMessage[]>;

    /** Acknowledge processed messages. */
    ack(messageIds: string[]): Promise<void>;

    /** Subscribe to real-time events (SSE/WebSocket). Returns unsubscribe. */
    subscribe?(handler: (message: ConduitMessage) => void): () => void;
}
```

### 4.3 Conduit Implementation (`@cleocode/core`)

```typescript
/** Conduit wraps a Transport, adding high-level messaging semantics. */
export class ConduitClient implements Conduit {
    private transport: Transport;
    private credential: AgentCredential;
    private state: ConduitState = 'disconnected';

    constructor(transport: Transport, credential: AgentCredential) {
        this.transport = transport;
        this.credential = credential;
    }

    get agentId(): string {
        return this.credential.agentId;
    }

    async connect(): Promise<void> {
        this.state = 'connecting';
        await this.transport.connect({
            agentId: this.credential.agentId,
            apiKey: this.credential.apiKey,
            apiBaseUrl: this.credential.apiBaseUrl,
            ...this.credential.transportConfig,
        });
        this.state = 'connected';
    }

    async send(to: string, content: string, options?: ConduitSendOptions): Promise<ConduitSendResult> {
        const result = await this.transport.push(to, content, {
            conversationId: options?.threadId,
        });
        return {
            messageId: result.messageId,
            deliveredAt: new Date().toISOString(),
        };
    }

    onMessage(handler: (message: ConduitMessage) => void): ConduitUnsubscribe {
        // Prefer real-time subscription if transport supports it
        if (this.transport.subscribe) {
            return this.transport.subscribe(handler);
        }
        // Fallback: polling loop
        const interval = setInterval(async () => {
            const messages = await this.transport.poll();
            for (const msg of messages) handler(msg);
            if (messages.length > 0) {
                await this.transport.ack(messages.map(m => m.id));
            }
        }, this.credential.transportConfig.pollIntervalMs ?? 5000);
        return () => clearInterval(interval);
    }

    async heartbeat(): Promise<void> {
        await this.transport.push(this.credential.agentId, '', {});
    }

    async isOnline(agentId: string): Promise<boolean> {
        // Delegate to cloud API check
        return true; // Stub — implement via GET /agents/{id}/online
    }

    async disconnect(): Promise<void> {
        await this.transport.disconnect();
        this.state = 'disconnected';
    }

    getState(): ConduitState {
        return this.state;
    }
}
```

### 4.4 Transport Implementations

| Transport | Class | Wire Protocol | Use Case |
|---|---|---|---|
| `HttpTransport` | `@cleocode/core` | HTTP polling + REST | Cloud SignalDock, or local-to-cloud messaging |
| `LocalTransport` | `@cleocode/core` | In-process (napi-rs) | Embedded SignalDock — direct Rust calls, no HTTP |
| `SseTransport` | `@cleocode/core` | Server-Sent Events | Real-time cloud event streaming |
| `WsTransport` | `@cleocode/core` | WebSocket | Future — local SignalDock over network |

**Default behavior**: When running locally with embedded SignalDock, the factory creates `LocalTransport` (in-process napi-rs calls — zero network overhead). When connecting to a remote cloud instance, it creates `HttpTransport` or `SseTransport`.

### 4.5 Factory

```typescript
/** Creates a Conduit instance from the agent registry. */
export async function createConduit(
    registry: AgentRegistryAPI,
    agentId?: string,
): Promise<Conduit> {
    const credential = agentId
        ? await registry.get(agentId)
        : await registry.getActive();

    if (!credential) throw new Error('No agent credential found');

    const transport = resolveTransport(credential);
    const conduit = new ConduitClient(transport, credential);
    await conduit.connect();
    return conduit;
}

function resolveTransport(credential: AgentCredential): Transport {
    // Priority: Local (in-process) > WebSocket > SSE > HTTP polling
    // LocalTransport is only available when napi-rs native addon is loaded
    if (isNapiAvailable() && !credential.apiBaseUrl.startsWith('http')) {
        return new LocalTransport(); // In-process, zero network
    }
    if (credential.transportConfig.wsUrl) return new WsTransport();
    if (credential.transportConfig.sseEndpoint) return new SseTransport();
    return new HttpTransport(); // Default: HTTP polling to cloud
}

function isNapiAvailable(): boolean {
    try { require('@cleocode/signaldock-sdk'); return true; }
    catch { return false; } // napi-rs addon not built/installed
}
```

---

## 5. Polling as a Core Dispatch Capability

### 5.1 No Standalone Worker Scripts

The Python `clawmsgr-worker.py` is **eliminated**. Polling is a Core dispatch capability available through `@cleocode/cleo` CLI commands and programmatically through the Conduit API.

### 5.2 CLI Dispatch Commands

```bash
# One-shot: check for messages, print, exit
cleo agent poll

# Persistent: poll/SSE in background, deliver to active session
cleo agent watch

# Persistent: SSE/WebSocket direct connection
cleo agent connect
```

All three commands:
1. Read credentials from `AgentRegistryAPI` (no JSON files)
2. Create a `Transport` (HttpTransport for cloud, WsTransport for local)
3. Poll or subscribe depending on transport capability
4. Deliver messages to stdout (CLI) or to the active session context

### 5.3 `cleo agent watch` Implementation

The `watch` command delegates to `@cleocode/runtime`. The CLI command is a thin wrapper:

```typescript
// In @cleocode/cleo — thin dispatch to runtime
export async function agentWatchCommand(cleo: Cleo): Promise<void> {
    const runtime = await cleo.runtime();
    await runtime.start();
    process.on('SIGINT', async () => { await runtime.stop(); process.exit(0); });
}
```

The actual polling logic lives in `@cleocode/runtime`:

```typescript
// In @cleocode/runtime
export async function agentWatch(registry: AgentRegistryAPI): Promise<void> {
    const credential = await registry.getActive();
    if (!credential) throw new Error('No active agent. Run: cleo agent register');

    const conduit = await createConduit(registry, credential.agentId);

    // Use onMessage — it auto-selects SSE or polling fallback
    conduit.onMessage((msg) => {
        // Format and output for the provider to consume
        console.log(JSON.stringify({
            type: 'signaldock:message',
            from: msg.from,
            content: msg.content,
            metadata: msg.metadata,
            timestamp: msg.timestamp,
        }));
    });

    // Keep alive until interrupted
    process.on('SIGINT', async () => {
        await conduit.disconnect();
        process.exit(0);
    });
}
```

### 5.4 Non-Node Environments: Rust `signaldock-poll` Binary

For agents running in pure Python or other non-Node environments, a minimal Rust binary provides the same polling capability:

**Source**: `signaldock/bindings/poll/` (compiled from signaldock-transport crate via git dep)

**Usage**:
```bash
# One-shot poll
signaldock-poll --agent-id my-agent --api-key sk_live_... --once

# Persistent watch
signaldock-poll --agent-id my-agent --api-key sk_live_... --watch --interval 12

# Read credentials from local registry (if cleo is installed)
signaldock-poll --from-registry my-agent
```

**Characteristics**:
- Single static binary, no runtime dependencies
- Compiled from the same `signaldock-transport` Rust crate used by the server
- Uses `HttpTransport` (polling) or SSE depending on `--sse` flag
- Outputs JSON to stdout (same format as `cleo agent watch`)
- Cross-platform: Linux, macOS, Windows

**Build**: Part of the signaldock-core CI, published as GitHub release artifacts.

---

## 6. Directory Structure (Rename: `signaldock/` → `conduit/`)

### 6.1 Rationale

The `packages/core/src/signaldock/` directory is misnamed. It contains the **Conduit implementation** — the high-level messaging abstraction. "SignalDock" is the cloud service (a specific backend); "Conduit" is the CLEO communication layer that can talk to ANY backend.

### 6.2 Rename Map

```
BEFORE:
packages/core/src/signaldock/
├── index.ts                    → DELETE (rewrite)
├── types.ts                    → DELETE (types move to contracts)
├── transport.ts                → DELETE (interface moves to contracts/transport.ts)
├── factory.ts                  → MOVE to conduit/factory.ts
├── signaldock-transport.ts     → RENAME to conduit/http-transport.ts
├── claude-code-transport.ts    → DELETE (provider-specific, not needed)
└── __tests__/                  → MOVE to conduit/__tests__/

AFTER:
packages/core/src/conduit/
├── index.ts                    # Exports: ConduitClient, createConduit, HttpTransport
├── conduit-client.ts           # ConduitClient class (implements Conduit interface)
├── http-transport.ts           # HttpTransport (HTTP polling to cloud SignalDock)
├── ws-transport.ts             # WsTransport stub (WebSocket to local, future)
├── sse-transport.ts            # SseTransport stub (SSE real-time, future)
├── factory.ts                  # createConduit() factory
└── __tests__/
    ├── conduit-client.test.ts
    ├── http-transport.test.ts
    └── factory.test.ts
```

### 6.3 What Moves Where

| Old Location | New Location | Notes |
|---|---|---|
| `signaldock/types.ts` (AgentTransport interface) | `contracts/transport.ts` | Interface goes to contracts |
| `signaldock/types.ts` (Agent, Message, etc.) | Already in contracts | Types already defined elsewhere |
| `signaldock/transport.ts` (AgentTransport) | `contracts/transport.ts` | Merged with above |
| `signaldock/signaldock-transport.ts` | `conduit/http-transport.ts` | Rename — it's the HTTP adapter |
| `signaldock/claude-code-transport.ts` | DELETED | No provider-specific transports |
| `signaldock/factory.ts` | `conduit/factory.ts` | Uses registry instead of config scanning |

---

## 7. Naming Normalization (Clean Cut)

### 7.1 Delete (no replacement needed)

| What | Why |
|---|---|
| `ClawMsgrPollingService` (JSDoc) | Never existed as code. Replaced by `ConduitClient` + `HttpTransport` |
| `ClawMsgrTransport` (JSDoc) | Never existed in cleocode. Was only in CleoOS |
| `ClawMsgrWorker` (JSDoc) | Replaced by `cleo agent watch` |
| `ClaudeCodeTransport` (code) | No provider-specific transports in Core |
| `clawmsgr-worker.py` | Stays in clawmsgr repo as legacy v1. NOT in cleocode |
| All `clawmsgr-*.json` files | Replaced by `agent_credentials` table |

### 7.2 Files to DELETE in cleocode/

```
clawmsgr-agent.json
clawmsgr-cleocode-lead.json
.cleo/clawmsgr-cleo-dev.json
packages/core/src/signaldock/claude-code-transport.ts
packages/core/src/signaldock/types.ts (after types moved to contracts)
packages/core/src/signaldock/transport.ts (after interface moved to contracts)
packages/core/src/signaldock/ (entire directory, after rename to conduit/)
```

### 7.3 Files to CREATE in cleocode/

```
packages/contracts/src/agent-registry.ts     # AgentCredential, AgentRegistryAPI
packages/contracts/src/transport.ts          # Transport adapter interface
packages/core/src/store/agent-registry-accessor.ts
packages/core/src/conduit/conduit-client.ts
packages/core/src/conduit/http-transport.ts
packages/core/src/conduit/ws-transport.ts    # Stub
packages/core/src/conduit/sse-transport.ts   # Stub
packages/core/src/conduit/local-transport.ts # Stub (requires napi-rs — Phase 9)
packages/core/src/conduit/factory.ts
packages/core/src/conduit/index.ts
packages/core/src/crypto/credentials.ts     # encrypt/decrypt for API keys
packages/cleo/src/commands/agent.ts          # CLI commands
```

### 7.4 Documentation Fixes

| File | Change |
|---|---|
| `packages/contracts/src/conduit.ts` | Remove all ClawMsgr references. Implementations: `HttpTransport`, `WsTransport` (future), `SseTransport` (future) |
| `docs/concepts/CLEO-CANT.md` | Replace ClawMsgrTransport → ConduitClient |
| `docs/specs/CLEOCODE-ECOSYSTEM-PLAN.md` | Replace all ClawMsgr references |
| `WASM-COMPLETENESS-REPORT.md` | Replace ClawMsgr references |

---

## 8. Spawn/Handoff Integration

### 8.1 New Flow

```
orchestrateSpawnExecute()
  → registry.getActive() — typed AgentCredential from DB
  → injects agentId + apiKey into handoff context
  → subagent reads credential from context
  → subagent calls registry.markUsed(agentId)
```

### 8.2 Key Rotation on Handoff

```
orchestrateHandoff()
  → if credential age > rotation threshold (configurable, default 7 days):
      registry.rotateKey(agentId)
      → calls POST /agents/{id}/rotate-key on cloud
      → re-encrypts new key in local DB
  → passes fresh credential to next session
```

---

## 9. Error Handling

| Scenario | Behavior |
|---|---|
| `machine-key` doesn't exist | Auto-generate on first `cleo agent register`. Set permissions `0600`. |
| Decryption fails (moved DB to new machine) | Error: "Cannot decrypt credentials. Machine key mismatch." Suggest: `cleo agent rotate-key {id}` or re-register. |
| Cloud sync fails (offline) | Silently skip. Local operations continue. Retry on next `cleo agent sync`. |
| Cloud rejects registration (tier limit) | Error: "Free tier limit reached (1 agent per project). Upgrade at signaldock.io/pricing." Agent still works locally, just not cloud-registered. |
| Transport connection fails | `ConduitClient` transitions to `error` state. Caller can retry or switch transport. |
| SSE stream drops | Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s). |
| Agent not found in registry | Error: "No agent credential found. Run: cleo agent register" |
| API key expired/revoked on cloud | Cloud returns 401. Local `cleo agent rotate-key` generates fresh key. |

---

## 10. Test Strategy

### Unit Tests

| Component | Test File | What to Test |
|---|---|---|
| `AgentRegistryAccessor` | `agent-registry-accessor.test.ts` | CRUD operations, getActive(), markUsed(), list with filters |
| `credentials.ts` | `credentials.test.ts` | encrypt/decrypt roundtrip, wrong key fails, key generation, file permissions |
| `ConduitClient` | `conduit-client.test.ts` | send(), onMessage() with mock transport, state transitions, disconnect |
| `HttpTransport` | `http-transport.test.ts` | poll(), push(), ack() against mock server, error handling |
| `factory.ts` | `factory.test.ts` | Transport auto-selection based on credential config, napi-rs fallback |

### Integration Tests

| Test | What It Validates |
|---|---|
| `cleo agent register → get → list → remove` | Full CRUD lifecycle through CLI |
| `cleo agent register → rotate-key → get` | Key rotation updates encrypted storage |
| `ConduitClient + HttpTransport → real SignalDock` | End-to-end message send/receive against cloud API |
| Encryption across machine-key lifecycle | Generate key, encrypt, decrypt, delete key, verify failure |

### Smoke Tests (CI)

- `cleo agent register` with a test API key → verify stored in tasks.db
- `cleo agent poll` against a mock → verify messages returned
- Machine-key auto-generation → verify file exists with correct permissions

---

## 11. Migration (Greenfield — Manual for Existing Agents)

We are still in development with only a handful of registered agents. No automated migration script is needed.

### Steps

1. **Add schema + contracts**: `agent_credentials` table, `AgentCredential` interface, `Transport` interface
2. **Implement**: `AgentRegistryAccessor`, `HttpTransport`, `ConduitClient`, `cleo agent` CLI
3. **Manually register existing agents**: For each current agent, run `cleo agent register --id {id} --name {name} --api-key {key}`
4. **Delete JSON files**: Remove all `clawmsgr-*.json` and `.cleo/clawmsgr-*.json`
5. **Rename directory**: `signaldock/` → `conduit/`
6. **Delete old code**: `claude-code-transport.ts`, old `types.ts`, old `transport.ts`, old factory logic
7. **Update imports**: All consumers update `from signaldock/` → `from conduit/`

---

## 12. Consumers (NOT in cleocode)

These repos consume the cleocode interfaces. They adapt on their own:

| Consumer | What It Does | How It Uses This Spec |
|---|---|---|
| SignalDock server (`signaldock/`) | Cloud API backend (Axum) | Imports crates via Cargo git dep. Serves endpoints that `HttpTransport` calls. |
| CleoOS (`CleoOS/`) | Electron app | Imports `@cleocode/core` + `@cleocode/runtime`, uses `createConduit()` with `LocalTransport` for embedded SignalDock. |
| Any CLI agent | Claude Code, OpenCode, Codex, Kimi | Runs `cleo agent watch` which uses `@cleocode/runtime` with embedded `LocalTransport`. Cloud sync via `cleo agent sync` (paid tier). |

**Note**: The ClawMsgr v1 frontend is replaced by the SignalDock v2 frontend (in the `signaldock/` repo). It is not a separate consumer — it ships with the cloud deployment.

---

## 13. napi-rs v3.8+ Unified Bindings

### 13.1 The Modern Approach: One Framework, Two Targets

All 8 Rust crates in `cleocode/crates/` migrate from `wasm-bindgen` to **napi-rs v3.8+**. This enables a single codebase with `#[napi]` macros that compiles to BOTH targets:

- **Node.js Runtime**: `napi build` → native `.node` addon (1.75-2.5x faster than WASM)
- **Browser/Portable**: `napi build --target wasm32-wasip1-threads` → WASM module

### 13.2 Crate Changes

Each crate adds:
```toml
[dependencies]
napi = { version = "3", features = ["napi9"] }
napi-derive = "3"

[lib]
crate-type = ["cdylib", "rlib"]
```

Functions and structs exposed to JS/TS use `#[napi]`:
```rust
#[napi]
pub fn parse(content: String) -> ParsedCANTMessage { ... }

#[napi(object)]
pub struct ParsedCANTMessage { ... }
```

### 13.3 Build Pipeline

```bash
# Native Node.js addon (production)
cd crates/cant-core && napi build --release

# WASM for browser
cd crates/cant-core && napi build --target wasm32-wasip1-threads --release

# Cross-platform (CI matrix)
napi build --platform linux-x64-gnu
napi build --platform darwin-arm64
napi build --platform win32-x64-msvc
```

### 13.4 Core Package Integration

`@cleocode/core` imports native addons directly:
```typescript
// Auto-resolves: native .node in Node.js, WASM in browser
import { parse } from '@cleocode/cant-core';
import { LafsEnvelope } from '@cleocode/lafs-core';
```

### 13.5 Browser Security Headers (WASM threading)

When running WASM with threading in browser environments, the server MUST set:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

### 13.6 Documentation Updates Required

- `docs/specs/CORE-PACKAGE-SPEC.md` — add napi-rs build instructions, native addon loading
- `docs/specs/CLEO-API.md` — document Rust-backed API performance characteristics

---

## 14. `@cleocode/runtime` Package (NEW)

### 14.1 Purpose

`@cleocode/core` is a **pure library** — it exports `Cleo.init()` and a facade. It has no daemon, no server, no background processes.

`@cleocode/runtime` is the **long-running process layer**:
- Agent polling loops
- SSE persistent connections
- Heartbeat intervals
- Credential rotation timers
- Background message delivery

### 14.2 Package Structure

```
packages/runtime/
├── package.json           # @cleocode/runtime
├── src/
│   ├── index.ts           # Exports: createRuntime, Runtime
│   ├── runtime.ts         # Runtime class — manages background services
│   ├── services/
│   │   ├── agent-poller.ts    # Persistent polling loop
│   │   ├── sse-connection.ts  # SSE persistent connection manager
│   │   ├── heartbeat.ts       # Periodic heartbeat sender
│   │   └── key-rotation.ts    # Automatic credential rotation
│   └── __tests__/
```

### 14.3 Runtime API

```typescript
export interface Runtime {
    /** Start all background services. */
    start(): Promise<void>;

    /** Stop all background services gracefully. */
    stop(): Promise<void>;

    /** Register an event handler for incoming messages. */
    onMessage(handler: (message: ConduitMessage) => void): void;

    /** Get runtime health status. */
    health(): RuntimeHealth;
}

export interface RuntimeHealth {
    uptime: number;
    services: {
        poller: 'running' | 'stopped' | 'error';
        sse: 'connected' | 'disconnected' | 'reconnecting';
        heartbeat: 'running' | 'stopped';
    };
    lastMessageAt?: string;
    messagesProcessed: number;
}

/** Create a Runtime from a Cleo instance. */
export async function createRuntime(cleo: Cleo): Promise<Runtime>;
```

### 14.4 Integration with Core and Cleo

```
@cleocode/core (library)
  └── Cleo.init() returns facade
       └── Exposes: cleo.runtime → lazy-loads @cleocode/runtime

@cleocode/runtime (long-running processes)
  └── createRuntime(cleo) → starts polling, SSE, heartbeat
  └── Uses: core's AgentRegistryAPI, ConduitClient, Transport

@cleocode/cleo (`cleo` CLI — sole runtime surface)
  └── dispatch commands use runtime:
       └── cleo agent watch → runtime.start()
       └── cleo agent stop → runtime.stop()
```

### 14.5 Dispatch Refactor

Review `@cleocode/cleo/src/dispatch/` for anything that is a long-running process concern (not a one-shot command). Move to runtime:

| In dispatch today | Stays in dispatch | Moves to runtime |
|---|---|---|
| Command routing | YES | — |
| Domain dispatchers | YES | — |
| Engine execution | YES | — |
| Background polling | — | YES |
| SSE connection mgmt | — | YES |
| Heartbeat loops | — | YES |

---

## 15. Local Embedded SignalDock

### 15.1 How Local Works

When running locally (no cloud), `@cleocode/core` boots an embedded SignalDock using the Rust crates via napi-rs. This gives full messaging capability without any network dependency.

```
cleo agent watch (or any Cleo operation that needs messaging)
    │
    ▼
ConduitClient
    │
    ├── LocalTransport (DEFAULT for local)
    │     │
    │     └── In-process napi-rs calls to:
    │           signaldock-sdk (AgentService, MessageService)
    │             └── signaldock-storage (local SQLite: .cleo/signaldock.db)
    │             └── signaldock-transport (in-process pub/sub — no Redis needed)
    │
    └── HttpTransport (OPTIONAL — for cloud sync)
          └── HTTP calls to api.signaldock.io (paid tier)
```

### 15.2 Local Database

Embedded SignalDock uses a SEPARATE SQLite database from the CLEO task store:

| Database | Tables | Purpose |
|---|---|---|
| `.cleo/tasks.db` | tasks, sessions, brain, nexus, agent_credentials | CLEO task management + credential store |
| `.cleo/signaldock.db` | agents, messages, conversations, delivery_jobs, capabilities, skills | SignalDock messaging (same schema as cloud) |

This separation means:
- SignalDock storage crate works identically in both local and cloud
- No schema conflicts between CLEO and SignalDock tables
- The credential store (in tasks.db) is separate from the message store (in signaldock.db)

### 15.3 Local Agent-to-Agent Messaging

On a single machine, agents communicate through the embedded SignalDock without network:

```
Agent A (Claude Code session)     Agent B (OpenCode session)
    │                                 │
    ▼                                 ▼
ConduitClient(LocalTransport)    ConduitClient(LocalTransport)
    │                                 │
    └──────── both call ──────────────┘
                   │
                   ▼
        signaldock-sdk (in-process)
        signaldock-storage (.cleo/signaldock.db)
        signaldock-transport (in-process pub/sub)
```

Messages are stored in the local SQLite and delivered via in-process pub/sub. No HTTP, no Redis, no cloud needed.

### 15.4 Cloud Connectivity (Paid Tier)

When cloud sync is enabled, the local embedded SignalDock syncs with the cloud:

- **Agent registration**: Local agent profiles pushed to cloud for cross-device discovery
- **Message relay**: Messages to agents on OTHER machines are relayed through cloud
- **Conversation sync**: Conversations that span multiple machines are synced bi-directionally
- **Nexus routing**: Cross-machine task routing via cloud NEXUS endpoint

Cloud sync is additive — it extends local capability, never replaces it.

---

## 16. Crate Migration: Server Crates → cleocode/crates/

### 16.1 Decision

ALL SignalDock crates move from the server repo to `cleocode/crates/`. The server repo becomes a thin cloud application that imports them via git dep. This makes cleocode truly SSoT for the entire SignalDock platform — both local and cloud.

### 16.2 Crates Moving to cleocode/crates/

| Crate | Lines | From | Purpose |
|---|---|---|---|
| `signaldock-storage` | 3,234 | `signaldock-core/crates/` | SQLite/Postgres adapters, 17 migrations, repository traits |
| `signaldock-transport` | 1,893 | `signaldock-core/crates/` | SSE, Webhook, Redis pub/sub, WebSocket, HTTP/2 |
| `signaldock-sdk` | 1,316 | `signaldock-core/crates/` | AgentService, MessageService, ConversationService, DeliveryOrchestrator |
| `signaldock-payments` | 297 | `signaldock-core/crates/` | Stripe/Square payment facilitation |

These join the existing crates already in cleocode:

| Crate | Lines | Already Here | Purpose |
|---|---|---|---|
| `signaldock-core` | 1,325 | Yes | Domain types |
| `lafs-core` | 1,257 | Yes | LAFS envelope |
| `conduit-core` | 933 | Yes | Conduit wire types |
| `cant-core` | 996 | Yes | CANT parser |

**Total after migration: 8 Rust crates, ~11,251 lines in cleocode/crates/**

### 16.3 Updated cleocode/crates/ Directory

```
cleocode/crates/
├── cant-core/               ← CANT parser (existing)
├── conduit-core/            ← Conduit wire types (existing)
├── lafs-core/               ← LAFS envelope (existing)
├── signaldock-core/         ← Domain types (existing)
├── signaldock-storage/      ← DB adapters + migrations (MOVED from server)
├── signaldock-transport/    ← SSE, webhook, Redis, WS (MOVED from server)
├── signaldock-sdk/          ← Service layer (MOVED from server)
├── signaldock-payments/     ← Payment facilitation (MOVED from server)
└── integration-tests/       ← Cross-crate tests (existing)
```

### 16.4 Each Crate Gets napi-rs Dual Target

```toml
[dependencies]
napi = { version = "3", features = ["napi9"], optional = true }
napi-derive = { version = "3", optional = true }

[features]
default = []
napi = ["dep:napi", "dep:napi-derive"]

[lib]
crate-type = ["cdylib", "rlib"]
```

- `cargo build` → Rust library (for cloud server)
- `napi build` → native .node addon (for @cleocode/core embedded)
- `napi build --target wasm32-wasip1-threads` → WASM (for browser)

### 16.5 What the Server Repo Becomes

The `signaldock-core/` repo (renamed to `signaldock/`) keeps ONLY:

```
signaldock/
├── apps/signaldock-api/     ← Axum HTTP server (routes, middleware, auth)
├── apps/signaldock-worker/  ← Background delivery job processor
├── bindings/poll/           ← signaldock-poll CLI binary
├── frontend/                ← SignalDock v2 web UI (NEW)
├── Dockerfile               ← Production build
├── railway.toml             ← Railway deployment
└── Cargo.toml               ← Git deps to cleocode/crates/
```

All crates consumed via:
```toml
signaldock-storage = { git = "https://github.com/kryptobaseddev/cleo" }
signaldock-transport = { git = "https://github.com/kryptobaseddev/cleo" }
signaldock-sdk = { git = "https://github.com/kryptobaseddev/cleo" }
# ... etc
```

### 16.6 Cloud vs Local — Same Crates, Different Wrappers

```
cleocode/crates/ (SSoT — 8 Rust crates)
        │
  ┌─────┴──────────────────┐
  │                        │
  ▼ (Cargo git dep)        ▼ (napi-rs native addon)
SignalDock Cloud           @cleocode/core (Local)
(Axum server)             (embedded in Node.js)
api.signaldock.io          cleo agent watch
```

---

## 17. Summary of Architectural Layers

```
┌─────────────────────────────────────────────────────────┐
│  @cleocode/contracts                                     │
│  Conduit, Transport, AgentCredential, AgentRegistryAPI,  │
│  Runtime, LAFS types, Conduit types, CANT types           │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Rust Crates — cleocode/crates/ (napi-rs v3.8+)         │
│  ALL 8 crates: dual target (native .node + WASM)         │
│                                                          │
│  Protocol:                                               │
│    lafs-core         LAFS envelope format                │
│    conduit-core      Conduit wire types + CantMetadata   │
│    cant-core         CANT parser (13 directives)         │
│    signaldock-core   Domain types (Agent, Message, etc.) │
│                                                          │
│  Services (MOVED from server repo):                      │
│    signaldock-storage    SQLite/Postgres, 17 migrations  │
│    signaldock-transport  SSE, Webhook, Redis, WebSocket  │
│    signaldock-sdk        AgentService, MessageService,   │
│                          ConversationService, Delivery   │
│    signaldock-payments   Stripe/Square payments          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  @cleocode/core (LIBRARY — no daemon, no server)         │
│                                                          │
│  conduit/                                                │
│    ConduitClient (implements Conduit interface)           │
│    LocalTransport (in-process napi-rs — embedded SD)     │
│    HttpTransport (HTTP polling to cloud)                  │
│    SseTransport (SSE real-time to cloud)                 │
│    WsTransport (WebSocket — future)                      │
│    factory.ts (createConduit — auto-selects transport)   │
│                                                          │
│  store/                                                  │
│    agent-registry-accessor.ts (credential CRUD)          │
│                                                          │
│  crypto/                                                 │
│    credentials.ts (AES-256-GCM encrypt/decrypt)          │
│                                                          │
│  Cleo.init() → facade (tasks, sessions, memory, etc.)    │
│  Cleo.runtime → lazy-loads @cleocode/runtime             │
│  Cleo.conduit → creates ConduitClient from registry      │
└──────────┬─────────────────────────┬────────────────────┘
           │                         │
┌──────────▼──────────┐  ┌──────────▼──────────────────┐
│  @cleocode/runtime   │  │  @cleocode/cleo              │
│  (LONG-RUNNING)      │  │  (CLI DISPATCH)              │
│                      │  │                              │
│  services/           │  │  cli/commands/agent.ts       │
│    agent-poller      │  │    cleo agent register       │
│    sse-connection    │  │    cleo agent watch → runtime │
│    heartbeat         │  │    cleo agent poll            │
│    key-rotation      │  │    cleo agent send            │
│                      │  │                              │
│  createRuntime(cleo) │  │  dispatch/ (command routing)  │
│  runtime.start()     │  │  dispatch adapter (cli.ts)   │
│  runtime.stop()      │  │                              │
└──────────────────────┘  └──────────────────────────────┘

CONSUMERS:

┌────────────────────────────────────────────────────────┐
│  SignalDock Cloud (signaldock/ repo — Axum server)       │
│  Imports ALL 8 crates via Cargo git dep (no napi-rs)     │
│  Cloud-only: Redis fan-out, Axum routes, webhooks,       │
│  payment gating, Postgres, horizontal scaling             │
│  + SignalDock v2 frontend                                │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│  Any CLI Agent (Claude Code, OpenCode, Codex, Kimi)      │
│  Runs: cleo agent watch (embedded SignalDock via napi-rs)│
│  Local messaging works offline. Cloud sync = paid tier.  │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│  CleoOS (Electron)                                       │
│  Imports @cleocode/core + @cleocode/runtime               │
│  Embedded SignalDock via LocalTransport (napi-rs)         │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│  signaldock-poll (Rust binary — non-Node environments)   │
│  Built from signaldock/ repo bindings/poll/               │
│  Uses signaldock-transport crate (via git dep)            │
│  For pure Python/shell agents without Node.js             │
└────────────────────────────────────────────────────────┘
```

---

*Spec authored by signaldock-dev. Incorporates owner directives: clean cut (no deprecation), provider-agnostic agents, kill Python worker, layered Conduit+Transport architecture, directory rename signaldock→conduit, encrypted credential store, napi-rs v3.8+ dual-target bindings (native Node + WASM), new @cleocode/runtime package for long-running processes, Rust binary for non-Node.*
