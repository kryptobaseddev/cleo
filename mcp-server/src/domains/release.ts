/**
 * Release Domain Handler
 *
 * Implements all 12 release operations for CLEO MCP server:
 * - Query (3): version, verify, changelog
 * - Mutate (9): bump, tag, publish, rollback, prepare, changelog, commit, push, gates.run
 *
 * Each operation maps to corresponding CLEO CLI commands with proper
 * parameter validation and error handling.
 *
 * @task T2934
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import type {
  ReleaseType,
  ReleasePrepareParams,
  ReleasePrepareResult,
  ReleaseChangelogParams,
  ReleaseChangelogResult,
  ReleaseCommitParams,
  ReleaseCommitResult,
  ReleaseTagParams,
  ReleaseTagResult,
  ReleasePushParams,
  ReleasePushResult,
  ReleaseGatesRunParams,
  ReleaseGatesRunResult,
  ReleaseRollbackParams,
  ReleaseRollbackResult,
} from '../types/index.js';

/**
 * Additional operation types
 */
interface ReleaseVersionParams {}

interface ReleaseVersionResult {
  version: string;
  major: number;
  minor: number;
  patch: number;
}

interface ReleaseVerifyParams {}

interface ReleaseVerifyResult {
  consistent: boolean;
  version: string;
  files: Array<{
    file: string;
    version: string;
    consistent: boolean;
  }>;
  errors: string[];
}

interface ReleaseBumpParams {
  type: ReleaseType;
  push?: boolean;
}

interface ReleaseBumpResult {
  oldVersion: string;
  newVersion: string;
  type: ReleaseType;
  filesUpdated: string[];
}

interface ReleasePublishParams {
  type: ReleaseType;
  push?: boolean;
}

interface ReleasePublishResult {
  version: string;
  type: ReleaseType;
  commitHash: string;
  tagName: string;
  pushed: boolean;
}

/**
 * Release domain handler implementation
 */
export class ReleaseHandler implements DomainHandler {
  constructor(private executor?: CLIExecutor) {}

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Require executor for all operations
    if (!this.executor) {
      return this.createErrorResponse(
        'cleo_query',
        'release',
        operation,
        'E_NOT_INITIALIZED',
        'Release handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'version':
          return await this.queryVersion(params as unknown as ReleaseVersionParams);
        case 'verify':
          return await this.queryVerify(params as unknown as ReleaseVerifyParams);
        case 'changelog':
          return await this.queryChangelog(params as unknown as ReleaseChangelogParams);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'release',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'release', operation, error, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Require executor for all operations
    if (!this.executor) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        operation,
        'E_NOT_INITIALIZED',
        'Release handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'bump':
          return await this.mutateBump(params as unknown as ReleaseBumpParams);
        case 'tag':
          return await this.mutateTag(params as unknown as ReleaseTagParams);
        case 'publish':
          return await this.mutatePublish(params as unknown as ReleasePublishParams);
        case 'rollback':
          return await this.mutateRollback(params as unknown as ReleaseRollbackParams);
        case 'prepare':
          return await this.mutatePrepare(params as unknown as ReleasePrepareParams);
        case 'changelog':
          return await this.mutateChangelog(params as unknown as ReleaseChangelogParams);
        case 'commit':
          return await this.mutateCommit(params as unknown as ReleaseCommitParams);
        case 'push':
          return await this.mutatePush(params as unknown as ReleasePushParams);
        case 'gates.run':
          return await this.mutateGatesRun(params as unknown as ReleaseGatesRunParams);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'release',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'release', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['version', 'verify', 'changelog'],
      mutate: ['bump', 'tag', 'publish', 'rollback', 'prepare', 'changelog', 'commit', 'push', 'gates.run'],
    };
  }

  // ===== Query Operations =====

  /**
   * version - Get current version
   * CLI: cleo version
   */
  private async queryVersion(params: ReleaseVersionParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<ReleaseVersionResult>({
      domain: 'version',
      operation: '',
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'release', 'version', startTime);
  }

  /**
   * verify - Verify version consistency
   * CLI: ./dev/validate-version.sh
   */
  private async queryVerify(params: ReleaseVerifyParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<ReleaseVerifyResult>({
      domain: 'validate-version',
      operation: '',
      flags: { json: true },
      customCommand: './dev/validate-version.sh',
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'release', 'verify', startTime);
  }

  /**
   * changelog - Get changelog content
   * CLI: cat CHANGELOG.md
   */
  private async queryChangelog(params: ReleaseChangelogParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_query',
        'release',
        'changelog',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const result = await this.executor!.execute<ReleaseChangelogResult>({
      domain: 'changelog',
      operation: '',
      args: [params.version],
      flags: { json: true },
      customCommand: 'cat CHANGELOG.md',
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'release', 'changelog', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * bump - Bump version (patch/minor/major)
   * CLI: ./dev/bump-version.sh <type>
   */
  private async mutateBump(params: ReleaseBumpParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.type) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'bump',
        'E_INVALID_INPUT',
        'type is required (patch, minor, or major)',
        startTime
      );
    }

    // Validate type
    if (!['patch', 'minor', 'major'].includes(params.type)) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'bump',
        'E_INVALID_INPUT',
        `Invalid type: ${params.type}. Must be patch, minor, or major`,
        startTime
      );
    }

    const result = await this.executor!.execute<ReleaseBumpResult>({
      domain: 'bump-version',
      operation: '',
      args: [params.type],
      flags: { json: true },
      customCommand: './dev/bump-version.sh',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'bump', startTime);
  }

  /**
   * tag - Create git tag
   * CLI: git tag -a v<version> -m <message>
   */
  private async mutateTag(params: ReleaseTagParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'tag',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const args = ['-a', `v${params.version}`, '-m', params.message || `Release v${params.version}`];

    const result = await this.executor!.execute<ReleaseTagResult>({
      domain: 'git',
      operation: 'tag',
      args,
      flags: { json: true },
      customCommand: 'git',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'tag', startTime);
  }

  /**
   * publish - Publish release
   * CLI: ./dev/release-version.sh <type> [--push]
   */
  private async mutatePublish(params: ReleasePublishParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.type) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'publish',
        'E_INVALID_INPUT',
        'type is required (patch, minor, or major)',
        startTime
      );
    }

    // Validate type
    if (!['patch', 'minor', 'major'].includes(params.type)) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'publish',
        'E_INVALID_INPUT',
        `Invalid type: ${params.type}. Must be patch, minor, or major`,
        startTime
      );
    }

    const args = [params.type];
    const flags: Record<string, unknown> = { json: true };

    if (params?.push) {
      flags.push = true;
    }

    const result = await this.executor!.execute<ReleasePublishResult>({
      domain: 'release-version',
      operation: '',
      args,
      flags,
      customCommand: './dev/release-version.sh',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'publish', startTime);
  }

  /**
   * rollback - Rollback to previous version
   * CLI: git tag -d v<version> && git push --delete origin v<version>
   */
  private async mutateRollback(params: ReleaseRollbackParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'rollback',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    if (!params?.reason) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'rollback',
        'E_INVALID_INPUT',
        'reason is required',
        startTime
      );
    }

    // Delete local tag
    await this.executor!.execute({
      domain: 'git',
      operation: 'tag',
      args: ['-d', `v${params.version}`],
      customCommand: 'git',
    });

    // Delete remote tag
    const result = await this.executor!.execute<ReleaseRollbackResult>({
      domain: 'git',
      operation: 'push',
      args: ['--delete', 'origin', `v${params.version}`],
      flags: { json: true },
      customCommand: 'git',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'rollback', startTime);
  }

  // ===== New Mutate Operations =====

  /**
   * prepare - Prepare release (dry-run validation)
   * CLI: ./dev/release-version.sh <type> --dry-run
   */
  private async mutatePrepare(params: ReleasePrepareParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'prepare',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const type = params.type || 'patch';

    const result = await this.executor!.execute<ReleasePrepareResult>({
      domain: 'release-version',
      operation: '',
      args: [type],
      flags: { json: true, 'dry-run': true },
      customCommand: './dev/release-version.sh',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'prepare', startTime);
  }

  /**
   * changelog (mutate) - Generate changelog
   * CLI: scripts/generate-changelog.sh
   */
  private async mutateChangelog(params: ReleaseChangelogParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'changelog',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const result = await this.executor!.execute<ReleaseChangelogResult>({
      domain: 'generate-changelog',
      operation: '',
      args: [params.version],
      flags: { json: true },
      customCommand: './scripts/generate-changelog.sh',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'changelog', startTime);
  }

  /**
   * commit - Create release commit
   * CLI: git commit -m "chore: Release v<version>"
   */
  private async mutateCommit(params: ReleaseCommitParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'commit',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const message = `chore: Release v${params.version}`;
    const args: (string | number)[] = ['-m', message];
    if (params?.files && params.files.length > 0) {
      // Stage specific files first
      await this.executor!.execute({
        domain: 'git',
        operation: 'add',
        args: params.files,
        customCommand: 'git',
      });
    }

    const result = await this.executor!.execute<ReleaseCommitResult>({
      domain: 'git',
      operation: 'commit',
      args,
      flags: { json: true },
      customCommand: 'git',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'commit', startTime);
  }

  /**
   * push - Push to remote with tags
   * CLI: git push [<remote>] --follow-tags
   */
  private async mutatePush(params: ReleasePushParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'push',
        'E_INVALID_INPUT',
        'version is required',
        startTime
      );
    }

    const remote = params.remote || 'origin';
    const args = [remote, '--follow-tags'];

    const result = await this.executor!.execute<ReleasePushResult>({
      domain: 'git',
      operation: 'push',
      args,
      flags: { json: true },
      customCommand: 'git',
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'push', startTime);
  }

  /**
   * gates.run - Run release gates (tests, lint, security)
   * CLI: Run test suite and validation checks
   */
  private async mutateGatesRun(params: ReleaseGatesRunParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.gates && params.gates.length > 0) {
      flags.gates = params.gates.join(',');
    }

    const result = await this.executor!.execute<ReleaseGatesRunResult>({
      domain: 'release',
      operation: 'gates',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'release', 'gates.run', startTime);
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
