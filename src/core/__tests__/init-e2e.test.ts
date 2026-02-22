/**
 * E2E dogfood test: cleo init in a fresh project.
 *
 * Verifies the full init pipeline creates the expected .cleo/ directory
 * structure, core data files, and injection references.
 *
 * @task T4694
 * @epic T4663
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants as fsConstants, existsSync } from 'node:fs';
import { initProject } from '../init.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

describe('E2E: cleo init in fresh project (T4694)', () => {
  let testDir: string;
  let origCwd: string;
  let origCleoDir: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-init-e2e-'));
    origCwd = process.cwd();
    origCleoDir = process.env['CLEO_DIR'];
    process.chdir(testDir);
    process.env['CLEO_DIR'] = join(testDir, '.cleo');
  });

  afterEach(async () => {
    process.chdir(origCwd);
    if (origCleoDir !== undefined) {
      process.env['CLEO_DIR'] = origCleoDir;
    } else {
      delete process.env['CLEO_DIR'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates .cleo/ directory', async () => {
    const result = await initProject({ name: 'test-project' });
    expect(result.initialized).toBe(true);
    expect(existsSync(join(testDir, '.cleo'))).toBe(true);
  });

  it('creates tasks.json with valid structure', async () => {
    await initProject({ name: 'test-project' });
    const todoPath = join(testDir, '.cleo', 'tasks.json');
    expect(await fileExists(todoPath)).toBe(true);

    const content = JSON.parse(await readFile(todoPath, 'utf-8'));
    expect(content.version).toBe('2.10.0');
    expect(content.project.name).toBe('test-project');
    expect(content._meta).toBeDefined();
    expect(content._meta.schemaVersion).toBe('2.10.0');
    expect(content.tasks).toEqual([]);
  });

  it('creates config.json with valid structure', async () => {
    await initProject({ name: 'test-project' });
    const configPath = join(testDir, '.cleo', 'config.json');
    expect(await fileExists(configPath)).toBe(true);

    const content = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(content.version).toBe('2.10.0');
    expect(content.output).toBeDefined();
    expect(content.output.defaultFormat).toBe('json');
    expect(content.hierarchy).toBeDefined();
    expect(content.hierarchy.maxDepth).toBe(3);
    expect(content.hierarchy.maxSiblings).toBe(7);
  });

  it('creates sessions.json', async () => {
    await initProject({ name: 'test-project' });
    const sessionsPath = join(testDir, '.cleo', 'sessions.json');
    expect(await fileExists(sessionsPath)).toBe(true);

    const content = JSON.parse(await readFile(sessionsPath, 'utf-8'));
    expect(content.sessions).toEqual([]);
  });

  it('creates .sequence.json file', async () => {
    await initProject({ name: 'test-project' });
    const sequencePath = join(testDir, '.cleo', '.sequence.json');
    expect(await fileExists(sequencePath)).toBe(true);
    const content = JSON.parse(await readFile(sequencePath, 'utf-8'));
    expect(content.counter).toBe(0);
    expect(content.lastId).toBe('T000');
  });

  it('creates .cleo/.gitignore', async () => {
    await initProject({ name: 'test-project' });
    const gitignorePath = join(testDir, '.cleo', '.gitignore');
    expect(await fileExists(gitignorePath)).toBe(true);
    const content = await readFile(gitignorePath, 'utf-8');
    // Should contain agent-outputs/ and backup patterns
    expect(content).toContain('agent-outputs/');
    expect(content).toContain('.backups/');
  });

  it('creates todo-log.jsonl', async () => {
    await initProject({ name: 'test-project' });
    const logPath = join(testDir, '.cleo', 'todo-log.jsonl');
    expect(await fileExists(logPath)).toBe(true);
  });

  it('creates todo-archive.json', async () => {
    await initProject({ name: 'test-project' });
    const archivePath = join(testDir, '.cleo', 'todo-archive.json');
    expect(await fileExists(archivePath)).toBe(true);
    const content = JSON.parse(await readFile(archivePath, 'utf-8'));
    expect(content.archivedTasks).toEqual([]);
  });

  it('creates backup directories', async () => {
    await initProject({ name: 'test-project' });
    expect(existsSync(join(testDir, '.cleo', 'backups', 'operational'))).toBe(true);
    expect(existsSync(join(testDir, '.cleo', 'backups', 'safety'))).toBe(true);
  });

  it('creates project-info.json with project metadata', async () => {
    await initProject({ name: 'test-project' });
    const projectInfoPath = join(testDir, '.cleo', 'project-info.json');
    expect(await fileExists(projectInfoPath)).toBe(true);
    const content = JSON.parse(await readFile(projectInfoPath, 'utf-8'));
    expect(content.projectHash).toBeDefined();
    expect(typeof content.projectHash).toBe('string');
    expect(content.cleoVersion).toBeDefined();
    expect(content.schemas.todo).toBe('2.10.0');
  });

  it('creates templates/AGENT-INJECTION.md', async () => {
    await initProject({ name: 'test-project' });
    const templatePath = join(testDir, '.cleo', 'templates', 'AGENT-INJECTION.md');
    expect(await fileExists(templatePath)).toBe(true);
    const content = await readFile(templatePath, 'utf-8');
    // Should reference the global CLEO-INJECTION.md
    expect(content).toContain('CLEO-INJECTION.md');
  });

  it('skips existing files without --force', async () => {
    await initProject({ name: 'first-run' });
    const result = await initProject({ name: 'second-run' });
    // Key files should be in skipped list
    expect(result.skipped).toContain('tasks.json');
    expect(result.skipped).toContain('config.json');
    expect(result.skipped).toContain('sessions.json');
  });

  it('overwrites existing files with --force', async () => {
    await initProject({ name: 'first-run' });
    const result = await initProject({ name: 'overwrite-run', force: true });
    // Should recreate key files
    expect(result.created).toContain('tasks.json');
    expect(result.created).toContain('config.json');

    const content = JSON.parse(await readFile(join(testDir, '.cleo', 'tasks.json'), 'utf-8'));
    expect(content.project.name).toBe('overwrite-run');
  });

  it('returns initialized=true on success', async () => {
    const result = await initProject({ name: 'test-project' });
    expect(result.initialized).toBe(true);
    expect(result.directory).toContain('.cleo');
    expect(result.created.length).toBeGreaterThan(0);
  });

  it('handles --detect flag for project type detection', async () => {
    // Create a package.json so detection has something to find
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      devDependencies: { vitest: '^1.0.0' },
    }));

    const result = await initProject({ name: 'test-project', detect: true });
    expect(result.initialized).toBe(true);
    // project-context.json should be created when detection succeeds
    const created = result.created.join(',');
    expect(created).toContain('project-context.json');
  });
});
