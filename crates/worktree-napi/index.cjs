// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// Native-addon loader for @cleocode/worktree-napi.
//
// Resolution order:
//   1. A `worktree-napi.<triple>.node` file co-located with this loader
//      (developer / CI artifact path — wins so local `napi build` always
//      takes precedence over an installed prebuilt).
//   2. `@cleocode/worktree-napi-<triple>` per-arch package (the
//      optionalDependencies wrapper published from CI).
//
// If neither is available we throw a descriptive error pointing at the
// per-arch package name + a local build command.

const { existsSync } = require('node:fs');
const { join } = require('node:path');

function tripleName() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64-gnu';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc';
  throw new Error(
    `@cleocode/worktree-napi: unsupported platform/arch ${platform}/${arch}`
  );
}

const triple = tripleName();
const localPath = join(__dirname, `worktree-napi.${triple}.node`);

let nativeBinding;

if (existsSync(localPath)) {
  // Dev / CI / local fallback — `napi build` writes the .node here.
  nativeBinding = require(localPath);
} else {
  try {
    // Production — per-arch optional dep wrapper published from CI.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeBinding = require(`@cleocode/worktree-napi-${triple}`);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? e.message : String(e);
    throw new Error(
      `@cleocode/worktree-napi: failed to load native binding for ${triple}. ` +
        `Install \`@cleocode/worktree-napi-${triple}\` or run ` +
        `\`pnpm dlx @napi-rs/cli@3 build --release\` inside \`crates/worktree-napi/\`. ` +
        `Underlying error: ${msg}`
    );
  }
}

module.exports = nativeBinding;
