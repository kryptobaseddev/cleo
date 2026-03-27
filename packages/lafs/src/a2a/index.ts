/**
 * LAFS Agent-to-Agent (A2A) Integration v2.0
 *
 * Full integration with the official @a2a-js/sdk for Agent-to-Agent communication.
 * Implements A2A Protocol v1.0+ specification.
 *
 * Reference: specs/external/specification.md
 *
 * @example
 * ```typescript
 * import type { AgentCard, Task } from '@cleocode/lafs/a2a';
 * import {
 *   createLafsArtifact,
 *   createTextArtifact,
 *   LafsA2AResult,
 *   isExtensionRequired
 * } from '@cleocode/lafs/a2a';
 *
 * // Use A2A SDK directly for client operations
 * import { ClientFactory } from '@a2a-js/sdk/client';
 *
 * const factory = new ClientFactory();
 * const client = await factory.createFromUrl('https://agent.example.com');
 * const result = await client.sendMessage({...});
 *
 * // Wrap result with LAFS helpers
 * const lafsResult = new LafsA2AResult(result, {}, 'req-001');
 * const envelope = lafsResult.getLafsEnvelope();
 * ```
 */

// ============================================================================
// Core Exports
// ============================================================================

export {
  // Constants
  AGENT_CARD_PATH,
  createFileArtifact,
  // Artifact helpers
  createLafsArtifact,
  createTextArtifact,
  getExtensionParams,
  HTTP_EXTENSION_HEADER,
  // Extension helpers
  isExtensionRequired,
  // Result wrapper
  LafsA2AResult,
} from './bridge.js';

// ============================================================================
// Extensions (T098)
// ============================================================================

export type {
  BuildLafsExtensionOptions,
  ExtensionNegotiationMiddlewareOptions,
  ExtensionNegotiationResult,
  LafsExtensionParams,
} from './extensions.js';
export {
  A2A_EXTENSIONS_HEADER,
  buildLafsExtension,
  // Error class
  ExtensionSupportRequiredError,
  // Middleware
  extensionNegotiationMiddleware,
  formatExtensionsHeader,
  // Constants
  LAFS_EXTENSION_URI,
  negotiateExtensions,
  // Functions
  parseExtensionsHeader,
} from './extensions.js';

// ============================================================================
// Task Lifecycle (T099)
// ============================================================================

export {
  // LAFS integration
  attachLafsEnvelope,
  INTERRUPTED_STATES,
  // Error classes
  InvalidStateTransitionError,
  isInterruptedState,
  isTerminalState,
  // State functions
  isValidTransition,
  TaskImmutabilityError,
  // Task manager
  TaskManager,
  TaskNotFoundError,
  TaskRefinementError,
  // State constants
  TERMINAL_STATES,
  VALID_TRANSITIONS,
} from './task-lifecycle.js';

// ============================================================================
// Streaming and Async (T101)
// ============================================================================

export type {
  PushNotificationDeliveryResult,
  PushTransport,
  StreamIteratorOptions,
  TaskStreamEvent,
} from './streaming.js';
export {
  PushNotificationConfigStore,
  PushNotificationDispatcher,
  streamTaskEvents,
  TaskArtifactAssembler,
  TaskEventBus,
} from './streaming.js';

export type {
  CreateTaskOptions,
  ListTasksOptions,
  ListTasksResult,
} from './task-lifecycle.js';

// ============================================================================
// Protocol Bindings (T100)
// ============================================================================

export * from './bindings/index.js';

// ============================================================================
// Type Exports
// ============================================================================

// Re-export A2A SDK types for convenience
export type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentSkill,
  Artifact,
  DataPart,
  FilePart,
  JSONRPCErrorResponse,
  Message,
  MessageSendConfiguration,
  Part,
  PushNotificationConfig,
  SendMessageResponse,
  SendMessageSuccessResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
export type {
  // LAFS-specific types
  LafsA2AConfig,
  LafsSendMessageParams,
} from './bridge.js';
