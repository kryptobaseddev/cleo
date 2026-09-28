/**
 * Registry-derived default search roots (T12476).
 *
 * @task T12476
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parentRootsOf } from '../registry-roots.js';

describe('parentRootsOf', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'registry-roots-'));
    for (const p of ['code/a', 'code/b', 'srv/c']) mkdirSync(join(base, p), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('returns the unique, sorted parents of live project paths', () => {
    const roots = parentRootsOf([
      join(base, 'srv', 'c'),
      join(base, 'code', 'a'),
      join(base, 'code', 'b'),
    ]);
    expect(roots).toEqual([join(base, 'code'), join(base, 'srv')]);
  });

  it('skips vanished checkouts, relative paths and filesystem roots', () => {
    const roots = parentRootsOf([
      join(base, 'gone', 'x'),
      'relative/project',
      '/',
      join(base, 'code', 'a'),
    ]);
    expect(roots).toEqual([join(base, 'code')]);
  });

  it('never names a hardcoded location when the registry is empty', () => {
    expect(parentRootsOf([])).toEqual([]);
  });
});
