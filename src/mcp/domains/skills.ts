/**
 * Skills Domain Handler
 *
 * Implements all 12 skills operations for CLEO MCP server:
 * - Query (6): list, show, search, dispatch, verify, dependencies
 * - Mutate (6): install, uninstall, enable, disable, configure, refresh
 *
 * Uses @cleocode/ct-skills for skill metadata and dispatch simulation.
 * Uses @cleocode/lafs-protocol for envelope conformance types.
 *
 * @task T4387
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import {
  listSkills,
  getSkill,
  getCoreSkills,
  getSkillsByCategory,
  getSkillDependencies,
  resolveDependencyTree,
  getDispatchMatrix,
  validateSkillFrontmatter,
  validateAll,
  manifest as skillManifest,
  version as ctSkillsVersion,
} from '@cleocode/ct-skills';
import type {
  SkillEntry,
  ManifestSkill,
  ValidationResult,
} from '@cleocode/ct-skills';
import type {
  SkillsListParams,
  SkillsShowParams,
  SkillsSearchParams,
  SkillsDispatchParams,
  SkillsVerifyParams,
  SkillsDependenciesParams,
  SkillsInstallParams,
  SkillsUninstallParams,
  SkillsEnableParams,
  SkillsDisableParams,
  SkillsConfigureParams,
  SkillsRefreshParams,
  SkillSummary,
  SkillDetail,
  DispatchCandidate,
} from '../types/operations/skills.js';

/**
 * Convert a SkillEntry to a SkillSummary for list responses
 */
function toSkillSummary(entry: SkillEntry): SkillSummary {
  return {
    name: entry.name,
    version: entry.version,
    description: entry.description,
    category: entry.category,
    core: entry.core,
    tier: entry.tier,
    status: 'active',
    protocol: entry.protocol,
  };
}

/**
 * Convert a SkillEntry to a SkillDetail for show responses
 */
function toSkillDetail(entry: SkillEntry): SkillDetail {
  // Find matching manifest skill for capabilities/constraints
  const manifestSkill = skillManifest?.skills?.find(
    (s: ManifestSkill) => s.name === entry.name
  );

  return {
    ...toSkillSummary(entry),
    path: entry.path,
    references: entry.references,
    dependencies: entry.dependencies,
    sharedResources: entry.sharedResources,
    compatibility: entry.compatibility,
    license: entry.license,
    metadata: entry.metadata,
    capabilities: manifestSkill
      ? {
          inputs: manifestSkill.capabilities.inputs,
          outputs: manifestSkill.capabilities.outputs,
          dispatch_triggers: manifestSkill.capabilities.dispatch_triggers,
          compatible_subagent_types:
            manifestSkill.capabilities.compatible_subagent_types,
          chains_to: manifestSkill.capabilities.chains_to,
          dispatch_keywords: manifestSkill.capabilities.dispatch_keywords,
        }
      : undefined,
    constraints: manifestSkill
      ? {
          max_context_tokens: manifestSkill.constraints.max_context_tokens,
          requires_session: manifestSkill.constraints.requires_session,
          requires_epic: manifestSkill.constraints.requires_epic,
        }
      : undefined,
  };
}

/**
 * Skills domain handler implementation
 */
export class SkillsHandler implements DomainHandler {
  constructor(private executor?: CLIExecutor) {}

  /**
   * Query operations (read-only)
   */
  async query(
    operation: string,
    params?: Record<string, unknown>
  ): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'list':
          return this.queryList(params as unknown as SkillsListParams, startTime);
        case 'show':
          return this.queryShow(params as unknown as SkillsShowParams, startTime);
        case 'search':
          return this.querySearch(params as unknown as SkillsSearchParams, startTime);
        case 'dispatch':
          return this.queryDispatch(params as unknown as SkillsDispatchParams, startTime);
        case 'verify':
          return this.queryVerify(params as unknown as SkillsVerifyParams, startTime);
        case 'dependencies':
          return this.queryDependencies(params as unknown as SkillsDependenciesParams, startTime);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'skills',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'skills', operation, error, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(
    operation: string,
    params?: Record<string, unknown>
  ): Promise<DomainResponse> {
    const startTime = Date.now();

    // Mutate operations require CLI executor
    if (!this.executor || !this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'skills.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'install':
          return await this.mutateInstall(params as unknown as SkillsInstallParams, startTime);
        case 'uninstall':
          return await this.mutateUninstall(params as unknown as SkillsUninstallParams, startTime);
        case 'enable':
          return await this.mutateEnable(params as unknown as SkillsEnableParams, startTime);
        case 'disable':
          return await this.mutateDisable(params as unknown as SkillsDisableParams, startTime);
        case 'configure':
          return await this.mutateConfigure(params as unknown as SkillsConfigureParams, startTime);
        case 'refresh':
          return await this.mutateRefresh(params as unknown as SkillsRefreshParams, startTime);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'skills',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'skills', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'show', 'search', 'dispatch', 'verify', 'dependencies'],
      mutate: ['install', 'uninstall', 'enable', 'disable', 'configure', 'refresh'],
    };
  }

  // ===== Query Operations =====

  /**
   * list - List available skills with optional filtering
   */
  private queryList(params: SkillsListParams, startTime: number): DomainResponse {
    let entries: SkillEntry[];

    if (params?.category) {
      entries = getSkillsByCategory(params.category);
    } else if (params?.core === true) {
      entries = getCoreSkills();
    } else {
      const names = listSkills();
      entries = names
        .map((name) => getSkill(name))
        .filter((e): e is SkillEntry => e !== undefined);
    }

    // Apply text filter if provided
    if (params?.filter) {
      const filterLower = params.filter.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(filterLower) ||
          e.description.toLowerCase().includes(filterLower)
      );
    }

    const skills = entries.map(toSkillSummary);

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'list',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        ctSkillsVersion,
      },
      success: true,
      data: skills,
    };
  }

  /**
   * show - Get detailed skill information
   */
  private queryShow(params: SkillsShowParams, startTime: number): DomainResponse {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'show',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const entry = getSkill(params.name);
    if (!entry) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'show',
        'E_NOT_FOUND',
        `Skill '${params.name}' not found`,
        startTime
      );
    }

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'show',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: toSkillDetail(entry),
    };
  }

  /**
   * search - Search skills by query string
   */
  private querySearch(params: SkillsSearchParams, startTime: number): DomainResponse {
    if (!params?.query) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'search',
        'E_INVALID_INPUT',
        'query is required',
        startTime
      );
    }

    const queryLower = params.query.toLowerCase();
    const limit = params.limit ?? 10;
    const names = listSkills();

    const scored = names
      .map((name) => {
        const entry = getSkill(name);
        if (!entry) return null;

        let score = 0;
        let matchReason = '';

        // Exact name match
        if (entry.name.toLowerCase() === queryLower) {
          score = 100;
          matchReason = 'exact name match';
        }
        // Name contains query
        else if (entry.name.toLowerCase().includes(queryLower)) {
          score = 80;
          matchReason = 'name contains query';
        }
        // Description contains query
        else if (entry.description.toLowerCase().includes(queryLower)) {
          score = 60;
          matchReason = 'description match';
        }
        // Protocol match
        else if (entry.protocol?.toLowerCase().includes(queryLower)) {
          score = 50;
          matchReason = 'protocol match';
        }
        // Category match
        else if (entry.category.toLowerCase().includes(queryLower)) {
          score = 40;
          matchReason = 'category match';
        }

        if (score === 0) return null;

        return {
          ...toSkillSummary(entry),
          score,
          matchReason,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'search',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: {
        query: params.query,
        results: scored,
      },
    };
  }

  /**
   * dispatch - Simulate skill selection for a task
   *
   * Uses ct-skills dispatch matrix to match skills to task parameters.
   * This is a read-only simulation - no state changes.
   */
  private queryDispatch(params: SkillsDispatchParams, startTime: number): DomainResponse {
    if (!params?.taskType && !params?.labels?.length && !params?.title && !params?.description && !params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'dispatch',
        'E_INVALID_INPUT',
        'At least one of taskId, taskType, labels, title, or description is required',
        startTime
      );
    }

    const matrix = getDispatchMatrix();
    const candidates: DispatchCandidate[] = [];

    // Strategy 1: Label-based dispatch
    if (params.labels?.length) {
      for (const label of params.labels) {
        // Check dispatch_matrix.by_keyword for label matches
        const normalizedLabel = label.toLowerCase();
        for (const [keyword, skillName] of Object.entries(matrix.by_keyword)) {
          if (normalizedLabel.includes(keyword.toLowerCase())) {
            candidates.push({
              skill: skillName,
              score: 90,
              strategy: 'label',
              reason: `Label '${label}' matched keyword '${keyword}'`,
            });
          }
        }
      }
    }

    // Strategy 2: Type-based dispatch
    if (params.taskType) {
      const typeMatch = matrix.by_task_type[params.taskType];
      if (typeMatch) {
        candidates.push({
          skill: typeMatch,
          score: 85,
          strategy: 'type',
          reason: `Task type '${params.taskType}' mapped to skill`,
        });
      }
    }

    // Strategy 3: Keyword-based dispatch from title/description
    const searchText = [params.title, params.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (searchText) {
      for (const [keyword, skillName] of Object.entries(matrix.by_keyword)) {
        if (searchText.includes(keyword.toLowerCase())) {
          // Avoid duplicate candidates from same skill
          if (!candidates.some((c) => c.skill === skillName && c.strategy === 'keyword')) {
            candidates.push({
              skill: skillName,
              score: 70,
              strategy: 'keyword',
              reason: `Text matched dispatch keyword '${keyword}'`,
            });
          }
        }
      }
    }

    // Strategy 4: Fallback
    if (candidates.length === 0) {
      const fallback = matrix.by_task_type['default'] || 'ct-task-executor';
      candidates.push({
        skill: fallback,
        score: 10,
        strategy: 'fallback',
        reason: 'No specific match found, using default executor',
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const selected = candidates[0];

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'dispatch',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: {
        selectedSkill: selected.skill,
        reason: selected.reason,
        strategy: selected.strategy,
        candidates,
      },
    };
  }

  /**
   * verify - Validate skill frontmatter
   */
  private queryVerify(params: SkillsVerifyParams, startTime: number): DomainResponse {
    if (params?.name) {
      // Validate single skill
      const entry = getSkill(params.name);
      if (!entry) {
        return this.createErrorResponse(
          'cleo_query',
          'skills',
          'verify',
          'E_NOT_FOUND',
          `Skill '${params.name}' not found`,
          startTime
        );
      }

      const result = validateSkillFrontmatter(params.name);
      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'skills',
          operation: 'verify',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          valid: result.valid,
          total: 1,
          passed: result.valid ? 1 : 0,
          failed: result.valid ? 0 : 1,
          results: [
            {
              name: params.name,
              valid: result.valid,
              issues: result.issues,
            },
          ],
        },
      };
    }

    // Validate all skills
    const allResults = validateAll();
    let passed = 0;
    let failed = 0;
    const results: Array<{
      name: string;
      valid: boolean;
      issues: Array<{ level: string; field: string; message: string }>;
    }> = [];

    allResults.forEach((result: ValidationResult, name: string) => {
      if (result.valid) {
        passed++;
      } else {
        failed++;
      }
      results.push({
        name,
        valid: result.valid,
        issues: result.issues,
      });
    });

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'verify',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: {
        valid: failed === 0,
        total: passed + failed,
        passed,
        failed,
        results,
      },
    };
  }

  /**
   * dependencies - Get skill dependency tree
   */
  private queryDependencies(
    params: SkillsDependenciesParams,
    startTime: number
  ): DomainResponse {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'dependencies',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const entry = getSkill(params.name);
    if (!entry) {
      return this.createErrorResponse(
        'cleo_query',
        'skills',
        'dependencies',
        'E_NOT_FOUND',
        `Skill '${params.name}' not found`,
        startTime
      );
    }

    const directDeps = getSkillDependencies(params.name);
    const resolvedTree = params.transitive !== false
      ? resolveDependencyTree([params.name])
      : directDeps;

    // Build dependency nodes
    const dependencies = resolvedTree
      .filter((name) => name !== params.name)
      .map((name) => {
        const depEntry = getSkill(name);
        return {
          name,
          version: depEntry?.version ?? 'unknown',
          direct: directDeps.includes(name),
          depth: directDeps.includes(name) ? 1 : 2,
        };
      });

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'skills',
        operation: 'dependencies',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: {
        name: params.name,
        dependencies,
        resolved: resolvedTree.filter((n) => n !== params.name),
      },
    };
  }

  // ===== Mutate Operations =====

  /**
   * install - Install a skill
   * CLI: cleo skill install <name> [--source <source>]
   */
  private async mutateInstall(
    params: SkillsInstallParams,
    startTime: number
  ): Promise<DomainResponse> {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'install',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.source) flags.source = params.source;

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'install',
      args: [params.name],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'install', startTime);
  }

  /**
   * uninstall - Uninstall a skill
   * CLI: cleo skill uninstall <name> [--force]
   */
  private async mutateUninstall(
    params: SkillsUninstallParams,
    startTime: number
  ): Promise<DomainResponse> {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'uninstall',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.force) flags.force = true;

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'uninstall',
      args: [params.name],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'uninstall', startTime);
  }

  /**
   * enable - Enable a skill
   * CLI: cleo skill enable <name>
   */
  private async mutateEnable(
    params: SkillsEnableParams,
    startTime: number
  ): Promise<DomainResponse> {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'enable',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'enable',
      args: [params.name],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'enable', startTime);
  }

  /**
   * disable - Disable a skill
   * CLI: cleo skill disable <name> [--reason <reason>]
   */
  private async mutateDisable(
    params: SkillsDisableParams,
    startTime: number
  ): Promise<DomainResponse> {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'disable',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.reason) flags.reason = params.reason;

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'disable',
      args: [params.name],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'disable', startTime);
  }

  /**
   * configure - Configure a skill
   * CLI: cleo skill configure <name> --config <json>
   */
  private async mutateConfigure(
    params: SkillsConfigureParams,
    startTime: number
  ): Promise<DomainResponse> {
    if (!params?.name) {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'configure',
        'E_INVALID_INPUT',
        'name is required',
        startTime
      );
    }

    if (!params?.config || typeof params.config !== 'object') {
      return this.createErrorResponse(
        'cleo_mutate',
        'skills',
        'configure',
        'E_INVALID_INPUT',
        'config object is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'configure',
      args: [params.name],
      flags: { config: JSON.stringify(params.config), json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'configure', startTime);
  }

  /**
   * refresh - Refresh skill registry cache
   * CLI: cleo skill refresh [--force]
   */
  private async mutateRefresh(
    params: SkillsRefreshParams,
    startTime: number
  ): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.force) flags.force = true;

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'refresh',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'skills', 'refresh', startTime);
  }

  // ===== Helper Methods =====

  /**
   * Wrap executor result in DomainResponse format
   */
  private wrapExecutorResult(
    result: any,
    gateway: string,
    domain: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;

    if (result.success) {
      return {
        _meta: {
          gateway,
          domain,
          operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms,
        },
        success: true,
        data: result.data,
      };
    }

    return {
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms,
      },
      success: false,
      error: result.error,
    };
  }

  /**
   * Create error response
   */
  private createErrorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number
  ): DomainResponse {
    return {
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  /**
   * Handle unexpected errors
   */
  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number
  ): DomainResponse {
    return this.createErrorResponse(
      gateway,
      domain,
      operation,
      'E_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime
    );
  }
}
