/**
 * Upgrade Domain Handler (Dispatch Layer)
 *
 * Handles `cleo upgrade <operation>` dispatch operations.
 *
 * For T9536 (Phase 4 of T9497) the only supported operation is
 * `workflows` — re-renders the four shipped workflow templates against
 * the project's current `.cleo/release-config.json` + ADR-061 tool
 * state, compares to the on-disk `.github/workflows/release-*.yml`
 * files, and reports per-template drift.
 *
 * QUERY operations:
 *   workflows — read-only drift detection. Accepts `dryRun?: boolean`
 *               (always true at the query gateway), `force?: boolean`
 *               (always false at the query gateway), and a logical
 *               `check?: boolean` discriminator the CLI uses to drive
 *               the `--check` exit-code contract.
 *
 * MUTATE operations:
 *   workflows — destructive variant that re-writes drifted files when
 *               `force=true`. Without `force` the behaviour is identical
 *               to the query path; with `force` the SDK primitive
 *               atomic-writes the rendered YAML and audits the action
 *               to `.cleo/audit/upgrade-workflows.jsonl`.
 *
 * @task T9536
 * @epic T9497
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger, getProjectRoot } from '@cleocode/core';
import { type UpgradeWorkflowsResult, upgradeWorkflows } from '@cleocode/core/internal';

import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

const log = getLogger('domain:upgrade');

/**
 * Resolve the absolute path to the `@cleocode/cleo` package's
 * `templates/workflows/` directory from THIS file's location. Works in
 * both monorepo development (`packages/cleo/dist/dispatch/domains/...`)
 * and installed npm package (`node_modules/@cleocode/cleo/dist/...`)
 * layouts.
 *
 * Mirrors `getWorkflowTemplatesDir` in
 * `packages/cleo/src/cli/commands/init.ts` — that helper is the
 * CLI-layer source, this is the dispatch-layer source. They MUST stay
 * in sync; see T9536 acceptance criteria.
 *
 * @internal
 */
function resolveTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = packages/cleo/dist/dispatch/domains   (after esbuild emit)
  //      = packages/cleo/src/dispatch/domains    (in dev)
  // Either way, up 3 levels lands at packages/cleo and templates/workflows is the target.
  return resolve(here, '..', '..', '..', 'templates', 'workflows');
}

/**
 * Convert an {@link UpgradeWorkflowsResult} envelope into the CLI
 * dispatch surface shape.
 *
 * @internal
 */
function toDispatchData(result: UpgradeWorkflowsResult) {
  return {
    outcomes: result.outcomes.map((o) => ({
      template: o.template,
      targetPath: o.targetPath,
      status: o.status,
      overrideDeclared: o.overrideDeclared,
    })),
    resolvedTools: result.resolvedTools,
    hasDrift: result.hasDrift,
  };
}

/**
 * Dispatch handler for the `upgrade` domain (workflow upgrade ops).
 *
 * Registered under the `upgrade` domain key in {@link createDomainHandlers}.
 *
 * @task T9536
 */
export class UpgradeHandler implements DomainHandler {
  /**
   * Handle read-only upgrade queries.
   *
   * Supported operations:
   *  - `workflows` — drift detection only; never writes to disk.
   *                  Effectively forces `dryRun=true` at the query gateway.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'workflows': {
          const includeRendered = params?.['includeRendered'] === true;
          const result = await upgradeWorkflows({
            projectRoot: getProjectRoot(),
            templatesDir: resolveTemplatesDir(),
            dryRun: true,
          });
          const data = toDispatchData(result);
          return {
            meta: dispatchMeta('query', 'upgrade', operation, startTime),
            success: true,
            data: includeRendered
              ? {
                  ...data,
                  rendered: result.outcomes.map((o) => ({
                    template: o.template,
                    rendered: o.rendered,
                  })),
                }
              : data,
          };
        }
        default:
          return unsupportedOp('query', 'upgrade', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'UpgradeHandler query error');
      return handleErrorResult('query', 'upgrade', operation, err, startTime);
    }
  }

  /**
   * Handle upgrade mutations.
   *
   * Supported operations:
   *  - `workflows` — re-render + (optionally) re-write drifted files.
   *                  Params: `{ force?, dryRun? }`. Returns the per-template
   *                  outcomes plus the `hasDrift` flag the CLI uses to drive
   *                  the `--check` exit-code contract.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'workflows': {
          const force = params?.['force'] === true;
          const dryRun = params?.['dryRun'] === true;
          const includeRendered = params?.['includeRendered'] === true;
          const result = await upgradeWorkflows({
            projectRoot: getProjectRoot(),
            templatesDir: resolveTemplatesDir(),
            force,
            dryRun,
          });
          const data = toDispatchData(result);
          return {
            meta: dispatchMeta('mutate', 'upgrade', operation, startTime),
            success: true,
            data: includeRendered
              ? {
                  ...data,
                  rendered: result.outcomes.map((o) => ({
                    template: o.template,
                    rendered: o.rendered,
                  })),
                }
              : data,
          };
        }
        default:
          return unsupportedOp('mutate', 'upgrade', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'UpgradeHandler mutate error');
      return handleErrorResult('mutate', 'upgrade', operation, err, startTime);
    }
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['workflows'],
      mutate: ['workflows'],
    };
  }
}
