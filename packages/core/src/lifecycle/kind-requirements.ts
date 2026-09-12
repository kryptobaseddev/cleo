/**
 * Predicates over the per-kind lifecycle requirements SSoT (gh#494).
 *
 * The TABLE lives in `@cleocode/contracts` as const data — it is a declaration
 * about the domain. The PREDICATES live here, because contracts is types-only
 * (architectural gate 10) and a bodied helper there is a boundary violation
 * regardless of how small it is.
 *
 * @task T12140 (gh#494)
 * @adr ADR-066
 */

import { KIND_LIFECYCLE_REQUIREMENTS, type TaskKind } from '@cleocode/contracts';

/**
 * Does an epic of this kind gate child completion on its pipeline stage?
 *
 * Unknown or absent kinds resolve to `work` — the conservative default. A
 * missing kind must never become the cheapest way to opt out of ceremony,
 * which is precisely the failure this replaces.
 *
 * @param kind - The epic's kind, if recorded.
 * @returns `true` when the staged pipeline gates child completion.
 *
 * @task T12140 (gh#494)
 */
export function requiresStagedPipeline(kind: TaskKind | null | undefined): boolean {
  if (!kind) return true;
  return KIND_LIFECYCLE_REQUIREMENTS[kind]?.requiresStagedPipeline ?? true;
}

/**
 * The rationale for a kind's staged-pipeline requirement, for error text.
 *
 * @param kind - The epic's kind, if recorded.
 * @returns Human-readable rationale.
 *
 * @task T12140 (gh#494)
 */
export function stagedPipelineRationale(kind: TaskKind | null | undefined): string {
  if (!kind) return KIND_LIFECYCLE_REQUIREMENTS.work.rationale;
  return KIND_LIFECYCLE_REQUIREMENTS[kind]?.rationale ?? KIND_LIFECYCLE_REQUIREMENTS.work.rationale;
}
