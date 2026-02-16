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
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  releasePrepare as nativeReleasePrepare,
  releaseChangelog as nativeReleaseChangelog,
  releaseList as _nativeReleaseList,
  releaseShow as _nativeReleaseShow,
  releaseCommit as nativeReleaseCommit,
  releaseTag as nativeReleaseTag,
  releaseGatesRun as nativeReleaseGatesRun,
  releaseRollback as nativeReleaseRollback,
  releasePush as nativeReleasePush,
  resolveProjectRoot,
} from '../engine/index.js';
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
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(private executor?: CLIExecutor, executionMode: ResolvedMode = 'cli') {
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor?.isAvailable()) {
      return false;
    }
    return canRunNatively('release', operation, gateway);
  }

  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;
    if (result.success) {
      return {
        _meta: { gateway, domain: 'release', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'release', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  private mutateNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    switch (operation) {
      case 'prepare':
        return this.wrapNativeResult(
          nativeReleasePrepare(params?.version as string, params?.tasks as string[], params?.notes as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'changelog':
        return this.wrapNativeResult(nativeReleaseChangelog(params?.version as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'commit':
        return this.wrapNativeResult(nativeReleaseCommit(params?.version as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'tag':
        return this.wrapNativeResult(nativeReleaseTag(params?.version as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'gates.run':
        return this.wrapNativeResult(nativeReleaseGatesRun(params?.version as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'rollback':
        return this.wrapNativeResult(nativeReleaseRollback(params?.version as string, params?.reason as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'push':
        return this.wrapNativeResult(nativeReleasePush(params?.version as string, params?.remote as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      default:
        return this.createErrorResponse('cleo_mutate', 'release', operation, 'E_INVALID_OPERATION', `Unknown native mutate operation: ${operation}`, startTime);
    }
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!this.executor || !this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_query',
        'release',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'release.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
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

    if (this.useNative(operation, 'mutate')) {
      try {
        return this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'release', operation, error, startTime);
      }
    }

    if (!this.executor || !this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'release.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
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
  private async queryVersion(_params: ReleaseVersionParams): Promise<DomainResponse> {
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
  private async queryVerify(_params: ReleaseVerifyParams): Promise<DomainResponse> {
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
   * Uses portable config-driven version bump from lib/release/version-bump.sh
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

    // Use portable config-driven version bump library
    // Sources lib/release/version-bump.sh, reads current VERSION, calculates new version, and bumps all configured files
    const bumpScript = [
      'source lib/release/version-bump.sh',
      `CURRENT=$(cat VERSION 2>/dev/null || echo "0.0.0")`,
      `NEW=$(calculate_new_version "$CURRENT" "${params.type}")`,
      `bump_version_from_config "$NEW"`,
    ].join(' && ');

    const result = await this.executor!.execute<ReleaseBumpResult>({
      domain: 'release',
      operation: 'bump',
      args: [],
      flags: {},
      customCommand: `bash -c '${bumpScript}'`,
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
   * CLI: cleo release ship <version> --bump-version --create-tag [--push]
   *
   * @fix GitHub Issue #21 - was using deprecated ./dev/release-version.sh which
   *      doesn't exist in user projects. Now routes through cleo release ship.
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

    // Determine version from type - read current VERSION and compute next
    const versionResult = await this.executor!.execute<{ version: string }>({
      domain: 'version',
      operation: '',
      flags: { json: true },
    });

    if (!versionResult.success || !versionResult.data?.version) {
      return this.createErrorResponse(
        'cleo_mutate',
        'release',
        'publish',
        'E_VERSION_READ_FAILED',
        'Could not read current version',
        startTime
      );
    }

    const currentParts = versionResult.data.version.replace(/^v/, '').split('.').map(Number);
    let nextVersion: string;
    switch (params.type) {
      case 'major':
        nextVersion = `v${currentParts[0] + 1}.0.0`;
        break;
      case 'minor':
        nextVersion = `v${currentParts[0]}.${currentParts[1] + 1}.0`;
        break;
      case 'patch':
      default:
        nextVersion = `v${currentParts[0]}.${currentParts[1]}.${currentParts[2] + 1}`;
        break;
    }

    // Create the release entry if it doesn't exist
    await this.executor!.execute({
      domain: 'release',
      operation: 'create',
      args: [nextVersion],
      flags: { json: true },
    });

    // Ship the release
    const flags: Record<string, unknown> = {
      json: true,
      'bump-version': true,
      'create-tag': true,
    };

    if (params?.push) {
      flags.push = true;
    }

    const result = await this.executor!.execute<ReleasePublishResult>({
      domain: 'release',
      operation: 'ship',
      args: [nextVersion],
      flags,
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
   * prepare - Prepare release (create + dry-run validation)
   * CLI: cleo release create <version> && cleo release ship <version> --dry-run
   *
   * @fix GitHub Issue #21 - was using deprecated ./dev/release-version.sh which
   *      doesn't exist in user projects. Now routes through cleo release create + ship --dry-run.
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

    const version = params.version.startsWith('v') ? params.version : `v${params.version}`;

    // Create the release entry (idempotent - will fail if exists, which is fine)
    await this.executor!.execute({
      domain: 'release',
      operation: 'create',
      args: [version],
      flags: { json: true },
    });

    // Run ship in dry-run mode for validation
    const result = await this.executor!.execute<ReleasePrepareResult>({
      domain: 'release',
      operation: 'ship',
      args: [version],
      flags: { json: true, 'dry-run': true, 'bump-version': true },
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
