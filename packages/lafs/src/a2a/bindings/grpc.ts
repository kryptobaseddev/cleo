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

/** Standard gRPC status codes (numeric values 0-16) */
export const GRPC_STATUS_CODE = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export type GrpcStatusCode = (typeof GRPC_STATUS_CODE)[keyof typeof GRPC_STATUS_CODE];
export type GrpcStatusName = keyof typeof GRPC_STATUS_CODE;

// ============================================================================
// A2A gRPC Status Mapping (spec Section 5.4)
// ============================================================================

/** Maps A2A error types to gRPC status names */
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

/** UPPER_SNAKE_CASE error reasons without "Error" suffix */
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

/** Error domain for A2A gRPC errors */
export const A2A_GRPC_ERROR_DOMAIN = 'a2a-protocol.org' as const;

// ============================================================================
// Service Method Definitions (spec Section 10.3)
// ============================================================================

/** gRPC service method descriptor */
export interface GrpcServiceMethod {
  request: string;
  response: string;
  streaming: boolean;
}

/** gRPC service method definitions for the A2A protocol */
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

/** gRPC metadata key for A2A protocol version */
export const GRPC_METADATA_VERSION_KEY = 'a2a-version' as const;

/** gRPC metadata key for activated A2A extensions */
export const GRPC_METADATA_EXTENSIONS_KEY = 'a2a-extensions' as const;

// ============================================================================
// Builders
// ============================================================================

/** gRPC Status object for A2A errors */
export interface GrpcStatus {
  code: GrpcStatusCode;
  message: string;
  details?: GrpcErrorInfo[];
}

/** google.rpc.ErrorInfo equivalent */
export interface GrpcErrorInfo {
  reason: string;
  domain: string;
  metadata?: Record<string, string>;
}

/**
 * Create a gRPC Status object for an A2A error type.
 * Includes ErrorInfo details with reason and domain.
 */
export function createGrpcStatus(
  errorType: A2AErrorType,
  message: string,
  metadata?: Record<string, string>
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
