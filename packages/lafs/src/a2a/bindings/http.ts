/**
 * A2A HTTP Protocol Binding
 *
 * HTTP endpoint definitions, status codes, error type URIs,
 * and RFC 9457 Problem Details support per A2A spec Section 11.3-11.5.
 */

import type { A2AErrorType } from './jsonrpc.js';
import type { LAFSError } from '../../types.js';

// ============================================================================
// Endpoint Constants (spec Section 11.3)
// ============================================================================

/** HTTP+JSON endpoint definitions for each A2A operation */
export const HTTP_ENDPOINTS = {
  SendMessage: { method: 'POST', path: '/message:send' },
  SendStreamingMessage: { method: 'POST', path: '/message:stream' },
  GetTask: { method: 'GET', path: '/tasks/:id' },
  ListTasks: { method: 'GET', path: '/tasks' },
  CancelTask: { method: 'POST', path: '/tasks/:id:cancel' },
  SubscribeToTask: { method: 'GET', path: '/tasks/:id:subscribe' },
  SetTaskPushNotificationConfig: { method: 'POST', path: '/tasks/:id/pushNotificationConfig' },
  GetTaskPushNotificationConfig: { method: 'GET', path: '/tasks/:id/pushNotificationConfig' },
  ListTaskPushNotificationConfig: { method: 'GET', path: '/tasks/:id/pushNotificationConfig:list' },
  DeleteTaskPushNotificationConfig: { method: 'DELETE', path: '/tasks/:id/pushNotificationConfig/:configId' },
  GetExtendedAgentCard: { method: 'GET', path: '/agent/authenticatedExtendedCard' },
} as const;

export type HttpEndpoint = (typeof HTTP_ENDPOINTS)[keyof typeof HTTP_ENDPOINTS];

// ============================================================================
// HTTP Status Codes (spec Section 5.4)
// ============================================================================

/** Maps A2A error types to HTTP status codes */
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

/** RFC 9457 Problem Details type URIs for A2A errors */
export const A2A_ERROR_TYPE_URIS: Record<A2AErrorType, string> = {
  TaskNotFound: 'https://a2a-protocol.org/errors/task-not-found',
  TaskNotCancelable: 'https://a2a-protocol.org/errors/task-not-cancelable',
  PushNotificationNotSupported: 'https://a2a-protocol.org/errors/push-notification-not-supported',
  UnsupportedOperation: 'https://a2a-protocol.org/errors/unsupported-operation',
  ContentTypeNotSupported: 'https://a2a-protocol.org/errors/content-type-not-supported',
  InvalidAgentResponse: 'https://a2a-protocol.org/errors/invalid-agent-response',
  AuthenticatedExtendedCardNotConfigured: 'https://a2a-protocol.org/errors/authenticated-extended-card-not-configured',
  ExtensionSupportRequired: 'https://a2a-protocol.org/errors/extension-support-required',
  VersionNotSupported: 'https://a2a-protocol.org/errors/version-not-supported',
} as const;

// ============================================================================
// Problem Details (RFC 9457)
// ============================================================================

/** RFC 9457 Problem Details object */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  [key: string]: unknown;
}

/**
 * Create an RFC 9457 Problem Details object for an A2A error.
 * @param errorType - The A2A error type name
 * @param detail - Human-readable explanation of the error
 * @param extensions - Additional members to include in the response
 */
export function createProblemDetails(
  errorType: A2AErrorType,
  detail: string,
  extensions?: Record<string, unknown>
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
 * Includes LAFS agent-actionable extension fields from the LAFSError.
 *
 * @param errorType - The A2A error type name
 * @param lafsError - The LAFS error object to extract extension fields from
 * @param requestId - Optional request identifier for the `instance` field
 */
export function createLafsProblemDetails(
  errorType: A2AErrorType,
  lafsError: LAFSError,
  requestId?: string
): ProblemDetails {
  const base = createProblemDetails(errorType, lafsError.message);

  return {
    ...base,
    ...(requestId != null && { instance: requestId }),
    retryable: lafsError.retryable,
    ...(lafsError.agentAction != null && { agentAction: lafsError.agentAction }),
    ...(lafsError.retryAfterMs != null && { retryAfterMs: lafsError.retryAfterMs }),
    ...(lafsError.escalationRequired != null && { escalationRequired: lafsError.escalationRequired }),
    ...(lafsError.suggestedAction != null && { suggestedAction: lafsError.suggestedAction }),
    ...(lafsError.docUrl != null && { docUrl: lafsError.docUrl }),
  };
}

// ============================================================================
// URL Building
// ============================================================================

/**
 * Build a URL by substituting path parameters.
 * @param endpoint - HTTP endpoint definition (from HTTP_ENDPOINTS)
 * @param params - Path parameter values (keys without leading colon)
 */
export function buildUrl(
  endpoint: HttpEndpoint,
  params?: Record<string, string>
): string {
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

/** Parsed query parameters for ListTasks (spec Section 11.5) */
export interface ListTasksQueryParams {
  contextId?: string;
  state?: string;
  limit?: number;
  pageToken?: string;
}

/**
 * Parse camelCase query parameters for the ListTasks endpoint.
 * Handles type coercion for numeric fields.
 */
export function parseListTasksQuery(
  query: Record<string, string | undefined>
): ListTasksQueryParams {
  return {
    contextId: query['contextId'],
    state: query['state'],
    limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    pageToken: query['pageToken'],
  };
}
