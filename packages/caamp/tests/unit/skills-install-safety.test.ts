/**
 * T12383 — a skill install must never remove the installed copy before its
 * replacement is fully staged.
 *
 * Reproduces the sandbox data loss from the CAAMP study (2026-09-25):
 * `cleo tools skill install <name>` handed the literal string
 * `library:<name>` to the installer as a filesystem path. The installer ran
 * `rm -rf <canonical>/<name>` first and only then `cp('library:<name>')`,
 * which threw `ENOENT` — so the skill went from present to gone.
 *
 * @task T12383
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/skills/skill-root.js', () => ({
  resolveSkillsRoot: vi.fn(),
}));

const { resolveSkillsRoot } = await import('@cleocode/core/skills/skill-root.js');
const { installSkill, installToCanonical } = await import('../../src/core/skills/installer.js');

import type { Provider } from '../../src/types.js';

let testDir: string;
let skillsRoot: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'caamp-install-safety-'));
  skillsRoot = join(testDir, '.cleo', 'skills');
  vi.mocked(resolveSkillsRoot).mockReturnValue(skillsRoot);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n`);
  return dir;
}

function provider(id: string): Provider {
  return {
    id,
    toolName: id,
    vendor: 'test',
    agentFlag: id,
    aliases: [],
    pathGlobal: join(testDir, id),
    pathProject: `.${id}`,
    instructFile: 'AGENTS.md',
    pathSkills: join(testDir, `${id}-skills`),
    pathProjectSkills: `.${id}-skills`,
    detection: { methods: ['binary'], binary: id },
    priority: 'high',
    status: 'active',
    agentSkillsCompatible: true,
    capabilities: {
      mcp: {
        configKey: 'mcpServers',
        configFormat: 'json',
        configPathGlobal: join(testDir, `${id}.json`),
        configPathProject: `.${id}.json`,
        supportedTransports: ['stdio'],
        supportsHeaders: false,
      },
      harness: null,
      skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: 'vendor-only' },
      hooks: {
        supported: [],
        hookConfigPath: null,
        hookConfigPathProject: null,
        hookFormat: null,
        nativeEventCatalog: 'canonical',
        canInjectSystemPrompt: false,
        canBlockTools: false,
      },
      spawn: {
        supportsSubagents: false,
        supportsProgrammaticSpawn: false,
        supportsInterAgentComms: false,
        supportsParallelSpawn: false,
        spawnMechanism: null,
        spawnCommand: null,
      },
    },
  };
}

describe('T12383 — install never deletes the existing copy first', () => {
  it('keeps the installed skill when the source path does not exist', async () => {
    const installed = await writeSkill(join(skillsRoot, 'demo'), 'demo', 'installed copy');

    await expect(installToCanonical('library:demo', 'demo')).rejects.toThrow();

    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
    expect(await readFile(join(installed, 'SKILL.md'), 'utf-8')).toContain('installed copy');
  });

  it('keeps the installed skill when installSkill is handed an unresolved library id', async () => {
    const installed = await writeSkill(join(skillsRoot, 'demo'), 'demo', 'installed copy');

    await expect(installSkill('library:demo', 'demo', [provider('p1')], true)).rejects.toThrow();

    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
  });

  it('replaces the installed copy once the new one is staged, leaving no staging debris', async () => {
    await writeSkill(join(skillsRoot, 'demo'), 'demo', 'old copy');
    await writeFile(join(skillsRoot, 'demo', 'stale.txt'), 'stale');
    const source = await writeSkill(join(testDir, 'src', 'demo'), 'demo', 'new copy');

    const target = await installToCanonical(source, 'demo');

    expect(await readFile(join(target, 'SKILL.md'), 'utf-8')).toContain('new copy');
    expect(existsSync(join(target, 'stale.txt'))).toBe(false);
    expect(readdirSync(skillsRoot)).toEqual(['demo']);
  });

  it('swaps a real directory at a provider link path only after the link is staged', async () => {
    const source = await writeSkill(join(testDir, 'src', 'demo'), 'demo', 'new copy');
    const p = provider('p2');
    const userDir = await writeSkill(join(testDir, 'p2-skills', 'demo'), 'demo', 'user copy');

    const result = await installSkill(source, 'demo', [p], true);

    // Linking succeeds and the provider entry now resolves to the new copy …
    expect(result.linkedAgents).toEqual(['p2']);
    expect(await readFile(join(userDir, 'SKILL.md'), 'utf-8')).toContain('new copy');
    // … without leaving swap debris beside it.
    expect(readdirSync(join(testDir, 'p2-skills'))).toEqual(['demo']);
  });
});
