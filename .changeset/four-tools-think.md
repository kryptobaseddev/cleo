---
"@cleocode/contracts": minor
"@cleocode/cant": minor
---

## WASM Integration Complete - All Rust Crates

### 🚀 Major Features

Complete WASM bindings for the CANT ecosystem with TypeScript SDK integration:

**Rust Crates:**
- `cant-core`: CANT parser with `cant_parse()` and `cant_classify_directive()` functions
- `lafs-core`: LAFS transport with `WasmLafsTransport`, `WasmLafsMeta`, `WasmLafsEnvelope`
- `conduit-core`: Conduit messaging with `WasmConduitMessage`, `WasmConduitState`, `WasmCantMetadata`
- `signaldock-core`: Agent types with `WasmAgentClass`, `WasmPrivacyTier`, `WasmAgentStatus`

**TypeScript SDK (`packages/contracts/src/wasm/`):**
- Central SDK entry point with unified loader
- Full type definitions for all WASM exports
- Async initialization with proper error handling
- Zero-dependency WASM loading

### 📦 Build System

- Feature propagation: `wasm` feature chains through all crates
- `wasm-pack` builds for all targets (web, bundler, nodejs)
- Centralized SDK exports all WASM modules
- Build script: `build-wasm.sh`

### 📝 Documentation

- `RUST-WASM-BUILD.md`: Build instructions
- `CANT-TYPESCRIPT-INTEGRATION.md`: Usage guide
- `WASM-HANDOFF-REPORT.md`: Complete audit report

### 🔧 Technical Details

- All crates compile to WASM with `wasm-bindgen`
- Full type safety with generated TypeScript definitions
- Proper memory management for WASM/JS boundary
- Production-ready for npm publishing

### 📊 Stats

- 4 Rust crates with complete WASM bindings
- 68 files changed
- ~450KB total WASM output
- Zero breaking changes to existing APIs
