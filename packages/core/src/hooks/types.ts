/**
 * Universal Hooks Core Types - Phase 2B of T5237
 *
 * This module defines the core type system for CLEO's Universal Hooks
 * integration with CAAMP 1.6.0. CLEO builds the hook registry and
 * execution system while CAAMP provides the event definitions.
 *
 * @module @cleocode/cleo/hooks/types
 */

import type { HookEvent as CAAMPHookEvent } from '@cleocode/caamp';

// Re-export CAAMP provider query functions for hook capability discovery
export { getCommonHookEvents, getProvidersByHookEvent } from '@cleocode/caamp';

/**
 * CAAMP-defined hook events supported by provider capability discovery.
 */
export type ProviderHookEvent = CAAMPHookEvent;

/**
 * CLEO-local coordination events used by the autonomous runtime.
 *
 * These are internal lifecycle signals for worker orchestration and are not
 * surfaced through CAAMP's provider capability registry.
 */
export const INTERNAL_HOOK_EVENTS = [
  'onWorkAvailable',
  'onAgentSpawn',
  'onAgentComplete',
  'onCascadeStart',
  'onPatrol',
] as const;

export type InternalHookEvent = (typeof INTERNAL_HOOK_EVENTS)[number];

/**
 * Full CLEO hook event union.
 *
 * CAAMP defines provider-facing events; CLEO extends the registry with local
 * coordination events for autonomous execution.
 */
export type HookEvent = ProviderHookEvent | InternalHookEvent;

const INTERNAL_HOOK_EVENT_SET = new Set<string>(INTERNAL_HOOK_EVENTS);

/**
 * Type guard for CAAMP/provider-discoverable hook events.
 */
export function isProviderHookEvent(event: HookEvent): event is ProviderHookEvent {
  return !INTERNAL_HOOK_EVENT_SET.has(event);
}

/**
 * Type guard for CLEO-local coordination hook events.
 */
export function isInternalHookEvent(event: HookEvent): event is InternalHookEvent {
  return INTERNAL_HOOK_EVENT_SET.has(event);
}

/**
 * Base interface for all hook payloads
 * Provides common fields available across all hook events
 */
export interface HookPayload {
  /** ISO 8601 timestamp when the hook fired */
  timestamp: string;

  /** Optional session ID if firing within a session context */
  sessionId?: string;

  /** Optional task ID if firing within a task context */
  taskId?: string;

  /** Optional provider ID that triggered the hook */
  providerId?: string;

  /** Optional metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/**
 * Payload for onSessionStart hook
 * Fired when a CLEO session begins
 */
export interface OnSessionStartPayload extends HookPayload {
  /** Session identifier (required for session events) */
  sessionId: string;

  /** Human-readable session name */
  name: string;

  /** Session scope/area of work */
  scope: string;

  /** Optional agent identifier */
  agent?: string;
}

/**
 * Payload for onSessionEnd hook
 * Fired when a CLEO session ends
 */
export interface OnSessionEndPayload extends HookPayload {
  /** Session identifier */
  sessionId: string;

  /** Session duration in seconds */
  duration: number;

  /** Array of task IDs completed during this session */
  tasksCompleted: string[];
}

/**
 * Payload for onToolStart hook
 * Fired when a task/tool operation begins
 */
export interface OnToolStartPayload extends HookPayload {
  /** Task identifier */
  taskId: string;

  /** Human-readable task title */
  taskTitle: string;

  /** Optional ID of the previous task if sequential */
  previousTask?: string;
}

/**
 * Payload for onToolComplete hook
 * Fired when a task/tool operation completes
 */
export interface OnToolCompletePayload extends HookPayload {
  /** Task identifier */
  taskId: string;

  /** Human-readable task title */
  taskTitle: string;

  /** Final status of the completed task */
  status: 'done' | 'archived' | 'cancelled';
}

/**
 * Handler function type for hook events
 * Handlers receive project root and typed payload
 */
export type HookHandler<T extends HookPayload = HookPayload> = (
  projectRoot: string,
  payload: T,
) => Promise<void> | void;

/**
 * Hook registration metadata
 * Tracks registered handlers with priority and event binding
 */
export interface HookRegistration<T extends HookPayload = HookPayload> {
  /** Unique identifier for this registration */
  id: string;

  /** CAAMP hook event this handler listens for */
  event: HookEvent;

  /** Handler function to execute when event fires */
  handler: HookHandler<T>;

  /** Priority for execution order (higher = earlier) */
  priority: number;
}

/**
 * Configuration for the hook system
 * Controls which events are enabled/disabled
 */
export interface HookConfig {
  /** Master switch for hook system */
  enabled: boolean;

  /** Per-event enable/disable configuration */
  events: Record<HookEvent, boolean>;
}

/**
 * Payload for onFileChange hook
 * Fired when a tracked file is written, created, or deleted
 */
export interface OnFileChangePayload extends HookPayload {
  /** Absolute or project-relative path of the changed file */
  filePath: string;

  /** Kind of filesystem change */
  changeType: 'write' | 'create' | 'delete';

  /** File size in bytes after the change (absent for deletes) */
  sizeBytes?: number;
}

/**
 * Payload for onError hook
 * Fired when an operation fails with a structured error
 */
export interface OnErrorPayload extends HookPayload {
  /** Numeric exit code or string error code */
  errorCode: number | string;

  /** Human-readable error message */
  message: string;

  /** Domain where the error occurred */
  domain?: string;

  /** Operation that failed */
  operation?: string;

  /** Gateway (query / mutate) that received the error */
  gateway?: string;

  /** Optional stack trace */
  stack?: string;
}

/**
 * Payload for onPromptSubmit hook
 * Fired when an agent submits a prompt through a gateway
 */
export interface OnPromptSubmitPayload extends HookPayload {
  /** Gateway that received the prompt (query / mutate) */
  gateway: string;

  /** Target domain */
  domain: string;

  /** Target operation */
  operation: string;

  /** Optional source identifier (e.g. agent name) */
  source?: string;
}

/**
 * Payload for onResponseComplete hook
 * Fired when a gateway operation finishes (success or failure)
 */
export interface OnResponseCompletePayload extends HookPayload {
  /** Gateway that handled the operation */
  gateway: string;

  /** Target domain */
  domain: string;

  /** Target operation */
  operation: string;

  /** Whether the operation succeeded */
  success: boolean;

  /** Wall-clock duration in milliseconds */
  durationMs?: number;

  /** Error code if the operation failed */
  errorCode?: string;
}

/**
 * Payload for onWorkAvailable hook
 * Fired when the system detects ready work on a Loom/Tapestry
 */
export interface OnWorkAvailablePayload extends HookPayload {
  /** IDs of tasks now ready for execution */
  taskIds: string[];

  /** Optional epic / Loom identifier */
  epicId?: string;

  /** Optional chain or tessera instance identifier */
  chainId?: string;

  /** Why the work became available */
  reason?: 'dependency-cleared' | 'new-task' | 'retry' | 'manual' | 'patrol';
}

/**
 * Payload for onAgentSpawn hook
 * Fired when a worker session/process is launched
 */
export interface OnAgentSpawnPayload extends HookPayload {
  /** Worker or session identifier */
  agentId: string;

  /** Worker role / archetype name */
  role: string;

  /** Provider or adapter used to launch the worker */
  adapterId?: string;

  /** Optional task assignment at spawn time */
  taskId?: string;
}

/**
 * Payload for onAgentComplete hook
 * Fired when a worker finishes its assigned run
 */
export interface OnAgentCompletePayload extends HookPayload {
  /** Worker or session identifier */
  agentId: string;

  /** Worker role / archetype name */
  role: string;

  /** Completion status for the run */
  status: 'complete' | 'partial' | 'blocked' | 'failed';

  /** Optional task assignment that was completed */
  taskId?: string;

  /** Optional summary or manifest reference */
  summary?: string;
}

/**
 * Payload for onCascadeStart hook
 * Fired when autonomous execution begins flowing through a chain or wave
 */
export interface OnCascadeStartPayload extends HookPayload {
  /** Identifier for the cascade / execution wave */
  cascadeId: string;

  /** Optional chain identifier */
  chainId?: string;

  /** Optional tessera template / instance identifier */
  tesseraId?: string;

  /** Task IDs participating in the cascade */
  taskIds?: string[];
}

/**
 * Payload for onPatrol hook
 * Fired when a watcher performs a periodic health/sweep cycle
 */
export interface OnPatrolPayload extends HookPayload {
  /** Watcher / patrol identifier */
  watcherId: string;

  /** Patrol category */
  patrolType: 'health' | 'sweep' | 'refinery' | 'watcher' | 'custom';

  /** Optional scope being patrolled */
  scope?: string;
}

/**
 * Mapping from CLEO internal lifecycle events to CAAMP hook events
 * This is where CLEO connects its lifecycle to CAAMP's event definitions
 */
export const CLEO_TO_CAAMP_HOOK_MAP = {
  'session.start': 'onSessionStart',
  'session.end': 'onSessionEnd',
  'task.start': 'onToolStart',
  'task.complete': 'onToolComplete',
  'file.change': 'onFileChange',
  'system.error': 'onError',
  'prompt.submit': 'onPromptSubmit',
  'response.complete': 'onResponseComplete',
} as const;

/**
 * Internal CLEO lifecycle events that drive autonomous coordination.
 */
export const CLEO_INTERNAL_HOOK_MAP = {
  'agent.work.available': 'onWorkAvailable',
  'agent.spawn': 'onAgentSpawn',
  'agent.complete': 'onAgentComplete',
  'cascade.start': 'onCascadeStart',
  'watcher.patrol': 'onPatrol',
} as const;

/**
 * Type for CLEO lifecycle event names
 * These are the internal events CLEO fires that get mapped to CAAMP events
 */
export type CLEOLifecycleEvent = keyof typeof CLEO_TO_CAAMP_HOOK_MAP;

/**
 * Type for autonomous CLEO lifecycle events.
 */
export type CLEOAutonomousLifecycleEvent = keyof typeof CLEO_INTERNAL_HOOK_MAP;
