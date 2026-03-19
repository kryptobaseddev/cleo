/**
 * Status Registry — re-exports from @cleocode/contracts.
 *
 * The canonical status definitions now live in @cleocode/contracts.
 * This file exists for backward compatibility within the store layer.
 */

export type {
  AdrStatus,
  EntityType,
  GateStatus,
  ManifestStatus,
  PipelineStatus,
  SessionStatus,
  StageStatus,
  TaskStatus,
} from '@cleocode/contracts';
export {
  ADR_STATUSES,
  GATE_STATUSES,
  isValidStatus,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  PIPELINE_STATUS_ICONS,
  SESSION_STATUSES,
  STAGE_STATUS_ICONS,
  STATUS_REGISTRY,
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  TASK_STATUSES,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_STAGE_STATUSES,
  TERMINAL_TASK_STATUSES,
} from '@cleocode/contracts';
