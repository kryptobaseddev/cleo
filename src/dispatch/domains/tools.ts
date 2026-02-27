/**
 * Tools Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP domains issues, skills, and providers into a single
 * "tools" domain with dot-prefixed operation names. All operations delegate
 * to src/core/ or native engine functions -- no MCP coupling.
 *
 * Sub-domains:
 *   issue.*    - Issue templates, diagnostics, creation
 *   skill.*    - Skill discovery, dispatch, catalog
 *   provider.* - CAAMP provider registry
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('domain:tools');
import {
  parseIssueTemplates,
  getTemplateForSubcommand,
  generateTemplateConfig,
  validateLabels,
} from '../engines/template-parser.js';
import { collectDiagnostics } from '../../core/issue/diagnostics.js';
import { createIssue } from '../../core/issue/create.js';
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

      return this.errorResponse('query', 'tools', operation, 'E_INVALID_OPERATION',
        `Unknown query operation: ${operation}`, startTime);
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
      // Issue sub-domain
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

      return this.errorResponse('mutate', 'tools', operation, 'E_INVALID_OPERATION',
        `Unknown mutate operation: ${operation}`, startTime);
    } catch (error) {
      return this.handleError('mutate', 'tools', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        // issue
        'issue.diagnostics',
        'issue.templates',
        'issue.validate.labels',
        // skill
        'skill.list', 'skill.show', 'skill.find',
        'skill.dispatch', 'skill.verify', 'skill.dependencies',
        // skill.catalog
        'skill.catalog.protocols', 'skill.catalog.profiles',
        'skill.catalog.resources', 'skill.catalog.info',
        // provider
        'provider.list', 'provider.detect', 'provider.inject.status',
      ],
      mutate: [
        // issue
        'issue.add.bug', 'issue.add.feature', 'issue.add.help',
        'issue.create.bug', 'issue.create.feature', 'issue.create.help',
        'issue.generate.config',
        // skill
        'skill.install', 'skill.uninstall', 'skill.enable',
        'skill.disable', 'skill.configure', 'skill.refresh',
        // provider
        'provider.inject',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Issue queries
  // -----------------------------------------------------------------------

  private queryIssue(
    sub: string,
    params: Record<string, unknown> | undefined,
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

      case 'templates': {
        const subcommand = params?.subcommand as string | undefined;
        if (subcommand) {
          const result = getTemplateForSubcommand(this.projectRoot, subcommand);
          return this.wrapEngineResult(result, 'query', 'issue.templates', startTime);
        }
        const result = parseIssueTemplates(this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'issue.templates', startTime);
      }

      case 'validate.labels': {
        const labels = params?.labels as string[] | undefined;
        const repoLabels = params?.repoLabels as string[] | undefined;
        if (!labels || !repoLabels) {
          return this.errorResponse('query', 'tools', 'issue.validate.labels',
            'E_INVALID_INPUT',
            'Missing required parameters: labels and repoLabels (both arrays of strings)',
            startTime);
        }
        const result = validateLabels(labels, repoLabels);
        return this.wrapEngineResult(result, 'query', 'issue.validate.labels', startTime);
      }

      default:
        return this.errorResponse('query', 'tools', `issue.${sub}`,
          'E_INVALID_OPERATION', `Unknown issue query: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Issue mutations
  // -----------------------------------------------------------------------

  private async mutateIssue(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'add.bug':
      case 'add.feature':
      case 'add.help':
      case 'create.bug':
      case 'create.feature':
      case 'create.help': {
        const title = params?.title as string;
        const body = params?.body as string;
        if (!title || !body) {
          return this.errorResponse('mutate', 'tools', `issue.${sub}`,
            'E_INVALID_INPUT', 'title and body are required', startTime);
        }
        // Extract issue type from sub (e.g. "add.bug" -> "bug")
        const issueType = sub.split('.').pop()!;
        const result = createIssue({
          issueType,
          title,
          body,
          severity: params?.severity as string | undefined,
          area: params?.area as string | undefined,
          dryRun: params?.dryRun as boolean | undefined,
        });
        return {
          _meta: dispatchMeta('mutate', 'tools', `issue.${sub}`, startTime),
          success: true,
          data: result,
        };
      }

      case 'generate.config': {
        const result = await generateTemplateConfig(this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'issue.generate.config', startTime);
      }

      default:
        return this.errorResponse('mutate', 'tools', `issue.${sub}`,
          'E_INVALID_OPERATION', `Unknown issue mutation: ${sub}`, startTime);
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
    // Catalog sub-sub-domain
    if (sub.startsWith('catalog.')) {
      return this.querySkillCatalog(sub.slice('catalog.'.length), startTime);
    }

    switch (sub) {
      case 'list': {
        const skills = await discoverSkills(getCanonicalSkillsDir());
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.list', startTime),
          success: true,
          data: { skills, count: skills.length },
        };
      }
      case 'show': {
        const name = params?.name as string | undefined;
        if (!name) {
          return this.errorResponse('query', 'tools', 'skill.show', 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const skill = await discoverSkill(`${getCanonicalSkillsDir()}/${name}`);
        if (!skill) {
          return this.errorResponse('query', 'tools', 'skill.show', 'E_SKILL_NOT_FOUND',
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
          return this.errorResponse('query', 'tools', 'skill.dispatch', 'E_INVALID_INPUT',
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
          return this.errorResponse('query', 'tools', 'skill.verify', 'E_INVALID_INPUT',
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
          return this.errorResponse('query', 'tools', 'skill.dependencies', 'E_INVALID_INPUT',
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

      default:
        return this.errorResponse('query', 'tools', `skill.${sub}`,
          'E_INVALID_OPERATION', `Unknown skill query: ${sub}`, startTime);
    }
  }

  private querySkillCatalog(
    sub: string,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'protocols': {
        const protocols = catalog.listProtocols();
        const details = protocols.map((name) => ({
          name,
          path: catalog.getProtocolPath(name) ?? null,
        }));
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.catalog.protocols', startTime),
          success: true,
          data: { protocols: details },
        };
      }

      case 'profiles': {
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
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.catalog.profiles', startTime),
          success: true,
          data: { profiles },
        };
      }

      case 'resources': {
        const resources = catalog.listSharedResources();
        const details = resources.map((name) => ({
          name,
          path: catalog.getSharedResourcePath(name) ?? null,
        }));
        return {
          _meta: dispatchMeta('query', 'tools', 'skill.catalog.resources', startTime),
          success: true,
          data: { resources: details },
        };
      }

      case 'info': {
        const available = catalog.isCatalogAvailable();
        const version = available ? catalog.getVersion() : null;
        const libraryRoot = available ? catalog.getLibraryRoot() : null;
        const skillCount = available ? catalog.getSkills().length : 0;
        const protocolCount = available ? catalog.listProtocols().length : 0;
        const profileCount = available ? catalog.listProfiles().length : 0;

        return {
          _meta: dispatchMeta('query', 'tools', 'skill.catalog.info', startTime),
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

      default:
        return this.errorResponse('query', 'tools', `skill.catalog.${sub}`,
          'E_INVALID_OPERATION', `Unknown catalog query: ${sub}`, startTime);
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
    const providers = getInstalledProviders();
    const isGlobal = params?.isGlobal !== false;

    if (providers.length === 0) {
      return this.errorResponse('mutate', 'tools', `skill.${sub}`,
        'E_PROVIDER_NOT_FOUND', 'No installed providers available', startTime);
    }

    switch (sub) {
      case 'install':
      case 'enable': {
        const name = params?.name as string | undefined;
        if (!name) {
          return this.errorResponse('mutate', 'tools', `skill.${sub}`, 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const source = (params?.source as string | undefined) ?? `library:${name}`;
        const result = await installSkill(source, name, providers, isGlobal, this.projectRoot);
        return {
          _meta: dispatchMeta('mutate', 'tools', `skill.${sub}`, startTime),
          success: result.success,
          data: { result },
          error: result.success ? undefined : { code: 'E_INSTALL_FAILED', message: result.errors.join('; ') || 'Skill install failed' },
        };
      }
      case 'uninstall':
      case 'disable': {
        const name = params?.name as string | undefined;
        if (!name) {
          return this.errorResponse('mutate', 'tools', `skill.${sub}`, 'E_INVALID_INPUT',
            'Missing required parameter: name', startTime);
        }
        const result = await removeSkill(name, providers, isGlobal, this.projectRoot);
        const ok = result.removed.length > 0 && result.errors.length === 0;
        return {
          _meta: dispatchMeta('mutate', 'tools', `skill.${sub}`, startTime),
          success: ok,
          data: { removed: result.removed, errors: result.errors },
          error: ok ? undefined : { code: 'E_UNINSTALL_FAILED', message: result.errors.join('; ') || 'Skill uninstall failed' },
        };
      }
      case 'configure': {
        return {
          _meta: dispatchMeta('mutate', 'tools', 'skill.configure', startTime),
          success: true,
          data: { configured: true, message: 'Configuration is managed by CAAMP providers and lock file' },
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
        return this.errorResponse('mutate', 'tools', `skill.${sub}`,
          'E_INVALID_OPERATION', `Unknown skill mutation: ${sub}`, startTime);
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
        return {
          _meta: dispatchMeta('query', 'tools', 'provider.list', startTime),
          success: true,
          data: { providers, count: providers.length },
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

      default:
        return this.errorResponse('query', 'tools', `provider.${sub}`,
          'E_INVALID_OPERATION', `Unknown provider query: ${sub}`, startTime);
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
          return this.errorResponse('mutate', 'tools', 'provider.inject',
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
        return this.errorResponse('mutate', 'tools', `provider.${sub}`,
          'E_INVALID_OPERATION', `Unknown provider mutation: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Wrap a native engine result (EngineResult pattern) into DispatchResponse.
   */
  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    if (result.success) {
      return {
        _meta: dispatchMeta(gateway, 'tools', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: dispatchMeta(gateway, 'tools', operation, startTime),
      success: false,
      error: {
        code: result.error?.code || 'E_UNKNOWN',
        message: result.error?.message || 'Unknown error',
      },
    };
  }

  private errorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number,
  ): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ gateway, domain, operation, err: error }, message);
    return this.errorResponse(
      gateway, domain, operation,
      'E_INTERNAL_ERROR',
      message,
      startTime,
    );
  }
}
