/**
 * Issues Domain Handler
 *
 * Enables filing bug reports, feature requests, and questions
 * against the CLEO GitHub repository via MCP.
 *
 * Operations:
 * - Query: diagnostics (system diagnostics)
 * - Mutate: create_bug, create_feature, create_help
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';

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
  constructor(private executor: CLIExecutor) {}

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    switch (operation) {
      case 'diagnostics':
        return this.handleDiagnostics(startTime);
      default:
        return this.unsupportedOperation('cleo_query', operation, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    switch (operation) {
      case 'create_bug':
        return this.handleCreateIssue('bug', params, startTime);
      case 'create_feature':
        return this.handleCreateIssue('feature', params, startTime);
      case 'create_help':
        return this.handleCreateIssue('help', params, startTime);
      default:
        return this.unsupportedOperation('cleo_mutate', operation, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['diagnostics'],
      mutate: ['create_bug', 'create_feature', 'create_help'],
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
      .map((a, i) => {
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
