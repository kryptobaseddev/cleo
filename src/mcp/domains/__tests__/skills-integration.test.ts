/**
 * Skills Domain Integration Tests
 *
 * Tests the full CT-SKILLS migration pipeline from the MCP server perspective:
 *   1. MCP skills.dispatch simulation returns correct skill selection
 *   2. MCP skills.list returns data from ct-skills registry
 *   3. LAFS envelope conformance on all MCP responses
 *   4. Cache invalidation and graceful degradation
 *   5. Dispatch strategy prioritization (label > type > keyword > fallback)
 *
 * @task T4387
 */

import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { SkillsHandler } from '../skills.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

// Mock @cleocode/ct-skills with realistic data
vi.mock('@cleocode/ct-skills', () => {
  const mockSkillEntries = [
    {
      name: 'ct-task-executor',
      description: 'General task execution skill',
      version: '2.0.0',
      path: '/home/user/.agents/skills/ct-task-executor',
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
      description: 'BATS test writing skill for shell scripts',
      version: '1.2.0',
      path: '/home/user/.agents/skills/ct-test-writer-bats',
      references: ['SKILL.md'],
      core: false,
      category: 'specialist',
      tier: 1,
      protocol: 'implementation',
      dependencies: ['ct-task-executor'],
      sharedResources: ['testing-framework-config.md'],
      compatibility: ['cleo-subagent'],
      license: 'MIT',
      metadata: {},
    },
    {
      name: 'ct-orchestrator',
      description: 'Multi-agent coordination and workflow orchestration',
      version: '2.0.0',
      path: '/home/user/.agents/skills/ct-orchestrator',
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
    {
      name: 'ct-research-agent',
      description: 'Research and investigation skill for gathering information',
      version: '1.5.0',
      path: '/home/user/.agents/skills/ct-research-agent',
      references: ['SKILL.md', 'references/methodology.md'],
      core: false,
      category: 'research',
      tier: 1,
      protocol: 'research',
      dependencies: ['ct-task-executor'],
      sharedResources: ['subagent-protocol-base.md'],
      compatibility: ['cleo-subagent'],
      license: 'MIT',
      metadata: {},
    },
    {
      name: 'ct-documentor',
      description: 'Documentation generation and maintenance skill',
      version: '1.0.0',
      path: '/home/user/.agents/skills/ct-documentor',
      references: ['SKILL.md'],
      core: false,
      category: 'specialist',
      tier: 1,
      protocol: 'implementation',
      dependencies: ['ct-docs-lookup', 'ct-docs-write', 'ct-docs-review'],
      sharedResources: [],
      compatibility: ['cleo-subagent'],
      license: 'MIT',
      metadata: {},
    },
  ];

  const mockManifest = {
    $schema: 'https://cleo-dev.com/schemas/v3/skills-manifest.schema.json',
    _meta: {
      schemaVersion: '3.0.0',
      generatedAt: '2026-02-12T00:00:00Z',
      ttlSeconds: 300,
      totalSkills: 5,
      sources: [
        { path: '/home/user/.agents/skills', type: 'caamp', skillCount: 5 },
      ],
      generatedBy: 'manifest-resolver',
    },
    dispatch_matrix: {
      by_task_type: {
        implementation: 'ct-task-executor',
        test: 'ct-test-writer-bats',
        research: 'ct-research-agent',
        default: 'ct-task-executor',
      },
      by_keyword: {
        implement: 'ct-task-executor',
        build: 'ct-task-executor',
        test: 'ct-test-writer-bats',
        bats: 'ct-test-writer-bats',
        orchestrate: 'ct-orchestrator',
        research: 'ct-research-agent',
        investigate: 'ct-research-agent',
        document: 'ct-documentor',
      },
      by_protocol: {
        implementation: 'ct-task-executor',
        research: 'ct-research-agent',
      },
      _comment: 'Dispatch matrix for skill selection',
    },
    skills: [
      {
        name: 'ct-task-executor',
        version: '2.0.0',
        description: 'General task execution',
        path: '/home/user/.agents/skills/ct-task-executor',
        tags: ['core', 'execution'],
        status: 'active',
        tier: 0,
        token_budget: 5000,
        references: [],
        capabilities: {
          inputs: ['task'],
          outputs: ['code', 'file'],
          dependencies: [],
          dispatch_triggers: ['implement', 'build', 'create'],
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

describe('Skills Domain Integration', () => {
  let handler: SkillsHandler;
  let mockExecutor: Mocked<CLIExecutor>;

  beforeEach(() => {
    mockExecutor = createMockExecutor() as Mocked<CLIExecutor>;
    handler = new SkillsHandler(mockExecutor);
  });

  // =========================================================================
  // LAFS ENVELOPE CONFORMANCE
  // =========================================================================

  describe('LAFS envelope conformance', () => {
    const requiredMetaFields = ['gateway', 'domain', 'operation', 'specVersion', 'timestamp', 'duration_ms'];

    it('query responses include all required _meta fields', async () => {
      const result = await handler.query('list', {});

      expect(result._meta).toBeDefined();
      for (const field of requiredMetaFields) {
        expect(result._meta).toHaveProperty(field);
      }
    });

    it('mutate responses include all required _meta fields', async () => {
      const mockResult = { success: true, data: { refreshed: true } };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      const result = await handler.mutate('refresh', {});

      expect(result._meta).toBeDefined();
      for (const field of requiredMetaFields) {
        expect(result._meta).toHaveProperty(field);
      }
    });

    it('error responses include all required _meta fields', async () => {
      const result = await handler.query('show', {});

      expect(result.success).toBe(false);
      expect(result._meta).toBeDefined();
      for (const field of requiredMetaFields) {
        expect(result._meta).toHaveProperty(field);
      }
    });

    it('query _meta.gateway is always cleo_query', async () => {
      const operations = ['list', 'show', 'find', 'dispatch', 'verify', 'dependencies'];
      for (const op of operations) {
        // Provide minimal valid params for each operation
        const params: Record<string, unknown> = {};
        if (op === 'show') params.name = 'ct-task-executor';
        if (op === 'find') params.query = 'test';
        if (op === 'dispatch') params.taskType = 'implementation';
        if (op === 'dependencies') params.name = 'ct-test-writer-bats';

        const result = await handler.query(op, params);
        expect(result._meta.gateway).toBe('cleo_query');
        expect(result._meta.domain).toBe('skills');
        expect(result._meta.operation).toBe(op);
      }
    });

    it('mutate _meta.gateway is always cleo_mutate', async () => {
      const mockResult = { success: true, data: {} };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      const operations = ['install', 'uninstall', 'enable', 'disable', 'configure', 'refresh'];
      for (const op of operations) {
        const params: Record<string, unknown> = {};
        if (['install', 'uninstall', 'enable', 'disable'].includes(op)) {
          params.name = 'test-skill';
        }
        if (op === 'configure') {
          params.name = 'test-skill';
          params.config = { key: 'value' };
        }

        const result = await handler.mutate(op, params);
        expect(result._meta.gateway).toBe('cleo_mutate');
        expect(result._meta.domain).toBe('skills');
        expect(result._meta.operation).toBe(op);
      }
    });

    it('_meta.specVersion is 1.2.3 for all operations', async () => {
      const queryResult = await handler.query('list', {});
      expect(queryResult._meta.specVersion).toBe('1.2.3');

      const errorResult = await handler.query('unknown-op', {});
      expect(errorResult._meta.specVersion).toBe('1.2.3');
    });

    it('_meta.timestamp is valid ISO 8601', async () => {
      const result = await handler.query('list', {});
      const timestamp = result._meta.timestamp;

      expect(timestamp).toBeDefined();
      const parsed = new Date(timestamp);
      expect(parsed.toISOString()).toBe(timestamp);
    });

    it('_meta.duration_ms is non-negative number', async () => {
      const result = await handler.query('list', {});

      expect(typeof result._meta.duration_ms).toBe('number');
      expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('success responses have data field', async () => {
      const result = await handler.query('list', {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('error responses have error field with code and message', async () => {
      const result = await handler.query('show', {});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBeDefined();
      expect(result.error!.message).toBeDefined();
    });

    it('list response includes ctSkillsVersion in _meta', async () => {
      const result = await handler.query('list', {});

      expect(result._meta.ctSkillsVersion).toBe('2.0.0');
    });
  });

  // =========================================================================
  // DISPATCH SIMULATION
  // =========================================================================

  describe('dispatch strategy prioritization', () => {
    it('label-based dispatch takes priority over keyword', async () => {
      const result = await handler.query('dispatch', {
        labels: ['bats'],
        title: 'Implement something',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      // Label match (bats -> ct-test-writer-bats) should have highest score
      const labelCandidate = data.candidates.find(
        (c: any) => c.strategy === 'label'
      );
      expect(labelCandidate).toBeDefined();
      expect(labelCandidate.score).toBe(90);
    });

    it('type-based dispatch has score 85', async () => {
      const result = await handler.query('dispatch', {
        taskType: 'implementation',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.selectedSkill).toBe('ct-task-executor');
      expect(data.strategy).toBe('type');
      expect(data.candidates[0].score).toBe(85);
    });

    it('keyword-based dispatch from title/description has score 70', async () => {
      const result = await handler.query('dispatch', {
        title: 'Research authentication patterns',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      const keywordCandidate = data.candidates.find(
        (c: any) => c.strategy === 'keyword'
      );
      expect(keywordCandidate).toBeDefined();
      expect(keywordCandidate.score).toBe(70);
    });

    it('fallback returns ct-task-executor with score 10', async () => {
      const result = await handler.query('dispatch', {
        title: 'Something completely unrelated xyz123 qqq',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.strategy).toBe('fallback');
      expect(data.selectedSkill).toBe('ct-task-executor');
      expect(data.candidates[0].score).toBe(10);
    });

    it('combined strategies produce multiple candidates sorted by score', async () => {
      const result = await handler.query('dispatch', {
        labels: ['bats'],
        taskType: 'test',
        title: 'Test the authentication module',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;

      // Should have candidates from label, type, and keyword strategies
      expect(data.candidates.length).toBeGreaterThan(1);

      // Candidates should be sorted by score descending
      for (let i = 1; i < data.candidates.length; i++) {
        expect(data.candidates[i - 1].score).toBeGreaterThanOrEqual(
          data.candidates[i].score
        );
      }
    });

    it('dispatch with taskId param is accepted', async () => {
      const result = await handler.query('dispatch', {
        taskId: 'T1234',
      });

      expect(result.success).toBe(true);
    });

    it('dispatch with empty params returns E_INVALID_INPUT', async () => {
      const result = await handler.query('dispatch', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // LIST FROM CT-SKILLS REGISTRY
  // =========================================================================

  describe('skills.list from ct-skills registry', () => {
    it('lists all 5 skills from registry', async () => {
      const result = await handler.query('list', {});

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data.length).toBe(5);
    });

    it('each skill has required summary fields', async () => {
      const result = await handler.query('list', {});

      const data = result.data as any[];
      for (const skill of data) {
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('version');
        expect(skill).toHaveProperty('description');
        expect(skill).toHaveProperty('category');
        expect(skill).toHaveProperty('core');
        expect(skill).toHaveProperty('tier');
        expect(skill).toHaveProperty('status');
      }
    });

    it('filters by category correctly', async () => {
      const result = await handler.query('list', { category: 'specialist' });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data.length).toBe(2);
      expect(data.every((s: any) => s.category === 'specialist')).toBe(true);
    });

    it('filters core skills correctly', async () => {
      const result = await handler.query('list', { core: true });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data.length).toBe(2);
      expect(data.every((s: any) => s.core === true)).toBe(true);
    });

    it('text filter matches name and description', async () => {
      const result = await handler.query('list', { filter: 'research' });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data.length).toBeGreaterThan(0);
      expect(data.some((s: any) => s.name.includes('research'))).toBe(true);
    });
  });

  // =========================================================================
  // SHOW WITH LAFS DETAIL
  // =========================================================================

  describe('skills.show detail view', () => {
    it('returns full detail for known skill', async () => {
      const result = await handler.query('show', { name: 'ct-task-executor' });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.name).toBe('ct-task-executor');
      expect(data.version).toBe('2.0.0');
      expect(data.path).toBeDefined();
      expect(data.references).toBeDefined();
      expect(data.dependencies).toBeDefined();
      expect(data.compatibility).toBeDefined();
      expect(data.license).toBe('MIT');
    });

    it('includes capabilities from manifest when available', async () => {
      const result = await handler.query('show', { name: 'ct-task-executor' });

      const data = result.data as any;
      expect(data.capabilities).toBeDefined();
      expect(data.capabilities.inputs).toEqual(['task']);
      expect(data.capabilities.outputs).toEqual(['code', 'file']);
      expect(data.capabilities.dispatch_triggers).toContain('implement');
    });

    it('includes constraints from manifest when available', async () => {
      const result = await handler.query('show', { name: 'ct-task-executor' });

      const data = result.data as any;
      expect(data.constraints).toBeDefined();
      expect(data.constraints.max_context_tokens).toBe(50000);
      expect(data.constraints.requires_session).toBe(true);
    });
  });

  // =========================================================================
  // SEARCH SCORING
  // =========================================================================

  describe('search scoring', () => {
    it('exact name match gets score 100', async () => {
      const result = await handler.query('find', { query: 'ct-orchestrator' });

      const data = result.data as any;
      expect(data.results[0].name).toBe('ct-orchestrator');
      expect(data.results[0].score).toBe(100);
      expect(data.results[0].matchReason).toBe('exact name match');
    });

    it('partial name match gets score 80', async () => {
      const result = await handler.query('find', { query: 'orchestrat' });

      const data = result.data as any;
      expect(data.results[0].name).toBe('ct-orchestrator');
      expect(data.results[0].score).toBe(80);
      expect(data.results[0].matchReason).toBe('name contains query');
    });

    it('description match gets score 60', async () => {
      const result = await handler.query('find', { query: 'shell scripts' });

      const data = result.data as any;
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].score).toBe(60);
      expect(data.results[0].matchReason).toBe('description match');
    });

    it('results sorted by score descending', async () => {
      const result = await handler.query('find', { query: 'ct' });

      const data = result.data as any;
      for (let i = 1; i < data.results.length; i++) {
        expect(data.results[i - 1].score).toBeGreaterThanOrEqual(data.results[i].score);
      }
    });

    it('limit parameter caps results', async () => {
      const result = await handler.query('find', { query: 'ct', limit: 2 });

      const data = result.data as any;
      expect(data.results.length).toBeLessThanOrEqual(2);
    });
  });

  // =========================================================================
  // DEPENDENCY RESOLUTION
  // =========================================================================

  describe('dependency resolution', () => {
    it('resolves direct dependencies', async () => {
      const result = await handler.query('dependencies', {
        name: 'ct-test-writer-bats',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.name).toBe('ct-test-writer-bats');
      expect(data.dependencies.length).toBeGreaterThan(0);

      const direct = data.dependencies.find((d: any) => d.name === 'ct-task-executor');
      expect(direct).toBeDefined();
      expect(direct.direct).toBe(true);
      expect(direct.depth).toBe(1);
    });

    it('resolves transitive dependencies', async () => {
      const result = await handler.query('dependencies', {
        name: 'ct-documentor',
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.dependencies.length).toBe(3);
      expect(data.resolved.length).toBe(3);
    });

    it('returns E_NOT_FOUND for unknown skill', async () => {
      const result = await handler.query('dependencies', {
        name: 'nonexistent-skill',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  // =========================================================================
  // VERIFY / VALIDATION
  // =========================================================================

  describe('skill verification', () => {
    it('verifies all skills and reports aggregate', async () => {
      const result = await handler.query('verify', {});

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.valid).toBe(true);
      expect(data.total).toBe(5);
      expect(data.passed).toBe(5);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(5);
    });

    it('single skill verify returns details', async () => {
      const result = await handler.query('verify', { name: 'ct-task-executor' });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(1);
      expect(data.results[0].name).toBe('ct-task-executor');
      expect(data.results[0].valid).toBe(true);
      expect(data.results[0].issues).toEqual([]);
    });
  });

  // =========================================================================
  // GRACEFUL DEGRADATION
  // =========================================================================

  describe('graceful degradation', () => {
    it('query operations work without executor', async () => {
      const noExecutorHandler = new SkillsHandler();

      const listResult = await noExecutorHandler.query('list', {});
      expect(listResult.success).toBe(true);

      const showResult = await noExecutorHandler.query('show', { name: 'ct-task-executor' });
      expect(showResult.success).toBe(true);

      const searchResult = await noExecutorHandler.query('find', { query: 'test' });
      expect(searchResult.success).toBe(true);

      const dispatchResult = await noExecutorHandler.query('dispatch', { taskType: 'test' });
      expect(dispatchResult.success).toBe(true);
    });

    it('mutate operations require executor', async () => {
      const noExecutorHandler = new SkillsHandler();

      const result = await noExecutorHandler.mutate('install', { name: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_CLI_REQUIRED');
    });

    it('executor errors are caught and wrapped', async () => {
      vi
        .mocked(mockExecutor.execute)
        .mockRejectedValue(new Error('CLI process crashed'));

      const result = await handler.mutate('install', { name: 'test' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('CLI process crashed');
      // Still has LAFS envelope
      expect(result._meta.gateway).toBe('cleo_mutate');
      expect(result._meta.domain).toBe('skills');
    });

    it('unknown operations return E_INVALID_OPERATION', async () => {
      const queryResult = await handler.query('nonexistent', {});
      expect(queryResult.success).toBe(false);
      expect(queryResult.error?.code).toBe('E_INVALID_OPERATION');

      const mutateResult = await handler.mutate('nonexistent', {});
      expect(mutateResult.success).toBe(false);
      expect(mutateResult.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // MUTATE OPERATIONS CLI PASSTHROUGH
  // =========================================================================

  describe('mutate CLI passthrough', () => {
    it('install passes name and source to executor', async () => {
      const mockResult = {
        success: true,
        data: { name: 'new-skill', installed: true, version: '1.0.0' },
      };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      const result = await handler.mutate('install', {
        name: 'new-skill',
        source: 'git+https://github.com/org/skill.git',
      });

      expect(result.success).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'skill',
        operation: 'install',
        args: ['new-skill'],
        flags: { json: true, source: 'git+https://github.com/org/skill.git' },
      });
    });

    it('uninstall passes force flag to executor', async () => {
      const mockResult = { success: true, data: { uninstalled: true } };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      await handler.mutate('uninstall', { name: 'old-skill', force: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'skill',
        operation: 'uninstall',
        args: ['old-skill'],
        flags: { json: true, force: true },
      });
    });

    it('configure serializes config object', async () => {
      const mockResult = { success: true, data: { configured: true } };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      await handler.mutate('configure', {
        name: 'ct-task-executor',
        config: { maxTokens: 50000, debug: true },
      });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'skill',
        operation: 'configure',
        args: ['ct-task-executor'],
        flags: { config: '{"maxTokens":50000,"debug":true}', json: true },
      });
    });

    it('refresh passes force flag', async () => {
      const mockResult = { success: true, data: { refreshed: true } };
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
