export * from "./types.js";
export * from "./errorRegistry.js";
export * from "./deprecationRegistry.js";
export * from "./validateEnvelope.js";
export * from "./envelope.js";
export * from "./flagSemantics.js";
export * from "./fieldExtraction.js";
export * from "./flagResolver.js";
export * from "./mviProjection.js";
export * from "./conformance.js";
export * from "./conformanceProfiles.js";
export * from "./compliance.js";
export * from "./tokenEstimator.js";
export * from "./budgetEnforcement.js";
export * from "./mcpAdapter.js";
export * from "./discovery.js";
export { lafsErrorToProblemDetails, PROBLEM_DETAILS_CONTENT_TYPE } from './problemDetails.js';
export type { LafsProblemDetails } from './problemDetails.js';

// Operations & Reliability
export * from "./health/index.js";
export * from "./shutdown/index.js";
export * from "./circuit-breaker/index.js";

// A2A Integration
// Explicitly re-export to avoid naming conflicts with discovery types
// (AgentCard, AgentSkill, AgentCapabilities, AgentExtension).
// For full A2A types, import from '@cleocode/lafs/a2a'.
export {
  // Bridge
  LafsA2AResult,
  createLafsArtifact,
  createTextArtifact,
  createFileArtifact,
  isExtensionRequired,
  getExtensionParams,
  AGENT_CARD_PATH,
  HTTP_EXTENSION_HEADER,

  // Extensions (T098)
  LAFS_EXTENSION_URI,
  A2A_EXTENSIONS_HEADER,
  parseExtensionsHeader,
  negotiateExtensions,
  formatExtensionsHeader,
  buildLafsExtension,
  ExtensionSupportRequiredError,
  extensionNegotiationMiddleware,

  // Task Lifecycle (T099)
  TERMINAL_STATES,
  INTERRUPTED_STATES,
  VALID_TRANSITIONS,
  isValidTransition,
  isTerminalState,
  isInterruptedState,
  InvalidStateTransitionError,
  TaskImmutabilityError,
  TaskNotFoundError,
  TaskRefinementError,
  TaskManager,
  attachLafsEnvelope,

  // Streaming and Async (T101)
  TaskEventBus,
  PushNotificationConfigStore,
  PushNotificationDispatcher,
  TaskArtifactAssembler,
  streamTaskEvents,
} from "./a2a/index.js";

export type {
  LafsA2AConfig,
  LafsSendMessageParams,
  LafsExtensionParams,
  ExtensionNegotiationResult,
  BuildLafsExtensionOptions,
  ExtensionNegotiationMiddlewareOptions,
  CreateTaskOptions,
  ListTasksOptions,
  ListTasksResult,
  TaskStreamEvent,
  StreamIteratorOptions,
  PushNotificationDeliveryResult,
  PushTransport,
} from "./a2a/index.js";

// A2A SDK types (non-conflicting subset)
export type {
  Task,
  TaskState,
  TaskStatus,
  Artifact,
  Part,
  Message,
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
} from "./a2a/index.js";
