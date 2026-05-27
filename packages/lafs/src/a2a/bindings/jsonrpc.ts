/**
 * A2A JSON-RPC Protocol Binding
 *
 * Method constants, error codes, and request/response builders
 * for JSON-RPC 2.0 transport per A2A spec Section 5.3-5.4.
 */

// ============================================================================
// Method Constants (spec Section 5.3)
// ============================================================================

/**
 * All JSON-RPC method names defined by the A2A protocol.
 *
 * @remarks
 * Each key corresponds to an A2A operation and each value is the
 * JSON-RPC method string sent on the wire per spec Section 5.3.
 */
export const JSONRPC_METHODS = {
  /** Send a single message to an agent */
  SendMessage: 'message/send',
  /** Send a streaming message to an agent */
  SendStreamingMessage: 'message/stream',
  /** Retrieve a task by identifier */
  GetTask: 'tasks/get',
  /** List tasks matching query criteria */
  ListTasks: 'tasks/list',
  /** Cancel a running task */
  CancelTask: 'tasks/cancel',
  /** Resubscribe to task events */
  SubscribeToTask: 'tasks/resubscribe',
  /** Set push notification configuration for a task */
  SetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/set',
  /** Get push notification configuration for a task */
  GetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/get',
  /** List push notification configurations for a task */
  ListTaskPushNotificationConfig: 'tasks/pushNotificationConfig/list',
  /** Delete push notification configuration for a task */
  DeleteTaskPushNotificationConfig: 'tasks/pushNotificationConfig/delete',
  /** Retrieve the authenticated extended agent card */
  GetExtendedAgentCard: 'agent/getAuthenticatedExtendedCard',
} as const;

/** Union of all valid JSON-RPC method string values from {@link JSONRPC_METHODS} */
export type JsonRpcMethod = (typeof JSONRPC_METHODS)[keyof typeof JSONRPC_METHODS];

// ============================================================================
// Error Code Constants (spec Section 5.4)
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes.
 *
 * @remarks
 * These are the error codes defined in the JSON-RPC 2.0 specification
 * and are not A2A-specific.
 */
export const JSONRPC_STANDARD_ERROR_CODES = {
  /** Invalid JSON was received by the server */
  ParseError: -32700,
  /** The JSON sent is not a valid Request object */
  InvalidRequest: -32600,
  /** The method does not exist or is not available */
  MethodNotFound: -32601,
  /** Invalid method parameter(s) */
  InvalidParams: -32602,
  /** Internal JSON-RPC error */
  InternalError: -32603,
} as const;

/**
 * A2A-specific error codes (-32001 through -32009).
 *
 * @remarks
 * These codes occupy the JSON-RPC server error range and are
 * defined by the A2A protocol spec Section 5.4.
 */
export const JSONRPC_A2A_ERROR_CODES = {
  /** The requested task was not found */
  TaskNotFound: -32001,
  /** The task cannot be canceled in its current state */
  TaskNotCancelable: -32002,
  /** Push notifications are not supported by the agent */
  PushNotificationNotSupported: -32003,
  /** The requested operation is not supported */
  UnsupportedOperation: -32004,
  /** The provided content type is not supported */
  ContentTypeNotSupported: -32005,
  /** The downstream agent returned an invalid response */
  InvalidAgentResponse: -32006,
  /** The authenticated extended card is not configured */
  AuthenticatedExtendedCardNotConfigured: -32007,
  /** A required extension is not supported by the peer */
  ExtensionSupportRequired: -32008,
  /** The requested protocol version is not supported */
  VersionNotSupported: -32009,
} as const;

/** Union of A2A error type key names from {@link JSONRPC_A2A_ERROR_CODES} */
export type A2AErrorType = keyof typeof JSONRPC_A2A_ERROR_CODES;

// ============================================================================
// JSON-RPC Message Types
// ============================================================================

/**
 * A JSON-RPC 2.0 request object.
 *
 * @remarks
 * Represents a well-formed JSON-RPC request per the JSON-RPC 2.0 specification.
 */
export interface JsonRpcRequest {
  /** JSON-RPC protocol version, always `"2.0"` */
  jsonrpc: '2.0';
  /** Client-assigned request identifier */
  id: string | number;
  /** The RPC method name to invoke */
  method: string;
  /**
   * Named parameters for the method call.
   * @defaultValue undefined
   */
  params?: Record<string, unknown>;
}

/**
 * A JSON-RPC 2.0 success response object.
 *
 * @remarks
 * Returned when the method call succeeds. The `result` field contains the
 * method return value and `error` is absent.
 */
export interface JsonRpcResponse {
  /** JSON-RPC protocol version, always `"2.0"` */
  jsonrpc: '2.0';
  /** Identifier matching the originating request, or `null` for notifications */
  id: string | number | null;
  /** The return value of the invoked method */
  result: unknown;
}

/**
 * A JSON-RPC 2.0 error response object.
 *
 * @remarks
 * Returned when the method call fails. The `error` field contains the
 * error details and `result` is absent.
 */
export interface JsonRpcErrorResponse {
  /** JSON-RPC protocol version, always `"2.0"` */
  jsonrpc: '2.0';
  /** Identifier matching the originating request, or `null` for notifications */
  id: string | number | null;
  /** Error descriptor containing code, message, and optional data */
  error: {
    /** Numeric error code indicating the type of failure */
    code: number;
    /** Short human-readable description of the error */
    message: string;
    /**
     * Additional structured error data.
     * @defaultValue undefined
     */
    data?: Record<string, unknown>;
  };
}

// ============================================================================
// Builders
// ============================================================================

/**
 * Create a JSON-RPC 2.0 request object.
 *
 * @remarks
 * Builds a spec-compliant request with the `jsonrpc: "2.0"` field set
 * automatically. The `params` field is omitted when not provided.
 *
 * @param id - Client-assigned request identifier
 * @param method - The RPC method name to invoke
 * @param params - Optional named parameters for the method call
 * @returns A fully formed {@link JsonRpcRequest} object
 *
 * @example
 * ```ts
 * const req = createJsonRpcRequest(1, 'tasks/get', { id: 'abc' });
 * // { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'abc' } }
 * ```
 */
export function createJsonRpcRequest(
  id: string | number,
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined && { params }),
  };
}

/**
 * Create a JSON-RPC 2.0 success response.
 *
 * @remarks
 * Wraps an arbitrary result value in the standard JSON-RPC 2.0 response
 * envelope with the `jsonrpc: "2.0"` field set automatically.
 *
 * @param id - Identifier matching the originating request, or `null` for notifications
 * @param result - The return value of the invoked method
 * @returns A fully formed {@link JsonRpcResponse} object
 *
 * @example
 * ```ts
 * const res = createJsonRpcResponse(1, { status: 'ok' });
 * // { jsonrpc: '2.0', id: 1, result: { status: 'ok' } }
 * ```
 */
export function createJsonRpcResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Create a JSON-RPC 2.0 error response.
 *
 * @remarks
 * Builds an error response with the standard `error` object containing
 * the numeric code, message, and optional structured data.
 *
 * @param id - Identifier matching the originating request, or `null` for notifications
 * @param code - Numeric error code (standard or A2A-specific)
 * @param message - Short human-readable description of the error
 * @param data - Optional additional structured error data
 * @returns A fully formed {@link JsonRpcErrorResponse} object
 *
 * @example
 * ```ts
 * const err = createJsonRpcErrorResponse(1, -32001, 'Task not found');
 * // { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Task not found' } }
 * ```
 */
export function createJsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
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

/**
 * Create an A2A-specific JSON-RPC error response by error type name.
 *
 * @remarks
 * Convenience wrapper around {@link createJsonRpcErrorResponse} that resolves
 * the numeric error code from {@link JSONRPC_A2A_ERROR_CODES} automatically.
 *
 * @param id - Identifier matching the originating request, or `null` for notifications
 * @param errorType - The A2A error type name (e.g. `"TaskNotFound"`)
 * @param message - Short human-readable description of the error
 * @param data - Optional additional structured error data
 * @returns A fully formed {@link JsonRpcErrorResponse} with the resolved A2A error code
 *
 * @example
 * ```ts
 * const err = createA2AErrorResponse(1, 'TaskNotFound', 'No task with id xyz');
 * // error.code === -32001
 * ```
 */
export function createA2AErrorResponse(
  id: string | number | null,
  errorType: A2AErrorType,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return createJsonRpcErrorResponse(id, JSONRPC_A2A_ERROR_CODES[errorType], message, data);
}

// ============================================================================
// Validation
// ============================================================================

const knownMethods = new Set(Object.values(JSONRPC_METHODS));

/**
 * Validate the structure of a JSON-RPC request.
 *
 * @remarks
 * Performs structural validation of an unknown input against the JSON-RPC 2.0
 * request schema. Checks the `jsonrpc` version, `id` type, `method` string,
 * and that the method is a known A2A method from {@link JSONRPC_METHODS}.
 *
 * @param input - The unknown value to validate
 * @returns An object with `valid` indicating success and `errors` listing any violations
 *
 * @example
 * ```ts
 * const { valid, errors } = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get' });
 * // valid === true, errors === []
 * ```
 */
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

  if (
    obj['params'] !== undefined &&
    (typeof obj['params'] !== 'object' || obj['params'] === null)
  ) {
    errors.push('params must be an object when provided');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a numeric error code is an A2A-specific error.
 *
 * @remarks
 * A2A error codes occupy the range -32009 through -32001 within the
 * JSON-RPC server error code space.
 *
 * @param code - The numeric JSON-RPC error code to check
 * @returns `true` if the code falls within the A2A error range
 *
 * @example
 * ```ts
 * isA2AError(-32001); // true  (TaskNotFound)
 * isA2AError(-32700); // false (standard ParseError)
 * ```
 */
export function isA2AError(code: number): boolean {
  return code >= -32009 && code <= -32001;
}
