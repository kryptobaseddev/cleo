/**
 * A2A JSON-RPC Protocol Binding
 *
 * Method constants, error codes, and request/response builders
 * for JSON-RPC 2.0 transport per A2A spec Section 5.3-5.4.
 */

// ============================================================================
// Method Constants (spec Section 5.3)
// ============================================================================

/** All JSON-RPC method names defined by the A2A protocol */
export const JSONRPC_METHODS = {
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  ListTasks: 'tasks/list',
  CancelTask: 'tasks/cancel',
  SubscribeToTask: 'tasks/resubscribe',
  SetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/set',
  GetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/get',
  ListTaskPushNotificationConfig: 'tasks/pushNotificationConfig/list',
  DeleteTaskPushNotificationConfig: 'tasks/pushNotificationConfig/delete',
  GetExtendedAgentCard: 'agent/getAuthenticatedExtendedCard',
} as const;

export type JsonRpcMethod = (typeof JSONRPC_METHODS)[keyof typeof JSONRPC_METHODS];

// ============================================================================
// Error Code Constants (spec Section 5.4)
// ============================================================================

/** Standard JSON-RPC 2.0 error codes */
export const JSONRPC_STANDARD_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A2A-specific error codes (-32001 through -32009) */
export const JSONRPC_A2A_ERROR_CODES = {
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  AuthenticatedExtendedCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009,
} as const;

export type A2AErrorType = keyof typeof JSONRPC_A2A_ERROR_CODES;

// ============================================================================
// JSON-RPC Message Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

// ============================================================================
// Builders
// ============================================================================

/** Create a JSON-RPC 2.0 request object */
export function createJsonRpcRequest(
  id: string | number,
  method: string,
  params?: Record<string, unknown>
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined && { params }),
  };
}

/** Create a JSON-RPC 2.0 success response */
export function createJsonRpcResponse(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/** Create a JSON-RPC 2.0 error response */
export function createJsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  };
}

/** Create an A2A-specific JSON-RPC error response by error type name */
export function createA2AErrorResponse(
  id: string | number | null,
  errorType: A2AErrorType,
  message: string,
  data?: Record<string, unknown>
): JsonRpcErrorResponse {
  return createJsonRpcErrorResponse(id, JSONRPC_A2A_ERROR_CODES[errorType], message, data);
}

// ============================================================================
// Validation
// ============================================================================

const knownMethods = new Set(Object.values(JSONRPC_METHODS));

/** Validate the structure of a JSON-RPC request */
export function validateJsonRpcRequest(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['Input must be an object'] };
  }

  const obj = input as Record<string, unknown>;

  if (obj['jsonrpc'] !== '2.0') {
    errors.push('jsonrpc must be "2.0"');
  }

  if (obj['id'] === undefined || (typeof obj['id'] !== 'string' && typeof obj['id'] !== 'number')) {
    errors.push('id must be a string or number');
  }

  if (typeof obj['method'] !== 'string') {
    errors.push('method must be a string');
  } else if (!knownMethods.has(obj['method'] as JsonRpcMethod)) {
    errors.push(`Unknown method: ${obj['method']}`);
  }

  if (obj['params'] !== undefined && (typeof obj['params'] !== 'object' || obj['params'] === null)) {
    errors.push('params must be an object when provided');
  }

  return { valid: errors.length === 0, errors };
}

/** Check if a numeric error code is an A2A-specific error */
export function isA2AError(code: number): boolean {
  return code >= -32009 && code <= -32001;
}
