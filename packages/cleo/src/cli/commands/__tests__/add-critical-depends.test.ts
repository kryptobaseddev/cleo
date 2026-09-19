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
import { addCommand } from '../add.js';

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

const fixture = {
  title: 'CLI control fixture',
  description: 'Verify real dispatch policy',
  type: 'saga',
  priority: 'critical',
};
const flags = [
  '--title',
  fixture.title,
  '--description',
  fixture.description,
  '--type',
  fixture.type,
  '--priority',
  fixture.priority,
];

describe('canonical creation policy from CLI inputs', () => {
  it.each([
    'flags',
    'params',
  ] as const)('rejects critical creation with no prerequisites through %s', async (form) => {
    const rawArgs = form === 'flags' ? flags : ['--params', JSON.stringify(fixture)];
    await expect(runCommand(addCommand, { rawArgs })).rejects.toThrow('process.exit(6)');
    expect((await env.accessor.queryTasks({})).tasks).toEqual([]);
    expect(await env.accessor.queryAuditLog({ actions: ['task_created'] })).toEqual([]);
  });

  it.each(['flags', 'params'] as const)('persists an explicit waiver through %s', async (form) => {
    const reason = 'Independent critical recovery';
    const rawArgs =
      form === 'flags'
        ? [...flags, '--depends-waiver', reason]
        : ['--params', JSON.stringify({ ...fixture, dependsWaiver: reason })];
    await runCommand(addCommand, { rawArgs });
    expect((await env.accessor.queryTasks({})).tasks[0]?.priority).toBe('critical');
    const entries = await env.accessor.queryAuditLog({ actions: ['task_created'] });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.detailsJson!)).toMatchObject({ dependsWaiver: reason });
  });

  it('persists declared dependencies through flags', async () => {
    await seedTasks(env.accessor, [{ id: 'T001' }]);
    await runCommand(addCommand, { rawArgs: [...flags, '--depends', 'T001'] });
    const created = (await env.accessor.queryTasks({})).tasks.find(
      (task) => task.title === fixture.title,
    );
    expect(created?.depends).toEqual(['T001']);
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
        ? [...flags, '--depends-waiver', 'Independent work', '--severity', 'P1']
        : [
            '--params',
            JSON.stringify({ ...fixture, dependsWaiver: 'Independent work', severity: 'P1' }),
          ];
    await expect(runCommand(addCommand, { rawArgs })).rejects.toThrow('process.exit(72)');
    expect((await env.accessor.queryTasks({})).tasks).toEqual([]);
    expect(await env.accessor.queryAuditLog({ actions: ['task_created'] })).toEqual([]);
  });
});
