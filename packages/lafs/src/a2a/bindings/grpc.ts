/**
 * A2A gRPC Protocol Binding
 *
 * Status codes, error reasons, service method definitions, and metadata
 * constants for gRPC transport. Types and helpers only — no @grpc/grpc-js
 * runtime dependency.
 *
 * Reference: A2A spec Section 10.3-10.6
 */

import type { A2AErrorType } from './jsonrpc.js';

// ============================================================================
// gRPC Status Codes (standard)
// ============================================================================

/**
 * Standard gRPC status codes (numeric values 0-16).
 *
 * @remarks
 * Canonical gRPC status codes as defined in the gRPC specification.
 * Used to map A2A errors to appropriate gRPC status values.
 */
export const GRPC_STATUS_CODE = {
  /** Not an error; returned on success */
  OK: 0,
  /** The operation was cancelled by the caller */
  CANCELLED: 1,
  /** Unknown error */
  UNKNOWN: 2,
  /** Client specified an invalid argument */
  INVALID_ARGUMENT: 3,
  /** Deadline expired before operation could complete */
  DEADLINE_EXCEEDED: 4,
  /** Requested entity was not found */
  NOT_FOUND: 5,
  /** Entity already exists */
  ALREADY_EXISTS: 6,
  /** Caller does not have permission */
  PERMISSION_DENIED: 7,
  /** Resource has been exhausted (e.g. quota) */
  RESOURCE_EXHAUSTED: 8,
  /** Operation rejected because the system is not in a required state */
  FAILED_PRECONDITION: 9,
  /** The operation was aborted (e.g. concurrency conflict) */
  ABORTED: 10,
  /** Operation was attempted past the valid range */
  OUT_OF_RANGE: 11,
  /** Operation is not implemented or not supported */
  UNIMPLEMENTED: 12,
  /** Internal error */
  INTERNAL: 13,
  /** The service is currently unavailable */
  UNAVAILABLE: 14,
  /** Unrecoverable data loss or corruption */
  DATA_LOSS: 15,
  /** The request does not have valid authentication credentials */
  UNAUTHENTICATED: 16,
} as const;

/** Numeric gRPC status code value (0-16) */
export type GrpcStatusCode = (typeof GRPC_STATUS_CODE)[keyof typeof GRPC_STATUS_CODE];
/** String name of a gRPC status code (e.g. `"OK"`, `"NOT_FOUND"`) */
export type GrpcStatusName = keyof typeof GRPC_STATUS_CODE;

// ============================================================================
// A2A gRPC Status Mapping (spec Section 5.4)
// ============================================================================

/**
 * Maps A2A error types to gRPC status names.
 *
 * @remarks
 * Used to determine the appropriate gRPC status code for each A2A error
 * type per spec Section 5.4.
 */
export const A2A_GRPC_STATUS_CODES: Record<A2AErrorType, GrpcStatusName> = {
  TaskNotFound: 'NOT_FOUND',
  TaskNotCancelable: 'FAILED_PRECONDITION',
  PushNotificationNotSupported: 'UNIMPLEMENTED',
  UnsupportedOperation: 'UNIMPLEMENTED',
  ContentTypeNotSupported: 'INVALID_ARGUMENT',
  InvalidAgentResponse: 'INTERNAL',
  AuthenticatedExtendedCardNotConfigured: 'NOT_FOUND',
  ExtensionSupportRequired: 'FAILED_PRECONDITION',
  VersionNotSupported: 'FAILED_PRECONDITION',
} as const;

// ============================================================================
// Error Reasons (spec Section 10.6)
// ============================================================================

/**
 * UPPER_SNAKE_CASE error reasons without "Error" suffix.
 *
 * @remarks
 * Used as the `reason` field in gRPC `google.rpc.ErrorInfo` details
 * per spec Section 10.6.
 */
export const A2A_GRPC_ERROR_REASONS: Record<A2AErrorType, string> = {
  TaskNotFound: 'TASK_NOT_FOUND',
  TaskNotCancelable: 'TASK_NOT_CANCELABLE',
  PushNotificationNotSupported: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  UnsupportedOperation: 'UNSUPPORTED_OPERATION',
  ContentTypeNotSupported: 'CONTENT_TYPE_NOT_SUPPORTED',
  InvalidAgentResponse: 'INVALID_AGENT_RESPONSE',
  AuthenticatedExtendedCardNotConfigured: 'AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED',
  ExtensionSupportRequired: 'EXTENSION_SUPPORT_REQUIRED',
  VersionNotSupported: 'VERSION_NOT_SUPPORTED',
} as const;

/**
 * Error domain for A2A gRPC errors.
 *
 * @remarks
 * Used as the `domain` field in `google.rpc.ErrorInfo` to identify
 * the error source as the A2A protocol.
 */
export const A2A_GRPC_ERROR_DOMAIN = 'a2a-protocol.org' as const;

// ============================================================================
// Service Method Definitions (spec Section 10.3)
// ============================================================================

/**
 * Descriptor for a single gRPC service method.
 *
 * @remarks
 * Describes the Protobuf request/response message types and whether
 * the method uses server-side streaming.
 */
export interface GrpcServiceMethod {
  /** Protobuf request message type name */
  request: string;
  /** Protobuf response message type name */
  response: string;
  /** Whether the method uses server-side streaming */
  streaming: boolean;
}

/**
 * gRPC service method definitions for the A2A protocol.
 *
 * @remarks
 * Enumerates all RPC methods in the A2A gRPC service with their Protobuf
 * message types and streaming mode per spec Section 10.3.
 */
export const GRPC_SERVICE_METHODS: Record<string, GrpcServiceMethod> = {
  SendMessage: {
    request: 'MessageSendParams',
    response: 'SendMessageResponse',
    streaming: false,
  },
  SendStreamingMessage: {
    request: 'MessageSendParams',
    response: 'SendStreamingMessageResponse',
    streaming: true,
  },
  GetTask: {
    request: 'TaskQueryParams',
    response: 'GetTaskResponse',
    streaming: false,
  },
  ListTasks: {
    request: 'TaskQueryParams',
    response: 'ListTasksResponse',
    streaming: false,
  },
  CancelTask: {
    request: 'TaskIdParams',
    response: 'CancelTaskResponse',
    streaming: false,
  },
  SubscribeToTask: {
    request: 'TaskIdParams',
    response: 'SubscribeToTaskResponse',
    streaming: true,
  },
  SetTaskPushNotificationConfig: {
    request: 'TaskPushNotificationConfig',
    response: 'SetTaskPushNotificationConfigResponse',
    streaming: false,
  },
  GetTaskPushNotificationConfig: {
    request: 'GetTaskPushNotificationConfigParams',
    response: 'GetTaskPushNotificationConfigResponse',
    streaming: false,
  },
  ListTaskPushNotificationConfig: {
    request: 'ListTaskPushNotificationConfigParams',
    response: 'ListTaskPushNotificationConfigResponse',
    streaming: false,
  },
  DeleteTaskPushNotificationConfig: {
    request: 'DeleteTaskPushNotificationConfigParams',
    response: 'DeleteTaskPushNotificationConfigResponse',
    streaming: false,
  },
  GetExtendedAgentCard: {
    request: 'GetAuthenticatedExtendedCardRequest',
    response: 'GetAuthenticatedExtendedCardResponse',
    streaming: false,
  },
} as const;

// ============================================================================
// gRPC Metadata Constants
// ============================================================================

/**
 * gRPC metadata key for A2A protocol version.
 *
 * @remarks
 * Sent as gRPC metadata to declare the A2A protocol version in use.
 */
export const GRPC_METADATA_VERSION_KEY = 'a2a-version' as const;

/**
 * gRPC metadata key for activated A2A extensions.
 *
 * @remarks
 * Sent as gRPC metadata to declare which A2A extensions are active on the connection.
 */
export const GRPC_METADATA_EXTENSIONS_KEY = 'a2a-extensions' as const;

// ============================================================================
// Builders
// ============================================================================

/**
 * gRPC Status object for A2A errors.
 *
 * @remarks
 * Models the gRPC `Status` message with an optional `details` array
 * containing `google.rpc.ErrorInfo` entries for rich error context.
 */
export interface GrpcStatus {
  /** Numeric gRPC status code */
  code: GrpcStatusCode;
  /** Human-readable error message */
  message: string;
  /**
   * Structured error details (typically `google.rpc.ErrorInfo` entries).
   * @defaultValue undefined
   */
  details?: GrpcErrorInfo[];
}

/**
 * Equivalent of `google.rpc.ErrorInfo` for structured gRPC error details.
 *
 * @remarks
 * Provides machine-readable error context including a reason code,
 * error domain, and optional key-value metadata.
 */
export interface GrpcErrorInfo {
  /** UPPER_SNAKE_CASE reason string identifying the error */
  reason: string;
  /** Error domain (e.g. `"a2a-protocol.org"`) */
  domain: string;
  /**
   * Additional key-value metadata for the error.
   * @defaultValue undefined
   */
  metadata?: Record<string, string>;
}

/**
 * Create a gRPC Status object for an A2A error type.
 *
 * @remarks
 * Resolves the gRPC status code from the A2A error type mapping and
 * attaches an `ErrorInfo` detail entry with the error reason and domain.
 *
 * @param errorType - The A2A error type name (e.g. `"TaskNotFound"`)
 * @param message - Human-readable error message
 * @param metadata - Optional key-value metadata to include in the ErrorInfo detail
 * @returns A fully formed {@link GrpcStatus} object with ErrorInfo details
 *
 * @example
 * ```ts
 * const status = createGrpcStatus('TaskNotFound', 'No task with id xyz');
 * // { code: 5, message: '...', details: [{ reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' }] }
 * ```
 */
export function createGrpcStatus(
  errorType: A2AErrorType,
  message: string,
  metadata?: Record<string, string>,
): GrpcStatus {
  const statusName = A2A_GRPC_STATUS_CODES[errorType];
  const code = GRPC_STATUS_CODE[statusName];

  return {
    code,
    message,
    details: [
      {
        reason: A2A_GRPC_ERROR_REASONS[errorType],
        domain: A2A_GRPC_ERROR_DOMAIN,
        ...(metadata && { metadata }),
      },
    ],
  };
}
