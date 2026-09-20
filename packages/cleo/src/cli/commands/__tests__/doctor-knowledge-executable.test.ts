/** Executable regression: child flags validate before repair and emit one envelope. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { KnowledgeRepairLedgerEntry } from '@cleocode/contracts/knowledge-health';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../../../../core/src/__tests__/test-cleanup.js';
import { generateProjectHash } from '../../../../../core/src/nexus/hash.js';
import { getBrainDb, getBrainNativeDb } from '../../../../../core/src/store/memory-sqlite.js';
import { getNexusDb } from '../../../../../core/src/store/nexus-sqlite.js';
import { closeAllDatabases, getDb } from '../../../../../core/src/store/sqlite.js';

const cli = resolve('packages/cleo/dist/cli/index.js');
let root: string;

beforeEach(async () => {
  expect(existsSync(cli), 'Build the CLI before running executable regressions').toBe(true);
  root = mkdtempSync(join(tmpdir(), 'cleo-doctor-cli-'));
  mkdirSync(join(root, '.cleo'));
  vi.stubEnv('CLEO_ROOT', root);
  vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
  vi.stubEnv('CLEO_HOME', join(root, 'home'));
  writeFileSync(
    join(root, '.cleo/project-info.json'),
    JSON.stringify({
      projectId: 'repair-cli',
      projectHash: generateProjectHash(root),
      projectRoot: root,
    }),
  );
  await getBrainDb(root);
  await getNexusDb(root);
  await getDb(root);
  const db = getBrainNativeDb(root);
  if (!db) throw new Error('Missing fixture database');
  db.prepare(`INSERT INTO main.brain_observations (id, type, title, narrative)
    VALUES ('O-stub', 'discovery', 'Task complete: T448', 'Task T448 completed with status: undefined')`).run();
});

afterEach(async () => {
  await closeAllDatabases();
  vi.unstubAllEnvs();
  removeTempDirSync(root);
});

function invoke(flags: string[]) {
  return spawnSync(
    process.execPath,
    ['--no-warnings', cli, 'doctor', 'knowledge', '--json', '--budget-ms', '10000', ...flags],
    {
      cwd: root,
      env: { ...process.env, CLEO_ROOT: root },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

describe('doctor knowledge executable dispatch', () => {
  it('accepts a child-only --task flag and emits one successful envelope', () => {
    const result = invoke(['--dry-run', '--task', 'T448']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ success: true });
  });

  it('rejects an unknown child flag before --fix can quarantine a record', () => {
    const result = invoke(['--fix', '--task-id', 'T448']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(6);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ success: false });
    expect(lines[0]).toContain('E_UNKNOWN_FLAG');
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
  });
  it('requires an explicit actor and rejects ambiguous lifecycle actions before mutation', () => {
    for (const flags of [
      ['--fix'],
      ['--fix', '--inspect', 'job', '--actor', 'cli-test'],
      ['--fix', '--actor', 'cli-test', '--proposal-id', 'unrelated-input'],
      ['--fix', '--actor', 'cli-test', '--budget-ms', '0'],
    ]) {
      const result = invoke(flags);
      expect(result.status, result.stderr + result.stdout).toBe(6);
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
    }
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id='O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
  });

  it('retrieves, prepares, applies, inspects and rolls back through independent CLI processes', () => {
    const assessed = invoke(['--dry-run']);
    expect(assessed.status, assessed.stderr + assessed.stdout).toBe(0);
    const proposal = JSON.parse(assessed.stdout).data.proposals[0];
    expect(proposal).toMatchObject({ projectId: 'repair-cli' });
    const file = join(root, 'proposal.json');
    writeFileSync(file, JSON.stringify(proposal));
    const prepared = invoke(['--prepare', file, '--actor', 'cli-test']);
    expect(prepared.status, prepared.stderr + prepared.stdout).toBe(0);
    const pending = JSON.parse(prepared.stdout).data;
    expect(pending.jobStatus).toBe('pending');
    const identity = ['--actor', 'cli-test', '--proposal-id', proposal.id];
    const applied = invoke(['--apply', pending.jobId, ...identity]);
    expect(applied.status, applied.stderr + applied.stdout).toBe(0);
    const receipt = JSON.parse(applied.stdout).data;
    expect(receipt).toMatchObject({ id: proposal.id, state: 'repaired' });
    const inspected = invoke(['--inspect', pending.jobId, ...identity, '--limit', '1']);
    expect(inspected.status, inspected.stderr + inspected.stdout).toBe(0);
    expect(JSON.parse(inspected.stdout).data).toMatchObject({
      status: 'complete',
      receipt,
      ledgerComplete: false,
    });
    const repeated = invoke(['--resume', pending.jobId, ...identity]);
    expect(repeated.status, repeated.stderr + repeated.stdout).toBe(0);
    expect(JSON.parse(repeated.stdout).data).toEqual(receipt);
    const rollbackFlags = [
      '--rollback',
      receipt.id,
      '--actor',
      'cli-test',
      '--proposal-id',
      'cli-recovery',
    ];
    const rollback = invoke(rollbackFlags);
    expect(rollback.status, rollback.stderr + rollback.stdout).toBe(0);
    expect(JSON.parse(rollback.stdout).data).toMatchObject({
      state: 'repaired',
      id: 'cli-recovery',
    });
    const repeatRollback = invoke(rollbackFlags);
    expect(repeatRollback.status, repeatRollback.stderr + repeatRollback.stdout).toBe(0);
    expect(JSON.parse(repeatRollback.stdout).data).toEqual(JSON.parse(rollback.stdout).data);
    const corrected = invoke(['--inspect', pending.jobId, ...identity]);
    expect(corrected.status, corrected.stderr + corrected.stdout).toBe(0);
    expect(JSON.parse(corrected.stdout).data).toMatchObject({
      receipt,
      rollbackReceipt: { id: 'cli-recovery' },
    });
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id='O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
  }, 120000);

  it('rejects stale proposals without relabeling failed attempts or discarding intervening edits', () => {
    const assessed = invoke(['--dry-run']);
    expect(assessed.status, assessed.stderr + assessed.stdout).toBe(0);
    const proposal = JSON.parse(assessed.stdout).data.proposals[0];
    const file = join(root, 'proposal.json');
    writeFileSync(file, JSON.stringify(proposal));
    const prepared = invoke(['--prepare', file, '--actor', 'cli-test']);
    expect(prepared.status, prepared.stderr + prepared.stdout).toBe(0);
    const pending = JSON.parse(prepared.stdout).data;
    getBrainNativeDb(root)
      ?.prepare(
        "UPDATE main.brain_observations SET title='Preserved real finding' WHERE id='O-stub'",
      )
      .run();
    const identity = ['--actor', 'cli-test', '--proposal-id', proposal.id];
    const stale = invoke(['--apply', pending.jobId, ...identity]);
    expect(stale.status, stale.stderr + stale.stdout).toBe(6);
    expect(JSON.parse(stale.stdout)).toMatchObject({ success: false });
    const cancel = invoke(['--cancel', pending.jobId, ...identity]);
    expect(cancel.status, cancel.stderr + cancel.stdout).toBe(0);
    const resume = invoke(['--resume', pending.jobId, ...identity]);
    expect(resume.status, resume.stderr + resume.stdout).toBe(6);
    const inspected = invoke(['--inspect', pending.jobId, ...identity]);
    expect(inspected.status, inspected.stderr + inspected.stdout).toBe(0);
    expect(JSON.parse(cancel.stdout).data.requested).toBe(false);
    expect(JSON.parse(inspected.stdout).data).toMatchObject({
      status: 'failed',
      attempts: 1,
      receipt: null,
    });
    expect(JSON.parse(stale.stdout).error.details.attemptFailure).toMatchObject({
      attempt: { status: 'failed', errorCode: 'E_REPAIR_STALE' },
    });
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT title,invalid_at FROM main.brain_observations WHERE id='O-stub'")
        .get(),
    ).toMatchObject({ title: 'Preserved real finding', invalid_at: null });
  }, 120000);

  it('explicitly resumes a cancelled prepared job without discarding its prior outcome', () => {
    const assessed = invoke(['--dry-run']);
    expect(assessed.status, assessed.stderr + assessed.stdout).toBe(0);
    const proposal = JSON.parse(assessed.stdout).data.proposals[0];
    const file = join(root, 'proposal.json');
    writeFileSync(file, JSON.stringify(proposal));
    const prepared = invoke(['--prepare', file, '--actor', 'cli-test']);
    expect(prepared.status, prepared.stderr + prepared.stdout).toBe(0);
    const pending = JSON.parse(prepared.stdout).data;
    const identity = ['--actor', 'cli-test', '--proposal-id', proposal.id];
    const cancelled = invoke(['--cancel', pending.jobId, ...identity]);
    expect(cancelled.status, cancelled.stderr + cancelled.stdout).toBe(0);
    expect(JSON.parse(cancelled.stdout).data).toMatchObject({
      requested: true,
      inspection: { status: 'cancelled' },
    });
    const wrongActor = invoke([
      '--resume',
      pending.jobId,
      '--actor',
      'other',
      '--proposal-id',
      proposal.id,
    ]);
    expect(wrongActor.status, wrongActor.stderr + wrongActor.stdout).toBe(6);
    const resumed = invoke(['--resume', pending.jobId, ...identity]);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    const inspected = invoke(['--inspect', pending.jobId, ...identity]);
    expect(inspected.status, inspected.stderr + inspected.stdout).toBe(0);
    expect(JSON.parse(inspected.stdout).data).toMatchObject({
      status: 'complete',
      attempts: 1,
      ledgerComplete: true,
    });
    expect(
      JSON.parse(inspected.stdout).data.ledger.some((entry: KnowledgeRepairLedgerEntry) =>
        entry.key.startsWith('knowledge_repair_retry:'),
      ),
    ).toBe(true);
  }, 120000);
  it('refuses rollback after conflicting affected-row changes and preserves the committed receipt', () => {
    const repaired = invoke(['--fix', '--actor', 'cli-test']);
    expect(repaired.status, repaired.stderr + repaired.stdout).toBe(0);
    const receipt = JSON.parse(repaired.stdout).data;
    expect(receipt.state).toBe('repaired');
    getBrainNativeDb(root)
      ?.prepare(
        "UPDATE main.brain_observations SET title='User correction after repair' WHERE id='O-stub'",
      )
      .run();
    const rollback = invoke([
      '--rollback',
      receipt.id,
      '--actor',
      'cli-test',
      '--proposal-id',
      'conflicting-recovery',
    ]);
    expect(rollback.status, rollback.stderr + rollback.stdout).toBe(6);
    const inspected = invoke([
      '--inspect',
      receipt.execution.jobId,
      '--actor',
      'cli-test',
      '--proposal-id',
      receipt.id,
    ]);
    expect(inspected.status, inspected.stderr + inspected.stdout).toBe(0);
    expect(JSON.parse(inspected.stdout).data).toMatchObject({
      status: 'complete',
      receipt,
      rollbackReceipt: null,
    });
    const row = getBrainNativeDb(root)
      ?.prepare("SELECT title,invalid_at FROM main.brain_observations WHERE id='O-stub'")
      .get();
    expect(row?.title).toBe('User correction after repair');
    expect(row?.invalid_at).not.toBeNull();
  }, 120000);
});
