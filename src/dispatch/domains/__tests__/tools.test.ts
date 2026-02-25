import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    getLibraryRoot: vi.fn(() => '/tmp/ct-skills'),
    getSkills: vi.fn(() => []),
    getDispatchMatrix: vi.fn(() => ({ by_task_type: {}, by_keyword: {}, by_protocol: {} })),
    getSkill: vi.fn(() => undefined),
    getSkillDependencies: vi.fn(() => []),
    resolveDependencyTree: vi.fn(() => []),
  },
  discoverSkill: vi.fn(async () => null),
  discoverSkills: vi.fn(async () => []),
  getCanonicalSkillsDir: vi.fn(() => '/tmp/skills'),
  installSkill: vi.fn(async () => ({
    name: 'ct-test',
    canonicalPath: '/tmp/skills/ct-test',
    linkedAgents: ['claude-code'],
    errors: [],
    success: true,
  })),
  removeSkill: vi.fn(async () => ({ removed: ['ct-test'], errors: [] })),
  getInstalledProviders: vi.fn(() => [{ id: 'claude-code' }]),
  getAllProviders: vi.fn(() => [{ id: 'claude-code' }]),
  detectAllProviders: vi.fn(() => [{ id: 'claude-code', installed: true }]),
  getTrackedSkills: vi.fn(async () => ({})),
  checkAllSkillUpdates: vi.fn(async () => ({})),
  checkAllInjections: vi.fn(async () => []),
  injectAll: vi.fn(async () => new Map()),
  buildInjectionContent: vi.fn(() => '@AGENTS.md'),
}));

vi.mock('@cleocode/caamp', () => ({
  catalog: mocks.catalog,
  discoverSkill: mocks.discoverSkill,
  discoverSkills: mocks.discoverSkills,
  getCanonicalSkillsDir: mocks.getCanonicalSkillsDir,
  installSkill: mocks.installSkill,
  removeSkill: mocks.removeSkill,
  getInstalledProviders: mocks.getInstalledProviders,
  getAllProviders: mocks.getAllProviders,
  detectAllProviders: mocks.detectAllProviders,
  getTrackedSkills: mocks.getTrackedSkills,
  checkAllSkillUpdates: mocks.checkAllSkillUpdates,
  checkAllInjections: mocks.checkAllInjections,
  injectAll: mocks.injectAll,
  buildInjectionContent: mocks.buildInjectionContent,
}));

import { ToolsHandler } from '../tools.js';

describe('ToolsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skill list via CAAMP', async () => {
    mocks.discoverSkills.mockResolvedValueOnce([
      { name: 'ct-test', metadata: { description: 'test skill' } },
    ] as any);
    const handler = new ToolsHandler();
    const res = await handler.query('skill.list');
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBe(1);
  });

  it('installs a skill via CAAMP', async () => {
    const handler = new ToolsHandler();
    const res = await handler.mutate('skill.install', { name: 'ct-test' });
    expect(res.success).toBe(true);
    expect(mocks.installSkill).toHaveBeenCalled();
  });

  it('returns provider list via CAAMP', async () => {
    const handler = new ToolsHandler();
    const res = await handler.query('provider.list');
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBe(1);
  });

  it('runs provider injection via CAAMP', async () => {
    const handler = new ToolsHandler();
    const res = await handler.mutate('provider.inject', { references: ['@AGENTS.md'] });
    expect(res.success).toBe(true);
    expect(mocks.injectAll).toHaveBeenCalled();
  });
});
