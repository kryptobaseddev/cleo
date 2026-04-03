/**
 * A2A HTTP Protocol Binding
 *
 * HTTP endpoint definitions, status codes, error type URIs,
 * and RFC 9457 Problem Details support per A2A spec Section 11.3-11.5.
 */

import type { LAFSError } from '../../types.js';
import type { A2AErrorType } from './jsonrpc.js';

// ============================================================================
// Endpoint Constants (spec Section 11.3)
// ============================================================================

/**
 * HTTP+JSON endpoint definitions for each A2A operation.
 *
 * @remarks
 * Each entry specifies the HTTP method and path template per A2A spec Section 11.3.
 * Path parameters are prefixed with `:` (e.g. `:id`).
 */
export const HTTP_ENDPOINTS = {
  /** Send a single message to an agent */
  SendMessage: { method: 'POST', path: '/message:send' },
  /** Send a streaming message to an agent */
  SendStreamingMessage: { method: 'POST', path: '/message:stream' },
  /** Retrieve a task by identifier */
  GetTask: { method: 'GET', path: '/tasks/:id' },
  /** List tasks matching query criteria */
  ListTasks: { method: 'GET', path: '/tasks' },
  /** Cancel a running task */
  CancelTask: { method: 'POST', path: '/tasks/:id:cancel' },
  /** Subscribe to task events via SSE */
  SubscribeToTask: { method: 'GET', path: '/tasks/:id:subscribe' },
  /** Set push notification configuration for a task */
  SetTaskPushNotificationConfig: { method: 'POST', path: '/tasks/:id/pushNotificationConfig' },
  /** Get push notification configuration for a task */
  GetTaskPushNotificationConfig: { method: 'GET', path: '/tasks/:id/pushNotificationConfig' },
  /** List push notification configurations for a task */
  ListTaskPushNotificationConfig: { method: 'GET', path: '/tasks/:id/pushNotificationConfig:list' },
  /** Delete push notification configuration for a task */
  DeleteTaskPushNotificationConfig: {
    method: 'DELETE',
    path: '/tasks/:id/pushNotificationConfig/:configId',
  },
  /** Retrieve the authenticated extended agent card */
  GetExtendedAgentCard: { method: 'GET', path: '/agent/authenticatedExtendedCard' },
} as const;

/** Union of all HTTP endpoint descriptor objects from {@link HTTP_ENDPOINTS} */
export type HttpEndpoint = (typeof HTTP_ENDPOINTS)[keyof typeof HTTP_ENDPOINTS];

// ============================================================================
// HTTP Status Codes (spec Section 5.4)
// ============================================================================

/**
 * Maps A2A error types to HTTP status codes.
 *
 * @remarks
 * Used by the HTTP binding to determine the appropriate response status
 * code for each A2A error type per spec Section 5.4.
 */
export const A2A_HTTP_STATUS_CODES: Record<A2AErrorType, number> = {
  TaskNotFound: 404,
  TaskNotCancelable: 409,
  PushNotificationNotSupported: 400,
  UnsupportedOperation: 400,
  ContentTypeNotSupported: 415,
  InvalidAgentResponse: 502,
  AuthenticatedExtendedCardNotConfigured: 404,
  ExtensionSupportRequired: 400,
  VersionNotSupported: 400,
} as const;

// ============================================================================
// Error Type URIs (spec Section 5.4)
// ============================================================================

/**
 * RFC 9457 Problem Details type URIs for A2A errors.
 *
 * @remarks
 * Each URI uniquely identifies an A2A error type and is used as the
 * `type` field in RFC 9457 Problem Details responses.
 */
export const A2A_ERROR_TYPE_URIS: Record<A2AErrorType, string> = {
  TaskNotFound: 'https://a2a-protocol.org/errors/task-not-found',
  TaskNotCancelable: 'https://a2a-protocol.org/errors/task-not-cancelable',
  PushNotificationNotSupported: 'https://a2a-protocol.org/errors/push-notification-not-supported',
  UnsupportedOperation: 'https://a2a-protocol.org/errors/unsupported-operation',
  ContentTypeNotSupported: 'https://a2a-protocol.org/errors/content-type-not-supported',
  InvalidAgentResponse: 'https://a2a-protocol.org/errors/invalid-agent-response',
  AuthenticatedExtendedCardNotConfigured:
    'https://a2a-protocol.org/errors/authenticated-extended-card-not-configured',
  ExtensionSupportRequired: 'https://a2a-protocol.org/errors/extension-support-required',
  VersionNotSupported: 'https://a2a-protocol.org/errors/version-not-supported',
} as const;

// ============================================================================
// Problem Details (RFC 9457)
// ============================================================================

/**
 * RFC 9457 Problem Details object.
 *
 * @remarks
 * Represents a machine-readable error response per RFC 9457. The index
 * signature allows arbitrary extension members alongside the required fields.
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type */
  type: string;
  /** Short human-readable summary of the problem */
  title: string;
  /** HTTP status code for this occurrence */
  status: number;
  /** Human-readable explanation specific to this occurrence */
  detail: string;
  /** Extension members (arbitrary key-value pairs) */
  [key: string]: unknown;
}

/**
 * Create an RFC 9457 Problem Details object for an A2A error.
 *
 * @remarks
 * Resolves the `type` URI, `title`, and `status` automatically from
 * the A2A error type. The title is derived by converting the PascalCase
 * error type name to title case.
 *
 * @param errorType - The A2A error type name (e.g. `"TaskNotFound"`)
 * @param detail - Human-readable explanation specific to this occurrence
 * @param extensions - Optional additional members to include in the response
 * @returns A fully formed {@link ProblemDetails} object
 *
 * @example
 * ```ts
 * const problem = createProblemDetails('TaskNotFound', 'No task with id xyz');
 * // { type: 'https://a2a-protocol.org/errors/task-not-found', title: 'Task Not Found', status: 404, detail: '...' }
 * ```
 */
export function createProblemDetails(
  errorType: A2AErrorType,
  detail: string,
  extensions?: Record<string, unknown>,
): ProblemDetails {
  // Convert PascalCase to Title Case: "TaskNotFound" -> "Task Not Found"
  const title = errorType.replace(/([A-Z])/g, ' $1').trim();

  return {
    type: A2A_ERROR_TYPE_URIS[errorType],
    title,
    status: A2A_HTTP_STATUS_CODES[errorType],
    detail,
    ...extensions,
  };
}

/**
 * Create an RFC 9457 Problem Details object bridging A2A error types with LAFS error data.
 *
 * @remarks
 * Extends the base Problem Details with LAFS agent-actionable fields such as
 * `retryable`, `agentAction`, `retryAfterMs`, `escalationRequired`,
 * `suggestedAction`, and `docUrl` extracted from the provided LAFSError.
 *
 * @param errorType - The A2A error type name (e.g. `"InvalidAgentResponse"`)
 * @param lafsError - The LAFS error object to extract extension fields from
 * @param requestId - Optional request identifier used as the `instance` field
 * @returns A {@link ProblemDetails} object with LAFS extension fields
 *
 * @example
 * ```ts
 * const problem = createLafsProblemDetails('InvalidAgentResponse', {
 *   code: 'E_AGENT_RESPONSE',
 *   message: 'Upstream agent returned invalid JSON',
 *   retryable: true,
 *   retryAfterMs: 5000,
 * }, 'req-123');
 * ```
 */
export function createLafsProblemDetails(
  errorType: A2AErrorType,
  lafsError: LAFSError,
  requestId?: string,
): ProblemDetails {
  const base = createProblemDetails(errorType, lafsError.message);

  return {
    ...base,
    ...(requestId != null && { instance: requestId }),
    retryable: lafsError.retryable,
    ...(lafsError.agentAction != null && { agentAction: lafsError.agentAction }),
    ...(lafsError.retryAfterMs != null && { retryAfterMs: lafsError.retryAfterMs }),
    ...(lafsError.escalationRequired != null && {
      escalationRequired: lafsError.escalationRequired,
    }),
    ...(lafsError.suggestedAction != null && { suggestedAction: lafsError.suggestedAction }),
    ...(lafsError.docUrl != null && { docUrl: lafsError.docUrl }),
  };
}

// ============================================================================
// URL Building
// ============================================================================

/**
 * Build a URL by substituting path parameters.
 *
 * @remarks
 * Replaces `:param` placeholders in the endpoint path template with
 * URI-encoded values from the `params` object.
 *
 * @param endpoint - HTTP endpoint definition from {@link HTTP_ENDPOINTS}
 * @param params - Path parameter values keyed by name (without leading colon)
 * @returns The resolved URL path string with parameters substituted
 *
 * @example
 * ```ts
 * const url = buildUrl(HTTP_ENDPOINTS.GetTask, { id: 'task-42' });
 * // '/tasks/task-42'
 * ```
 */
export function buildUrl(endpoint: HttpEndpoint, params?: Record<string, string>): string {
  let path = endpoint.path as string;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(value));
    }
  }
  return path;
}

// ============================================================================
// Query Parameter Parsing
// ============================================================================

/**
 * Parsed query parameters for the ListTasks endpoint.
 *
 * @remarks
 * Represents the camelCase query parameters defined in A2A spec Section 11.5.
 * All fields are optional for flexible filtering.
 */
export interface ListTasksQueryParams {
  /**
   * Filter tasks by context identifier.
   * @defaultValue undefined
   */
  contextId?: string;
  /**
   * Filter tasks by state (e.g. `"submitted"`, `"working"`).
   * @defaultValue undefined
   */
  state?: string;
  /**
   * Maximum number of tasks to return.
   * @defaultValue undefined
   */
  limit?: number;
  /**
   * Pagination token from a previous response.
   * @defaultValue undefined
   */
  pageToken?: string;
}

/**
 * Parse camelCase query parameters for the ListTasks endpoint.
 *
 * @remarks
 * Handles type coercion for numeric fields (e.g. `limit` is parsed from
 * string to integer). Undefined values are preserved as-is.
 *
 * @param query - Raw query parameter map from the HTTP request
 * @returns A typed {@link ListTasksQueryParams} object with coerced values
 *
 * @example
 * ```ts
 * const params = parseListTasksQuery({ contextId: 'ctx-1', limit: '10' });
 * // { contextId: 'ctx-1', limit: 10 }
 * ```
 */
export function parseListTasksQuery(
  query: Record<string, string | undefined>,
): ListTasksQueryParams {
  return {
    contextId: query['contextId'],
    state: query['state'],
    limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    pageToken: query['pageToken'],
  };
}
