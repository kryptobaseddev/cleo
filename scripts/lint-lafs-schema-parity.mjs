#!/usr/bin/env node
/**
 * scripts/lint-lafs-schema-parity.mjs
 *
 * Enforces parity between the TypeScript canonical LAFS envelope schema
 * (`packages/lafs/schemas/v1/envelope.schema.json`) and the Rust vendored
 * copy (`crates/lafs-core/schemas/v1/envelope.schema.json`).
 *
 * The Rust copy MUST be byte-identical to the TS canonical source. Drift
 * means the published `lafs-core` crate validates a stale schema while
 * the TypeScript stack uses the current one — a wire-protocol regression
 * vector.
 *
 * Why vendor at all: `cargo publish` rejects `include_str!` paths that
 * traverse outside the crate directory. Vendoring keeps the crate
 * publishable without sacrificing the TS-as-canonical contract. See
 * SAGA T10176 and ADR-078.
 *
 * Usage:
 *   node scripts/lint-lafs-schema-parity.mjs        # report only
 *   node scripts/lint-lafs-schema-parity.mjs --fix  # copy TS -> Rust
 *   node scripts/lint-lafs-schema-parity.mjs --exit-on-fail  # CI mode
 *
 * Exit codes:
 *   0  parity OK (or --fix succeeded)
 *   1  parity drift detected (CI mode) OR copy/read failure
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = process.cwd();
const TS_CANONICAL = resolve(REPO, 'packages/lafs/schemas/v1/envelope.schema.json');
const RUST_VENDOR = resolve(REPO, 'crates/lafs-core/schemas/v1/envelope.schema.json');

const args = new Set(process.argv.slice(2));
const FIX = args.has('--fix');
const EXIT_ON_FAIL = args.has('--exit-on-fail');

function fail(msg, code = 1) {
  console.error(`[lint-lafs-schema-parity] ${msg}`);
  process.exit(code);
}

if (!existsSync(TS_CANONICAL)) {
  fail(`TS canonical schema missing: ${TS_CANONICAL}`);
}
if (!existsSync(RUST_VENDOR)) {
  if (FIX) {
    const ts = readFileSync(TS_CANONICAL);
    writeFileSync(RUST_VENDOR, ts);
    console.log(`[lint-lafs-schema-parity] created Rust vendor copy from TS canonical`);
    process.exit(0);
  }
  fail(`Rust vendor schema missing: ${RUST_VENDOR}`);
}

const tsBytes = readFileSync(TS_CANONICAL);
const rustBytes = readFileSync(RUST_VENDOR);

if (tsBytes.equals(rustBytes)) {
  console.log('[lint-lafs-schema-parity] OK — TS canonical and Rust vendor are byte-identical');
  process.exit(0);
}

if (FIX) {
  writeFileSync(RUST_VENDOR, tsBytes);
  console.log('[lint-lafs-schema-parity] FIXED — copied TS canonical to Rust vendor');
  process.exit(0);
}

console.error('[lint-lafs-schema-parity] DRIFT detected:');
console.error(`  TS canonical: ${TS_CANONICAL} (${tsBytes.length} bytes)`);
console.error(`  Rust vendor:  ${RUST_VENDOR} (${rustBytes.length} bytes)`);
console.error('');
console.error('  Run `node scripts/lint-lafs-schema-parity.mjs --fix` to sync.');

process.exit(EXIT_ON_FAIL ? 1 : 0);
