/**
 * Release Domain Handler (Dispatch Layer)
 *
 * Handles `cleo release <operation>` dispatch operations:
 *
 * QUERY operations:
 *   gate           — check all IVTR loops in a release epic are `released`
 *   ivtr-suggest   — query whether all sibling tasks in an epic are
 *                    released and emit a `cleo release plan` + `cleo release open` suggestion
 *
 * MUTATE operations:
 *   gate           — same semantics as query.gate; safe in both gateways
 *   ivtr-suggest   — same semantics as query.ivtr-suggest; safe in both gateways
 *   plan           — SPEC-T9345 §4.2 (T9525): build canonical Release Plan envelope
 *   open           — SPEC-T9345 §4.3 (T9530): dispatch release-prepare workflow
 *   reconcile      — SPEC-T9345 §4.4 (T9526 v2): backfill 11 provenance tables
 *
 * Ship, list, show, cancel, changelog, rollback, channel are handled by the
 * pipeline domain handler (via `pipeline.release.*` operations).
 *
 * Type-safe dispatch via OpsFromCore<typeof coreOps> per ADR-058.
 * Param extraction inferred by coreOps — zero `params?.x as Type` casts.
 * Engine result fields (fix, exitCode, details) preserved via wrapResult.
 *
 * Historical note: the legacy 4-step pipeline operations (`start`,
 * `verify`, `publish`, and the legacy `reconcile`) were deleted in T9540
 * (Phase 6 of T9499) along with the backing functions in
 * `packages/core/src/release/pipeline.ts`. The plan/open/reconcile-v2
 * verbs above are the canonical replacement per SPEC-T9345 §4.
 *
 * @task T820 RELEASE-03
 * @task T820 RELEASE-07
 * @task T1416
 * @task T1543 — OpsFromCore migration per ADR-058
 * @task T1726 — Register release domain in OPERATIONS (SDK surface parity)
 * @task T9540 — remove legacy start/verify/publish handlers
 */

import type { ReleaseGateCheckParams } from '@cleocode/contracts/operations/release';
import type {
  ReleaseOpenOptions,
  ReleasePlanOptions,
  ValidateChangelogOptions,
} from '@cleocode/core/internal';
import { getLogger, getProjectRoot } from '@cleocode/core/internal';
import type { OpsFromCore } from '../adapters/typed.js';
import {
  releaseGateCheck,
  releaseIvtrAutoSuggest,
  releaseOpen,
  releasePlan,
  releaseReconcileV2,
  validateChangelog,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:release');

// ---------------------------------------------------------------------------
// Local param types — ops not yet in @cleocode/contracts
// ---------------------------------------------------------------------------

/** Params for `release.ivtr-suggest` operation. */
interface ReleaseIvtrSuggestParams {
  /** Task ID that just reached the `released` phase. */
  taskId: string;
}

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
//
// Engine functions use positional args (epicId, force, projectRoot). These
// thin wrappers normalise to single-object params so OpsFromCore can infer
// the full typed record (matching the pipeline.ts canonical pattern).
// Engine results include `fix`, `exitCode`, `details` — preserved by wrapResult.
// ---------------------------------------------------------------------------

/** @task T1543 */
async function releaseGateOp(params: ReleaseGateCheckParams) {
  return releaseGateCheck(params.epicId, params.force ?? false, getProjectRoot());
}

/** @task T1543 */
async function releaseIvtrSuggestOp(params: ReleaseIvtrSuggestParams) {
  return releaseIvtrAutoSuggest(params.taskId, getProjectRoot());
}

// ---------------------------------------------------------------------------
// Core op registry — OpsFromCore inference source
// ---------------------------------------------------------------------------

/**
 * Release operation registry for `OpsFromCore<typeof coreOps>` inference.
 *
 * @task T1543 — release dispatch OpsFromCore migration
 */
const coreOps = {
  gate: releaseGateOp,
  'ivtr-suggest': releaseIvtrSuggestOp,
} as const;

// ---------------------------------------------------------------------------
// Typed operation record (public — for testing and downstream inference)
// ---------------------------------------------------------------------------

/** Inferred typed operation record for the release domain (ADR-058 · T1543). */
export type ReleaseOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// ReleaseHandler
// ---------------------------------------------------------------------------

/**
 * Dispatch domain handler for IVTR-integration release operations.
 *
 * Registered under the `release` domain key in the domain handler registry.
 * Implements the two acceptance criteria gaps from T820 that were identified
 * by the 2026-04-24 Council audit (T1216):
 *
 * - **RELEASE-03** (`release.gate`): Pre-ship IVTR state validation.
 * - **RELEASE-07** (`release.ivtr-suggest`): Auto-suggestion when IVTR loop
 *   reaches `released`.
 *
 * Uses coreOps wrapper functions for type-safe param access (no `as string`
 * casts). Delegates to `wrapResult` to preserve engine error fields
 * (`fix`, `exitCode`, `details`) that typed envelope would otherwise strip.
 *
 * @task T1543 — OpsFromCore migration per ADR-058
 */
export class ReleaseHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // query — read-only
  // -----------------------------------------------------------------------

  /**
   * Handle read-only release queries.
   *
   * Supported operations:
   * - `gate`         — check IVTR phase state for all tasks in a release epic
   * - `ivtr-suggest` — check if all epic tasks are released and suggest `cleo release plan` + `cleo release open`
   *
   * The legacy `verify` query (run gates + audit child tasks) was removed
   * in T9540 — use `cleo verify <task> --gate X --evidence …` per
   * SPEC-T9345 §12 R-422 / ADR-051.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // release.gate — IVTR gate check (RELEASE-03)
        case 'gate': {
          const epicId = typeof params?.epicId === 'string' ? params.epicId : undefined;
          if (!epicId)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const force = typeof params?.force === 'boolean' ? params.force : false;
          const typed: ReleaseGateCheckParams = { epicId, force };
          return wrapResult(await coreOps.gate(typed), 'query', 'release', operation, startTime);
        }

        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07)
        case 'ivtr-suggest': {
          const taskId = typeof params?.taskId === 'string' ? params.taskId : undefined;
          if (!taskId)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const typed: ReleaseIvtrSuggestParams = { taskId };
          return wrapResult(
            await coreOps['ivtr-suggest'](typed),
            'query',
            'release',
            operation,
            startTime,
          );
        }

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
   * Note: `release.gate` and `release.ivtr-suggest` do not write any state.
   * They are exposed in the `mutate` gateway to allow automated pipelines
   * (e.g. playbook action blocks) to call them without changing gateway.
   *
   * Supported operations:
   * - `gate`         — same IVTR gate check as query.gate (no DB writes)
   * - `ivtr-suggest` — same auto-suggest as query.ivtr-suggest (no DB writes)
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
        // release.gate — IVTR gate check (RELEASE-03, no DB writes)
        case 'gate': {
          const epicId = typeof params?.epicId === 'string' ? params.epicId : undefined;
          if (!epicId)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const force = typeof params?.force === 'boolean' ? params.force : false;
          const typed: ReleaseGateCheckParams = { epicId, force };
          return wrapResult(await coreOps.gate(typed), 'mutate', 'release', operation, startTime);
        }

        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07, no DB writes)
        case 'ivtr-suggest': {
          const taskId = typeof params?.taskId === 'string' ? params.taskId : undefined;
          if (!taskId)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const typed: ReleaseIvtrSuggestParams = { taskId };
          return wrapResult(
            await coreOps['ivtr-suggest'](typed),
            'mutate',
            'release',
            operation,
            startTime,
          );
        }

        // release.plan — SPEC-T9345 §4.2 (T9525): build canonical Release Plan envelope
        // T9838: --saga and --no-changelog flags forwarded; epicId no longer
        // required at the dispatch layer — the core verb validates that
        // (epicId XOR sagaId) is set.
        case 'plan': {
          const version = typeof params?.version === 'string' ? params.version : undefined;
          const epicId = typeof params?.epicId === 'string' ? params.epicId : undefined;
          const sagaId = typeof params?.sagaId === 'string' ? params.sagaId : undefined;
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
          if (!epicId && !sagaId) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              '--saga or --epic is required',
              startTime,
            );
          }
          const typed: ReleasePlanOptions = {
            version,
            ...(epicId ? { epicId } : {}),
            ...(sagaId ? { sagaId } : {}),
            scheme:
              typeof params?.scheme === 'string'
                ? (params.scheme as ReleasePlanOptions['scheme'])
                : undefined,
            channel:
              typeof params?.channel === 'string'
                ? (params.channel as ReleasePlanOptions['channel'])
                : undefined,
            hotfix: typeof params?.hotfix === 'boolean' ? params.hotfix : false,
            dryRun: typeof params?.dryRun === 'boolean' ? params.dryRun : false,
            writeChangelog:
              typeof params?.writeChangelog === 'boolean' ? params.writeChangelog : true,
            projectRoot: getProjectRoot(),
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
      query: ['gate', 'ivtr-suggest', 'validate-changelog'],
      mutate: ['gate', 'ivtr-suggest', 'reconcile', 'plan', 'open'],
    };
  }
}
