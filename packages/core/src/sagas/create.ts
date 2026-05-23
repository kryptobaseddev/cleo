/**
 * saga.create — create a labeled top-level Epic as a Saga.
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
import { SAGA_LABEL } from './constants.js';

/** Input parameters for {@link sagaCreate}. */
export interface SagaCreateParams {
  /** Saga title (required). */
  title: string;
  /** Optional long-form description. */
  description?: string;
  /** Optional acceptance criteria. */
  acceptance?: string[];
}

/**
 * Create a Saga — a top-level Epic with `label='saga'` per ADR-073 §1.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Saga creation parameters.
 * @returns EngineResult with the created task record and duplicate flag.
 */
export async function sagaCreate(
  projectRoot: string,
  params: SagaCreateParams,
): Promise<
  EngineResult<{ task: TaskRecord; duplicate: boolean; dryRun?: boolean; warnings?: string[] }>
> {
  return addTaskWithSessionScope(projectRoot, {
    title: params.title,
    description: params.description,
    labels: [SAGA_LABEL],
    type: 'epic',
    acceptance: params.acceptance,
  });
}
