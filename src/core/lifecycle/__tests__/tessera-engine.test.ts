/**
 * Tests for Tessera instantiation engine.
 *
 * Covers buildDefaultTessera, instantiateTessera, listTesseraTemplates,
 * and showTessera using temp-dir SQLite.
 *
 * @task T5410
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

function buildTypedTemplate() {
  return {
    id: 'tessera-typed-contract',
    name: 'Typed Contract Template',
    version: '1.0.0',
    description: 'Template for type contract assertions',
    shape: {
      stages: [
        { id: 's1', name: 'Stage 1', category: 'research' as const, skippable: false },
        { id: 's2', name: 'Stage 2', category: 'implementation' as const, skippable: false },
      ],
      links: [{ from: 's1', to: 's2', type: 'linear' as const }],
      entryPoint: 's1',
      exitPoints: ['s2'],
    },
    gates: [],
    tessera: 'tessera-typed-contract',
    metadata: {},
    variables: {
      epicId: {
        name: 'epicId',
        type: 'epicId' as const,
        description: 'Epic id',
        required: true,
      },
      projectName: {
        name: 'projectName',
        type: 'string' as const,
        description: 'Project name',
        required: false,
      },
      skipResearch: {
        name: 'skipResearch',
        type: 'boolean' as const,
        description: 'Skip research',
        required: false,
      },
      maxRounds: {
        name: 'maxRounds',
        type: 'number' as const,
        description: 'Max rounds',
        required: false,
      },
      taskRef: {
        name: 'taskRef',
        type: 'taskId' as const,
        description: 'Task reference',
        required: false,
      },
    },
    defaultValues: {
      projectName: 'typed-default',
      skipResearch: false,
      maxRounds: 3,
      taskRef: 'T1000',
    },
    archetypes: ['lifecycle'],
    category: 'custom' as const,
  };
}

describe('Tessera engine', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-tessera-'));
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

  it('buildDefaultTessera returns valid TesseraTemplate', async () => {
    const { buildDefaultTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    expect(template.id).toBe('tessera-rcasd');
    expect(template.category).toBe('lifecycle');
    expect(template.archetypes).toContain('rcasd');
    expect(template.variables).toHaveProperty('epicId');
    expect(template.variables).toHaveProperty('projectName');
    expect(template.variables).toHaveProperty('skipResearch');
    expect(template.variables.epicId.required).toBe(true);
    expect(template.variables.projectName.required).toBe(false);
    expect(template.shape.stages.length).toBeGreaterThan(0);
    expect(template.gates.length).toBeGreaterThan(0);
  });

  it('instantiate default RCASD template creates valid instance', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();
    const instance = await instantiateTessera(
      template,
      {
        templateId: template.id,
        epicId: 'T8888',
        variables: { epicId: 'T8888', projectName: 'my-project' },
      },
      tempDir,
    );

    expect(instance.id).toMatch(/^wci-/);
    expect(instance.chainId).toBe('tessera-rcasd');
    expect(instance.epicId).toBe('T8888');
    expect(instance.variables).toHaveProperty('projectName', 'my-project');
    expect(instance.status).toBe('pending');
  });

  it('missing required variable (epicId) throws error', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    await expect(
      instantiateTessera(
        template,
        { templateId: template.id, epicId: 'T8888', variables: {} },
        tempDir,
      ),
    ).rejects.toThrow('Missing required variable: epicId');
  });

  it('default values applied when optional variable not provided', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();
    const instance = await instantiateTessera(
      template,
      {
        templateId: template.id,
        epicId: 'T8888',
        variables: { epicId: 'T8888' },
      },
      tempDir,
    );

    expect(instance.variables).toHaveProperty('projectName', 'unnamed');
    expect(instance.variables).toHaveProperty('skipResearch', false);
  });

  it('invalid variable type throws deterministic diagnostic', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    await expect(
      instantiateTessera(
        template,
        {
          templateId: template.id,
          epicId: 'T8888',
          variables: { epicId: 'T8888', skipResearch: 'yes' },
        },
        tempDir,
      ),
    ).rejects.toThrow('Invalid variable type for "skipResearch": expected boolean, got string');
  });

  it.each([
    {
      label: 'string variable type mismatch',
      variables: { epicId: 'T8888', projectName: 42 },
      message: 'Invalid variable type for "projectName": expected string, got number',
    },
    {
      label: 'number variable type mismatch',
      variables: { epicId: 'T8888', maxRounds: '5' },
      message: 'Invalid variable type for "maxRounds": expected finite number, got string',
    },
    {
      label: 'taskId variable type mismatch',
      variables: { epicId: 'T8888', taskRef: false },
      message: 'Invalid variable type for "taskRef": expected taskId, got boolean',
    },
    {
      label: 'epicId variable type mismatch',
      variables: { epicId: 9999 },
      message: 'Invalid variable type for "epicId": expected epicId, got number',
    },
  ])('invalid variable type contract: $label', async ({ variables, message }) => {
    const { instantiateTessera } = await import('../tessera-engine.js');

    await expect(
      instantiateTessera(
        buildTypedTemplate(),
        {
          templateId: 'tessera-typed-contract',
          epicId: 'T8888',
          variables,
        },
        tempDir,
      ),
    ).rejects.toThrow(message);
  });

  it('positive path still succeeds after invalid-type assertions', async () => {
    const { instantiateTessera } = await import('../tessera-engine.js');

    const instance = await instantiateTessera(
      buildTypedTemplate(),
      {
        templateId: 'tessera-typed-contract',
        epicId: 'T8888',
        variables: {
          epicId: 'T8888',
          projectName: 'typed-happy-path',
          skipResearch: true,
          maxRounds: 5,
          taskRef: 'T9000',
        },
      },
      tempDir,
    );

    expect(instance.epicId).toBe('T8888');
    expect(instance.variables).toMatchObject({
      epicId: 'T8888',
      projectName: 'typed-happy-path',
      skipResearch: true,
      maxRounds: 5,
      taskRef: 'T9000',
    });
  });

  it('invalid epicId format throws deterministic diagnostic', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    await expect(
      instantiateTessera(
        template,
        {
          templateId: template.id,
          epicId: 'T8888',
          variables: { epicId: 'epic-1' },
        },
        tempDir,
      ),
    ).rejects.toThrow('Invalid variable format for "epicId": expected epicId like "T1234", got "epic-1"');
  });

  it('unknown input variable throws deterministic diagnostic', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    await expect(
      instantiateTessera(
        template,
        {
          templateId: template.id,
          epicId: 'T8888',
          variables: { epicId: 'T8888', notDeclared: true },
        },
        tempDir,
      ),
    ).rejects.toThrow('Unknown variable: notDeclared. Allowed variables: epicId, projectName, skipResearch');
  });

  it('treats undefined required variable as missing', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const template = buildDefaultTessera();

    await expect(
      instantiateTessera(
        template,
        {
          templateId: template.id,
          epicId: 'T8888',
          variables: { epicId: undefined },
        },
        tempDir,
      ),
    ).rejects.toThrow('Missing required variable: epicId');
  });

  it('performs deep substitution in nested chain structures', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');
    const { showChain } = await import('../chain-store.js');

    const base = buildDefaultTessera();
    const template = {
      ...base,
      name: 'Pipeline {{projectName}}',
      description: 'Epic {{epicId}} skip={{skipResearch}}',
      shape: {
        ...base.shape,
        stages: base.shape.stages.map((stage, index) =>
          index === 0
            ? {
                ...stage,
                name: 'Start {{projectName}}',
                description: '{{epicId}}',
              }
            : stage,
        ),
      },
      gates: [
        {
          ...base.gates[0],
          id: 'gate-substitute-test',
          name: 'Skip flag {{skipResearch}}',
          check: {
            type: 'custom' as const,
            validator: 'validator-{{projectName}}',
            params: {
              epicRaw: '{{epicId}}',
              nested: {
                project: '{{projectName}}',
                skip: '{{skipResearch}}',
              },
            },
          },
        },
      ],
      metadata: {
        nested: {
          project: '{{projectName}}',
          epic: '{{epicId}}',
          skip: '{{skipResearch}}',
        },
      },
    };

    const instance = await instantiateTessera(
      template,
      {
        templateId: template.id,
        epicId: 'T8888',
        variables: {
          epicId: 'T8888',
          projectName: 'deep-sub',
          skipResearch: true,
        },
      },
      tempDir,
    );

    const persisted = await showChain(template.id, tempDir);
    expect(instance.variables).toMatchObject({
      epicId: 'T8888',
      projectName: 'deep-sub',
      skipResearch: true,
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.name).toBe('Pipeline deep-sub');
    expect(persisted!.description).toBe('Epic T8888 skip=true');
    expect(persisted!.shape.stages[0].name).toBe('Start deep-sub');
    expect(persisted!.shape.stages[0].description).toBe('T8888');
    expect(persisted!.gates[0].name).toBe('Skip flag true');
    expect(persisted!.gates[0].check).toEqual({
      type: 'custom',
      validator: 'validator-deep-sub',
      params: {
        epicRaw: 'T8888',
        nested: {
          project: 'deep-sub',
          skip: true,
        },
      },
    });
    expect(persisted!.metadata).toMatchObject({
      nested: {
        project: 'deep-sub',
        epic: 'T8888',
        skip: true,
      },
      variables: {
        epicId: 'T8888',
        projectName: 'deep-sub',
        skipResearch: true,
      },
    });
  });

  it('throws deterministic error for unknown substitution variable', async () => {
    const { buildDefaultTessera, instantiateTessera } = await import('../tessera-engine.js');

    const base = buildDefaultTessera();
    const template = {
      ...base,
      description: 'Uses unknown {{missingVar}}',
    };

    await expect(
      instantiateTessera(
        template,
        {
          templateId: template.id,
          epicId: 'T8888',
          variables: { epicId: 'T8888' },
        },
        tempDir,
      ),
    ).rejects.toThrow('Unknown template variable "missingVar" at chain.description');
  });

  it('listTesseraTemplates returns at least default template', async () => {
    const { listTesseraTemplates } = await import('../tessera-engine.js');

    const templates = listTesseraTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.some((t) => t.id === 'tessera-rcasd')).toBe(true);
  });

  it('showTessera returns template by ID', async () => {
    const { showTessera } = await import('../tessera-engine.js');

    const template = showTessera('tessera-rcasd');
    expect(template).not.toBeNull();
    expect(template!.id).toBe('tessera-rcasd');
    expect(template!.category).toBe('lifecycle');
  });

  it('showTessera returns null for nonexistent', async () => {
    const { showTessera } = await import('../tessera-engine.js');

    const result = showTessera('nonexistent-id');
    expect(result).toBeNull();
  });
});
