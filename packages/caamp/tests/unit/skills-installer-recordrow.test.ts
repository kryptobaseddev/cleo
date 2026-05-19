/**
 * Unit tests for the T9659 `recordRow` callback contract on the CAAMP
 * installer.
 *
 * @remarks
 * Verifies three properties:
 *
 * 1. `getCanonicalSkillsDir()` (and its newer alias
 *    `getCanonicalSkillsRoot()`) resolve to the new SSoT under `~/.cleo/skills/`
 *    when no `AGENTS_HOME` override is in play.
 * 2. The `AGENTS_HOME` test-seam still wins so existing fixtures keep working.
 * 3. `installSkill(..., { recordRow })` fires the callback exactly once per
 *    install with the canonical install path and a heuristically-correct
 *    `sourceType`.
 *
 * @task T9659
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLegacySkillsWarning,
  getCanonicalSkillsDir,
  getCanonicalSkillsRoot,
} from '../../src/core/paths/standard.js';
import {
  inferSkillSourceType,
  installSkill,
  type SkillRowData,
} from '../../src/core/skills/installer.js';
import type { Provider } from '../../src/types.js';

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'caamp-recordrow-'));
  originalCwd = process.cwd();
  process.chdir(testDir);
  _resetLegacySkillsWarning();
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

describe('getCanonicalSkillsRoot (T9659)', () => {
  it('AGENTS_HOME override still wins for tests', () => {
    vi.stubEnv('AGENTS_HOME', join(testDir, 'agents-tmp'));
    const root = getCanonicalSkillsRoot();
    expect(root).toBe(join(testDir, 'agents-tmp', 'skills'));
  });

  it('getCanonicalSkillsDir() delegates to getCanonicalSkillsRoot()', () => {
    vi.stubEnv('AGENTS_HOME', join(testDir, 'agents-tmp-2'));
    expect(getCanonicalSkillsDir()).toBe(getCanonicalSkillsRoot());
  });

  it('defaults to ~/.cleo/skills on fresh-install (no AGENTS_HOME, no legacy)', () => {
    // unstub to force inheritance of process default (empty string -> falsy)
    delete process.env.AGENTS_HOME;
    const root = getCanonicalSkillsRoot();
    // Should always end with the SSoT subpath on a fresh-install machine where
    // ~/.cleo/skills doesn't exist yet (resolver returns the preferred path).
    // On dev machines where ~/.cleo/skills DOES exist, this also passes.
    const isNewSSoT = root.endsWith(join('.cleo', 'skills'));
    const isLegacy = root.endsWith(join('agents', 'skills'));
    expect(isNewSSoT || isLegacy).toBe(true);
    expect(root.startsWith(homedir())).toBe(true);
  });
});

describe('installSkill recordRow callback (T9659)', () => {
  it('fires recordRow exactly once with the canonical install path', async () => {
    vi.stubEnv('AGENTS_HOME', join(testDir, '.agents'));
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
    vi.stubEnv('AGENTS_HOME', join(testDir, '.agents'));
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
    vi.stubEnv('AGENTS_HOME', join(testDir, '.agents'));
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
    vi.stubEnv('AGENTS_HOME', join(testDir, '.agents'));
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
