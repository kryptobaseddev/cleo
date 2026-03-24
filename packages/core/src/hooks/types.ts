/**
 * Universal Hooks Core Types - Phase 2B of T5237
 *
 * This module defines the core type system for CLEO's Universal Hooks
 * integration with CAAMP 1.9.1. CLEO builds the hook registry and
 * execution system while CAAMP provides the canonical event definitions.
 *
 * @module @cleocode/cleo/hooks/types
 */

import type { CanonicalHookEvent } from '@cleocode/caamp';
import {
  buildHookMatrix,
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
  supportsHook,
  toCanonical,
  toNative,
} from '@cleocode/caamp';

// Re-export CAAMP provider query functions for hook capability discovery
export { getCommonHookEvents, getProvidersByHookEvent } from '@cleocode/caamp';
export type { CanonicalHookEvent };
// Re-export CAAMP canonical event constants and normalizer APIs
export {
  buildHookMatrix,
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
  supportsHook,
  toCanonical,
  toNative,
};

/**
 * CAAMP canonical hook event type.
 *
 * This is the normalized 16-event taxonomy from CAAMP 1.9.1.
 */
export type ProviderHookEvent = CanonicalHookEvent;

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
 * CAAMP defines provider-facing canonical events; CLEO extends the registry
 * with local coordination events for autonomous execution.
 */
export type HookEvent = ProviderHookEvent | InternalHookEvent;

const INTERNAL_HOOK_EVENT_SET = new Set<string>(INTERNAL_HOOK_EVENTS);

/**
 * Type guard for CAAMP/provider-discoverable canonical hook events.
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
 * Payload for SessionStart hook (canonical: was onSessionStart)
 * Fired when a CLEO session begins
 */
export interface SessionStartPayload extends HookPayload {
  /** Session identifier (required for session events) */
  sessionId: string;

  /** Human-readable session name */
  name: string;

  /** Session scope/area of work */
  scope: string;

  /** Optional agent identifier */
  agent?: string;
}

/** @deprecated Use {@link SessionStartPayload} instead. Kept for backward compatibility. */
export type OnSessionStartPayload = SessionStartPayload;

/**
 * Payload for SessionEnd hook (canonical: was onSessionEnd)
 * Fired when a CLEO session ends
 */
export interface SessionEndPayload extends HookPayload {
  /** Session identifier */
  sessionId: string;

  /** Session duration in seconds */
  duration: number;

  /** Array of task IDs completed during this session */
  tasksCompleted: string[];
}

/** @deprecated Use {@link SessionEndPayload} instead. Kept for backward compatibility. */
export type OnSessionEndPayload = SessionEndPayload;

/**
 * Payload for PreToolUse hook (canonical: was onToolStart)
 * Fired when a task/tool operation begins
 */
export interface PreToolUsePayload extends HookPayload {
  /** Task identifier */
  taskId: string;

  /** Human-readable task title */
  taskTitle: string;

  /** Optional ID of the previous task if sequential */
  previousTask?: string;

  /** Optional tool name being invoked */
  toolName?: string;

  /** Optional structured input to the tool */
  toolInput?: Record<string, unknown>;
}

/** @deprecated Use {@link PreToolUsePayload} instead. Kept for backward compatibility. */
export type OnToolStartPayload = PreToolUsePayload;

/**
 * Payload for PostToolUse hook (canonical: was onToolComplete)
 * Fired when a task/tool operation completes
 */
export interface PostToolUsePayload extends HookPayload {
  /** Task identifier */
  taskId: string;

  /** Human-readable task title */
  taskTitle: string;

  /** Final status of the completed task */
  status: 'done' | 'archived' | 'cancelled';

  /** Optional structured result from the tool */
  toolResult?: Record<string, unknown>;
}

/** @deprecated Use {@link PostToolUsePayload} instead. Kept for backward compatibility. */
export type OnToolCompletePayload = PostToolUsePayload;

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
 * Payload for Notification hook (canonical: was onFileChange)
 * Fired when a tracked file is written, created, or deleted, or for
 * general-purpose notifications.
 */
export interface NotificationPayload extends HookPayload {
  /** Absolute or project-relative path of the changed file */
  filePath?: string;

  /** Kind of filesystem change (for file-change notifications) */
  changeType?: 'write' | 'create' | 'delete';

  /** File size in bytes after the change (absent for deletes) */
  sizeBytes?: number;

  /** Optional notification message for non-file notifications */
  message?: string;
}

/** @deprecated Use {@link NotificationPayload} instead. Kept for backward compatibility. */
export type OnFileChangePayload = NotificationPayload & {
  filePath: string;
  changeType: 'write' | 'create' | 'delete';
};

/**
 * Payload for PostToolUseFailure hook (canonical: was onError)
 * Fired when an operation fails with a structured error
 */
export interface PostToolUseFailurePayload extends HookPayload {
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

/** @deprecated Use {@link PostToolUseFailurePayload} instead. Kept for backward compatibility. */
export type OnErrorPayload = PostToolUseFailurePayload;

/**
 * Payload for PromptSubmit hook (canonical: was onPromptSubmit)
 * Fired when an agent submits a prompt through a gateway
 */
export interface PromptSubmitPayload extends HookPayload {
  /** Gateway that received the prompt (query / mutate) */
  gateway: string;

  /** Target domain */
  domain: string;

  /** Target operation */
  operation: string;

  /** Optional source identifier (e.g. agent name) */
  source?: string;
}

/** @deprecated Use {@link PromptSubmitPayload} instead. Kept for backward compatibility. */
export type OnPromptSubmitPayload = PromptSubmitPayload;

/**
 * Payload for ResponseComplete hook (canonical: was onResponseComplete)
 * Fired when a gateway operation finishes (success or failure)
 */
export interface ResponseCompletePayload extends HookPayload {
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

/** @deprecated Use {@link ResponseCompletePayload} instead. Kept for backward compatibility. */
export type OnResponseCompletePayload = ResponseCompletePayload;

/**
 * Payload for SubagentStart hook
 * Fired when a subagent process is launched
 */
export interface SubagentStartPayload extends HookPayload {
  /** Subagent or worker identifier */
  agentId: string;

  /** Subagent role or archetype */
  role?: string;

  /** Task assigned to the subagent */
  taskId?: string;
}

/**
 * Payload for SubagentStop hook
 * Fired when a subagent process completes
 */
export interface SubagentStopPayload extends HookPayload {
  /** Subagent or worker identifier */
  agentId: string;

  /** Completion status */
  status?: 'complete' | 'partial' | 'blocked' | 'failed';

  /** Task that was completed */
  taskId?: string;

  /** Optional summary reference */
  summary?: string;
}

/**
 * Payload for PreCompact hook
 * Fired before context compaction begins
 */
export interface PreCompactPayload extends HookPayload {
  /** Estimated token count before compaction */
  tokensBefore?: number;

  /** Reason for compaction */
  reason?: string;
}

/**
 * Payload for PostCompact hook
 * Fired after context compaction completes
 */
export interface PostCompactPayload extends HookPayload {
  /** Token count before compaction */
  tokensBefore?: number;

  /** Token count after compaction */
  tokensAfter?: number;

  /** Whether compaction succeeded */
  success: boolean;
}

/**
 * Payload for ConfigChange hook
 * Fired when configuration is updated
 */
export interface ConfigChangePayload extends HookPayload {
  /** Configuration key that changed */
  key: string;

  /** Previous value */
  previousValue?: unknown;

  /** New value */
  newValue?: unknown;
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
 * Mapping from CLEO internal lifecycle events to CAAMP canonical hook event names.
 *
 * Updated for CAAMP 1.9.1 canonical taxonomy.
 */
export const CLEO_TO_CAAMP_HOOK_MAP = {
  'session.start': 'SessionStart',
  'session.end': 'SessionEnd',
  'task.start': 'PreToolUse',
  'task.complete': 'PostToolUse',
  'file.change': 'Notification',
  'system.error': 'PostToolUseFailure',
  'prompt.submit': 'PromptSubmit',
  'response.complete': 'ResponseComplete',
} as const satisfies Record<string, CanonicalHookEvent>;

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
