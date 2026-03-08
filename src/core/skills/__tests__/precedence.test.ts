/**
 * Tests for skills precedence integration.
 * @task T5238
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  determineInstallationTargets,
  getProvidersWithPrecedence,
  getSkillsMapWithPrecedence,
  resolveSkillPathsForProvider,
  supportsAgentsPath,
} from '../precedence-integration.js';

// Mock CAAMP
vi.mock('@cleocode/caamp', () => ({
  getProvider: vi.fn(),
  getProviderCapabilities: vi.fn(),
  getProvidersBySkillsPrecedence: vi.fn(),
  getEffectiveSkillsPaths: vi.fn(),
  buildSkillsMap: vi.fn(),
}));

describe('Skills Precedence Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveSkillPathsForProvider', () => {
    it('should resolve paths for vendor-only provider', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'claude-code',
        name: 'Claude Code',
        skills: { precedence: 'vendor-only', agentsGlobalPath: null, agentsProjectPath: null },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '/home/user/.claude/skills', source: 'vendor', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('claude-code', 'global');

      expect(paths).toHaveLength(1);
      expect(paths[0].path).toBe('/home/user/.claude/skills');
      expect(paths[0].source).toBe('vendor');
      expect(paths[0].scope).toBe('global');
      expect(paths[0].precedence).toBe('vendor-only');
      expect(paths[0].providerId).toBe('claude-code');
    });

    it('should resolve paths for agents-canonical provider', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'codex',
        name: 'Codex CLI',
        skills: {
          precedence: 'agents-canonical',
          agentsGlobalPath: '~/.agents/skills',
          agentsProjectPath: '.agents/skills',
        },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '~/.agents/skills', source: 'agents', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('codex', 'global');

      expect(paths).toHaveLength(1);
      expect(paths[0].path).toBe('~/.agents/skills');
      expect(paths[0].source).toBe('agents');
      expect(paths[0].precedence).toBe('agents-canonical');
    });

    it('should resolve paths for agents-supported provider', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'opencode',
        name: 'OpenCode',
        skills: {
          precedence: 'agents-supported',
          agentsGlobalPath: '~/.opencode/skills',
          agentsProjectPath: '.opencode/skills',
        },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '/home/user/.opencode/skills', source: 'agents', scope: 'global' },
        { path: '~/.opencode/skills', source: 'agents', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('opencode', 'global');

      expect(paths).toHaveLength(2);
      expect(paths[0].precedence).toBe('agents-supported');
      expect(paths[1].precedence).toBe('agents-supported');
    });

    it('should resolve paths for agents-paths-only provider', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'custom-agent',
        name: 'Custom Agent CLI',
        skills: {
          precedence: 'agents-paths-only',
          agentsGlobalPath: '~/.custom/skills',
          agentsProjectPath: '.custom/skills',
        },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '~/.custom/skills', source: 'agents', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('custom-agent', 'global');

      expect(paths).toHaveLength(1);
      expect(paths[0].precedence).toBe('agents-paths-only');
    });

    it('should resolve paths for agents-preferred provider', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'hybrid-agent',
        name: 'Hybrid Agent',
        skills: {
          precedence: 'agents-preferred',
          agentsGlobalPath: '~/.hybrid/skills',
          agentsProjectPath: '.hybrid/skills',
        },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '~/.hybrid/skills', source: 'agents', scope: 'global' },
        { path: '/vendor/skills', source: 'vendor', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('hybrid-agent', 'global');

      expect(paths).toHaveLength(2);
      expect(paths[0].precedence).toBe('agents-preferred');
      expect(paths[1].precedence).toBe('agents-preferred');
    });

    it('should resolve project-scoped paths', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'claude-code',
        name: 'Claude Code',
        skills: { precedence: 'vendor-only', agentsGlobalPath: null, agentsProjectPath: null },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '/project/.claude/skills', source: 'vendor', scope: 'project' },
      ]);

      const paths = await resolveSkillPathsForProvider('claude-code', 'project', '/project');

      expect(paths).toHaveLength(1);
      expect(paths[0].scope).toBe('project');
      expect(paths[0].path).toBe('/project/.claude/skills');
    });

    it('should throw for unknown provider', async () => {
      const { getProvider } = await import('@cleocode/caamp');
      vi.mocked(getProvider).mockReturnValue(undefined);

      await expect(resolveSkillPathsForProvider('unknown', 'global')).rejects.toThrow(
        'Provider unknown not found',
      );
    });

    it('should default to vendor-only when precedence is not specified', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'legacy-provider',
        name: 'Legacy Provider',
        skills: { agentsGlobalPath: null, agentsProjectPath: null },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '/legacy/skills', source: 'vendor', scope: 'global' },
      ]);

      const paths = await resolveSkillPathsForProvider('legacy-provider', 'global');

      expect(paths[0].precedence).toBe('vendor-only');
    });
  });

  describe('getProvidersWithPrecedence', () => {
    it('should return providers for vendor-only precedence', async () => {
      const { getProvidersBySkillsPrecedence } = await import('@cleocode/caamp');

      vi.mocked(getProvidersBySkillsPrecedence).mockReturnValue([
        { id: 'claude-code', name: 'Claude Code' },
        { id: 'legacy', name: 'Legacy' },
      ] as any);

      const providers = getProvidersWithPrecedence('vendor-only');

      expect(providers).toEqual(['claude-code', 'legacy']);
      expect(getProvidersBySkillsPrecedence).toHaveBeenCalledWith('vendor-only');
    });

    it('should return providers for agents-canonical precedence', async () => {
      const { getProvidersBySkillsPrecedence } = await import('@cleocode/caamp');

      vi.mocked(getProvidersBySkillsPrecedence).mockReturnValue([
        { id: 'codex', name: 'Codex CLI' },
      ] as any);

      const providers = getProvidersWithPrecedence('agents-canonical');

      expect(providers).toEqual(['codex']);
    });

    it('should return empty array when no providers match', async () => {
      const { getProvidersBySkillsPrecedence } = await import('@cleocode/caamp');

      vi.mocked(getProvidersBySkillsPrecedence).mockReturnValue([]);

      const providers = getProvidersWithPrecedence('agents-supported');

      expect(providers).toEqual([]);
    });
  });

  describe('getSkillsMapWithPrecedence', () => {
    it('should return skills map from CAAMP', async () => {
      const { buildSkillsMap } = await import('@cleocode/caamp');

      const mockMap = [
        {
          providerId: 'claude-code',
          toolName: 'skill',
          precedence: 'vendor-only',
          paths: { global: '~/.claude/skills', project: '.claude/skills' },
        },
        {
          providerId: 'codex',
          toolName: 'skill',
          precedence: 'agents-canonical',
          paths: { global: '~/.agents/skills', project: '.agents/skills' },
        },
      ];

      vi.mocked(buildSkillsMap).mockReturnValue(mockMap as any);

      const result = getSkillsMapWithPrecedence();

      expect(result).toEqual(mockMap);
      expect(buildSkillsMap).toHaveBeenCalled();
    });

    it('should return empty array when no providers configured', async () => {
      const { buildSkillsMap } = await import('@cleocode/caamp');

      vi.mocked(buildSkillsMap).mockReturnValue([]);

      const result = getSkillsMapWithPrecedence();

      expect(result).toEqual([]);
    });
  });

  describe('determineInstallationTargets', () => {
    it('should determine targets for multiple providers', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockImplementation(
        (id) =>
          ({
            id,
            name: `Provider ${id}`,
            skills: { precedence: 'agents-supported' },
          }) as any,
      );

      vi.mocked(getEffectiveSkillsPaths).mockImplementation((provider) => [
        { path: `/skills/${provider.id}`, source: 'agents', scope: 'global' },
      ]);

      const targets = await determineInstallationTargets({
        skillName: 'ct-research',
        source: 'library:ct-research',
        targetProviders: ['claude-code', 'codex'],
      });

      expect(targets).toHaveLength(2);
      expect(targets[0].providerId).toBe('claude-code');
      expect(targets[0].path).toBe('/skills/claude-code');
      expect(targets[1].providerId).toBe('codex');
      expect(targets[1].path).toBe('/skills/codex');
    });

    it('should use project scope when projectRoot is provided', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockReturnValue({
        id: 'claude-code',
        name: 'Claude Code',
        skills: { precedence: 'vendor-only' },
      } as any);

      vi.mocked(getEffectiveSkillsPaths).mockReturnValue([
        { path: '/my-project/.claude/skills', source: 'vendor', scope: 'project' },
      ]);

      const targets = await determineInstallationTargets({
        skillName: 'ct-research',
        source: 'library:ct-research',
        targetProviders: ['claude-code'],
        projectRoot: '/my-project',
      });

      expect(targets).toHaveLength(1);
      expect(targets[0].path).toBe('/my-project/.claude/skills');
    });

    it('should skip providers with no paths', async () => {
      const { getProvider, getEffectiveSkillsPaths } = await import('@cleocode/caamp');

      vi.mocked(getProvider).mockImplementation(
        (id) =>
          ({
            id,
            name: `Provider ${id}`,
            skills: { precedence: 'vendor-only' },
          }) as any,
      );

      vi.mocked(getEffectiveSkillsPaths).mockImplementation((provider) => {
        if (provider.id === 'codex') {
          return []; // No paths for codex
        }
        return [{ path: `/skills/${provider.id}`, source: 'vendor', scope: 'global' }];
      });

      const targets = await determineInstallationTargets({
        skillName: 'ct-research',
        source: 'library:ct-research',
        targetProviders: ['claude-code', 'codex'],
      });

      expect(targets).toHaveLength(1);
      expect(targets[0].providerId).toBe('claude-code');
    });

    it('should handle empty target providers list', async () => {
      const targets = await determineInstallationTargets({
        skillName: 'ct-research',
        source: 'library:ct-research',
        targetProviders: [],
      });

      expect(targets).toEqual([]);
    });
  });

  describe('supportsAgentsPath', () => {
    it('should return true for provider with agents global path', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue({
        skills: { agentsGlobalPath: '~/.agents/skills', agentsProjectPath: null },
      } as any);

      const result = await supportsAgentsPath('codex');

      expect(result).toBe(true);
    });

    it('should return true for provider with agents project path', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue({
        skills: { agentsGlobalPath: null, agentsProjectPath: '.agents/skills' },
      } as any);

      const result = await supportsAgentsPath('codex');

      expect(result).toBe(true);
    });

    it('should return true for provider with both paths', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue({
        skills: { agentsGlobalPath: '~/.agents/skills', agentsProjectPath: '.agents/skills' },
      } as any);

      const result = await supportsAgentsPath('codex');

      expect(result).toBe(true);
    });

    it('should return false for vendor-only provider', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue({
        skills: { agentsGlobalPath: null, agentsProjectPath: null },
      } as any);

      const result = await supportsAgentsPath('claude-code');

      expect(result).toBe(false);
    });

    it('should return false when provider has no skills capability', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue({
        tools: true,
      } as any);

      const result = await supportsAgentsPath('some-provider');

      expect(result).toBe(false);
    });

    it('should return false when provider has no capabilities', async () => {
      const { getProviderCapabilities } = await import('@cleocode/caamp');

      vi.mocked(getProviderCapabilities).mockReturnValue(undefined);

      const result = await supportsAgentsPath('unknown');

      expect(result).toBe(false);
    });
  });
});
