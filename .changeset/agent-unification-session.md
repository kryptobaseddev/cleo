---
id: agent-unification-session
tasks: [T170]
kind: feat
summary: Agent unification + Conduit architecture — unified cleo agent CLI, AgentRegistry with encrypted credentials, Conduit transport layer.
breaking: |
  - `cleo agents` command deprecated — `health` moved to `cleo agent health`.
  - `packages/core/src/signaldock/` directory removed — use `conduit/` instead.
  - Default API URL changed from `api.clawmsgr.com` to `api.signaldock.io`.
---

Migrated from the upstream `@changesets/cli` format on 2026-05-20 (T9738). The
original entry shipped multiple semver bumps across `@cleocode/cleo`,
`@cleocode/core`, `@cleocode/contracts`, and `@cleocode/runtime` — those
package-level bumps are no longer tracked here; releases roll up via tags and
`cleo release plan` will derive the bump from `kind` in a future task.

### Highlights

- Unified `cleo agent` CLI: register, list, get, remove, rotate-key, claim-code,
  watch, poll, send, health.
- `AgentRegistry` with `agent_credentials` table — AES-256-GCM encrypted API
  keys, machine-key bound.
- Conduit architecture: `ConduitClient` + `HttpTransport` + factory
  (2-layer Transport/Conduit pattern).
- `@cleocode/runtime` `AgentPoller` with group `@mention` support — fixes peek
  blind spot.
- 5 Rust crates migrated: signaldock-protocol, signaldock-storage,
  signaldock-transport, signaldock-sdk, signaldock-payments (9 → 13 workspace
  crates).
- Crypto hardening: version byte in ciphertext, HOME validation, key length
  check.

### Bug fixes folded into this slice

- E-FIND-004: ACL denial now audited + projectPath redacted in
  `nexus/workspace.ts`.
- CAAMP `library-loader.ts` TS2352 type cast fix.
- `workflow-executor.ts` unused variable build errors.
- Test assertion updates for the conduit transport layer (Circle of Ten remains
  10 domains).
- Audit test mock updated for `agentCredentials` schema export.

### Contracts added

- `AgentCredential`, `AgentRegistryAPI`, `TransportConfig` interfaces.
- `Transport` interface (connect / disconnect / push / poll / ack / subscribe).
- `TransportConnectConfig` type.
- Conduit JSDoc updated — removed ClawMsgr references.
