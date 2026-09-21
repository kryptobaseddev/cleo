/** CLI flags and params reach canonical task policy through the real dispatcher. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { resetCliDispatcher } from '../../../dispatch/adapters/cli.js';
import { updateCommand } from '../update.js';

vi.mock('../../renderers/index.js', async (original) => ({
  ...(await original<typeof import('../../renderers/index.js')>()),
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

let env: TestDbEnv;
beforeEach(async () => {
  env = await createTestDb();
  vi.stubEnv('CLEO_DIR', env.cleoDir);
  vi.stubEnv('CLEO_PROJECT_ROOT', env.tempDir);
  vi.stubEnv('CLEO_ROOT', env.tempDir);
  vi.stubEnv('CLEO_IDENTITY_SEED', 'ab'.repeat(32));
  // Existing grade mode awaits dispatch audit writes before fixture teardown.
  vi.stubEnv('CLEO_SESSION_GRADE', 'true');
  resetCliDispatcher();
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(async () => {
  resetCliDispatcher();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await env.cleanup();
});

const fixture = { taskId: 'T001', priority: 'critical' };
const flags = ['T001', '--priority', 'critical'];

describe('canonical update policy from CLI inputs', () => {
  beforeEach(async () => {
    await seedTasks(env.accessor, [{ id: 'T001', severity: 'P0' }, { id: 'T002' }]);
  });

  it.each([
    'flags',
    'params',
  ] as const)('rejects critical promotion with no prerequisites through %s', async (form) => {
    const rawArgs = form === 'flags' ? flags : ['T001', '--params', JSON.stringify(fixture)];
    await expect(runCommand(updateCommand, { rawArgs })).rejects.toThrow('process.exit(6)');
    expect((await env.accessor.loadSingleTask('T001'))?.priority).toBe('medium');
    expect(await env.accessor.queryAuditLog({ actions: ['task_updated'] })).toEqual([]);
  });

  it.each(['flags', 'params'] as const)('persists an explicit waiver through %s', async (form) => {
    const reason = 'Independent critical recovery';
    const rawArgs =
      form === 'flags'
        ? [...flags, '--depends-waiver', reason]
        : ['T001', '--params', JSON.stringify({ ...fixture, dependsWaiver: reason })];
    await runCommand(updateCommand, { rawArgs });
    expect((await env.accessor.loadSingleTask('T001'))?.priority).toBe('critical');
    const entries = await env.accessor.queryAuditLog({ actions: ['task_updated'] });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.detailsJson!)).toMatchObject({ dependsWaiver: reason });
  });

  it('accepts existing dependencies but rejects removal in the same critical mutation', async () => {
    await seedTasks(env.accessor, [{ id: 'T001', severity: 'P0', depends: ['T002'] }]);
    await runCommand(updateCommand, { rawArgs: flags });
    await expect(
      runCommand(updateCommand, { rawArgs: [...flags, '--remove-depends', 'T002'] }),
    ).rejects.toThrow('process.exit(6)');
    expect((await env.accessor.loadSingleTask('T001'))?.depends).toEqual(['T002']);
    expect(await env.accessor.queryAuditLog({ actions: ['task_updated'] })).toHaveLength(1);
  });

  it.each([
    'flags',
    'params',
  ] as const)('rejects unauthorized severity through %s', async (form) => {
    const configPath = join(env.cleoDir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...config, ownerPubkeys: ['00'.repeat(32)] }));
    const rawArgs =
      form === 'flags'
        ? ['T001', '--severity', 'P3']
        : ['T001', '--params', JSON.stringify({ taskId: 'T001', severity: 'P3' })];
    await expect(runCommand(updateCommand, { rawArgs })).rejects.toThrow('process.exit(72)');
    expect((await env.accessor.loadSingleTask('T001'))?.severity).toBe('P0');
    expect(await env.accessor.queryAuditLog({ actions: ['task_updated'] })).toEqual([]);
  });
});
