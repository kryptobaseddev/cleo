/**
 * saga.create — create a Saga as a first-class TaskType (type='saga') per ADR-083.
 *
 * Pure business logic. Returns an EngineResult; the dispatch layer
 * (`packages/cleo/src/dispatch/domains/tasks.ts`) wraps it in a LAFS
 * envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaCreate` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import type { TaskRecord } from '@cleocode/contracts';
import type { EngineResult } from '../engine-result.js';
import { addTaskWithSessionScope } from '../tasks/session-scope.js';

/** Input parameters for {@link sagaCreate}. */
export interface SagaCreateParams {
  /** Saga title (required). */
  title: string;
  /** Optional long-form description. */
  description?: string;
  /** Optional acceptance criteria. */
  acceptance?: string[];
  /** Validate and preview the Saga without writing task, relation, or doc rows. */
  dryRun?: boolean;
}

/** Result shape for {@link sagaCreate}. */
export interface SagaCreateResult {
  task: TaskRecord;
  duplicate: boolean;
  dryRun?: boolean;
  warnings?: string[];
  /** Number of Saga tasks that would be created by a successful dry-run. */
  wouldCreate?: number;
  /** Generic affected-entity count for dry-run projection. */
  wouldAffect?: number;
  /** Number of Saga specs validated during dry-run preflight. */
  validatedCount?: number;
  /** Number of rows durably inserted; always 0 for dry-run. */
  insertedCount?: number;
}

/**
 * Create a Saga — a top-level task with `type='saga'` per ADR-083 §2.5.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Saga creation parameters.
 * @returns EngineResult with the created task record and duplicate flag.
 */
export async function sagaCreate(
  projectRoot: string,
  params: SagaCreateParams,
): Promise<EngineResult<SagaCreateResult>> {
  const result = await addTaskWithSessionScope(projectRoot, {
    title: params.title,
    description: params.description,
    type: 'saga',
    acceptance: params.acceptance,
    dryRun: params.dryRun,
  });

  if (!result.success || !params.dryRun) {
    return result;
  }

  return {
    ...result,
    data: {
      ...result.data,
      dryRun: true,
      wouldCreate: result.data.duplicate ? 0 : 1,
      wouldAffect: result.data.duplicate ? 0 : 1,
      validatedCount: 1,
      insertedCount: 0,
    },
  };
}
