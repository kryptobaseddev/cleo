/**
 * Skills Domain Handler Tests
 *
 * @task T4387
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillsHandler } from '../skills.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

// Mock @cleocode/ct-skills
vi.mock('@cleocode/ct-skills', () => {
  const mockSkillEntries = [
    {
      name: 'ct-task-executor',
      description: 'General task execution skill',
      version: '1.0.0',
      path: '/skills/ct-task-executor',
      references: ['SKILL.md'],
      core: true,
      category: 'core',
      tier: 0,
      protocol: 'implementation',
      dependencies: [],
      sharedResources: ['subagent-protocol-base.md'],
      compatibility: ['cleo-subagent'],
      license: 'MIT',
      metadata: {},
    },
    {
      name: 'ct-test-writer-bats',
      description: 'BATS test writing skill',
      version: '1.0.0',
      path: '/skills/ct-test-writer-bats',
      references: ['SKILL.md'],
      core: false,
      category: 'specialist',
      tier: 1,
      protocol: 'implementation',
      dependencies: ['ct-task-executor'],
      sharedResources: [],
      compatibility: ['cleo-subagent'],
      license: 'MIT',
      metadata: {},
    },
    {
      name: 'ct-orchestrator',
      description: 'Multi-agent coordination',
      version: '2.0.0',
      path: '/skills/ct-orchestrator',
      references: ['SKILL.md'],
      core: true,
      category: 'meta',
      tier: 0,
      protocol: null,
      dependencies: [],
      sharedResources: [],
      compatibility: [],
      license: 'MIT',
      metadata: {},
    },
  ];

  const mockManifest = {
    $schema: 'https://lafs.dev/schemas/v1/manifest.schema.json',
    _meta: {},
    dispatch_matrix: {
      by_task_type: {
        implementation: 'ct-task-executor',
        test: 'ct-test-writer-bats',
        default: 'ct-task-executor',
      },
      by_keyword: {
        implement: 'ct-task-executor',
        test: 'ct-test-writer-bats',
        orchestrate: 'ct-orchestrator',
        bats: 'ct-test-writer-bats',
      },
      by_protocol: {
        implementation: 'ct-task-executor',
      },
    },
    skills: [
      {
        name: 'ct-task-executor',
        version: '1.0.0',
        description: 'General task execution',
        path: '/skills/ct-task-executor',
        tags: ['core'],
        status: 'active',
        tier: 0,
        token_budget: 5000,
        references: [],
        capabilities: {
          inputs: ['task'],
          outputs: ['code', 'file'],
          dependencies: [],
          dispatch_triggers: ['implement', 'build'],
          compatible_subagent_types: ['cleo-subagent'],
          chains_to: [],
          dispatch_keywords: {
            primary: ['implement', 'build'],
            secondary: ['create', 'develop'],
          },
        },
        constraints: {
          max_context_tokens: 50000,
          requires_session: true,
          requires_epic: false,
        },
      },
    ],
  };

  return {
    listSkills: vi.fn(() => mockSkillEntries.map((s) => s.name)),
    getSkill: vi.fn((name: string) => mockSkillEntries.find((s) => s.name === name)),
    getCoreSkills: vi.fn(() => mockSkillEntries.filter((s) => s.core)),
    getSkillsByCategory: vi.fn((cat: string) =>
      mockSkillEntries.filter((s) => s.category === cat)
    ),
    getSkillDependencies: vi.fn((name: string) => {
      const entry = mockSkillEntries.find((s) => s.name === name);
      return entry?.dependencies ?? [];
    }),
    resolveDependencyTree: vi.fn((names: string[]) => {
      const result = new Set<string>();
      for (const name of names) {
        result.add(name);
        const entry = mockSkillEntries.find((s) => s.name === name);
        if (entry) {
          for (const dep of entry.dependencies) {
            result.add(dep);
          }
        }
      }
      return Array.from(result);
    }),
    getDispatchMatrix: vi.fn(() => mockManifest.dispatch_matrix),
    validateSkillFrontmatter: vi.fn((name: string) => ({
      valid: true,
      issues: [],
    })),
    validateAll: vi.fn(() => {
      const map = new Map();
      for (const entry of mockSkillEntries) {
        map.set(entry.name, { valid: true, issues: [] });
      }
      return map;
    }),
    manifest: mockManifest,
    version: '2.0.0',
  };
});

describe('SkillsHandler', () => {
  let handler: SkillsHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new SkillsHandler(mockExecutor);
  });

  describe('getSupportedOperations', () => {
    it('returns correct query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toEqual([
        'list',
        'show',
        'search',
        'dispatch',
        'verify',
        'dependencies',
        'catalog.protocols',
        'catalog.profiles',
        'catalog.resources',
        'catalog.info',
      ]);
    });

    it('returns correct mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual([
        'install',
        'uninstall',
        'enable',
        'disable',
        'configure',
        'refresh',
      ]);
    });
  });

  describe('query operations', () => {
    describe('list', () => {
      it('lists all skills', async () => {
        const result = await handler.query('list', {});

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
        expect((result.data as any[]).length).toBe(3);
        expect((result.data as any[])[0]).toHaveProperty('name');
        expect((result.data as any[])[0]).toHaveProperty('version');
        expect((result.data as any[])[0]).toHaveProperty('category');
      });

      it('filters by category', async () => {
        const result = await handler.query('list', { category: 'core' });

        expect(result.success).toBe(true);
        // Only ct-task-executor has category 'core'; ct-orchestrator is category 'meta'
        expect((result.data as any[]).length).toBe(1);
        expect((result.data as any[])[0].name).toBe('ct-task-executor');
        expect((result.data as any[])[0].category).toBe('core');
      });

      it('filters core skills', async () => {
        const result = await handler.query('list', { core: true });

        expect(result.success).toBe(true);
        expect((result.data as any[]).length).toBe(2);
      });

      it('filters by text', async () => {
        const result = await handler.query('list', { filter: 'bats' });

        expect(result.success).toBe(true);
        expect((result.data as any[]).length).toBe(1);
        expect((result.data as any[])[0].name).toBe('ct-test-writer-bats');
      });

      it('includes ctSkillsVersion in metadata', async () => {
        const result = await handler.query('list', {});

        expect(result._meta).toBeDefined();
        expect(result._meta.ctSkillsVersion).toBe('2.0.0');
      });
    });

    describe('show', () => {
      it('shows skill details', async () => {
        const result = await handler.query('show', { name: 'ct-task-executor' });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.name).toBe('ct-task-executor');
        expect(data.version).toBe('1.0.0');
        expect(data.path).toBeDefined();
        expect(data.dependencies).toBeDefined();
        expect(data.capabilities).toBeDefined();
        expect(data.constraints).toBeDefined();
      });

      it('requires name', async () => {
        const result = await handler.query('show', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });

      it('returns not found for unknown skill', async () => {
        const result = await handler.query('show', { name: 'nonexistent' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_NOT_FOUND');
      });
    });

    describe('search', () => {
      it('searches skills by query', async () => {
        const result = await handler.query('search', { query: 'test' });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.query).toBe('test');
        expect(data.results.length).toBeGreaterThan(0);
        expect(data.results[0]).toHaveProperty('score');
        expect(data.results[0]).toHaveProperty('matchReason');
      });

      it('requires query parameter', async () => {
        const result = await handler.query('search', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });

      it('returns exact name matches with highest score', async () => {
        const result = await handler.query('search', { query: 'ct-orchestrator' });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.results[0].name).toBe('ct-orchestrator');
        expect(data.results[0].score).toBe(100);
      });

      it('respects limit parameter', async () => {
        const result = await handler.query('search', { query: 'ct', limit: 2 });

        expect(result.success).toBe(true);
        expect((result.data as any).results.length).toBeLessThanOrEqual(2);
      });
    });

    describe('dispatch', () => {
      it('dispatches by task type', async () => {
        const result = await handler.query('dispatch', {
          taskType: 'implementation',
        });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.selectedSkill).toBe('ct-task-executor');
        expect(data.strategy).toBe('type');
        expect(data.candidates.length).toBeGreaterThan(0);
      });

      it('dispatches by labels', async () => {
        const result = await handler.query('dispatch', {
          labels: ['bats'],
        });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.selectedSkill).toBe('ct-test-writer-bats');
        expect(data.strategy).toBe('label');
      });

      it('dispatches by title/description keywords', async () => {
        const result = await handler.query('dispatch', {
          title: 'Implement the new feature',
          description: 'Build the authentication module',
        });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.selectedSkill).toBeDefined();
        expect(data.candidates.length).toBeGreaterThan(0);
      });

      it('falls back to default when no match', async () => {
        const result = await handler.query('dispatch', {
          title: 'Something completely unrelated xyz123',
        });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.strategy).toBe('fallback');
      });

      it('requires at least one input parameter', async () => {
        const result = await handler.query('dispatch', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('verify', () => {
      it('verifies single skill', async () => {
        const result = await handler.query('verify', { name: 'ct-task-executor' });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.valid).toBe(true);
        expect(data.total).toBe(1);
        expect(data.passed).toBe(1);
        expect(data.failed).toBe(0);
        expect(data.results).toHaveLength(1);
      });

      it('verifies all skills when no name provided', async () => {
        const result = await handler.query('verify', {});

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.total).toBe(3);
        expect(data.results).toHaveLength(3);
      });

      it('returns not found for unknown skill', async () => {
        const result = await handler.query('verify', { name: 'nonexistent' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_NOT_FOUND');
      });
    });

    describe('dependencies', () => {
      it('gets dependencies for a skill', async () => {
        const result = await handler.query('dependencies', {
          name: 'ct-test-writer-bats',
        });

        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.name).toBe('ct-test-writer-bats');
        expect(data.dependencies.length).toBeGreaterThan(0);
        expect(data.dependencies[0]).toHaveProperty('name');
        expect(data.dependencies[0]).toHaveProperty('direct');
      });

      it('requires name parameter', async () => {
        const result = await handler.query('dependencies', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });

      it('returns not found for unknown skill', async () => {
        const result = await handler.query('dependencies', { name: 'nonexistent' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_NOT_FOUND');
      });
    });
  });

  describe('mutate operations', () => {
    describe('install', () => {
      it('installs a skill', async () => {
        const mockResult = {
          success: true,
          data: { name: 'new-skill', installed: true, version: '1.0.0', path: '/skills/new-skill' },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('install', { name: 'new-skill' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'install',
          args: ['new-skill'],
          flags: { json: true },
        });
      });

      it('passes source option', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('install', { name: 'new-skill', source: 'git://repo' });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'install',
          args: ['new-skill'],
          flags: { json: true, source: 'git://repo' },
        });
      });

      it('requires name', async () => {
        const result = await handler.mutate('install', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('uninstall', () => {
      it('uninstalls a skill', async () => {
        const mockResult = {
          success: true,
          data: { name: 'old-skill', uninstalled: true },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('uninstall', { name: 'old-skill' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'uninstall',
          args: ['old-skill'],
          flags: { json: true },
        });
      });

      it('passes force flag', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('uninstall', { name: 'old-skill', force: true });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'uninstall',
          args: ['old-skill'],
          flags: { json: true, force: true },
        });
      });

      it('requires name', async () => {
        const result = await handler.mutate('uninstall', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('enable', () => {
      it('enables a skill', async () => {
        const mockResult = {
          success: true,
          data: { name: 'ct-task-executor', enabled: true, status: 'active' },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('enable', { name: 'ct-task-executor' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'enable',
          args: ['ct-task-executor'],
          flags: { json: true },
        });
      });

      it('requires name', async () => {
        const result = await handler.mutate('enable', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('disable', () => {
      it('disables a skill', async () => {
        const mockResult = {
          success: true,
          data: { name: 'ct-task-executor', disabled: true, status: 'disabled' },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('disable', {
          name: 'ct-task-executor',
          reason: 'Testing',
        });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'disable',
          args: ['ct-task-executor'],
          flags: { json: true, reason: 'Testing' },
        });
      });

      it('requires name', async () => {
        const result = await handler.mutate('disable', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('configure', () => {
      it('configures a skill', async () => {
        const mockResult = {
          success: true,
          data: { name: 'ct-task-executor', configured: true, config: { key: 'value' } },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('configure', {
          name: 'ct-task-executor',
          config: { key: 'value' },
        });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'configure',
          args: ['ct-task-executor'],
          flags: { config: '{"key":"value"}', json: true },
        });
      });

      it('requires name', async () => {
        const result = await handler.mutate('configure', { config: {} });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });

      it('requires config object', async () => {
        const result = await handler.mutate('configure', { name: 'ct-task-executor' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('refresh', () => {
      it('refreshes skill registry', async () => {
        const mockResult = {
          success: true,
          data: { refreshed: true, skillCount: 3, timestamp: '2026-02-12' },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('refresh', {});

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'refresh',
          flags: { json: true },
        });
      });

      it('passes force flag', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('refresh', { force: true });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'skill',
          operation: 'refresh',
          flags: { json: true, force: true },
        });
      });
    });
  });

  describe('error handling', () => {
    it('handles unknown query operation', async () => {
      const result = await handler.query('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles unknown mutate operation', async () => {
      const result = await handler.mutate('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles executor errors', async () => {
      vi.mocked(mockExecutor.execute).mockRejectedValue(new Error('Executor failed'));

      const result = await handler.mutate('install', { name: 'test-skill' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
    });

    it('requires executor for mutate operations', async () => {
      const handlerNoExecutor = new SkillsHandler();
      const result = await handlerNoExecutor.mutate('install', { name: 'test-skill' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_CLI_REQUIRED');
    });

    it('does not require executor for query operations', async () => {
      const handlerNoExecutor = new SkillsHandler();
      const result = await handlerNoExecutor.query('list', {});
      expect(result.success).toBe(true);
    });
  });

  describe('response format', () => {
    it('includes proper metadata in success response', async () => {
      const result = await handler.query('list', {});

      expect(result._meta).toBeDefined();
      expect(result._meta.gateway).toBe('cleo_query');
      expect(result._meta.domain).toBe('skills');
      expect(result._meta.operation).toBe('list');
      expect(result._meta.specVersion).toBe('1.2.3');
      expect(result._meta.timestamp).toBeDefined();
      expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('includes proper metadata in error response', async () => {
      const result = await handler.query('show', {});

      expect(result._meta).toBeDefined();
      expect(result._meta.gateway).toBe('cleo_query');
      expect(result._meta.domain).toBe('skills');
      expect(result._meta.operation).toBe('show');
    });

    it('includes proper metadata for mutate operations', async () => {
      const mockResult = { success: true, data: {} };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      const result = await handler.mutate('refresh', {});

      expect(result._meta.gateway).toBe('cleo_mutate');
      expect(result._meta.domain).toBe('skills');
      expect(result._meta.operation).toBe('refresh');
    });
  });
});
