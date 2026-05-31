/**
 * LAFS (LLM-Agent-First Specification) TypeScript SDK.
 *
 * @packageDocumentation
 *
 * @remarks
 * This is the main entry point for the `@cleocode/lafs` package. It re-exports all
 * public modules including envelope creation, validation, conformance checking,
 * error registry, flag resolution, MVI projection, and operational primitives
 * (health, shutdown, circuit breaker).
 *
 * A2A integration is available as a product-only subpath: `@cleocode/lafs/a2a`.
 * It requires `@a2a-js/sdk` (optional peer dependency) and is NOT part of the
 * CLEO-core runtime closure. Import directly when needed:
 * ```ts
 * import { TaskManager } from '@cleocode/lafs/a2a';
 * ```
 */

// A2A type-only re-exports from main index (T11425: types are compile-erased;
// runtime values moved to product-only subpath '@cleocode/lafs/a2a').
// For runtime A2A symbols, import from '@cleocode/lafs/a2a'.
export type {
  Artifact,
  BuildLafsExtensionOptions,
  CreateTaskOptions,
  DataPart,
  ExtensionNegotiationMiddlewareOptions,
  ExtensionNegotiationResult,
  FilePart,
  JSONRPCErrorResponse,
  LafsA2AConfig,
  LafsExtensionParams,
  LafsSendMessageParams,
  ListTasksOptions,
  ListTasksResult,
  Message,
  MessageSendConfiguration,
  Part,
  PushNotificationConfig,
  PushNotificationDeliveryResult,
  PushTransport,
  SendMessageResponse,
  SendMessageSuccessResponse,
  StreamIteratorOptions,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskStreamEvent,
  TextPart,
} from './a2a/index.js';
export * from './budgetEnforcement.js';
export * from './circuit-breaker/index.js';
export * from './compliance.js';
export * from './conformance.js';
export * from './conformanceProfiles.js';
export * from './deprecationRegistry.js';
export * from './discovery.js';
export * from './envelope.js';
export * from './errorRegistry.js';
export * from './fieldExtraction.js';
export * from './flagResolver.js';
export * from './flagSemantics.js';
// Operations & Reliability
export * from './health/index.js';
export * from './mviProjection.js';
export { isNativeAvailable } from './native-loader.js';
export type { LafsProblemDetails } from './problemDetails.js';
export { lafsErrorToProblemDetails, PROBLEM_DETAILS_CONTENT_TYPE } from './problemDetails.js';
export * from './shutdown/index.js';
export * from './tokenEstimator.js';
export * from './types.js';
export * from './validateEnvelope.js';
