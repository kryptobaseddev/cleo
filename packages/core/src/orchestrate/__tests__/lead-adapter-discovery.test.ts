/** Real installed-package discovery through the lead entrypoint (T14449). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CleoConfig } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectHarnessSpawnProvider } from '../../harness/spawn-provider-selection.js';
import { spawnRegistry } from '../../spawn/adapter-registry.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { AgentMbxClient } from '../agentmbx.js';
import { orchestrateLead } from '../lead.js';

vi.mock('@cleocode/worktree', () => import('../../../../worktree/src/index.js'));

// T14448: the lead records and claims its mailbox before any spawn; the
// default client is agentmbx-absent under vitest, which refuses the lead
// before the composer. A granted stub keeps this probe about discovery.
const grantedMbx: AgentMbxClient = {
  available: async () => true,
  send: async () => ({ ok: false, warning: 'not used here' }),
  inbox: async () => ({ ok: false, warning: 'not used here' }),
  claim: async (name) => ({ ok: true, value: { name, state: 'bound', unread: 0 } }),
  status: async () => ({ ok: true, value: { name: null, state: 'unknown', unread: 0 } }),
  release: async () => ({ ok: true, value: { name: null, state: 'unbound', unread: 0 } }),
};

// Stop after real discovery/selection and the session claim, before any agent can run.
vi.mock('../plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plan.js')>()),
  openAgentRegistryDbForComposer: async () => ({ close: () => undefined }),
}));
vi.mock('../../orchestration/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../orchestration/spawn.js')>()),
  composeSpawnPayload: async () => ({
    taskId: 'T100',
    prompt: '',
    agentId: 'adapter-selection-probe',
    role: 'lead',
    harnessHint: 'generic',
    atomicity: {
      allowed: false,
      code: 'E_ATOMICITY_VIOLATION',
      message: 'Adapter selection reached composer',
    },
    meta: { protocol: 'implementation' },
  }),
}));

const terminalCwd = process.cwd();
let env: TestDbEnv;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  env = await createTestDb();
  vi.stubEnv('CLEO_ROOT', env.tempDir);
  vi.stubEnv('CLEO_PROJECT_ROOT', env.tempDir);
  await seedTasks(env.accessor, [
    { id: 'T100', title: 'Discovery probe', type: 'epic', status: 'pending', priority: 'medium' },
  ]);
  const file = join(env.cleoDir, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as CleoConfig;
  config.orchestrate = { leadWorker: { v1: true } };
  writeFileSync(file, JSON.stringify(config));
  const bin = join(env.tempDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '', {
    mode: 0o755,
  });
  vi.stubEnv('PATH', `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`);
  vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined);
  vi.stubEnv('CLAUDECODE', undefined);
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  spawnRegistry.clear();
});

afterEach(async () => {
  process.chdir(terminalCwd);
  spawnRegistry.clear();
  await env.cleanup();
  vi.unstubAllEnvs();
});

describe('plain-terminal adapter selection', () => {
  it.each([
    'cleocode root',
    'project without packages',
  ])('lead passes real adapter selection from %s', async (terminal) => {
    if (terminal === 'project without packages') process.chdir(env.tempDir);
    expect(existsSync(join(env.tempDir, 'packages'))).toBe(false);
    const selection = await selectHarnessSpawnProvider(['supportsSubagents']);
    expect(selection).toMatchObject({
      success: true,
      data: { adapterId: 'claude-code', providerId: 'claude-code' },
    });
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      adapterId: 'claude-code',
      mbxClient: grantedMbx,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'E_ATOMICITY_VIOLATION', message: 'Adapter selection reached composer' },
    });
    expect(spawnRegistry.get('claude-code')?.providerId).toBe('claude-code');
  });
});
