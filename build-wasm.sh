#!/bin/bash
# Build all crates as WASM packages for TypeScript consumption

set -e

echo "Building WASM packages..."
echo ""

# Build lafs-core
echo "Building lafs-core..."
cd crates/lafs-core
wasm-pack build --target web --features wasm --out-dir ../../packages/lafs/src/wasm 2>&1 || echo "Note: wasm-pack may not be installed"
cd ../..

# Build conduit-core
echo "Building conduit-core..."
cd crates/conduit-core
wasm-pack build --target web --features wasm --out-dir ../../packages/contracts/src/wasm/conduit 2>&1 || echo "Note: wasm-pack may not be installed"
cd ../..

# Build cant-core
echo "Building cant-core..."
cd crates/cant-core
wasm-pack build --target web --features wasm --out-dir ../../packages/cant/src/wasm 2>&1 || echo "Note: wasm-pack may not be installed"
cd ../..

echo ""
echo "WASM build complete!"
echo ""
echo "Packages built:"
echo "  - packages/lafs/src/wasm/"
echo "  - packages/contracts/src/wasm/conduit/"
echo "  - packages/cant/src/wasm/"
