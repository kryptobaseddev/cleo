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
import {
  parseIssueTemplates,
  getTemplateForSubcommand,
  generateTemplateConfig,
  validateLabels,
} from '../lib/engine.js';
import { catalog } from '@cleocode/caamp';

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
        return this.querySkill(operation.slice('skill.'.length), params, startTime);
      }

      // Provider sub-domain
      if (operation.startsWith('provider.')) {
        return this.queryProvider(operation.slice('provider.'.length), params, startTime);
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
        return this.mutateSkill(operation.slice('skill.'.length), params, startTime);
      }

      // Provider sub-domain
      if (operation.startsWith('provider.')) {
        return this.mutateProvider(operation.slice('provider.'.length), params, startTime);
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
      case 'diagnostics':
        // TODO: delegate to core diagnostics when available
        return this.errorResponse('query', 'tools', 'issue.diagnostics',
          'E_NOT_IMPLEMENTED', 'Diagnostics not yet available in dispatch layer', startTime);

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
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'add.bug':
      case 'add.feature':
      case 'add.help':
      case 'create.bug':
      case 'create.feature':
      case 'create.help':
        // TODO: delegate to core issue creation when available
        return this.errorResponse('mutate', 'tools', `issue.${sub}`,
          'E_NOT_IMPLEMENTED', 'Issue creation not yet available in dispatch layer', startTime);

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

  private querySkill(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    // Catalog sub-sub-domain
    if (sub.startsWith('catalog.')) {
      return this.querySkillCatalog(sub.slice('catalog.'.length), startTime);
    }

    switch (sub) {
      case 'list':
      case 'show':
      case 'find':
      case 'dispatch':
      case 'verify':
      case 'dependencies':
        // TODO: delegate to core skill operations when dispatch migration completes
        return this.errorResponse('query', 'tools', `skill.${sub}`,
          'E_NOT_IMPLEMENTED', `Skill query '${sub}' not yet available in dispatch layer`, startTime);

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

  private mutateSkill(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'install':
      case 'uninstall':
      case 'enable':
      case 'disable':
      case 'configure':
      case 'refresh':
        // TODO: delegate to core skill operations when dispatch migration completes
        return this.errorResponse('mutate', 'tools', `skill.${sub}`,
          'E_NOT_IMPLEMENTED', `Skill mutation '${sub}' not yet available in dispatch layer`, startTime);

      default:
        return this.errorResponse('mutate', 'tools', `skill.${sub}`,
          'E_INVALID_OPERATION', `Unknown skill mutation: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Provider queries
  // -----------------------------------------------------------------------

  private queryProvider(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'list':
      case 'detect':
      case 'inject.status':
        // TODO: delegate to CAAMP adapter when dispatch migration completes
        return this.errorResponse('query', 'tools', `provider.${sub}`,
          'E_NOT_IMPLEMENTED', `Provider query '${sub}' not yet available in dispatch layer`, startTime);

      default:
        return this.errorResponse('query', 'tools', `provider.${sub}`,
          'E_INVALID_OPERATION', `Unknown provider query: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Provider mutations
  // -----------------------------------------------------------------------

  private mutateProvider(
    sub: string,
    _params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'inject':
        // TODO: delegate to CAAMP adapter when dispatch migration completes
        return this.errorResponse('mutate', 'tools', `provider.${sub}`,
          'E_NOT_IMPLEMENTED', `Provider mutation '${sub}' not yet available in dispatch layer`, startTime);

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
    return this.errorResponse(
      gateway, domain, operation,
      'E_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime,
    );
  }
}
