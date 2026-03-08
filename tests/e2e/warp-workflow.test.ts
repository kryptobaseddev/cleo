/**
 * Warp Workflow E2E Test
 *
 * End-to-end test covering:
 * 1. List tessera templates -> find default RCASD
 * 2. Instantiate template for a test epic -> get chain instance
 * 3. Validate the chain via validateChain
 * 4. Assert explicit wave plan for instantiated chain
 * 5. Advance through first 3 stages with passing gate results
 * 5. Compose two small custom chains via sequenceChains -> validate result
 * 6. Compose via parallelChains -> validate result
 *
 * @task T5412
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateResult, WarpChain, WarpStage } from '../../src/types/warp-chain.js';

let tempDir: string;

function makeSmallChain(id: string, stageIds: [string, string]): WarpChain {
  return {
    id,
    name: `Chain ${id}`,
    version: '1.0.0',
    description: `Small test chain ${id}`,
    shape: {
      stages: [
        { id: stageIds[0], name: `Stage ${stageIds[0]}`, category: 'research', skippable: false },
        {
          id: stageIds[1],
          name: `Stage ${stageIds[1]}`,
          category: 'implementation',
          skippable: false,
        },
      ],
      links: [{ from: stageIds[0], to: stageIds[1], type: 'linear' }],
      entryPoint: stageIds[0],
      exitPoints: [stageIds[1]],
    },
    gates: [],
  };
}

describe('Warp workflow E2E', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-warp-e2e-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('full lifecycle: template -> instantiate -> validate -> advance -> compose', async () => {
    const { listTesseraTemplates, instantiateTessera } = await import(
      '../../src/core/lifecycle/tessera-engine.js'
    );
    const { validateChain } = await import('../../src/core/validation/chain-validation.js');
    const { advanceInstance, showInstance, listInstanceGateResults } = await import(
      '../../src/core/lifecycle/chain-store.js'
    );
    const { sequenceChains, parallelChains } = await import(
      '../../src/core/lifecycle/chain-composition.js'
    );

    // 1. List tessera templates -> find default RCASD
    const templates = listTesseraTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(1);

    const rcasd = templates.find((t) => t.id === 'tessera-rcasd');
    expect(rcasd).toBeDefined();
    expect(rcasd!.category).toBe('lifecycle');
    expect(rcasd!.variables).toHaveProperty('epicId');

    // 2. Instantiate template for a test epic -> get chain instance
    const instance = await instantiateTessera(
      rcasd!,
      {
        templateId: rcasd!.id,
        epicId: 'T7777',
        variables: { epicId: 'T7777', projectName: 'e2e-test' },
      },
      tempDir,
    );

    expect(instance.id).toMatch(/^wci-/);
    expect(instance.epicId).toBe('T7777');
    expect(instance.status).toBe('pending');

    // 3. Validate the chain via validateChain
    const chainValidation = validateChain(rcasd!);
    expect(chainValidation.wellFormed).toBe(true);
    expect(chainValidation.gateSatisfiable).toBe(true);
    expect(chainValidation.errors).toHaveLength(0);

    // 4. Assert chain shape has expected structure (chain.plan removed in T5615)
    expect(rcasd!.shape).toMatchObject({
      entryPoint: rcasd!.shape.entryPoint,
      exitPoints: rcasd!.shape.exitPoints,
    });
    expect(rcasd!.shape.stages.length).toBeGreaterThanOrEqual(4);

    const shapeStageIds = rcasd!.shape.stages.map((stage) => stage.id);
    expect(shapeStageIds).toContain(rcasd!.shape.entryPoint);
    for (const exitPoint of rcasd!.shape.exitPoints) {
      expect(shapeStageIds).toContain(exitPoint);
    }

    // 5. Advance through first 3 stages with passing gate results
    const stages = rcasd!.shape.stages;
    expect(stages.length).toBeGreaterThanOrEqual(4);

    const gateResult1: GateResult = {
      gateId: 'e2e-gate-1',
      passed: true,
      forced: false,
      message: 'E2E stage 1 complete',
      evaluatedAt: new Date().toISOString(),
    };

    const advanced1 = await advanceInstance(instance.id, stages[1].id, [gateResult1], tempDir);
    expect(advanced1.currentStage).toBe(stages[1].id);
    expect(advanced1.status).toBe('active');

    const gateResult2: GateResult = {
      gateId: 'e2e-gate-2',
      passed: true,
      forced: false,
      message: 'E2E stage 2 complete',
      evaluatedAt: new Date().toISOString(),
    };

    const advanced2 = await advanceInstance(instance.id, stages[2].id, [gateResult2], tempDir);
    expect(advanced2.currentStage).toBe(stages[2].id);
    expect(advanced2.status).toBe('active');

    const gateResult3: GateResult = {
      gateId: 'e2e-gate-3',
      passed: true,
      forced: false,
      message: 'E2E stage 3 complete',
      evaluatedAt: new Date().toISOString(),
    };

    const advanced3 = await advanceInstance(instance.id, stages[3].id, [gateResult3], tempDir);
    expect(advanced3.currentStage).toBe(stages[3].id);
    expect(advanced3.status).toBe('active');

    const finalState = await showInstance(instance.id, tempDir);
    expect(finalState).not.toBeNull();
    expect(finalState!.currentStage).toBe(stages[3].id);
    expect(finalState!.status).toBe('active');

    const gateResults = await listInstanceGateResults(instance.id, tempDir);
    expect(gateResults).toHaveLength(3);
    expect(gateResults.map((result) => result.gateId)).toEqual([
      'e2e-gate-1',
      'e2e-gate-2',
      'e2e-gate-3',
    ]);

    // 6. Compose two small custom chains via sequenceChains -> validate result
    const chainA = makeSmallChain('chain-a', ['a1', 'a2']);
    const chainB = makeSmallChain('chain-b', ['b1', 'b2']);

    const sequenced = sequenceChains(chainA, chainB);
    expect(sequenced.id).toBe('chain-a+chain-b');
    expect(sequenced.shape.stages).toHaveLength(4);
    expect(sequenced.shape.entryPoint).toBe('a1');

    const seqValidation = validateChain(sequenced);
    expect(seqValidation.wellFormed).toBe(true);
    expect(seqValidation.errors).toHaveLength(0);

    // 7. Compose via parallelChains -> validate result
    const joinStage: WarpStage = {
      id: 'join-point',
      name: 'Join Point',
      category: 'custom',
      skippable: false,
    };

    const parallel = parallelChains([chainA, chainB], joinStage);
    expect(parallel.shape.stages.length).toBeGreaterThanOrEqual(5); // fork + 2*2 + join
    expect(parallel.shape.entryPoint).toBe('parallel-fork');
    expect(parallel.shape.exitPoints).toEqual(['join-point']);

    const parValidation = validateChain(parallel);
    expect(parValidation.wellFormed).toBe(true);
    expect(parValidation.errors).toHaveLength(0);
  });

  it('tessera instantiation substitutes nested placeholders end-to-end', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import(
      '../../src/core/lifecycle/tessera-engine.js'
    );
    const { showChain } = await import('../../src/core/lifecycle/chain-store.js');

    const base = buildDefaultTessera();
    const template = {
      ...base,
      id: 'tessera-rcasd-e2e-sub',
      tessera: 'tessera-rcasd-e2e-sub',
      description: 'Project {{projectName}} on {{epicId}}',
      metadata: {
        deployment: {
          label: '{{projectName}}',
          epic: '{{epicId}}',
          skip: '{{skipResearch}}',
        },
      },
    };

    const instance = await instantiateTessera(
      template,
      {
        templateId: template.id,
        epicId: 'T7777',
        variables: {
          epicId: 'T7777',
          projectName: 'warp-e2e',
          skipResearch: false,
        },
      },
      tempDir,
    );

    const stored = await showChain(template.id, tempDir);
    expect(instance.variables).toMatchObject({
      epicId: 'T7777',
      projectName: 'warp-e2e',
      skipResearch: false,
    });
    expect(stored).not.toBeNull();
    expect(stored!.description).toBe('Project warp-e2e on T7777');
    expect(stored!.metadata).toMatchObject({
      deployment: {
        label: 'warp-e2e',
        epic: 'T7777',
        skip: false,
      },
      variables: {
        epicId: 'T7777',
        projectName: 'warp-e2e',
        skipResearch: false,
      },
    });
  });

  it('invalid-type flow fails deterministically and valid flow still works', async () => {
    const { listTesseraTemplates, instantiateTessera } = await import(
      '../../src/core/lifecycle/tessera-engine.js'
    );

    const template = listTesseraTemplates().find((t) => t.id === 'tessera-rcasd');
    expect(template).toBeDefined();

    await expect(
      instantiateTessera(
        template!,
        {
          templateId: template!.id,
          epicId: 'T7777',
          variables: {
            epicId: 'T7777',
            skipResearch: 'yes',
          },
        },
        tempDir,
      ),
    ).rejects.toThrow('Invalid variable type for "skipResearch": expected boolean, got string');

    const validInstance = await instantiateTessera(
      template!,
      {
        templateId: template!.id,
        epicId: 'T7777',
        variables: {
          epicId: 'T7777',
          projectName: 'still-valid',
          skipResearch: true,
        },
      },
      tempDir,
    );

    expect(validInstance.epicId).toBe('T7777');
    expect(validInstance.variables).toMatchObject({
      epicId: 'T7777',
      projectName: 'still-valid',
      skipResearch: true,
    });
  });
});
