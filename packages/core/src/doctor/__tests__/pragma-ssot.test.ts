/**
 * Equivalence guard for the T10310 embedded pragma SSoT mirror.
 *
 * Asserts the TypeScript literal embedded in
 * `packages/core/src/doctor/pragma-ssot.ts` is byte-equivalent to the
 * canonical JSON at `specs/sqlite-pragmas.json`. Drift between the two
 * sides would silently break the drift walker without this guard.
 *
 * Mirrors the pattern established by
 * `packages/core/src/store/__tests__/sqlite-pragmas-ssot.test.ts` for
 * the performance-pragma applier.
 *
 * @task T10310
 * @epic T10283
 * @saga T10281
 * @see packages/core/src/store/__tests__/sqlite-pragmas-ssot.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPragmaSsot, normalisePragmaValue } from '../pragma-ssot.js';

interface SqlitePragmaSpecFile {
  readonly version: number;
  readonly pragmas: ReadonlyArray<readonly [string, string]>;
  readonly fileInvariants: ReadonlyArray<readonly [string, string]>;
  readonly driftPragmas: readonly string[];
}

function loadJsonSsot(): SqlitePragmaSpecFile {
  const here = dirname(fileURLToPath(import.meta.url));
  const specPath = resolve(here, '..', '..', '..', '..', '..', 'specs', 'sqlite-pragmas.json');
  return JSON.parse(readFileSync(specPath, 'utf8')) as SqlitePragmaSpecFile;
}

describe('pragma-ssot loader (T10310)', () => {
  it('embedded literal matches the JSON SSoT pragmas array byte-for-byte', () => {
    const json = loadJsonSsot();
    const ssot = loadPragmaSsot();

    // Every JSON pragma entry MUST appear in the loader's entries array.
    for (const [name, expected] of json.pragmas) {
      const found = ssot.entries.find((e) => e[0] === name);
      expect(found, `pragma ${name} missing from embedded SSoT`).toBeDefined();
      expect(found?.[1]).toBe(expected);
    }
  });

  it('embedded literal matches the JSON SSoT fileInvariants array', () => {
    const json = loadJsonSsot();
    const ssot = loadPragmaSsot();
    for (const [name, expected] of json.fileInvariants) {
      const found = ssot.entries.find((e) => e[0] === name);
      expect(found, `fileInvariant ${name} missing from embedded SSoT`).toBeDefined();
      expect(found?.[1]).toBe(expected);
    }
  });

  it('embedded driftPragmas list matches the JSON SSoT exactly', () => {
    const json = loadJsonSsot();
    const ssot = loadPragmaSsot();
    expect(ssot.driftPragmas).toEqual(json.driftPragmas);
  });

  it('every driftPragma resolves to an expected value', () => {
    const ssot = loadPragmaSsot();
    for (const name of ssot.driftPragmas) {
      const expected = ssot.expectedByName.get(name.toLowerCase());
      expect(expected, `driftPragma ${name} has no expected value`).toBeDefined();
    }
  });

  it('normalisePragmaValue handles integer-coded values', () => {
    expect(normalisePragmaValue('synchronous', '0')).toBe('OFF');
    expect(normalisePragmaValue('synchronous', '1')).toBe('NORMAL');
    expect(normalisePragmaValue('synchronous', '2')).toBe('FULL');
    expect(normalisePragmaValue('synchronous', '3')).toBe('EXTRA');
    expect(normalisePragmaValue('foreign_keys', '0')).toBe('OFF');
    expect(normalisePragmaValue('foreign_keys', '1')).toBe('ON');
  });

  it('normalisePragmaValue passes through symbolic values upper-cased', () => {
    expect(normalisePragmaValue('journal_mode', 'wal')).toBe('WAL');
    expect(normalisePragmaValue('journal_mode', 'WAL')).toBe('WAL');
    expect(normalisePragmaValue('journal_mode', 'delete')).toBe('DELETE');
    expect(normalisePragmaValue('temp_store', 'memory')).toBe('MEMORY');
  });

  it('normalisePragmaValue is case-insensitive on the pragma name', () => {
    expect(normalisePragmaValue('Synchronous', '1')).toBe('NORMAL');
    expect(normalisePragmaValue('SYNCHRONOUS', '1')).toBe('NORMAL');
  });
});
