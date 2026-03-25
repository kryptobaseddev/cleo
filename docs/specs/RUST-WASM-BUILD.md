# Rust to WASM Build Guide

**Building CLEO Rust Crates for TypeScript Consumption**

## Overview

The CLEO ecosystem uses 4 Rust crates that compile to WebAssembly (WASM) for use in TypeScript packages:

1. **lafs-core** → `packages/lafs/src/wasm/`
2. **conduit-core** → `packages/contracts/src/wasm/conduit/`
3. **cant-core** → `packages/cant/src/wasm/`
4. **signaldock-core** → `packages/signaldock/src/wasm/` (optional)

## Prerequisites

```bash
# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Or via cargo
cargo install wasm-pack
```

## Build Commands

### Quick Build (All Crates)

```bash
./build-wasm.sh
```

### Individual Crate Builds

```bash
# lafs-core
cd crates/lafs-core
wasm-pack build --target web --features wasm --out-dir ../../packages/lafs/src/wasm

# conduit-core
cd crates/conduit-core
wasm-pack build --target web --features wasm --out-dir ../../packages/contracts/src/wasm/conduit

# cant-core
cd crates/cant-core
wasm-pack build --target web --features wasm --out-dir ../../packages/cant/src/wasm

# signaldock-core (optional)
cd crates/signaldock-core
wasm-pack build --target web --features wasm --out-dir ../../packages/signaldock/src/wasm
```

## Build Profiles

### Development
- Fast compilation
- No optimization
- Source maps included
- Large file size

### Release
- Optimized with wasm-opt
- Small file size
- No source maps
- Production ready

```bash
# Development build
wasm-pack build --dev --target web --features wasm

# Release build (default)
wasm-pack build --target web --features wasm
```

## Features

Each crate has a `wasm` feature flag:

```toml
[dependencies]
cant-core = { path = "../cant-core", features = ["wasm"] }
```

Enable this feature when building for WASM to include wasm-bindgen bindings.

## TypeScript Integration

### Example: Using cant-core in TypeScript

```typescript
import init, { cant_parse } from './wasm/cant_core';

async function parseMessage(content: string) {
  await init();
  const result = cant_parse(content);
  return {
    directive: result.directive,
    directiveType: result.directive_type,
    addresses: result.addresses,
    taskRefs: result.task_refs,
    tags: result.tags
  };
}
```

## Troubleshooting

### wasm-pack not found
```bash
# Install via npm
npm install -g wasm-pack

# Or via cargo
cargo install wasm-pack
```

### Build fails with missing wasm feature
Ensure you're building with `--features wasm` flag.

### Large WASM file size
Use release builds for production:
```bash
wasm-pack build --release --target web --features wasm
```

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Build WASM
  run: |
    cargo install wasm-pack
    ./build-wasm.sh
  
- name: Test WASM
  run: |
    cd packages/cant
    npm test
```
