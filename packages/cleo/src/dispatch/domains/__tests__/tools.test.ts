import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalog: {
    listProtocols: vi.fn(() => []),
    getProtocolPath: vi.fn(() => null),
    listProfiles: vi.fn(() => []),
    getProfile: vi.fn(() => undefined),
    listSharedResources: vi.fn(() => []),
    getSharedResourcePath: vi.fn(() => null),
    isCatalogAvailable: vi.fn(() => true),
    getVersion: vi.fn(() => '2.0.0'),
    getLibraryRoot: vi.fn(() => '/tmp/cleocode-skills'),
    getSkills: vi.fn(() => []),
    getDispatchMatrix: vi.fn(() => ({ by_task_type: {}, by_keyword: {}, by_protocol: {} })),
    getSkill: vi.fn(() => undefined),
    getSkillDependencies: vi.fn(() => []),
    resolveDependencyTree: vi.fn(() => []),
  },
  discoverSkill: vi.fn(async () => null),
  discoverSkills: vi.fn(async () => []),
  resolveSkillsRoot: vi.fn(() => '/tmp/skills'),
  installSkillFromSource: vi.fn(async () => ({
    name: 'ct-test',
    canonicalPath: '/tmp/skills/ct-test',
    linkedAgents: ['claude-code'],
    errors: [],
    success: true,
    sourceValue: 'library:ct-test',
    sourceType: 'library',
  })),
  removeSkill: vi.fn(async () => ({ removed: ['ct-test'], errors: [] })),
  getInstalledProviders: vi.fn(() => [{ id: 'claude-code' }]),
  getAllProviders: vi.fn(() => [{ id: 'claude-code' }]),
  getProvider: vi.fn(() => ({ id: 'claude-code' })),
  getProvidersBySkillsPrecedence: vi.fn(() => [{ id: 'claude-code' }]),
  getEffectiveSkillsPaths: vi.fn(() => [
    { path: '/tmp/skills', source: 'agents', scope: 'project' },
  ]),
  buildSkillsMap: vi.fn(() => []),
  detectAllProviders: vi.fn(() => [{ id: 'claude-code', installed: true }]),
  getTrackedSkills: vi.fn(async () => ({})),
  checkAllSkillUpdates: vi.fn(async () => ({})),
  checkAllInjections: vi.fn(async () => []),
  injectAll: vi.fn(async () => new Map()),
  buildInjectionContent: vi.fn(() => '@AGENTS.md'),
  validateSkill: vi.fn(async () => ({
    valid: false,
    issues: [
      { level: 'error', field: 'description', message: 'Missing required field: description' },
    ],
    metadata: { name: 'ct-planted' },
  })),
}));

vi.mock('@cleocode/core/skills/skill-root.js', () => ({
  resolveSkillsRoot: mocks.resolveSkillsRoot,
  resolveBundledSkillsDir: () => null,
}));

vi.mock('@cleocode/caamp', () => ({
  catalog: mocks.catalog,
  discoverSkill: mocks.discoverSkill,
  discoverSkills: mocks.discoverSkills,
  installSkillFromSource: mocks.installSkillFromSource,
  SkillInstallError: class SkillInstallError extends Error {},
  removeSkill: mocks.removeSkill,
  getInstalledProviders: mocks.getInstalledProviders,
  getAllProviders: mocks.getAllProviders,
  getProvider: mocks.getProvider,
  getProvidersBySkillsPrecedence: mocks.getProvidersBySkillsPrecedence,
  getEffectiveSkillsPaths: mocks.getEffectiveSkillsPaths,
  buildSkillsMap: mocks.buildSkillsMap,
  detectAllProviders: mocks.detectAllProviders,
  getTrackedSkills: mocks.getTrackedSkills,
  checkAllSkillUpdates: mocks.checkAllSkillUpdates,
  checkAllInjections: mocks.checkAllInjections,
  injectAll: mocks.injectAll,
  buildInjectionContent: mocks.buildInjectionContent,
  validateSkill: mocks.validateSkill,
}));

import { ToolsHandler } from '../tools.js';

describe('ToolsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skill list via CAAMP', async () => {
    mocks.discoverSkills.mockResolvedValueOnce([
      { name: 'ct-test', metadata: { description: 'test skill' } },
      { name: 'ct-second', metadata: { description: 'second skill' } },
    ] as any);
    const handler = new ToolsHandler();
    const res = await handler.query('skill.list', { limit: 1, offset: 1 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      skills: [{ name: 'ct-second', metadata: { description: 'second skill' } }],
      count: 2,
      total: 2,
      filtered: 2,
    });
    expect(res.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
  });

  it('installs a skill via CAAMP', async () => {
    const handler = new ToolsHandler();
    const res = await handler.mutate('skill.install', { name: 'ct-test' });
    expect(res.success).toBe(true);
    expect(mocks.installSkillFromSource).toHaveBeenCalledWith(
      'library:ct-test',
      expect.objectContaining({ skillName: 'ct-test', isGlobal: true }),
    );
  });

  it('returns provider list via CAAMP', async () => {
    mocks.getAllProviders.mockReturnValueOnce([{ id: 'claude-code' }, { id: 'opencode' }] as any);
    const handler = new ToolsHandler();
    const res = await handler.query('provider.list', { limit: 1 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      providers: [{ id: 'claude-code' }],
      count: 2,
      total: 2,
      filtered: 2,
    });
    expect(res.page).toEqual({ mode: 'offset', limit: 1, offset: 0, hasMore: true, total: 2 });
  });

  it('exposes precedence operation in supported queries', () => {
    const handler = new ToolsHandler();
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('skill.precedence');
  });

  it('skill.verify (cleo skills validate) fails E_VALIDATION with findings (T12655)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'skill-verify-')), 'ct-planted');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ct-planted\n---\n');
    const handler = new ToolsHandler();
    const res = await handler.query('skill.verify', { name: dir });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_VALIDATION');
    expect(res.error?.message).toMatch(/description: Missing required field/);
    expect(mocks.validateSkill).toHaveBeenCalledWith(join(dir, 'SKILL.md'));
  });

  it('runs provider injection via CAAMP', async () => {
    const handler = new ToolsHandler();
    const res = await handler.mutate('provider.inject', { references: ['@AGENTS.md'] });
    expect(res.success).toBe(true);
    expect(mocks.injectAll).toHaveBeenCalled();
  });
});
