/**
 * Tests for scripts/lint-no-committed-native-binaries.mjs (T12382 · gate 24).
 *
 * Each rule is proven in both directions: the violation fails AND the remedy
 * passes, so the gate cannot be satisfied by a check that rejects everything.
 *
 * @task T12382
 */

import { describe, expect, it } from 'vitest';
import {
  assessPackedCant,
  BASELINE,
  CANT_LOADER_FILES,
  CANT_NATIVE_TRIPLES,
  CANT_WASM_FILE,
  isCantBinaryPath,
  SOURCE_REV_PREFIX,
  scanCommittedBinaries,
} from '../lint-no-committed-native-binaries.mjs';

describe('scanCommittedBinaries (repository mode)', () => {
  it('fails on a committed cant .node and passes once it is removed', () => {
    const withBinary = ['packages/cant/src/index.ts', 'packages/cant/napi/cant.linux-x64-gnu.node'];
    expect(scanCommittedBinaries(withBinary).violations).toEqual([
      'packages/cant/napi/cant.linux-x64-gnu.node',
    ]);
    expect(scanCommittedBinaries(['packages/cant/src/index.ts']).violations).toEqual([]);
  });

  it('fails on committed .wasm files and crate-local binaries', () => {
    const files = ['crates/cant-napi/cant-napi.linux-x64-gnu.node', 'x/y/cant.wasm32-wasi.wasm'];
    expect(scanCommittedBinaries(files).violations).toEqual(files.slice().sort());
  });

  it('baselines pre-existing non-cant binaries only outside --strict', () => {
    const [baselined] = [...BASELINE];
    expect(scanCommittedBinaries([baselined]).violations).toEqual([]);
    expect(scanCommittedBinaries([baselined]).baselined).toEqual([baselined]);
    expect(scanCommittedBinaries([baselined], { strict: true }).violations).toEqual([baselined]);
  });

  it('never treats a cant binary as baselinable', () => {
    expect(isCantBinaryPath('packages/cant/napi/cant.darwin-arm64.node')).toBe(true);
    expect(isCantBinaryPath('crates/cant-napi/cant-napi.linux-x64-gnu.node')).toBe(true);
    expect(isCantBinaryPath('crates/lafs-napi/lafs-napi.linux-x64-gnu.node')).toBe(false);
  });
});

describe('assessPackedCant (packed mode)', () => {
  const rev = 'abc123';
  const stamped = Buffer.from(`\0junk${SOURCE_REV_PREFIX}${rev}junk\0`);
  const binaries = [...CANT_NATIVE_TRIPLES.map((t) => `napi/cant.${t}.node`), CANT_WASM_FILE];
  const completePack = ['dist/index.js', ...CANT_LOADER_FILES, ...binaries];

  it('passes a complete pack whose binaries carry the release revision', () => {
    expect(
      assessPackedCant({ packedFiles: completePack, readFile: () => stamped, expectRev: rev }),
    ).toEqual([]);
  });

  it('fails when a triple, the wasm or the loader is missing', () => {
    const pack = completePack.filter(
      (f) =>
        f !== 'napi/cant.win32-arm64-msvc.node' && f !== CANT_WASM_FILE && f !== 'napi/index.cjs',
    );
    const problems = assessPackedCant({
      packedFiles: pack,
      readFile: () => stamped,
      expectRev: rev,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'missing from the pack: napi/cant.win32-arm64-msvc.node',
        `missing from the pack: ${CANT_WASM_FILE}`,
        'missing from the pack: napi/index.cjs',
      ]),
    );
  });

  it('fails a stale binary built from another revision', () => {
    const readFile = (path) =>
      path === 'napi/cant.darwin-x64.node' ? Buffer.from(`${SOURCE_REV_PREFIX}oldrev`) : stamped;
    expect(assessPackedCant({ packedFiles: completePack, readFile, expectRev: rev })).toEqual([
      `stale binary (not built from ${rev}): napi/cant.darwin-x64.node`,
    ]);
  });

  it('fails leftover binaries such as the debug wasm or an unknown triple', () => {
    const pack = [
      ...completePack,
      'napi/cant.wasm32-wasi.debug.wasm',
      'napi/cant.freebsd-x64.node',
    ];
    const problems = assessPackedCant({
      packedFiles: pack,
      readFile: () => stamped,
      expectRev: rev,
    });
    expect(problems).toEqual([
      'unexpected binary in the pack (leftover or debug build): napi/cant.wasm32-wasi.debug.wasm',
      'unexpected binary in the pack (leftover or debug build): napi/cant.freebsd-x64.node',
    ]);
  });

  it('honours a narrower triple set (CI packs only the host binary)', () => {
    const pack = [
      'dist/index.js',
      ...CANT_LOADER_FILES,
      'napi/cant.linux-x64-gnu.node',
      CANT_WASM_FILE,
    ];
    expect(
      assessPackedCant({
        packedFiles: pack,
        readFile: () => stamped,
        expectRev: rev,
        triples: ['linux-x64-gnu'],
      }),
    ).toEqual([]);
  });
});
