/**
 * The cloud vault's machine-local state file (`nexus-vault.json`): an
 * unreadable or newer file is moved aside with a warning (never reset in
 * place), and every read-modify-write holds a lock and writes atomically.
 *
 * @task T12972
 * @epic T12322
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexusVaultState, W_NEXUS_VAULT_STATE_MOVED } from '../nexus-vault-state.js';

const API = 'https://api.nexus.test';
const USER = 'user-1';
const STREAM = 'project:p';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-state-'));
  file = path.join(dir, 'nexus-vault.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const asides = () => fs.readdirSync(dir).filter((f) => f.startsWith('nexus-vault.json.'));

describe('NexusVaultState', () => {
  it('round-trips trust and stream state', () => {
    const s = new NexusVaultState(file);
    s.saveTrust(API, USER, { keyVersion: 1, pins: {}, revoked: ['d/x'] });
    s.saveStream(API, USER, STREAM, '/r', { lastCheckpointId: 'cp', lastCoversSeq: 3 });
    const again = new NexusVaultState(file);
    expect(again.trust(API, USER)).toEqual({ keyVersion: 1, pins: {}, revoked: ['d/x'] });
    expect(again.stream(API, USER, STREAM, '/r')).toMatchObject({
      lastCheckpointId: 'cp',
      lastCoversSeq: 3,
    });
    expect(again.drainWarnings()).toEqual([]);
    expect(asides()).toEqual([]);
  });

  it('moves a truncated file aside with a warning instead of resetting it in place', () => {
    const s = new NexusVaultState(file);
    s.saveTrust(API, USER, { keyVersion: 2, pins: {}, revoked: ['d/x'] });
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
    const torn = fs.readFileSync(file, 'utf8');

    const r = new NexusVaultState(file);
    expect(r.trust(API, USER)).toEqual({ keyVersion: 0, pins: {}, revoked: [] });
    const warnings = r.drainWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe(W_NEXUS_VAULT_STATE_MOVED);
    expect(warnings[0]?.message).toContain('could not be read');
    const moved = asides();
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^nexus-vault\.json\.unreadable-/);
    // The torn bytes are kept for recovery, untouched.
    expect(fs.readFileSync(path.join(dir, moved[0] ?? ''), 'utf8')).toBe(torn);
    expect(r.drainWarnings()).toEqual([]);
  });

  it('moves a schema-invalid file aside too', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { x: { trust: 'nope' } } }));
    const r = new NexusVaultState(file);
    expect(r.stream(API, USER, STREAM, '/r')).toBeNull();
    expect(r.drainWarnings().map((w) => w.code)).toEqual([W_NEXUS_VAULT_STATE_MOVED]);
    expect(asides()).toHaveLength(1);
  });

  it('never overwrites a file written by a newer CLEO: it is moved aside first', () => {
    const newer = JSON.stringify({ version: 2, accounts: {}, future: true });
    fs.writeFileSync(file, newer);
    const s = new NexusVaultState(file);
    s.saveStream(API, USER, STREAM, '/r', { lastCheckpointId: 'cp', lastCoversSeq: 1 });
    const warnings = s.drainWarnings();
    expect(warnings[0]?.message).toContain('newer CLEO');
    const moved = asides();
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^nexus-vault\.json\.newer-/);
    expect(fs.readFileSync(path.join(dir, moved[0] ?? ''), 'utf8')).toBe(newer);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('writes atomically and leaves no temp files', () => {
    const s = new NexusVaultState(file);
    for (let i = 0; i < 20; i++) {
      s.saveStream(API, USER, `${STREAM}${i}`, '/r', {
        lastCheckpointId: `cp${i}`,
        lastCoversSeq: i,
      });
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(
      Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).accounts[`${API} ${USER}`].streams),
    ).toHaveLength(20);
  });

  it('waits for another process holding the lock, and loses none of its writes', async () => {
    const s = new NexusVaultState(file);
    s.saveStream(API, USER, 'project:first', '/r', { lastCheckpointId: 'a', lastCoversSeq: 1 });
    // Another process takes the lock, writes its own stream, and releases after a delay.
    const lockfilePath = createRequire(import.meta.url).resolve('proper-lockfile');
    const script = `
      const fs = require('node:fs');
      const lockfile = require(${JSON.stringify(lockfilePath)});
      const file = ${JSON.stringify(file)};
      const release = lockfile.lockSync(file, { realpath: false, stale: 10000 });
      process.stdout.write('locked\\n');
      setTimeout(() => {
        const st = JSON.parse(fs.readFileSync(file, 'utf8'));
        st.accounts[${JSON.stringify(`${API} ${USER}`)}].streams['project:child|/r'] =
          { lastCheckpointId: 'c', lastCoversSeq: 2, updatedAt: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(st));
        release();
      }, 400);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const started = Date.now();
    s.saveStream(API, USER, 'project:parent', '/r', { lastCheckpointId: 'p', lastCoversSeq: 3 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const streams = Object.keys(
      JSON.parse(fs.readFileSync(file, 'utf8')).accounts[`${API} ${USER}`].streams,
    ).sort();
    expect(streams).toEqual(['project:child|/r', 'project:first|/r', 'project:parent|/r']);
  });
});
