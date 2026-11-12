/** Fail-closed reaper inactivity proof: real child cwd/open files, worker records and leases. */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeProjectHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRecord } from '../../orchestrate/worker-records.js';
import { listWorkerRecords } from '../../orchestrate/worker-records.js';
import { agentLeaseDir, releaseAgentLease, writeAgentLease } from '../../resources/agent-lease.js';
import * as sqlite from '../../store/sqlite.js';
import {
  worktreeInUseProbe,
  worktreeProcessUse,
  worktreeReaperInUseProbe,
} from '../in-use-probe.js';

vi.mock('../../orchestrate/worker-records.js', () => ({ listWorkerRecords: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

let base: string;
let path: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-use-')));
  path = join(base, 'checkout');
  mkdirSync(path);
  mkdirSync(join(base, '.cleo'));
  writeFileSync(
    join(base, '.cleo', 'project.json'),
    JSON.stringify({ schemaVersion: 1, id: 'reaper-own-project', name: 'own' }),
  );
  writeFileSync(join(path, 'open.txt'), 'keep');
  vi.stubEnv('CLEO_HOME', join(base, 'home'));
  vi.stubEnv('CLEO_ROOT', base);
  vi.stubEnv('CLEO_DIR', join(base, '.cleo'));
  vi.mocked(listWorkerRecords).mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe('reaper inactivity proof', () => {
  it('keeps shared task locks regardless of whether the spawner PID is live or dead', () => {
    for (const [taskId, pid] of [
      ['T1', process.pid],
      ['T2', 2_147_483_647],
    ] as const) {
      acquireWorktreeTaskLock({ projectHash: computeProjectHash(base), taskId, holder: { pid } });
      expect(worktreeInUseProbe(readWorktreeTaskLock, base, taskId)?.()).toBe('task lock held');
    }
  });

  it.each([
    'cwd',
    'open file',
  ])('keeps a done checkout while a child has its %s in it', async (use) => {
    const script =
      use === 'cwd'
        ? "process.send('ready'); setInterval(() => {}, 1000)"
        : "require('node:fs').openSync(process.argv[1], 'r'); process.send('ready'); setInterval(() => {}, 1000)";
    const child = spawn(process.execPath, ['-e', script, join(path, 'open.txt')], {
      cwd: use === 'cwd' ? path : base,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        once(child, 'message'),
        exited.then(() => {
          throw new Error('usage fixture exited before ready');
        }),
      ]);
      const probe = await worktreeReaperInUseProbe(base, 'T1', path);
      expect(probe()).toContain('a process has its cwd or an open file');
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
    expect(worktreeProcessUse(path)).toBeNull();
  });

  it('keeps a terminal checkout with an unclosed worker record, even with no PID or local file use', async () => {
    const worker: WorkerRecord = {
      recordId: 'w1',
      taskId: 'T1',
      instanceId: 'i1',
      agentId: 'a1',
      provider: 'test',
      pid: null,
      pgid: null,
      worktree: path,
      leadMailbox: null,
      sessionId: null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
    };
    vi.mocked(listWorkerRecords).mockResolvedValue([worker]);
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain('worker record');
    expect(listWorkerRecords).toHaveBeenCalledWith(base, true);
    vi.mocked(listWorkerRecords).mockRejectedValueOnce(new Error('store unreadable'));
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain('unavailable');
  });

  it.each([
    'wal',
    'checkpointed',
    'empty',
    'missing',
    'unreadable',
    'schema missing',
    'checkpoint during read',
  ])('probes a foreign %s store without reader writes', async (state) => {
    const foreign = join(base, 'foreign');
    mkdirSync(join(foreign, '.cleo'), { recursive: true });
    writeFileSync(
      join(foreign, '.cleo', 'project.json'),
      JSON.stringify({ schemaVersion: 1, id: 'reaper-foreign-project', name: 'foreign' }),
    );
    const dbPath = join(foreign, '.cleo', 'cleo.db');
    const db = state === 'missing' || state === 'unreadable' ? null : new DatabaseSync(dbPath);
    try {
      if (db !== null) {
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE tasks_agent_instances (
              id TEXT PRIMARY KEY, agent_type TEXT, task_id TEXT,
              stopped_at TEXT, metadata_json TEXT
            );
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
        if (state === 'wal' || state === 'checkpointed') {
          db.prepare(
            "INSERT INTO tasks_agent_instances VALUES ('worker', 'executor', 'T1', NULL, ?)",
          ).run(JSON.stringify({ kind: 'worker', instanceId: 'i1', worktree: path }));
          if (state === 'wal') expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
        }
        if (state === 'schema missing') db.exec('DROP TABLE tasks_agent_instances');
        if (state !== 'wal' && state !== 'checkpoint during read') db.close();
      } else if (state === 'unreadable') writeFileSync(dbPath, 'not a database');

      const actualWorkers = await vi.importActual<
        typeof import('../../orchestrate/worker-records.js')
      >('../../orchestrate/worker-records.js');
      vi.mocked(listWorkerRecords).mockImplementation(actualWorkers.listWorkerRecords);
      const writable = vi
        .spyOn(sqlite, 'getDb')
        .mockRejectedValue(new Error('unexpected writable open'));
      if (state === 'empty')
        writeAgentLease({
          id: 'foreign-lease',
          taskId: 'T1',
          projectRoot: foreign,
          sessionId: 's1',
          takenAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        });
      const files = () =>
        ['', '-wal', '-shm'].map((suffix) =>
          existsSync(`${dbPath}${suffix}`) ? readFileSync(`${dbPath}${suffix}`) : null,
        );
      let expectedFiles = files();
      if (state === 'checkpoint during read' && db !== null) {
        expect(statSync(`${dbPath}-wal`).size).toBe(0);
        const openSnapshot = sqlite.openProjectTasksReadOnly;
        vi.spyOn(sqlite, 'openProjectTasksReadOnly').mockImplementationOnce((root) => {
          const snapshot = openSnapshot(root);
          if (snapshot === null) throw new Error('missing fixture snapshot');
          const prepare = snapshot.db.prepare.bind(snapshot.db);
          vi.spyOn(snapshot.db, 'prepare').mockImplementation((sql) => {
            const statement = prepare(sql);
            const get = statement.get.bind(statement);
            vi.spyOn(statement, 'get').mockImplementationOnce(() => {
              const row = get();
              expect(row).toBeUndefined();
              db.exec(`
                INSERT INTO tasks_agent_instances (id, agent_type, task_id)
                VALUES ('new-worker', 'executor', 'T1');
                PRAGMA wal_checkpoint(TRUNCATE);
              `);
              expect(statSync(`${dbPath}-wal`).size).toBe(0);
              expectedFiles = files();
              return row;
            });
            return statement;
          });
          return snapshot;
        });
      }
      const probe = await worktreeReaperInUseProbe(foreign, 'T1', path);
      expect(probe()).toBe(
        state === 'empty' ? 'an agent-session lease is still live' : 'unknown (foreign project)',
      );
      expect(writable).not.toHaveBeenCalled();
      expect(listWorkerRecords).not.toHaveBeenCalled();
      expect(files()).toEqual(expectedFiles);
    } finally {
      if (db?.isOpen) db.close();
    }
  });

  it('keeps a live session lease and fails closed on malformed lease ownership without deleting it', async () => {
    writeAgentLease({
      id: 'l1',
      taskId: 'T1',
      projectRoot: base,
      sessionId: 's1',
      takenAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    const probe = await worktreeReaperInUseProbe(base, 'T1', path);
    expect(probe()).toContain('lease is still live');
    releaseAgentLease('l1');
    writeFileSync(join(agentLeaseDir(), 'bad.json'), '{');
    expect(probe()).toContain('lease probe unavailable');
  });

  it('keeps the worktree when the OS process-use tool is unavailable', () => {
    const unavailable = spawnSync('cleo-test-command-that-does-not-exist', []);
    vi.mocked(spawnSync).mockReturnValueOnce(unavailable);
    expect(worktreeProcessUse(path)).toContain('unavailable');
  });

  it('leaves expired lease records untouched during a read-only proof', async () => {
    writeAgentLease({
      id: 'expired',
      taskId: 'T1',
      projectRoot: base,
      sessionId: 's1',
      takenAtMs: Date.now() - 120_000,
      expiresAtMs: Date.now() - 60_000,
    });
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toBeNull();
    expect(existsSync(join(agentLeaseDir(), 'expired.json'))).toBe(true);
  });

  it.each([
    'T1',
    'T2',
  ])('protects live %s leases in nested directories whose names begin with two dots', async (taskId) => {
    const nested = join(path, '..cache');
    mkdirSync(nested);
    writeAgentLease({
      id: 'nested',
      taskId,
      projectRoot: nested,
      sessionId: 's1',
      takenAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain('lease is still live');
  });
});
