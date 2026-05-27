// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// Native-addon loader for @cleocode/worktree-napi.
//
// Resolution order:
//   1. A `worktree-napi.<triple>.node` file co-located with this loader.
//      Release publishing copies this loader and the built .node files into
//      @cleocode/worktree/native so the existing @cleocode/worktree trusted
//      publisher owns the whole native distribution.
//
// If the co-located binary is unavailable we throw a descriptive error pointing
// at the missing bundled path and local build command.

const { existsSync } = require('node:fs');
const { join } = require('node:path');

function tripleName() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') {
    throw new Error(
      '@cleocode/worktree-napi: macOS x64 prebuilds are not published. ' +
        'Use an arm64 Node.js runtime on Apple Silicon or build locally with ' +
        '`pnpm dlx @napi-rs/cli@3 build --release` inside `crates/worktree-napi/`.'
    );
  }
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc';
  throw new Error(
    `@cleocode/worktree-napi: unsupported platform/arch ${platform}/${arch}`
  );
}

const triple = tripleName();
const localPath = join(__dirname, `worktree-napi.${triple}.node`);

let nativeBinding;

if (existsSync(localPath)) {
  nativeBinding = require(localPath);
} else {
  throw new Error(
    `@cleocode/worktree-napi: missing native binding for ${triple} at ${localPath}. ` +
      `The @cleocode/worktree package must include \`native/worktree-napi.${triple}.node\`; ` +
      `for local development, run \`pnpm dlx @napi-rs/cli@3 build --release\` inside ` +
      `\`crates/worktree-napi/\` and rename the output to \`worktree-napi.${triple}.node\`.`
  );
}

// Static named-export re-binding so Node.js can detect the export shape
// when this CJS module is imported from an ESM consumer (e.g. compiled
// @cleocode/worktree under "type": "module"). Without this, ESM named
// imports like `import { copyPathsParallel } from './native/worktree-napi.cjs'`
// throw "does not provide an export named ..." at module link time.
module.exports = nativeBinding;
