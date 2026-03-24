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
  // Result wrapper
  LafsA2AResult,

  // Artifact helpers
  createLafsArtifact,
  createTextArtifact,
  createFileArtifact,

  // Extension helpers
  isExtensionRequired,
  getExtensionParams,

  // Constants
  AGENT_CARD_PATH,
  HTTP_EXTENSION_HEADER,
} from './bridge.js';

// ============================================================================
// Extensions (T098)
// ============================================================================

export {
  // Constants
  LAFS_EXTENSION_URI,
  A2A_EXTENSIONS_HEADER,

  // Functions
  parseExtensionsHeader,
  negotiateExtensions,
  formatExtensionsHeader,
  buildLafsExtension,

  // Error class
  ExtensionSupportRequiredError,

  // Middleware
  extensionNegotiationMiddleware,
} from './extensions.js';

export type {
  LafsExtensionParams,
  ExtensionNegotiationResult,
  BuildLafsExtensionOptions,
  ExtensionNegotiationMiddlewareOptions,
} from './extensions.js';

// ============================================================================
// Task Lifecycle (T099)
// ============================================================================

export {
  // State constants
  TERMINAL_STATES,
  INTERRUPTED_STATES,
  VALID_TRANSITIONS,

  // State functions
  isValidTransition,
  isTerminalState,
  isInterruptedState,

  // Error classes
  InvalidStateTransitionError,
  TaskImmutabilityError,
  TaskNotFoundError,
  TaskRefinementError,

  // Task manager
  TaskManager,

  // LAFS integration
  attachLafsEnvelope,
} from './task-lifecycle.js';

// ============================================================================
// Streaming and Async (T101)
// ============================================================================

export {
  TaskEventBus,
  PushNotificationConfigStore,
  PushNotificationDispatcher,
  TaskArtifactAssembler,
  streamTaskEvents,
} from './streaming.js';

export type {
  TaskStreamEvent,
  StreamIteratorOptions,
  PushNotificationDeliveryResult,
  PushTransport,
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

export type {
  // LAFS-specific types
  LafsA2AConfig,
  LafsSendMessageParams,
} from './bridge.js';

// Re-export A2A SDK types for convenience
export type {
  Task,
  TaskState,
  TaskStatus,
  Artifact,
  Part,
  Message,
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  AgentExtension,
  PushNotificationConfig,
  MessageSendConfiguration,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  SendMessageResponse,
  SendMessageSuccessResponse,
  JSONRPCErrorResponse,
  TextPart,
  DataPart,
  FilePart,
} from '@a2a-js/sdk';
