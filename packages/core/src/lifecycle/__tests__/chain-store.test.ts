/**
 * Tests for WarpChain storage CRUD operations.
 *
 * Covers addChain, showChain, listChains, createInstance,
 * advanceInstance, and showInstance using temp-dir SQLite.
 *
 * @task T5404
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateResult, WarpChain } from '../../../types/warp-chain.js';

let tempDir: string;

function makeMinimalChain(overrides?: Partial<WarpChain>): WarpChain {
  return {
    id: 'test-chain',
    name: 'Test Chain',
    version: '1.0.0',
    description: 'A minimal test chain',
    shape: {
      stages: [
        { id: 'stage-a', name: 'Stage A', category: 'research', skippable: false },
        { id: 'stage-b', name: 'Stage B', category: 'implementation', skippable: false },
      ],
      links: [{ from: 'stage-a', to: 'stage-b', type: 'linear' }],
      entryPoint: 'stage-a',
      exitPoints: ['stage-b'],
    },
    gates: [],
    ...overrides,
  };
}

function makeThreeStageChain(overrides?: Partial<WarpChain>): WarpChain {
  return makeMinimalChain({
    id: 'three-stage-chain',
    name: 'Three Stage Chain',
    shape: {
      stages: [
        { id: 'stage-a', name: 'Stage A', category: 'research', skippable: false },
        { id: 'stage-b', name: 'Stage B', category: 'implementation', skippable: false },
        { id: 'stage-c', name: 'Stage C', category: 'validation', skippable: false },
      ],
      links: [
        { from: 'stage-a', to: 'stage-b', type: 'linear' },
        { from: 'stage-b', to: 'stage-c', type: 'linear' },
      ],
      entryPoint: 'stage-a',
      exitPoints: ['stage-c'],
    },
    ...overrides,
  });
}

describe('WarpChain chain-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-chainstore-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../../../store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('addChain stores valid chain, showChain retrieves it', async () => {
    const { addChain, showChain } = await import('../chain-store.js');
    const chain = makeMinimalChain();

    await addChain(chain, tempDir);

    const retrieved = await showChain('test-chain', tempDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('test-chain');
    expect(retrieved!.name).toBe('Test Chain');
    expect(retrieved!.shape.stages).toHaveLength(2);
    expect(retrieved!.shape.entryPoint).toBe('stage-a');
  });

  it('addChain rejects invalid chain (missing entry point)', async () => {
    const { addChain } = await import('../chain-store.js');
    const chain = makeMinimalChain({
      shape: {
        stages: [{ id: 'stage-a', name: 'Stage A', category: 'research', skippable: false }],
        links: [],
        entryPoint: 'nonexistent',
        exitPoints: ['stage-a'],
      },
    });

    await expect(addChain(chain, tempDir)).rejects.toThrow('Chain validation failed');
  });

  it('showChain returns null for nonexistent ID', async () => {
    const { showChain } = await import('../chain-store.js');

    const result = await showChain('does-not-exist', tempDir);
    expect(result).toBeNull();
  });

  it('listChains returns all stored chains', async () => {
    const { addChain, listChains } = await import('../chain-store.js');

    await addChain(makeMinimalChain({ id: 'chain-1', name: 'Chain 1' }), tempDir);
    await addChain(makeMinimalChain({ id: 'chain-2', name: 'Chain 2' }), tempDir);

    const chains = await listChains(tempDir);
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.id).sort()).toEqual(['chain-1', 'chain-2']);
  });

  it('findChains filters by query, category, tessera, and archetype', async () => {
    const { addChain, findChains } = await import('../chain-store.js');

    await addChain(
      makeMinimalChain({
        id: 'alpha-chain',
        name: 'Alpha Build Chain',
        description: 'Research and implementation workflow',
        tessera: 'tessera-alpha',
        metadata: { archetypes: ['lifecycle', 'alpha'] },
      }),
      tempDir,
    );

    await addChain(
      makeMinimalChain({
        id: 'beta-chain',
        name: 'Beta Release Chain',
        description: 'Release-first workflow',
        shape: {
          stages: [{ id: 'release', name: 'Release', category: 'release', skippable: false }],
          links: [],
          entryPoint: 'release',
          exitPoints: ['release'],
        },
        tessera: 'tessera-beta',
        metadata: { archetype: 'release' },
      }),
      tempDir,
    );

    const byQuery = await findChains({ query: 'alpha' }, tempDir);
    expect(byQuery.map((chain) => chain.id)).toEqual(['alpha-chain']);

    const byCategory = await findChains({ category: 'release' }, tempDir);
    expect(byCategory.map((chain) => chain.id)).toEqual(['beta-chain']);

    const byTessera = await findChains({ tessera: 'tessera-alpha' }, tempDir);
    expect(byTessera.map((chain) => chain.id)).toEqual(['alpha-chain']);

    const byArchetype = await findChains({ archetype: 'release' }, tempDir);
    expect(byArchetype.map((chain) => chain.id)).toEqual(['beta-chain']);

    const withLimit = await findChains({ query: 'chain', limit: 1 }, tempDir);
    expect(withLimit).toHaveLength(1);
  });

  it('createInstance binds chain to epic with variables', async () => {
    const { addChain, createInstance } = await import('../chain-store.js');
    const chain = makeMinimalChain();
    await addChain(chain, tempDir);

    const instance = await createInstance(
      {
        chainId: 'test-chain',
        epicId: 'T9999',
        variables: { projectName: 'test-project' },
      },
      tempDir,
    );

    expect(instance.id).toMatch(/^wci-/);
    expect(instance.chainId).toBe('test-chain');
    expect(instance.epicId).toBe('T9999');
    expect(instance.variables).toEqual({ projectName: 'test-project' });
    expect(instance.status).toBe('pending');
    expect(instance.currentStage).toBe('stage-a');
  });

  it('enforces DB foreign key for chain instances', async () => {
    const { getDb } = await import('../../../store/sqlite.js');
    const { warpChainInstances } = await import('../../../store/chain-schema.js');

    const db = await getDb(tempDir);

    await expect(
      db.insert(warpChainInstances).values({
        id: 'wci-orphan',
        chainId: 'missing-chain',
        epicId: 'T9999',
        status: 'pending',
      }),
    ).rejects.toThrow();

    const instances = await db.select().from(warpChainInstances);
    expect(instances).toHaveLength(0);
  });

  it('advanceInstance updates currentStage and records gate results', async () => {
    const { addChain, createInstance, advanceInstance } = await import('../chain-store.js');
    const chain = makeMinimalChain();
    await addChain(chain, tempDir);

    const instance = await createInstance({ chainId: 'test-chain', epicId: 'T9999' }, tempDir);

    const gateResult: GateResult = {
      gateId: 'gate-1',
      passed: true,
      forced: false,
      message: 'All checks passed',
      evaluatedAt: new Date().toISOString(),
    };

    const advanced = await advanceInstance(instance.id, 'stage-b', [gateResult], tempDir);

    expect(advanced.currentStage).toBe('stage-b');
    expect(advanced.status).toBe('active');
  });

  it('showInstance returns full state with gate results', async () => {
    const { addChain, createInstance, advanceInstance, showInstance } = await import(
      '../chain-store.js'
    );
    const chain = makeMinimalChain();
    await addChain(chain, tempDir);

    const instance = await createInstance({ chainId: 'test-chain', epicId: 'T9999' }, tempDir);

    const gateResult: GateResult = {
      gateId: 'gate-1',
      passed: true,
      forced: false,
      evaluatedAt: new Date().toISOString(),
    };

    await advanceInstance(instance.id, 'stage-b', [gateResult], tempDir);

    const retrieved = await showInstance(instance.id, tempDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.currentStage).toBe('stage-b');
    expect(retrieved!.status).toBe('active');
    expect(retrieved!.chainId).toBe('test-chain');
    expect(retrieved!.epicId).toBe('T9999');
  });

  it('rejects illegal transition and preserves instance state', async () => {
    const { addChain, createInstance, advanceInstance, showInstance, listInstanceGateResults } =
      await import('../chain-store.js');
    const chain = makeThreeStageChain();
    await addChain(chain, tempDir);

    const instance = await createInstance(
      { chainId: 'three-stage-chain', epicId: 'T9999' },
      tempDir,
    );

    const initialState = await showInstance(instance.id, tempDir);
    expect(initialState).not.toBeNull();
    expect(initialState!.currentStage).toBe('stage-a');
    expect(initialState!.status).toBe('pending');

    await expect(advanceInstance(instance.id, 'stage-c', [], tempDir)).rejects.toThrow(
      'Invalid stage transition: "stage-a" -> "stage-c" is not allowed in chain "three-stage-chain"',
    );

    const afterFailedAdvance = await showInstance(instance.id, tempDir);
    expect(afterFailedAdvance).not.toBeNull();
    expect(afterFailedAdvance!.currentStage).toBe('stage-a');
    expect(afterFailedAdvance!.status).toBe('pending');
    await expect(listInstanceGateResults(instance.id, tempDir)).resolves.toEqual([]);
  });

  it('rejects terminal-state transitions and unknown stage transitions', async () => {
    const { addChain, createInstance, advanceInstance, showInstance } = await import(
      '../chain-store.js'
    );
    const { getDb } = await import('../../../store/sqlite.js');
    const { warpChainInstances } = await import('../../../store/chain-schema.js');
    const chain = makeMinimalChain();
    await addChain(chain, tempDir);

    const instance = await createInstance({ chainId: 'test-chain', epicId: 'T9999' }, tempDir);

    await expect(advanceInstance(instance.id, 'stage-z', [], tempDir)).rejects.toThrow(
      'Invalid stage transition: stage "stage-z" is not defined in chain "test-chain"',
    );

    const db = await getDb(tempDir);
    await db
      .update(warpChainInstances)
      .set({ status: 'completed' })
      .where(eq(warpChainInstances.id, instance.id));

    await expect(advanceInstance(instance.id, 'stage-b', [], tempDir)).rejects.toThrow(
      `Chain instance "${instance.id}" cannot advance from terminal status "completed"`,
    );

    const persisted = await showInstance(instance.id, tempDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.currentStage).toBe('stage-a');
    expect(persisted!.status).toBe('completed');
  });
});
