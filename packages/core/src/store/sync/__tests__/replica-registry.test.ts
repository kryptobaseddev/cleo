/**
 * The device replica registry under concurrent writers (T12908): every
 * read-modify-write holds the file's cross-process lock.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplicaRegistry } from '../replica-registry.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replica-registry-'));
  file = join(dir, 'state', 'replicas.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (nonce: string) => ({ nonce, scope: 'project', dbRealpath: `/s/${nonce}` });

describe('ReplicaRegistry lock (T12908)', () => {
  it('two concurrent upserts keep both entries: the second waits for the first', async () => {
    const registry = new ReplicaRegistry(file, 'dev-1');
    registry.upsert('r-first', entry('first'));
    // Another process upserts r-child: it reads the file under the lock, then
    // writes its entry back a moment later.
    const lockfilePath = createRequire(import.meta.url).resolve('proper-lockfile');
    const script = `
      const fs = require('node:fs');
      const lockfile = require(${JSON.stringify(lockfilePath)});
      const file = ${JSON.stringify(file)};
      const release = lockfile.lockSync(file, { realpath: false, stale: 10000 });
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      process.stdout.write('locked\\n');
      setTimeout(() => {
        st.replicas['r-child'] = { nonce: 'child', scope: 'project', dbRealpath: '/s/child', hwm: {}, updatedAt: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(st));
        release();
      }, 400);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    registry.upsert('r-parent', entry('parent'));
    await exited;
    expect(Object.keys(registry.read().replicas).sort()).toEqual([
      'r-child',
      'r-first',
      'r-parent',
    ]);
  });

  it('advanceHwm reads and patches under the lock, keeping a retire made meanwhile', async () => {
    const registry = new ReplicaRegistry(file, 'dev-1');
    registry.upsert('r1', { ...entry('one'), hwm: { s: 1 } });
    const lockfilePath = createRequire(import.meta.url).resolve('proper-lockfile');
    const script = `
      const fs = require('node:fs');
      const lockfile = require(${JSON.stringify(lockfilePath)});
      const file = ${JSON.stringify(file)};
      const release = lockfile.lockSync(file, { realpath: false, stale: 10000 });
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      process.stdout.write('locked\\n');
      setTimeout(() => {
        Object.assign(st.replicas.r1, { retiredAt: '2026-10-13T00:00:00.000Z', successor: 'r2' });
        fs.writeFileSync(file, JSON.stringify(st));
        release();
      }, 400);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    registry.advanceHwm('r1', 's', 5);
    await exited;
    expect(registry.get('r1')).toMatchObject({ successor: 'r2', hwm: { s: 5 } });
    expect(JSON.parse(readFileSync(file, 'utf8')).replicas.r1.retiredAt).toBe(
      '2026-10-13T00:00:00.000Z',
    );
  });
});
