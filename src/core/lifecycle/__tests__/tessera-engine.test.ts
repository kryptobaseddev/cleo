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
