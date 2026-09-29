/**
 * End to end (T12682): a worker spawned by `orchestrateSpawn` publishes its
 * completion on the wave topic its spawn prompt names, and a Lead listening
 * on the documented topic — `epic-<epicId>.wave-<n>`, n from
 * `cleo orchestrate waves` — receives it. Workers used to be told
 * `wave-<last 4 digits of their task id>`, so the Lead heard nothing.
 * `orchestrate roll-up --wave n` reads the same n.
 *
 * @task T12682
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrateSpawn } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTransport } from '../../conduit/local-transport.js';
import { rollupWaveStatus } from '../../orchestration/lead-rollup.js';
import { getEnrichedWaves } from '../../orchestration/waves.js';
import { ensureConduitDb } from '../../store/conduit-sqlite.js';

interface SeededTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  parentId?: string;
  depends?: string[];
  files?: string[];
  type?: string;
  createdAt: string;
  updatedAt: string | null;
}

async function seedTasks(testRoot: string, tasks: SeededTask[]): Promise<void> {
  await mkdir(join(testRoot, '.cleo'), { recursive: true });
  const { createTask, getDb } = await import('@cleocode/core/internal');
  await getDb(testRoot);
  for (const task of tasks) {
    await createTask(task as unknown as Parameters<typeof createTask>[0], testRoot);
  }
}

const EPIC = 'T700E';
const now = '2026-09-28T00:00:00Z';
const tasks: SeededTask[] = [
  {
    id: EPIC,
    title: 'Wave topic epic',
    description: 'Parent epic for the wave-topic end-to-end test',
    type: 'epic',
    status: 'active',
    priority: 'high',
    createdAt: now,
    updatedAt: null,
  },
  {
    id: 'T700A',
    title: 'First-wave worker',
    description: 'No dependencies, so wave 1',
    status: 'pending',
    priority: 'medium',
    parentId: EPIC,
    files: ['src/a.ts'],
    createdAt: now,
    updatedAt: null,
  },
  {
    // Its id's digits (701) are nothing like its wave number.
    id: 'T701',
    title: 'Second-wave worker',
    description: 'Depends on the first-wave worker, so wave 2',
    status: 'pending',
    priority: 'medium',
    parentId: EPIC,
    depends: ['T700A'],
    files: ['src/b.ts'],
    createdAt: now,
    updatedAt: null,
  },
];

let root: string;
let startCwd: string;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  startCwd = process.cwd();
  root = await mkdtemp(join(tmpdir(), 'cleo-t12682-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await seedTasks(root, tasks);
});

afterEach(async () => {
  process.chdir(startCwd);
  vi.unstubAllEnvs();
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
    await new Promise((r) => setTimeout(r, 50));
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

const conn = (agentId: string) => ({
  agentId,
  apiKey: 'sk_test_fake',
  apiBaseUrl: 'http://localhost:4000',
});

describe('wave topic: spawned worker → Lead (T12682)', () => {
  it("a spawned worker's completion reaches a Lead listening on epic-<id>.wave-<n> from `orchestrate waves`", async () => {
    // T701 becomes spawnable once its dependency is done — the moment its
    // Lead reads the plan and spawns it.
    const { getTaskAccessor } = await import('@cleocode/core/internal');
    await (await getTaskAccessor(root)).updateTaskFields('T700A', {
      status: 'done',
      pipelineStage: 'contribution',
    });

    // Worker side: the real spawn path renders the topic into the prompt.
    const spawned = await orchestrateSpawn('T701', undefined, root, 1, true);
    expect(spawned.success, JSON.stringify(spawned.error)).toBe(true);
    const prompt = (spawned.data as { prompt: string }).prompt;
    const workerTopic = /Your wave topic: `([^`]+)`/.exec(prompt)?.[1];
    const peerId = /Your peer identity: `([^`]+)`/.exec(prompt)?.[1];
    expect(workerTopic).toBeDefined();
    expect(peerId).toBeDefined();

    // Lead side: the documented topic, from the wave number the waves listing prints.
    const plan = await getEnrichedWaves(EPIC, root);
    const n = plan.waves.find((w) => w.taskIds.includes('T701'))?.waveNumber;
    expect(n).toBeDefined();
    const leadTopic = `epic-${EPIC}.wave-${n}`;
    expect(workerTopic).toBe(leadTopic);

    // The signal itself, over the local conduit transport.
    await ensureConduitDb(root);
    process.chdir(root);
    const lead = new LocalTransport();
    await lead.connect(conn('lead-t700e'));
    await lead.subscribeTopic(leadTopic);
    const worker = new LocalTransport();
    await worker.connect(conn(peerId as string));
    await worker.publishToTopic(workerTopic as string, 'T701 complete', {
      kind: 'notify',
      payload: { event: 'work-complete', taskId: 'T701' },
    });
    const heard = await lead.pollTopic(leadTopic);
    expect(heard.map((m) => m.payload)).toContainEqual({
      event: 'work-complete',
      taskId: 'T701',
    });
    await worker.disconnect();
    await lead.disconnect();

    // The Lead rolls up the same wave by the same number.
    const wave = await rollupWaveStatus(EPIC, n as number, root);
    expect(wave.workers.map((w) => w.taskId)).toEqual(['T701']);
  });

  it('a Lead that subscribes AHEAD still hears its worker: wave numbers never shift (T12682, option A)', async () => {
    // Plan time: wave 1 is still pending, and the Lead subscribes to wave 2 now.
    const ahead = await getEnrichedWaves(EPIC, root);
    const n = ahead.waves.find((w) => w.taskIds.includes('T701'))?.waveNumber;
    expect(n).toBe(2);
    const leadTopic = `epic-${EPIC}.wave-${n}`;

    // Wave 1 finishes; T701 becomes spawnable and is spawned.
    const { getTaskAccessor } = await import('@cleocode/core/internal');
    await (await getTaskAccessor(root)).updateTaskFields('T700A', {
      status: 'done',
      pipelineStage: 'contribution',
    });
    const spawned = await orchestrateSpawn('T701', undefined, root, 1, true);
    expect(spawned.success, JSON.stringify(spawned.error)).toBe(true);
    const prompt = (spawned.data as { prompt: string }).prompt;
    expect(/Your wave topic: `([^`]+)`/.exec(prompt)?.[1]).toBe(leadTopic);

    // The finished wave is still listed, under its number.
    const after = await getEnrichedWaves(EPIC, root);
    expect(after.waves.map((w) => [w.waveNumber, w.status])).toEqual([
      [1, 'completed'],
      [2, 'pending'],
    ]);
  });

  it('roll-up numbers waves as `orchestrate waves` does: 0 is refused, 1 is the first wave', async () => {
    const first = await rollupWaveStatus(EPIC, 1, root);
    expect(first.workers.map((w) => w.taskId)).toEqual(['T700A']);
    await expect(rollupWaveStatus(EPIC, 0, root)).rejects.toThrow(/numbered from 1/);
  });
});
