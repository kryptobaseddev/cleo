/**
 * Tools Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP domains issues, skills, and providers into a single
 * "tools" domain with dot-prefixed operation names. All operations delegate
 * to the tools-engine which wraps src/core/ calls.
 *
 * Sub-domains:
 *   issue.*      - Issue diagnostics (templates/create extracted to ct-github-issues)
 *   skill.*      - Skill discovery, dispatch, catalog
 *   provider.*   - CAAMP provider registry
 *   adapter.*    - Provider adapter management
 *
 * @epic T4820
 * @task T5703
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  toolsAdapterActivate,
  toolsAdapterDetect,
  toolsAdapterDispose,
  toolsAdapterHealth,
  toolsAdapterList,
  toolsAdapterShow,
  toolsIssueDiagnostics,
  toolsProviderDetect,
  toolsProviderHooks,
  toolsProviderInject,
  toolsProviderInjectStatus,
  toolsProviderList,
  toolsProviderSupports,
  toolsSkillCatalogInfo,
  toolsSkillCatalogProfiles,
  toolsSkillCatalogProtocols,
  toolsSkillCatalogResources,
  toolsSkillDependencies,
  toolsSkillDispatch,
  toolsSkillFind,
  toolsSkillInstall,
  toolsSkillList,
  toolsSkillPrecedenceResolve,
  toolsSkillPrecedenceShow,
  toolsSkillRefresh,
  toolsSkillShow,
  toolsSkillSpawnProviders,
  toolsSkillUninstall,
  toolsSkillVerify,
} from '../engines/tools-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  errorResult,
  getListParams,
  handleErrorResult,
  unsupportedOp,
  wrapResult,
} from './_base.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';

// ---------------------------------------------------------------------------
// ToolsHandler
// ---------------------------------------------------------------------------

export class ToolsHandler implements DomainHandler {
  private projectRoot: string;

  constructor() {
    this.projectRoot = getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      // Issue sub-domain
      if (operation.startsWith('issue.')) {
        return this.queryIssue(operation.slice('issue.'.length), params, startTime);
      }

      // Skill sub-domain
      if (operation.startsWith('skill.')) {
        return await this.querySkill(operation.slice('skill.'.length), params, startTime);
      }

      // Provider sub-domain
      if (operation.startsWith('provider.')) {
        return await this.queryProvider(operation.slice('provider.'.length), params, startTime);
      }

      // Adapter sub-domain
      if (operation.startsWith('adapter.')) {
        return this.queryAdapter(operation.slice('adapter.'.length), params, startTime);
      }

      return unsupportedOp('query', 'tools', operation, startTime);
    } catch (error) {
      return this.handleError('query', 'tools', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      // Issue sub-domain (plugin-extracted)
      if (operation.startsWith('issue.')) {
        return this.mutateIssue(operation.slice('issue.'.length), params, startTime);
      }

      // Skill sub-domain
      if (operation.startsWith('skill.')) {
        return await this.mutateSkill(operation.slice('skill.'.length), params, startTime);
      }

      // Provider sub-domain
      if (operation.startsWith('provider.')) {
        return await this.mutateProvider(operation.slice('provider.'.length), params, startTime);
      }

      // Adapter sub-domain
      if (operation.startsWith('adapter.')) {
        return await this.mutateAdapter(operation.slice('adapter.'.length), params, startTime);
      }

      return unsupportedOp('mutate', 'tools', operation, startTime);
    } catch (error) {
      return this.handleError('mutate', 'tools', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        // issue
        'issue.diagnostics',
        // skill
        'skill.list',
        'skill.show',
        'skill.find',
        'skill.dispatch',
        'skill.verify',
        'skill.dependencies',
        'skill.spawn.providers',
        'skill.catalog',
        'skill.precedence',
        // provider
        'provider.list',
        'provider.detect',
        'provider.inject.status',
        'provider.supports',
        'provider.hooks',
        // adapter
        'adapter.list',
        'adapter.show',
        'adapter.detect',
        'adapter.health',
      ],
      mutate: [
        // skill
        'skill.install',
        'skill.uninstall',
        'skill.refresh',
        // provider
        'provider.inject',
        // adapter
        'adapter.activate',
        'adapter.dispose',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Issue queries
  // -----------------------------------------------------------------------

  private queryIssue(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'diagnostics': {
        const result = toolsIssueDiagnostics();
        return wrapResult(result, 'query', 'tools', 'issue.diagnostics', startTime);
      }

      default:
        return unsupportedOp('query', 'tools', `issue.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Issue mutations (plugin-extracted)
  // -----------------------------------------------------------------------

  private mutateIssue(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    return unsupportedOp('mutate', 'tools', `issue.${sub}`, startTime);
  }

  // -----------------------------------------------------------------------
  // Skill queries
  // -----------------------------------------------------------------------

  private async querySkill(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'list': {
        const { limit, offset } = getListParams(params);
        const result = await toolsSkillList(limit, offset);
        if (!result.success) {
          return wrapResult(result, 'query', 'tools', 'skill.list', startTime);
        }
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.list', startTime),
          success: true,
          data: {
            skills: result.data!.skills,
            count: result.data!.count,
            total: result.data!.total,
            filtered: result.data!.filtered,
          },
          page: result.data!.page,
        };
      }
      case 'show': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'query',
            'tools',
            'skill.show',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const result = await toolsSkillShow(name);
        return wrapResult(result, 'query', 'tools', 'skill.show', startTime);
      }
      case 'find': {
        const query = params?.query as string | undefined;
        const result = await toolsSkillFind(query);
        return wrapResult(result, 'query', 'tools', 'skill.find', startTime);
      }
      case 'dispatch': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'query',
            'tools',
            'skill.dispatch',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const result = toolsSkillDispatch(name);
        return wrapResult(result, 'query', 'tools', 'skill.dispatch', startTime);
      }
      case 'verify': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'query',
            'tools',
            'skill.verify',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const result = await toolsSkillVerify(name);
        return wrapResult(result, 'query', 'tools', 'skill.verify', startTime);
      }
      case 'dependencies': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'query',
            'tools',
            'skill.dependencies',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const result = toolsSkillDependencies(name);
        return wrapResult(result, 'query', 'tools', 'skill.dependencies', startTime);
      }

      case 'spawn.providers': {
        const capability = params?.capability as
          | 'supportsSubagents'
          | 'supportsProgrammaticSpawn'
          | 'supportsInterAgentComms'
          | 'supportsParallelSpawn'
          | undefined;
        const result = await toolsSkillSpawnProviders(capability);
        return wrapResult(result, 'query', 'tools', 'skill.spawn.providers', startTime);
      }

      // Merged: skill.catalog (absorbs catalog.protocols/profiles/resources/info via type param)
      case 'catalog': {
        return routeByParam(
          params,
          'type',
          {
            protocols: () => {
              const { limit, offset } = getListParams(params);
              const result = toolsSkillCatalogProtocols(limit, offset);
              if (!result.success) {
                return wrapResult(result, 'query', 'tools', 'skill.catalog', startTime);
              }
              return {
                _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
                success: true,
                data: {
                  protocols: result.data!.protocols,
                  count: result.data!.count,
                  total: result.data!.total,
                  filtered: result.data!.filtered,
                },
                page: result.data!.page,
              } as DispatchResponse;
            },
            profiles: () => {
              const { limit, offset } = getListParams(params);
              const result = toolsSkillCatalogProfiles(limit, offset);
              if (!result.success) {
                return wrapResult(result, 'query', 'tools', 'skill.catalog', startTime);
              }
              return {
                _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
                success: true,
                data: {
                  profiles: result.data!.profiles,
                  count: result.data!.count,
                  total: result.data!.total,
                  filtered: result.data!.filtered,
                },
                page: result.data!.page,
              } as DispatchResponse;
            },
            resources: () => {
              const { limit, offset } = getListParams(params);
              const result = toolsSkillCatalogResources(limit, offset);
              if (!result.success) {
                return wrapResult(result, 'query', 'tools', 'skill.catalog', startTime);
              }
              return {
                _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
                success: true,
                data: {
                  resources: result.data!.resources,
                  count: result.data!.count,
                  total: result.data!.total,
                  filtered: result.data!.filtered,
                },
                page: result.data!.page,
              } as DispatchResponse;
            },
            info: () => {
              const result = toolsSkillCatalogInfo();
              return wrapResult(result, 'query', 'tools', 'skill.catalog', startTime);
            },
          },
          'info',
        );
      }

      // Merged: skill.precedence (absorbs precedence.show/resolve via action param)
      case 'precedence': {
        const action = (params?.action as string) ?? 'show';
        if (action === 'show') {
          const result = await toolsSkillPrecedenceShow();
          return wrapResult(result, 'query', 'tools', 'skill.precedence', startTime);
        }
        if (action === 'resolve') {
          const providerId = params?.providerId as string;
          const scope = (params?.scope as 'global' | 'project') || 'global';
          const result = await toolsSkillPrecedenceResolve(providerId, scope, this.projectRoot);
          return wrapResult(result, 'query', 'tools', 'skill.precedence', startTime);
        }
        return unsupportedOp('query', 'tools', `skill.precedence`, startTime);
      }

      default:
        return unsupportedOp('query', 'tools', `skill.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Skill mutations
  // -----------------------------------------------------------------------

  private async mutateSkill(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'install': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'mutate',
            'tools',
            'skill.install',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const source = params?.source as string | undefined;
        const isGlobal = params?.isGlobal as boolean | undefined;
        const result = await toolsSkillInstall(name, this.projectRoot, source, isGlobal);
        return wrapResult(result, 'mutate', 'tools', 'skill.install', startTime);
      }
      case 'uninstall': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult(
            'mutate',
            'tools',
            'skill.uninstall',
            'E_INVALID_INPUT',
            'Missing required parameter: name',
            startTime,
          );
        }
        const isGlobal = params?.isGlobal as boolean | undefined;
        const result = await toolsSkillUninstall(name, this.projectRoot, isGlobal);
        return wrapResult(result, 'mutate', 'tools', 'skill.uninstall', startTime);
      }
      case 'refresh': {
        const result = await toolsSkillRefresh(this.projectRoot);
        return wrapResult(result, 'mutate', 'tools', 'skill.refresh', startTime);
      }

      default:
        return unsupportedOp('mutate', 'tools', `skill.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Provider queries
  // -----------------------------------------------------------------------

  private async queryProvider(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'list': {
        const { limit, offset } = getListParams(params);
        const result = toolsProviderList(limit, offset);
        if (!result.success) {
          return wrapResult(result, 'query', 'tools', 'provider.list', startTime);
        }
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.list', startTime),
          success: true,
          data: {
            providers: result.data!.providers,
            count: result.data!.count,
            total: result.data!.total,
            filtered: result.data!.filtered,
          },
          page: result.data!.page,
        };
      }
      case 'detect': {
        const result = toolsProviderDetect();
        return wrapResult(result, 'query', 'tools', 'provider.detect', startTime);
      }
      case 'inject.status': {
        const scope = params?.scope as 'project' | 'global' | undefined;
        const content = params?.content as string | undefined;
        const result = await toolsProviderInjectStatus(this.projectRoot, scope, content);
        return wrapResult(result, 'query', 'tools', 'provider.inject.status', startTime);
      }
      case 'supports': {
        const providerId = params?.providerId as string | undefined;
        const capability = params?.capability as string | undefined;
        if (!providerId || !capability) {
          return errorResult(
            'query',
            'tools',
            'provider.supports',
            'E_INVALID_INPUT',
            'Missing required parameters: providerId and capability',
            startTime,
          );
        }
        const result = await toolsProviderSupports(providerId, capability);
        return wrapResult(result, 'query', 'tools', 'provider.supports', startTime);
      }

      case 'hooks': {
        const event = params?.event as string | undefined;
        if (!event) {
          return errorResult(
            'query',
            'tools',
            'provider.hooks',
            'E_INVALID_INPUT',
            'Missing required parameter: event (HookEvent)',
            startTime,
          );
        }
        const result = await toolsProviderHooks(event);
        return wrapResult(result, 'query', 'tools', 'provider.hooks', startTime);
      }

      default:
        return unsupportedOp('query', 'tools', `provider.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Provider mutations
  // -----------------------------------------------------------------------

  private async mutateProvider(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'inject': {
        const scope = params?.scope as 'project' | 'global' | undefined;
        const references = params?.references as string[] | undefined;
        const content = params?.content as string | undefined;
        const result = await toolsProviderInject(this.projectRoot, scope, references, content);
        return wrapResult(result, 'mutate', 'tools', 'provider.inject', startTime);
      }

      default:
        return unsupportedOp('mutate', 'tools', `provider.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Adapter queries
  // -----------------------------------------------------------------------

  private queryAdapter(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'list': {
        const result = toolsAdapterList(this.projectRoot);
        return wrapResult(result, 'query', 'tools', 'adapter.list', startTime);
      }
      case 'show': {
        const id = params?.id as string | undefined;
        if (!id) {
          return errorResult(
            'query',
            'tools',
            'adapter.show',
            'E_INVALID_INPUT',
            'Missing required parameter: id',
            startTime,
          );
        }
        const result = toolsAdapterShow(this.projectRoot, id);
        return wrapResult(result, 'query', 'tools', 'adapter.show', startTime);
      }
      case 'detect': {
        const result = toolsAdapterDetect(this.projectRoot);
        return wrapResult(result, 'query', 'tools', 'adapter.detect', startTime);
      }
      case 'health': {
        const id = params?.id as string | undefined;
        const result = toolsAdapterHealth(this.projectRoot, id);
        return wrapResult(result, 'query', 'tools', 'adapter.health', startTime);
      }
      default:
        return unsupportedOp('query', 'tools', `adapter.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Adapter mutations
  // -----------------------------------------------------------------------

  private async mutateAdapter(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'activate': {
        const id = params?.id as string | undefined;
        if (!id) {
          return errorResult(
            'mutate',
            'tools',
            'adapter.activate',
            'E_INVALID_INPUT',
            'Missing required parameter: id',
            startTime,
          );
        }
        const result = await toolsAdapterActivate(this.projectRoot, id);
        return wrapResult(result, 'mutate', 'tools', 'adapter.activate', startTime);
      }
      case 'dispose': {
        const id = params?.id as string | undefined;
        const result = await toolsAdapterDispose(this.projectRoot, id);
        return wrapResult(result, 'mutate', 'tools', 'adapter.dispose', startTime);
      }
      default:
        return unsupportedOp('mutate', 'tools', `adapter.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number,
  ): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:tools').error({ gateway, domain, operation, err: error }, message);
    return handleErrorResult(gateway, domain, operation, error, startTime);
  }
}
