/**
 * Lifecycle status for one epic, read from SQLite.
 *
 * A leaf module: `tasks.show` reports each epic's lifecycle status, so this
 * must not import the lifecycle index, whose stage guidance, ADR sync and
 * skill discovery load CAAMP and its YAML, TOML and frontmatter parsers.
 * `lifecycle/index.ts` re-exports {@link getLifecycleStatus}.
 *
 * @task T4801 - SQLite-native implementation
 * @task T1455 - normalized to (projectRoot, params) shape
 * @task T13126 - split out of lifecycle/index.ts
 */

import type { LifecycleStatusParams } from '@cleocode/contracts';
import * as schema from '../store/tasks-schema.js';
import { PIPELINE_STAGES, STAGE_PREREQUISITES, type Stage } from './stages.js';

/** One pipeline stage as {@link getLifecycleStatus} reports it. */
export interface LifecycleStageStatus {
  stage: string;
  status: string;
  completedAt?: string;
  notes?: string;
  outputFile?: string;
  provenanceChain?: Record<string, unknown>;
}

/** An epic's lifecycle status: stage progress, current and next stage, blockers. */
export interface LifecycleStatus {
  epicId: string;
  title?: string;
  currentStage: Stage | null;
  stages: LifecycleStageStatus[];
  nextStage: Stage | null;
  blockedOn: string[];
  initialized: boolean;
}

/** Recorded data for one stage, keyed by stage name. */
type StageData = Omit<LifecycleStageStatus, 'stage'>;

/** The first note of a stage's `notes_json` array, or `undefined`. */
function firstNote(notesJson: string | null): string | undefined {
  if (!notesJson) return undefined;
  const notes: unknown = JSON.parse(notesJson);
  if (!Array.isArray(notes)) return undefined;
  const first: unknown = notes[0];
  return typeof first === 'string' ? first : undefined;
}

/** A stage's parsed `provenance_chain_json` object, or `undefined`. */
function provenanceChain(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return undefined;
  }
}

/**
 * Get lifecycle status for an epic from SQLite.
 * Returns stage progress, current/next stage, and blockers.
 *
 * @param projectRoot - Project whose store to read.
 * @param params - The epic, as `epicId` or `taskId`.
 * @returns The epic's status; `initialized: false` with every stage
 *   `not_started` when the epic has no pipeline.
 * @task T4801 - SQLite-native implementation
 * @task T1455 - normalized to (projectRoot, params) shape
 */
export async function getLifecycleStatus(
  projectRoot: string,
  params: LifecycleStatusParams,
): Promise<LifecycleStatus> {
  const epicId = params.epicId ?? params.taskId ?? '';
  const { getDb } = await import('../store/sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getDb(projectRoot);

  // Query pipeline and task for this epic
  const pipelineResult = await db
    .select({
      pipeline: schema.lifecyclePipelines,
      task: schema.tasks,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(schema.tasks, eq(schema.lifecyclePipelines.taskId, schema.tasks.id))
    .where(eq(schema.lifecyclePipelines.taskId, epicId))
    .limit(1);

  // If no pipeline exists, return uninitialized status with default stages
  const first = pipelineResult[0];
  if (first === undefined) {
    return {
      epicId,
      currentStage: null,
      stages: PIPELINE_STAGES.map((s) => ({ stage: s, status: 'not_started' })),
      nextStage: 'research',
      blockedOn: [],
      initialized: false,
    };
  }

  const task = first.task;

  // Query all stages for this pipeline
  const pipelineId = `pipeline-${epicId}`;
  const stageRows = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId))
    .orderBy(schema.lifecycleStages.sequence);

  // Build a lookup map of stage data from DB
  const stageDataMap = new Map<string, StageData>();
  for (const row of stageRows) {
    stageDataMap.set(row.stageName, {
      status: row.status,
      completedAt: row.completedAt ?? undefined,
      notes: firstNote(row.notesJson),
      outputFile: row.outputFile ?? undefined,
      provenanceChain: provenanceChain(row.provenanceChainJson),
    });
  }

  // Build stages array in PIPELINE_STAGES order
  const stages = PIPELINE_STAGES.map((s) => {
    const data = stageDataMap.get(s);
    return {
      stage: s,
      status: data?.status || 'not_started',
      completedAt: data?.completedAt,
      notes: data?.notes,
      outputFile: data?.outputFile,
      provenanceChain: data?.provenanceChain,
    };
  });

  // Calculate currentStage and nextStage
  let currentStage: Stage | null = null;
  let nextStage: Stage | null = null;

  for (let i = PIPELINE_STAGES.length - 1; i >= 0; i--) {
    const s = PIPELINE_STAGES[i];
    if (s === undefined) continue;
    const data = stageDataMap.get(s);
    if (data?.status === 'completed' || data?.status === 'skipped') {
      currentStage = s;
      nextStage = PIPELINE_STAGES[i + 1] ?? null;
      break;
    }
  }

  if (!currentStage) {
    nextStage = 'research';
  }

  // Calculate blockedOn based on prerequisites
  const blockedOn: string[] = [];
  if (nextStage) {
    const prereqs = STAGE_PREREQUISITES[nextStage] || [];
    for (const prereq of prereqs) {
      const prereqData = stageDataMap.get(prereq);
      const prereqStatus = prereqData?.status;
      if (prereqStatus !== 'completed' && prereqStatus !== 'skipped') {
        blockedOn.push(prereq);
      }
    }
  }

  return {
    epicId,
    title: task.title,
    currentStage,
    stages,
    nextStage,
    blockedOn,
    initialized: true,
  };
}
