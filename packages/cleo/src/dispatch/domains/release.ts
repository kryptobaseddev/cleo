/**
 * Release Domain Handler (Dispatch Layer)
 *
 * Handles `cleo release <operation>` dispatch operations:
 *
 * QUERY operations:
 *   validate-changelog — CHANGELOG.md section check
 *
 * MUTATE operations:
 *   plan           — SPEC-T9345 §4.2 (T9525): build canonical Release Plan envelope
 *   open           — SPEC-T9345 §4.3 (T9530): dispatch release-prepare workflow
 *   reconcile      — SPEC-T9345 §4.4 (T9526 v2): backfill 11 provenance tables
 *   cut            — T14102: tag the newest green default-branch commit (one-command release)
 *   write-changelog — T14102: CHANGELOG section from changesets since the previous tag
 *   verify-tag     — T14102 (query): a release tag must be a green first-parent default-branch commit
 *
 * Ship, list, show, cancel, changelog, rollback, channel are handled by the
 * pipeline domain handler (via `pipeline.release.*` operations).
 *
 * Engine result fields (fix, exitCode, details) preserved via wrapResult.
 * The IVTR-only `gate` and `ivtr-suggest` operations were deleted in T14311
 * with the retired `ivtr_state` column.
 *
 * Historical note: the legacy 4-step pipeline operations (`start`,
 * `verify`, `publish`, and the legacy `reconcile`) were deleted in T9540
 * (Phase 6 of T9499) along with the backing functions in
 * `packages/core/src/release/pipeline.ts`. The plan/open/reconcile-v2
 * verbs above are the canonical replacement per SPEC-T9345 §4.
 *
 * @task T1543 — OpsFromCore migration per ADR-058
 * @task T1726 — Register release domain in OPERATIONS (SDK surface parity)
 * @task T9540 — remove legacy start/verify/publish handlers
 * @task T14311 — remove the IVTR gate and ivtr-suggest operations
 */

import type {
  ReleaseCutOptions,
  ReleaseOpenOptions,
  ReleasePlanOptions,
  ValidateChangelogOptions,
} from '@cleocode/core/internal';
import {
  getLogger,
  getProjectRoot,
  resolveInvokingCheckout,
  resolveWorktreeRouting,
} from '@cleocode/core/internal';
import {
  releaseChangelog,
  releaseCut,
  releaseOpen,
  releasePlan,
  releaseReconcileV2,
  releaseVerifyTag,
  validateChangelog,
} from '@cleocode/runtime/gateway';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:release');

// ---------------------------------------------------------------------------
// ReleaseHandler
// ---------------------------------------------------------------------------

/**
 * Dispatch domain handler for the release verbs served outside the pipeline
 * domain (plan, open, reconcile, cut, changelog checks).
 *
 * Registered under the `release` domain key in the domain handler registry.
 * Delegates to `wrapResult` to preserve engine error fields
 * (`fix`, `exitCode`, `details`) that typed envelope would otherwise strip.
 */
export class ReleaseHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // query — read-only
  // -----------------------------------------------------------------------

  /**
   * Handle read-only release queries.
   *
   * Supported operations: `validate-changelog`, `verify-tag`.
   *
   * The legacy `verify` query (run gates + audit child tasks) was removed
   * in T9540 — use `cleo verify <task> --gate X --evidence …` per
   * SPEC-T9345 §12 R-422 / ADR-051.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // release.validate-changelog — canonical CHANGELOG.md header validator
        // (T9937 / Saga T9862). Replaces the brittle `grep -qF "## [VERSION]"`
        // step in .github/workflows/release.yml. Read-only.
        //
        // The core verb returns a plain `ValidateChangelogResult` envelope
        // (NOT an EngineResult discriminated union) so direct SDK consumers
        // can branch on `result.valid`. At the dispatch boundary we translate
        // `valid=false` into `E_CHANGELOG_MISSING_SECTION` so the CLI emits a
        // non-zero exit code — exactly the behaviour CI workflows depend on
        // (the legacy `grep -qF "## [VERSION]" || exit 1` had the same
        // contract).
        // release.verify-tag — T14102: release.yml refuses to publish a tag
        // that is not a green first-parent commit of the default branch.
        case 'verify-tag': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT', // @sync-invariant none:input-shape a missing version is refused before anything is read
              'version is required',
              startTime,
            );
          return wrapResult(
            await releaseVerifyTag({ version, projectRoot: resolveInvokingCheckout() }),
            'query',
            'release',
            operation,
            startTime,
          );
        }

        case 'validate-changelog': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'version is required',
              startTime,
            );
          const typed: ValidateChangelogOptions = {
            version,
            projectRoot: getProjectRoot(),
            ...(typeof params?.changelogPath === 'string'
              ? { changelogPath: params.changelogPath }
              : {}),
          };
          const validation = await validateChangelog(typed);
          if (validation.valid) {
            return wrapResult(
              { success: true, data: validation },
              'query',
              'release',
              operation,
              startTime,
            );
          }
          return wrapResult(
            {
              success: false,
              error: {
                code: 'E_CHANGELOG_MISSING_SECTION',
                message:
                  validation.reason ??
                  `CHANGELOG.md missing canonical header for v${validation.normalizedVersion}`,
                details: {
                  version: validation.version,
                  normalizedVersion: validation.normalizedVersion,
                  changelogPath: validation.changelogPath,
                  headerFound: validation.headerFound,
                },
                fix: `Run \`cleo release plan v${validation.normalizedVersion}\` locally to write the section, then re-push.`,
                exitCode: 1,
              },
            },
            'query',
            'release',
            operation,
            startTime,
          );
        }

        default:
          return unsupportedOp('query', 'release', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ReleaseHandler query error');
      return handleErrorResult('query', 'release', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // mutate — state-modifying
  // -----------------------------------------------------------------------

  /**
   * Handle state-modifying release mutations.
   *
   * Supported operations:
   * - `plan`         — SPEC-T9345 §4.2 (T9525): build canonical Release Plan envelope
   * - `open`         — SPEC-T9345 §4.3 (T9530): dispatch release-prepare workflow
   * - `reconcile`    — SPEC-T9345 §4.4 (T9526 v2): backfill 11 provenance tables
   *
   * The legacy `start` / `publish` mutations (and the legacy v1
   * `reconcile`) were removed in T9540 — their backing functions in
   * `packages/core/src/release/pipeline.ts` were deleted as part of
   * Phase 6 of T9499.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // release.plan — SPEC-T9345 §4.2 (T9525): build canonical Release Plan envelope
        // T9838/T10088: --saga/--tasks and --no-changelog flags forwarded; epicId no longer
        // required at the dispatch layer — the core verb validates that
        // exactly one scope selector is set.
        case 'plan': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          const epicId = typeof params?.epicId === 'string' ? params.epicId : undefined;
          const sagaId = typeof params?.sagaId === 'string' ? params.sagaId : undefined;
          const taskIds = Array.isArray(params?.taskIds)
            ? params.taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
            : undefined;
          if (!version) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'version is required',
              startTime,
            );
          }
          if (!epicId && !sagaId && !taskIds?.length) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              '--saga, --epic, or --tasks is required',
              startTime,
            );
          }
          const typed: ReleasePlanOptions = {
            version,
            ...(epicId ? { epicId } : {}),
            ...(sagaId ? { sagaId } : {}),
            ...(taskIds?.length ? { taskIds } : {}),
            scheme:
              typeof params?.scheme === 'string'
                ? (params.scheme as ReleasePlanOptions['scheme'])
                : undefined,
            channel:
              typeof params?.channel === 'string'
                ? (params.channel as ReleasePlanOptions['channel'])
                : undefined,
            hotfix: typeof params?.hotfix === 'boolean' ? params.hotfix : false,
            hooksV1Promotion: params?.hooksV1Promotion === true,
            ...(typeof params?.hooksV1Waiver === 'string'
              ? { hooksV1Waiver: params.hooksV1Waiver }
              : {}),
            dryRun: typeof params?.dryRun === 'boolean' ? params.dryRun : false,
            writeChangelog:
              typeof params?.writeChangelog === 'boolean' ? params.writeChangelog : true,
            // T10079: release plan side effects are project-level. When invoked
            // from an XDG secondary worktree/subdir, route .changeset/,
            // CHANGELOG.md, and plan.json writes to the primary worktree.
            projectRoot: resolveWorktreeRouting().canonicalRoot,
          };
          return wrapResult(await releasePlan(typed), 'mutate', 'release', operation, startTime);
        }

        // release.open — SPEC-T9345 §4.3 (T9530): dispatch release-prepare workflow
        case 'open': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'version is required',
              startTime,
            );
          }
          const typed: ReleaseOpenOptions = {
            version,
            workflow: typeof params?.workflow === 'string' ? params.workflow : undefined,
            watch: typeof params?.watch === 'boolean' ? params.watch : false,
            commitPlan: typeof params?.commitPlan === 'boolean' ? params.commitPlan : false,
            // T12089: forward the plan scope. This mapping is explicit, so a
            // param the CLI accepts but this block omits is silently dropped —
            // `--tasks` reached the CLI, never reached `releaseOpen`, and the
            // dispatched workflow then had no scope to plan with. Adding an
            // option in core + the CLI is not enough; the dispatch layer is a
            // second chokepoint that must carry it too.
            epic: typeof params?.epic === 'string' ? params.epic : undefined,
            tasks: typeof params?.tasks === 'string' ? params.tasks : undefined,
            ref: typeof params?.ref === 'string' ? params.ref : undefined,
            projectRoot: getProjectRoot(),
          };
          return wrapResult(await releaseOpen(typed), 'mutate', 'release', operation, startTime);
        }

        // release.reconcile — v2 reconcile verb (T9526 / SPEC-T9345 §4.4)
        case 'reconcile': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'version is required',
              startTime,
            );
          const result = await releaseReconcileV2(version, {
            projectRoot: getProjectRoot(),
            fromWorkflow: typeof params?.fromWorkflow === 'boolean' ? params.fromWorkflow : false,
            rollback: typeof params?.rollback === 'boolean' ? params.rollback : false,
          });
          return wrapResult(result, 'mutate', 'release', operation, startTime);
        }

        // release.cut — T14102: tag the newest green default-branch commit
        // (release.yml then publishes); --dry-run reports without tagging.
        case 'cut': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT', // @sync-invariant none:input-shape a missing version is refused before any tag or file write
              'version is required',
              startTime,
            );
          const typed: ReleaseCutOptions = {
            version,
            projectRoot: getProjectRoot(),
            gitRoot: resolveInvokingCheckout(),
            ...(typeof params?.sha === 'string' ? { sha: params.sha } : {}),
            ...(typeof params?.lead === 'string' ? { leadFile: params.lead } : {}),
            dryRun: params?.dryRun === true,
            yes: params?.yes === true,
            allowInFlight: params?.allowInFlight === true,
          };
          return wrapResult(await releaseCut(typed), 'mutate', 'release', operation, startTime);
        }

        // release.write-changelog — T14102: write the CHANGELOG section from
        // the changesets since the previous tag (run by release.yml).
        case 'write-changelog': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          if (!version)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT', // @sync-invariant none:input-shape a missing version is refused before any tag or file write
              'version is required',
              startTime,
            );
          const result = await releaseChangelog({
            version,
            projectRoot: resolveInvokingCheckout(),
            ...(typeof params?.ref === 'string' ? { ref: params.ref } : {}),
          });
          return wrapResult(result, 'mutate', 'release', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'release', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ReleaseHandler mutate error');
      return handleErrorResult('mutate', 'release', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  /** Return declared operations for introspection and registry validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['validate-changelog', 'verify-tag'],
      mutate: ['reconcile', 'plan', 'open', 'cut', 'write-changelog'],
    };
  }
}
