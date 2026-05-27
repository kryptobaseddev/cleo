/**
 * Unit tests for the T9659 `recordRow` callback contract on the CAAMP
 * installer.
 *
 * @remarks
 * Verifies two properties (post-T9747):
 *
 * 1. `resolveSkillsRoot()` from `@cleocode/core/skills/skill-root.js` is the
 *    sole SSoT skills-root resolver. Tests mock it to a tmpdir so installer
 *    fixtures stay hermetic without relying on the legacy `AGENTS_HOME` env
 *    override (which was deleted in T9747).
 * 2. `installSkill(..., { recordRow })` fires the callback exactly once per
 *    install with the canonical install path and a heuristically-correct
 *    `sourceType`.
 *
 * @task T9659
 * @task T9747
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/skills/skill-root.js', () => ({
  resolveSkillsRoot: vi.fn(),
}));

const { resolveSkillsRoot } = await import('@cleocode/core/skills/skill-root.js');
const { inferSkillSourceType, installSkill } = await import('../../src/core/skills/installer.js');
type SkillRowData = import('../../src/core/skills/installer.js').SkillRowData;
import type { Provider } from '../../src/types.js';

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'caamp-recordrow-'));
  originalCwd = process.cwd();
  process.chdir(testDir);
  vi.mocked(resolveSkillsRoot).mockReturnValue(join(testDir, 'cleo-skills'));
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  await rm(testDir, { recursive: true }).catch(() => {});
});

async function createMockSkill(dir: string, name: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n# ${name}\n`,
  );
  return skillDir;
}

function createMockProvider(id: string): Provider {
  return {
    id,
    toolName: `${id}-tool`,
    vendor: 'test-vendor',
    agentFlag: id,
    aliases: [],
    pathGlobal: join(testDir, `${id}-global`),
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
        configPathGlobal: join(testDir, `${id}-config.json`),
        configPathProject: join(testDir, `.${id}-config.json`),
        supportedTransports: ['stdio'],
        supportsHeaders: false,
      },
      harness: null,
      skills: {
        agentsGlobalPath: null,
        agentsProjectPath: null,
        precedence: 'vendor-only',
      },
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

describe('inferSkillSourceType', () => {
  it('classifies library: prefix as canonical', () => {
    expect(inferSkillSourceType('library:ct-orchestrator')).toBe('canonical');
  });

  it('classifies github URLs as community', () => {
    expect(inferSkillSourceType('https://github.com/owner/repo')).toBe('community');
  });

  it('classifies gitlab URLs as community', () => {
    expect(inferSkillSourceType('https://gitlab.com/owner/repo')).toBe('community');
  });

  it('classifies scoped @author/name as community', () => {
    expect(inferSkillSourceType('@author/my-skill')).toBe('community');
  });

  it('classifies bare paths as user', () => {
    expect(inferSkillSourceType('/tmp/local-skill')).toBe('user');
  });

  it('classifies null/undefined as user', () => {
    expect(inferSkillSourceType(null)).toBe('user');
    expect(inferSkillSourceType(undefined)).toBe('user');
  });
});

describe('installSkill recordRow callback (T9659)', () => {
  it('fires recordRow exactly once with the canonical install path', async () => {
    const sourceDir = await createMockSkill(testDir, 'recordrow-skill');
    const skillName = `recordrow-${randomUUID()}`;
    const provider = createMockProvider('claude-code');

    const captured: SkillRowData[] = [];
    const result = await installSkill(sourceDir, skillName, [provider], true, undefined, {
      recordRow: (row) => {
        captured.push(row);
      },
    });

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);

    const row = captured[0]!;
    expect(row.name).toBe(skillName);
    expect(row.installPath).toBe(result.canonicalPath);
    expect(existsSync(row.installPath)).toBe(true);
    // sourceUrl mirrors the source path; sourceType infers 'user' for paths.
    expect(row.sourceUrl).toBe(sourceDir);
    expect(row.sourceType).toBe('user');
  });

  it('uses explicit sourceUrl + sourceType from options when provided', async () => {
    const sourceDir = await createMockSkill(testDir, 'lib-skill');
    const skillName = `lib-${randomUUID()}`;
    const provider = createMockProvider('claude-code');

    const captured: SkillRowData[] = [];
    // Dispatch-layer callers (engine-ops) resolve `library:<name>` to a
    // real filesystem path BEFORE calling installSkill, and pass the
    // original identifier through options so the row preserves provenance.
    const result = await installSkill(sourceDir, skillName, [provider], true, undefined, {
      recordRow: (row) => {
        captured.push(row);
      },
      sourceUrl: `library:${skillName}`,
      sourceType: 'canonical',
    });

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sourceUrl).toBe(`library:${skillName}`);
    expect(captured[0]!.sourceType).toBe('canonical');
  });

  it('falls back to heuristic when sourceType is omitted', async () => {
    const sourceDir = await createMockSkill(testDir, 'heur-skill');
    const skillName = `heur-${randomUUID()}`;
    const provider = createMockProvider('claude-code');

    const captured: SkillRowData[] = [];
    const result = await installSkill(sourceDir, skillName, [provider], true, undefined, {
      recordRow: (row) => {
        captured.push(row);
      },
      // Only sourceUrl provided; sourceType inferred from heuristic.
      sourceUrl: 'https://github.com/owner/repo',
    });

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sourceUrl).toBe('https://github.com/owner/repo');
    expect(captured[0]!.sourceType).toBe('community');
  });

  it('default behaviour (no recordRow) is a silent no-op', async () => {
    const sourceDir = await createMockSkill(testDir, 'silent-skill');
    const skillName = `silent-${randomUUID()}`;
    const provider = createMockProvider('claude-code');

    // Should NOT throw when recordRow is omitted (back-compat with pre-T9659
    // callers).
    const result = await installSkill(sourceDir, skillName, [provider], true);
    expect(result.success).toBe(true);
    const stat = lstatSync(result.canonicalPath);
    expect(stat.isDirectory() || stat.isSymbolicLink()).toBe(true);
  });
});
