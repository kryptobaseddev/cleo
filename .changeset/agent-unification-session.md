---
"@cleocode/cleo": minor
"@cleocode/core": minor
"@cleocode/contracts": minor
"@cleocode/runtime": minor
---

## Agent Unification + Conduit Architecture (T170)

### Breaking Changes
- `cleo agents` command deprecated — `health` moved to `cleo agent health`
- `packages/core/src/signaldock/` directory removed — use `conduit/` instead
- Default API URL changed from `api.clawmsgr.com` to `api.signaldock.io`

### New Features
- **Unified `cleo agent` CLI**: register, list, get, remove, rotate-key, claim-code, watch, poll, send, health
- **Agent Registry**: `agent_credentials` table with AES-256-GCM encrypted API keys (machine-key bound)
- **Conduit Architecture**: ConduitClient + HttpTransport + factory (2-layer Transport/Conduit pattern)
- **@cleocode/runtime**: AgentPoller with group @mention support (fixes peek blind spot)
- **AgentRegistryAccessor**: Full CRUD with encrypted storage, pre-flight checks, deterministic ordering
- **5 Rust crates migrated**: signaldock-protocol, signaldock-storage, signaldock-transport, signaldock-sdk, signaldock-payments (9→13 workspace crates)
- **Crypto hardening**: version byte in ciphertext, HOME validation, key length check

### Bug Fixes
- E-FIND-004: ACL denial now audited + projectPath redacted in nexus/workspace.ts
- CAAMP library-loader.ts TS2352 type cast fix
- workflow-executor.ts unused variable build errors
- Test assertion updates for conduit transport layer (Circle of Ten remains 10 domains)
- Audit test mock updated for agentCredentials schema export

### Contracts
- `AgentCredential`, `AgentRegistryAPI`, `TransportConfig` interfaces
- `Transport` interface (connect/disconnect/push/poll/ack/subscribe)
- `TransportConnectConfig` type
- Conduit JSDoc updated — removed ClawMsgr references

### CANT DSL (by @cleo-rust-lead)
- Full 8-phase epic complete: spec, napi-rs, parser, validator, LSP, runtime, migration
- 694 tests, 17K lines Rust, 3.8K lines TypeScript, 3 new crates
