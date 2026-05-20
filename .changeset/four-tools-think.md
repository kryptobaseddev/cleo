---
id: four-tools-think
tasks: [T9738]
kind: feat
summary: WASM bindings for the CANT ecosystem — cant-core, lafs-core, conduit-core, signaldock-core compile to WASM with TypeScript SDK integration.
---

Migrated from the upstream `@changesets/cli` format on 2026-05-20 (T9738) under
the umbrella T9738 task since no single CLEO task ID anchored this entry. The
original entry bumped `@cleocode/contracts` and `@cleocode/cant`.

### Rust crates

- `cant-core`: CANT parser with `cant_parse()` and `cant_classify_directive()`.
- `lafs-core`: LAFS transport with `WasmLafsTransport`, `WasmLafsMeta`,
  `WasmLafsEnvelope`.
- `conduit-core`: Conduit messaging with `WasmConduitMessage`,
  `WasmConduitState`, `WasmCantMetadata`.
- `signaldock-core`: Agent types with `WasmAgentClass`, `WasmPrivacyTier`,
  `WasmAgentStatus`.

### TypeScript SDK (`packages/contracts/src/wasm/`)

- Central SDK entry point with a unified loader.
- Full type definitions for every WASM export.
- Async initialization with proper error handling.
- Zero-dependency WASM loading.

### Build system

- Feature propagation: `wasm` feature chains through every crate.
- `wasm-pack` builds for all targets (web, bundler, nodejs).
- Centralized SDK exports every WASM module.
- Build script: `build-wasm.sh`.

### Stats

- 4 Rust crates with complete WASM bindings.
- 68 files changed.
- ~450KB total WASM output.
- Zero breaking changes to existing APIs.
