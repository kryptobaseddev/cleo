/**
 * Tools Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP domains issues, skills, and providers into a single
 * "tools" domain with dot-prefixed operation names. All operations delegate
 * to src/core/ or native engine functions -- no MCP coupling.
 *
 * Sub-domains:
 *   issue.*      - Issue diagnostics (templates/create extracted to ct-github-issues)
 *   skill.*      - Skill discovery, dispatch, catalog
 *   provider.*   - CAAMP provider registry
 *   todowrite.*  - TodoWrite sync state (moved from admin domain, T5615)
 *
 * @epic T4820
 * @task T5671
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';
import { paginate } from '../../core/pagination.js';
import { routeByParam } from './_routing.js';
import { wrapResult, errorResult, unsupportedOp, handleErrorResult, getListParams } from './_base.js';

import { collectDiagnostics } from '../../core/issue/diagnostics.js';
import {
  catalog,
  discoverSkill,
  discoverSkills,
  getCanonicalSkillsDir,
  installSkill,
  removeSkill,
  getInstalledProviders,
  getAllProviders,
  detectAllProviders,
  getTrackedSkills,
  checkAllSkillUpdates,
  checkAllInjections,
  injectAll,
  buildInjectionContent,
} from '@cleocode/caamp';

import { getSyncStatus, clearSyncState } from '../../core/admin/sync.js';
import { systemSync } from '../engines/system-engine.js';

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

  async query(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
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

      // TodoWrite sub-domain
      if (operation.startsWith('todowrite.')) {
        return await this.queryTodowrite(operation.slice('todowrite.'.length), params, startTime);
      }

      return unsupportedOp('query', 'tools', operation, startTime);
    } catch (error) {
      return this.handleError('query', 'tools', operation, error, startTime);
    }
  }

  async mutate(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
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

      // TodoWrite sub-domain
      if (operation.startsWith('todowrite.')) {
        return await this.mutateTodowrite(operation.slice('todowrite.'.length), params, startTime);
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
        'skill.list', 'skill.show', 'skill.find',
        'skill.dispatch', 'skill.verify', 'skill.dependencies', 'skill.spawn.providers',
        'skill.catalog', 'skill.precedence',
        // provider
        'provider.list', 'provider.detect', 'provider.inject.status', 'provider.supports', 'provider.hooks',
        // todowrite
        'todowrite.status',
      ],
      mutate: [
        // skill
        'skill.install', 'skill.uninstall', 'skill.refresh',
        // provider
        'provider.inject',
        // todowrite
        'todowrite.sync', 'todowrite.clear',
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
        const diag = collectDiagnostics();
        return {
          _meta: dispatchMeta('query', 'tools', 'issue.diagnostics', startTime),
          success: true,
          data: diag,
        };
      }

      // Plugin-extracted operations — return informative error
      case 'templates':
      case 'validate.labels':
        return {
          _meta: dispatchMeta('query', 'tools', `issue.${sub}`, startTime),
          success: false,
          error: { code: 'E_PLUGIN_EXTRACTED', message: 'This operation moved to the ct-github-issues plugin' },
        };

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
    switch (sub) {
      // Plugin-extracted operations
      case 'add.bug':
      case 'add.feature':
      case 'add.help':
      case 'generate.config':
        return {
          _meta: dispatchMeta('mutate', 'tools', `issue.${sub}`, startTime),
          success: false,
          error: { code: 'E_PLUGIN_EXTRACTED', message: 'This operation moved to the ct-github-issues plugin' },
        };

      default:
        return unsupportedOp('mutate', 'tools', `issue.${sub}`, startTime);
    }
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
        const skills = await discoverSkills(getCanonicalSkillsDir());
        const { limit, offset } = getListParams(params);
        const page = paginate(skills, limit, offset);
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.list', startTime),
          success: true,
          data: {
            skills: page.items,
            count: skills.length,
            total: skills.length,
            filtered: skills.length,
          },
          page: page.page,
        };
      }
      case 'show': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('query', 'tools', 'skill.show', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const skill = await discoverSkill(`${getCanonicalSkillsDir()}/${name}`);
        if (!skill) {
          return errorResult('query', 'tools', 'skill.show', 'E_SKILL_NOT_FOUND',
            `Skill not found: ${name}`, startTime);
        }
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.show', startTime),
          success: true,
          data: { skill },
        };
      }
      case 'find': {
        const query = ((params?.query as string | undefined) ?? '').toLowerCase();
        const skills = await discoverSkills(getCanonicalSkillsDir());
        const filtered = query
          ? skills.filter((s) =>
              s.name.toLowerCase().includes(query)
              || s.metadata.description.toLowerCase().includes(query))
          : skills;
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.find', startTime),
          success: true,
          data: { skills: filtered, count: filtered.length, query },
        };
      }
      case 'dispatch': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('query', 'tools', 'skill.dispatch', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const matrix = catalog.getDispatchMatrix();
        const entry = {
          byTaskType: Object.entries(matrix.by_task_type).filter(([, skill]) => skill === name).map(([k]) => k),
          byKeyword: Object.entries(matrix.by_keyword).filter(([, skill]) => skill === name).map(([k]) => k),
          byProtocol: Object.entries(matrix.by_protocol).filter(([, skill]) => skill === name).map(([k]) => k),
        };
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.dispatch', startTime),
          success: true,
          data: { skill: name, dispatch: entry },
        };
      }
      case 'verify': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('query', 'tools', 'skill.verify', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const installed = await discoverSkill(`${getCanonicalSkillsDir()}/${name}`);
        const catalogEntry = catalog.getSkill(name);
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.verify', startTime),
          success: true,
          data: {
            skill: name,
            installed: !!installed,
            inCatalog: !!catalogEntry,
            installPath: installed ? `${getCanonicalSkillsDir()}/${name}` : null,
          },
        };
      }
      case 'dependencies': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('query', 'tools', 'skill.dependencies', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const direct = catalog.getSkillDependencies(name);
        const tree = catalog.resolveDependencyTree([name]);
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.dependencies', startTime),
          success: true,
          data: { skill: name, direct, tree },
        };
      }

      case 'spawn.providers': {
        const capability = params?.capability as 'supportsSubagents' | 'supportsProgrammaticSpawn' | 'supportsInterAgentComms' | 'supportsParallelSpawn' | undefined;
        const { getProvidersBySpawnCapability } = await import('@cleocode/caamp');

        if (capability) {
          const providers = getProvidersBySpawnCapability(capability);
          return {
            _meta: dispatchMeta('query', 'tools', 'skill.spawn.providers', startTime),
            success: true,
            data: { providers, capability, count: providers.length },
          };
        }

        // Return all spawn-capable providers if no specific capability provided
        const providers = getProvidersBySpawnCapability('supportsSubagents');
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.spawn.providers', startTime),
          success: true,
          data: { providers, capability: 'supportsSubagents', count: providers.length },
        };
      }

      // Merged: skill.catalog (absorbs catalog.protocols/profiles/resources/info via type param)
      case 'catalog': {
        return routeByParam(params, 'type', {
          protocols: () => this.querySkillCatalogProtocols(params, startTime),
          profiles: () => this.querySkillCatalogProfiles(params, startTime),
          resources: () => this.querySkillCatalogResources(params, startTime),
          info: () => this.querySkillCatalogInfo(startTime),
        }, 'info');
      }

      // Backward-compat aliases for old dotted catalog sub-ops
      case 'catalog.protocols':
        return this.querySkillCatalogProtocols(params, startTime);
      case 'catalog.profiles':
        return this.querySkillCatalogProfiles(params, startTime);
      case 'catalog.resources':
        return this.querySkillCatalogResources(params, startTime);
      case 'catalog.info':
        return this.querySkillCatalogInfo(startTime);

      // Merged: skill.precedence (absorbs precedence.show/resolve via action param)
      case 'precedence': {
        return routeByParam(params, 'action', {
          show: () => this.querySkillPrecedenceShow(startTime),
          resolve: () => this.querySkillPrecedenceResolve(params, startTime),
        }, 'show');
      }

      // Backward-compat aliases for old dotted precedence sub-ops
      case 'precedence.show':
        return this.querySkillPrecedenceShow(startTime);
      case 'precedence.resolve':
        return this.querySkillPrecedenceResolve(params, startTime);

      default:
        return unsupportedOp('query', 'tools', `skill.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Skill catalog helpers
  // -----------------------------------------------------------------------

  private querySkillCatalogProtocols(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    const protocols = catalog.listProtocols();
    const details = protocols.map((name) => ({
      name,
      path: catalog.getProtocolPath(name) ?? null,
    }));
    const { limit, offset } = getListParams(params);
    const page = paginate(details, limit, offset);
    return {
      _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
      success: true,
      data: {
        protocols: page.items,
        count: details.length,
        total: details.length,
        filtered: details.length,
      },
      page: page.page,
    };
  }

  private querySkillCatalogProfiles(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    const profileNames = catalog.listProfiles();
    const profiles = profileNames.map((name) => {
      const profile = catalog.getProfile(name);
      return {
        name,
        description: profile?.description ?? '',
        extends: profile?.extends,
        skillCount: profile?.skills.length ?? 0,
        skills: profile?.skills ?? [],
      };
    });
    const { limit, offset } = getListParams(params);
    const page = paginate(profiles, limit, offset);
    return {
      _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
      success: true,
      data: {
        profiles: page.items,
        count: profiles.length,
        total: profiles.length,
        filtered: profiles.length,
      },
      page: page.page,
    };
  }

  private querySkillCatalogResources(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    const resources = catalog.listSharedResources();
    const details = resources.map((name) => ({
      name,
      path: catalog.getSharedResourcePath(name) ?? null,
    }));
    const { limit, offset } = getListParams(params);
    const page = paginate(details, limit, offset);
    return {
      _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
      success: true,
      data: {
        resources: page.items,
        count: details.length,
        total: details.length,
        filtered: details.length,
      },
      page: page.page,
    };
  }

  private querySkillCatalogInfo(startTime: number): DispatchResponse {
    const available = catalog.isCatalogAvailable();
    const version = available ? catalog.getVersion() : null;
    const libraryRoot = available ? catalog.getLibraryRoot() : null;
    const skillCount = available ? catalog.getSkills().length : 0;
    const protocolCount = available ? catalog.listProtocols().length : 0;
    const profileCount = available ? catalog.listProfiles().length : 0;

    return {
      _meta: dispatchMeta('query', 'tools', 'skill.catalog', startTime),
      success: true,
      data: {
        available,
        version,
        libraryRoot,
        skillCount,
        protocolCount,
        profileCount,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Skill precedence helpers
  // -----------------------------------------------------------------------

  private async querySkillPrecedenceShow(startTime: number): Promise<DispatchResponse> {
    const { getSkillsMapWithPrecedence } = await import('../../core/skills/precedence-integration.js');
    const map = getSkillsMapWithPrecedence();
    return {
      _meta: dispatchMeta('query', 'tools', 'skill.precedence', startTime),
      success: true,
      data: { precedenceMap: map },
    };
  }

  private async querySkillPrecedenceResolve(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const providerId = params?.providerId as string;
    const scope = (params?.scope as 'global' | 'project') || 'global';

    const { resolveSkillPathsForProvider } = await import('../../core/skills/precedence-integration.js');
    const paths = await resolveSkillPathsForProvider(providerId, scope, this.projectRoot);

    return {
      _meta: dispatchMeta('query', 'tools', 'skill.precedence', startTime),
      success: true,
      data: { providerId, scope, paths },
    };
  }

  // -----------------------------------------------------------------------
  // Skill mutations
  // -----------------------------------------------------------------------

  private async mutateSkill(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const providers = getInstalledProviders();
    const isGlobal = params?.isGlobal !== false;

    if (providers.length === 0) {
      return errorResult('mutate', 'tools', `skill.${sub}`,
        'E_PROVIDER_NOT_FOUND', 'No installed providers available', startTime);
    }

    switch (sub) {
      case 'install': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('mutate', 'tools', 'skill.install', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const source = (params?.source as string | undefined) ?? `library:${name}`;
        const providerIds = providers.map((p) => p.id);

        const { determineInstallationTargets } = await import('../../core/skills/precedence-integration.js');
        const targets = await determineInstallationTargets({
          skillName: name,
          source,
          targetProviders: providerIds,
          projectRoot: isGlobal ? undefined : this.projectRoot,
        });

        const results = [];
        const errors = [];

        for (const target of targets) {
          const provider = providers.find((p) => p.id === target.providerId);
          if (!provider) continue;
          const result = await installSkill(source, name, [provider], isGlobal, this.projectRoot);
          results.push({ providerId: target.providerId, ...result });
          if (!result.success) {
            errors.push(`${target.providerId}: ${result.errors.join('; ')}`);
          }
        }

        const allSuccess = results.length > 0 && results.every((r) => r.success);
        return {
          _meta: dispatchMeta('mutate', 'tools', 'skill.install', startTime),
          success: allSuccess,
          data: { results, targets: targets.map((t) => t.providerId) },
          error: allSuccess ? undefined : { code: 'E_INSTALL_FAILED', message: errors.join('; ') || 'Skill install failed' },
        };
      }
      case 'uninstall': {
        const name = params?.name as string | undefined;
        if (!name) {
          return errorResult('mutate', 'tools', 'skill.uninstall', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const result = await removeSkill(name, providers, isGlobal, this.projectRoot);
        const ok = result.removed.length > 0 && result.errors.length === 0;
        return {
          _meta: dispatchMeta('mutate', 'tools', 'skill.uninstall', startTime),
          success: ok,
          data: { removed: result.removed, errors: result.errors },
          error: ok ? undefined : { code: 'E_UNINSTALL_FAILED', message: result.errors.join('; ') || 'Skill uninstall failed' },
        };
      }
      case 'refresh': {
        const tracked = await getTrackedSkills();
        const updates = await checkAllSkillUpdates();
        const updated: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const [name, status] of Object.entries(updates)) {
          if (!status.hasUpdate) continue;
          const entry = tracked[name];
          if (!entry) continue;
          const source = entry.sourceType === 'library' ? `library:${name}` : entry.source;
          try {
            const result = await installSkill(source, name, providers, entry.isGlobal, entry.projectDir);
            if (result.success) {
              updated.push(name);
            } else {
              failed.push({ name, error: result.errors.join('; ') || 'refresh failed' });
            }
          } catch (err) {
            failed.push({ name, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return {
          _meta: dispatchMeta('mutate', 'tools', 'skill.refresh', startTime),
          success: failed.length === 0,
          data: { updated, failed, checked: Object.keys(updates).length },
          error: failed.length === 0 ? undefined : { code: 'E_REFRESH_FAILED', message: `${failed.length} skill refreshes failed` },
        };
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
        const providers = getAllProviders();
        const { limit, offset } = getListParams(params);
        const page = paginate(providers, limit, offset);
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.list', startTime),
          success: true,
          data: {
            providers: page.items,
            count: providers.length,
            total: providers.length,
            filtered: providers.length,
          },
          page: page.page,
        };
      }
      case 'detect': {
        const detected = detectAllProviders();
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.detect', startTime),
          success: true,
          data: { providers: detected, count: detected.length },
        };
      }
      case 'inject.status': {
        const providers = getInstalledProviders();
        const scope = (params?.scope as 'project' | 'global' | undefined) ?? 'project';
        const content = params?.content as string | undefined;
        const checks = await checkAllInjections(providers, this.projectRoot, scope, content);
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.inject.status', startTime),
          success: true,
          data: { checks, count: checks.length },
        };
      }
      case 'supports': {
        const providerId = params?.providerId as string | undefined;
        const capability = params?.capability as string | undefined;
        if (!providerId || !capability) {
          return errorResult('query', 'tools', 'provider.supports',
            'E_INVALID_INPUT', 'Missing required parameters: providerId and capability', startTime);
        }
        const { providerSupportsById } = await import('@cleocode/caamp');
        const supported = providerSupportsById(providerId, capability);
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.supports', startTime),
          success: true,
          data: { providerId, capability, supported },
        };
      }

      case 'hooks': {
        const event = params?.event as string | undefined;
        if (!event) {
          return errorResult('query', 'tools', 'provider.hooks', 'E_INVALID_INPUT',
            'Missing required parameter: event (HookEvent)', startTime);
        }
        const { queryHookProviders } = await import('../engines/hooks-engine.js');
        const result = await queryHookProviders(event as import('../../core/hooks/types.js').HookEvent);
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
        const providers = getInstalledProviders();
        if (providers.length === 0) {
          return errorResult('mutate', 'tools', 'provider.inject',
            'E_PROVIDER_NOT_FOUND', 'No installed providers available', startTime);
        }
        const scope = (params?.scope as 'project' | 'global' | undefined) ?? 'project';
        const references = (params?.references as string[] | undefined) ?? ['@AGENTS.md'];
        const content = (params?.content as string | undefined) ?? buildInjectionContent({ references });
        const result = await injectAll(providers, this.projectRoot, scope, content);
        const actions = Array.from(result.entries()).map(([file, action]) => ({ file, action }));
        return {
          _meta: dispatchMeta('mutate', 'tools', 'provider.inject', startTime),
          success: true,
          data: { actions, count: actions.length },
        };
      }

      default:
        return unsupportedOp('mutate', 'tools', `provider.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // TodoWrite queries (T5615 — moved from admin domain)
  // -----------------------------------------------------------------------

  private async queryTodowrite(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'status': {
        const result = await getSyncStatus(this.projectRoot);
        return wrapResult(result, 'query', 'tools', 'todowrite.status', startTime);
      }

      default:
        return unsupportedOp('query', 'tools', `todowrite.${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // TodoWrite mutations (T5615 — moved from admin domain)
  // -----------------------------------------------------------------------

  private async mutateTodowrite(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'sync': {
        const result = systemSync(this.projectRoot, params as { direction?: string } | undefined);
        return wrapResult(result, 'mutate', 'tools', 'todowrite.sync', startTime);
      }

      case 'clear': {
        const dryRun = params?.dryRun as boolean | undefined;
        const result = await clearSyncState(this.projectRoot, dryRun);
        return wrapResult(result, 'mutate', 'tools', 'todowrite.clear', startTime);
      }

      default:
        return unsupportedOp('mutate', 'tools', `todowrite.${sub}`, startTime);
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
