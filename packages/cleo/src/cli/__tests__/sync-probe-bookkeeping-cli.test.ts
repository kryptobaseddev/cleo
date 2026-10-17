/**
 * `cleo cloud verify` / `cloud status` write no startup bookkeeping (T13852):
 * the compiled CLI with a temp HOME, CLEO_HOME and project. Before the fix a
 * verify more than a minute after a push refreshed this device's
 * `nexus_devices` heartbeat (and the project encounter) first, then compared
 * the changed store and reported the device "ahead" of its own push. Skipped
 * without a build (CI restores one before unit tests).
 *
 * @task T13852
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const live = existsSync(CLI_DIST) ? it : it.skip;

let dir: string;
let cleoHome: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sync-probe-'));
  cleoHome = join(dir, 'cleo-home');
  project = join(dir, 'proj');
  for (const d of [cleoHome, project, join(dir, 'home')]) mkdirSync(d);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cleo(args: readonly string[]) {
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      CLEO_HOME: cleoHome,
      TMPDIR: dir,
      CLEO_DEBUG: '1',
      // Nothing listens here: no command in this test may reach a real service.
      CLEO_NEXUS_API_URL: 'http://127.0.0.1:9',
    },
    timeout: 120_000,
  });
  return { stderr: r.stderr.toString('utf-8'), status: r.status };
}

/** Age this device's heartbeat past the one-minute throttle (row and stamp). */
function ageHeartbeat(): void {
  const db = new DatabaseSync(join(cleoHome, 'cleo.db'));
  db.prepare("UPDATE nexus_devices SET last_heartbeat_at = '2000-01-01T00:00:00.000Z'").run();
  db.close();
  const old = new Date('2000-01-01T00:00:00Z');
  utimesSync(join(cleoHome, 'device-heartbeat.stamp'), old, old);
}

function heartbeats(): string[] {
  const db = new DatabaseSync(join(cleoHome, 'cleo.db'), { readOnly: true });
  const rows = db.prepare('SELECT last_heartbeat_at AS at FROM nexus_devices').all();
  db.close();
  return rows.map((r) => String(r['at']));
}

describe('sync-state probes skip startup bookkeeping (compiled CLI)', () => {
  live(
    'cloud verify and cloud status leave nexus_devices alone; other commands still heartbeat',
    () => {
      expect(cleo(['init', '--name', 'probe']).status).toBe(0);
      cleo(['current']); // the first command after init records the device
      ageHeartbeat();

      for (const probe of [
        ['cloud', 'verify'],
        ['cloud', 'status'],
      ]) {
        const r = cleo(probe);
        expect(r.stderr).toContain('Device heartbeat: skipped');
        expect(r.stderr).toContain('Project encounter: skipped');
        expect(heartbeats()).toEqual(['2000-01-01T00:00:00.000Z']);
      }

      const used = cleo(['current']);
      expect(used.stderr).toContain('Device heartbeat: written');
      expect(heartbeats()[0]).not.toBe('2000-01-01T00:00:00.000Z');
    },
  );
});
