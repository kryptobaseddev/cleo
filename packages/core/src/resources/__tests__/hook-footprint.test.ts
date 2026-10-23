/**
 * A git hook's measured peak, keyed by its content (T13921).
 *
 * @task T13921
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookFootprintKey, readHookPeak, recordHookPeak } from '../hook-footprint.js';

const GIB = 1024 ** 3;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-t13921-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hook footprints (T13921)', () => {
  it('keys a hook by its content: an edited hook is a new key', () => {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    expect(hookFootprintKey(repo, 'pre-push')).toBeNull(); // no hook file
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\npnpm typecheck\n');
    chmodSync(hook, 0o755);
    const first = hookFootprintKey(repo, 'pre-push');
    expect(first).toMatch(/^pre-push:[0-9a-f]{64}$/);
    writeFileSync(hook, '#!/bin/sh\npnpm test\n');
    expect(hookFootprintKey(repo, 'pre-push')).not.toBe(first);
  });

  it('records the largest peak seen, and nothing for a non-positive one', () => {
    const dir = join(root, 'admission');
    expect(readHookPeak('pre-push:a', dir)).toBeNull();
    recordHookPeak('pre-push:a', 3 * GIB, dir, 1);
    recordHookPeak('pre-push:a', 2 * GIB, dir, 2);
    expect(readHookPeak('pre-push:a', dir)).toBe(3 * GIB);
    recordHookPeak('pre-push:b', 0, dir, 3);
    expect(readHookPeak('pre-push:b', dir)).toBeNull();
    // A corrupt file reads as "not measured" and is replaced on the next record.
    writeFileSync(join(dir, 'hook-footprints.json'), '{not json');
    expect(readHookPeak('pre-push:a', dir)).toBeNull();
    recordHookPeak('pre-push:a', GIB, dir, 4);
    expect(readHookPeak('pre-push:a', dir)).toBe(GIB);
  });
});
