/**
 * Issues Domain Handler
 *
 * Enables filing bug reports, feature requests, and questions
 * against the CLEO GitHub repository via MCP.
 *
 * Supports dual-mode routing:
 * - Native: templates, validate_labels (query), generate_config (mutate)
 * - CLI-backed: diagnostics (query), create_bug, create_feature, create_help (mutate)
 *
 * Operations:
 * - Query: diagnostics, templates, validate_labels
 * - Mutate: create_bug, create_feature, create_help, generate_config
 *
 * @task T4492
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  parseIssueTemplates as nativeParseIssueTemplates,
  getTemplateForSubcommand as nativeGetTemplateForSubcommand,
  generateTemplateConfig as nativeGenerateTemplateConfig,
  validateLabels as nativeValidateLabels,
  resolveProjectRoot,
} from '../engine/index.js';

/**
 * Issue creation parameters
 */
interface IssueCreateParams {
  title: string;
  body: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  area?: 'cli' | 'mcp' | 'docs' | 'tests' | 'other';
  dryRun?: boolean;
}

export class IssuesHandler implements DomainHandler {
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(private executor: CLIExecutor, executionMode: ResolvedMode = 'cli') {
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  /**
   * Check if we should use native engine for this operation
   */
  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor.isAvailable()) {
      return false;
    }
    return canRunNatively('issues', operation, gateway);
  }

  /**
   * Wrap a native engine result in DomainResponse format
   */
  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;
    if (result.success) {
      return {
        _meta: { gateway, domain: 'issues', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'issues', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'query')) {
      return this.queryNative(operation, params, startTime);
    }

    switch (operation) {
      case 'diagnostics':
        return this.handleDiagnostics(startTime);
      case 'templates':
        // Fall through to native even in CLI mode (no CLI equivalent)
        return this.queryNative(operation, params, startTime);
      case 'validate_labels':
        // Fall through to native even in CLI mode (no CLI equivalent)
        return this.queryNative(operation, params, startTime);
      default:
        return this.unsupportedOperation('cleo_query', operation, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'mutate')) {
      return this.mutateNative(operation, params, startTime);
    }

    switch (operation) {
      case 'create_bug':
        return this.handleCreateIssue('bug', params, startTime);
      case 'create_feature':
        return this.handleCreateIssue('feature', params, startTime);
      case 'create_help':
        return this.handleCreateIssue('help', params, startTime);
      case 'generate_config':
        // Fall through to native even in CLI mode (no CLI equivalent)
        return this.mutateNative(operation, params, startTime);
      default:
        return this.unsupportedOperation('cleo_mutate', operation, startTime);
    }
  }

  /**
   * Native query routing
   */
  private queryNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): DomainResponse {
    switch (operation) {
      case 'templates': {
        const subcommand = params?.subcommand as string | undefined;
        if (subcommand) {
          const result = nativeGetTemplateForSubcommand(this.projectRoot, subcommand);
          return this.wrapNativeResult(result, 'cleo_query', operation, startTime);
        }
        const result = nativeParseIssueTemplates(this.projectRoot);
        return this.wrapNativeResult(result, 'cleo_query', operation, startTime);
      }
      case 'validate_labels': {
        const labels = params?.labels as string[] | undefined;
        const repoLabels = params?.repoLabels as string[] | undefined;
        if (!labels || !repoLabels) {
          return this.wrapNativeResult(
            {
              success: false,
              error: {
                code: 'E_PARSE_ERROR',
                message: 'Missing required parameters: labels and repoLabels (both arrays of strings)',
              },
            },
            'cleo_query',
            operation,
            startTime
          );
        }
        const result = nativeValidateLabels(labels, repoLabels);
        return this.wrapNativeResult(result, 'cleo_query', operation, startTime);
      }
      default:
        return this.unsupportedOperation('cleo_query', operation, startTime);
    }
  }

  /**
   * Native mutate routing
   */
  private async mutateNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): Promise<DomainResponse> {
    switch (operation) {
      case 'generate_config': {
        const result = await nativeGenerateTemplateConfig(this.projectRoot);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      default:
        return this.unsupportedOperation('cleo_mutate', operation, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['diagnostics', 'templates', 'validate_labels'],
      mutate: ['create_bug', 'create_feature', 'create_help', 'generate_config'],
    };
  }

  /**
   * Handle diagnostics query
   */
  private async handleDiagnostics(startTime: number): Promise<DomainResponse> {
    const result = await this.executor.execute({
      domain: 'issue',
      operation: 'diagnostics',
      customCommand: 'cleo issue diagnostics --json',
      timeout: 10000,
    });

    return {
      _meta: {
        gateway: 'cleo_query',
        domain: 'issues',
        operation: 'diagnostics',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: result.success,
      data: result.data,
      error: result.error
        ? {
            code: result.error.code,
            exitCode: result.error.exitCode,
            message: result.error.message,
            fix: result.error.fix,
          }
        : undefined,
    };
  }

  /**
   * Handle issue creation (bug, feature, help)
   */
  private async handleCreateIssue(
    type: 'bug' | 'feature' | 'help',
    params: Record<string, unknown> | undefined,
    startTime: number
  ): Promise<DomainResponse> {
    // Validate required params
    if (!params?.title || !params?.body) {
      return {
        _meta: {
          gateway: 'cleo_mutate',
          domain: 'issues',
          operation: `create_${type}`,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: false,
        error: {
          code: 'E_VALIDATION_FAILED',
          exitCode: 6,
          message: 'Missing required parameters: title and body',
          fix: `Provide both title and body parameters`,
        },
      };
    }

    // Build CLI command
    const args: string[] = [];
    args.push('--title', String(params.title));
    args.push('--body', String(params.body));

    if (params.severity) {
      args.push('--severity', String(params.severity));
    }
    if (params.area) {
      args.push('--area', String(params.area));
    }
    if (params.dryRun) {
      args.push('--dry-run');
    }

    const flagStr = args
      .map((a) => {
        if (a.startsWith('--')) return a;
        // Quote values
        return `"${a.replace(/"/g, '\\"')}"`;
      })
      .join(' ');

    const result = await this.executor.execute({
      domain: 'issue',
      operation: type,
      customCommand: `cleo issue ${type} --json ${flagStr}`,
      timeout: 30000,
    });

    return {
      _meta: {
        gateway: 'cleo_mutate',
        domain: 'issues',
        operation: `create_${type}`,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: result.success,
      data: result.data,
      error: result.error
        ? {
            code: result.error.code,
            exitCode: result.error.exitCode,
            message: result.error.message,
            fix: result.error.fix,
          }
        : undefined,
    };
  }

  /**
   * Unsupported operation error
   */
  private unsupportedOperation(
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const ops = this.getSupportedOperations();
    const validOps = gateway === 'cleo_query' ? ops.query : ops.mutate;

    return {
      _meta: {
        gateway,
        domain: 'issues',
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: false,
      error: {
        code: 'E_INVALID_OPERATION',
        exitCode: 2,
        message: `Operation '${operation}' not supported for ${gateway} in domain 'issues'`,
        fix: `Use one of: ${validOps.join(', ')}`,
        alternatives: validOps.map((op) => ({
          action: `Use ${op}`,
          command: `${gateway} issues ${op}`,
        })),
      },
    };
  }
}
