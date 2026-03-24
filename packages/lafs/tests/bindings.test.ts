/**
 * Tests for A2A Protocol Bindings (T100)
 */

import { describe, it, expect } from 'vitest';
import {
  // JSON-RPC
  JSONRPC_METHODS,
  JSONRPC_STANDARD_ERROR_CODES,
  JSONRPC_A2A_ERROR_CODES,
  createJsonRpcRequest,
  createJsonRpcResponse,
  createJsonRpcErrorResponse,
  createA2AErrorResponse,
  validateJsonRpcRequest,
  isA2AError,
  type A2AErrorType,

  // HTTP
  HTTP_ENDPOINTS,
  A2A_HTTP_STATUS_CODES,
  A2A_ERROR_TYPE_URIS,
  createProblemDetails,
  buildUrl,
  parseListTasksQuery,

  // gRPC
  GRPC_STATUS_CODE,
  A2A_GRPC_STATUS_CODES,
  A2A_GRPC_ERROR_REASONS,
  A2A_GRPC_ERROR_DOMAIN,
  GRPC_SERVICE_METHODS,
  GRPC_METADATA_VERSION_KEY,
  GRPC_METADATA_EXTENSIONS_KEY,
  createGrpcStatus,

  // Cross-binding
  A2A_ERROR_MAPPINGS,
  getErrorCodeMapping,
  DEFAULT_A2A_VERSION,
  SUPPORTED_A2A_VERSIONS,
  parseA2AVersionHeader,
  negotiateA2AVersion,
} from '../src/a2a/bindings/index.js';

// ============================================================================
// JSON-RPC Binding
// ============================================================================

describe('JSON-RPC Binding', () => {
  describe('Method constants', () => {
    it('should define all core methods', () => {
      expect(JSONRPC_METHODS.SendMessage).toBe('message/send');
      expect(JSONRPC_METHODS.SendStreamingMessage).toBe('message/stream');
      expect(JSONRPC_METHODS.GetTask).toBe('tasks/get');
      expect(JSONRPC_METHODS.CancelTask).toBe('tasks/cancel');
      expect(JSONRPC_METHODS.GetExtendedAgentCard).toBe('agent/getAuthenticatedExtendedCard');
    });

    it('should define push notification methods', () => {
      expect(JSONRPC_METHODS.SetTaskPushNotificationConfig).toBe('tasks/pushNotificationConfig/set');
      expect(JSONRPC_METHODS.GetTaskPushNotificationConfig).toBe('tasks/pushNotificationConfig/get');
      expect(JSONRPC_METHODS.ListTaskPushNotificationConfig).toBe('tasks/pushNotificationConfig/list');
      expect(JSONRPC_METHODS.DeleteTaskPushNotificationConfig).toBe('tasks/pushNotificationConfig/delete');
    });
  });

  describe('Error codes', () => {
    it('should define standard JSON-RPC error codes', () => {
      expect(JSONRPC_STANDARD_ERROR_CODES.ParseError).toBe(-32700);
      expect(JSONRPC_STANDARD_ERROR_CODES.InvalidRequest).toBe(-32600);
      expect(JSONRPC_STANDARD_ERROR_CODES.MethodNotFound).toBe(-32601);
      expect(JSONRPC_STANDARD_ERROR_CODES.InvalidParams).toBe(-32602);
      expect(JSONRPC_STANDARD_ERROR_CODES.InternalError).toBe(-32603);
    });

    it('should define all 9 A2A error codes', () => {
      expect(JSONRPC_A2A_ERROR_CODES.TaskNotFound).toBe(-32001);
      expect(JSONRPC_A2A_ERROR_CODES.TaskNotCancelable).toBe(-32002);
      expect(JSONRPC_A2A_ERROR_CODES.PushNotificationNotSupported).toBe(-32003);
      expect(JSONRPC_A2A_ERROR_CODES.UnsupportedOperation).toBe(-32004);
      expect(JSONRPC_A2A_ERROR_CODES.ContentTypeNotSupported).toBe(-32005);
      expect(JSONRPC_A2A_ERROR_CODES.InvalidAgentResponse).toBe(-32006);
      expect(JSONRPC_A2A_ERROR_CODES.AuthenticatedExtendedCardNotConfigured).toBe(-32007);
      expect(JSONRPC_A2A_ERROR_CODES.ExtensionSupportRequired).toBe(-32008);
      expect(JSONRPC_A2A_ERROR_CODES.VersionNotSupported).toBe(-32009);
    });

    it('A2A error codes should be contiguous from -32001 to -32009', () => {
      const codes = Object.values(JSONRPC_A2A_ERROR_CODES).sort((a, b) => a - b);
      expect(codes[0]).toBe(-32009);
      expect(codes[codes.length - 1]).toBe(-32001);
      expect(codes).toHaveLength(9);
    });
  });

  describe('Request builder', () => {
    it('should create a valid JSON-RPC request', () => {
      const req = createJsonRpcRequest(1, 'message/send', { message: {} });
      expect(req.jsonrpc).toBe('2.0');
      expect(req.id).toBe(1);
      expect(req.method).toBe('message/send');
      expect(req.params).toEqual({ message: {} });
    });

    it('should omit params when not provided', () => {
      const req = createJsonRpcRequest('req-1', 'tasks/get');
      expect(req).not.toHaveProperty('params');
    });
  });

  describe('Response builder', () => {
    it('should create a success response', () => {
      const res = createJsonRpcResponse(1, { id: 'task-1' });
      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(1);
      expect(res.result).toEqual({ id: 'task-1' });
    });

    it('should create an error response', () => {
      const res = createJsonRpcErrorResponse(1, -32001, 'Task not found', { taskId: 't1' });
      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(1);
      expect(res.error.code).toBe(-32001);
      expect(res.error.message).toBe('Task not found');
      expect(res.error.data).toEqual({ taskId: 't1' });
    });

    it('should create an A2A error by type name', () => {
      const res = createA2AErrorResponse('req-1', 'TaskNotFound', 'Not found');
      expect(res.error.code).toBe(-32001);
    });
  });

  describe('Request validation', () => {
    it('should validate a correct request', () => {
      const result = validateJsonRpcRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: {} },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing jsonrpc', () => {
      const result = validateJsonRpcRequest({ id: 1, method: 'message/send' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('jsonrpc must be "2.0"');
    });

    it('should reject unknown method', () => {
      const result = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'foo/bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown method');
    });

    it('should reject non-object input', () => {
      const result = validateJsonRpcRequest('not an object');
      expect(result.valid).toBe(false);
    });
  });

  describe('isA2AError', () => {
    it('should return true for A2A error codes', () => {
      expect(isA2AError(-32001)).toBe(true);
      expect(isA2AError(-32009)).toBe(true);
      expect(isA2AError(-32005)).toBe(true);
    });

    it('should return false for standard JSON-RPC errors', () => {
      expect(isA2AError(-32700)).toBe(false);
      expect(isA2AError(-32600)).toBe(false);
    });

    it('should return false for non-A2A codes', () => {
      expect(isA2AError(-32000)).toBe(false);
      expect(isA2AError(-32010)).toBe(false);
      expect(isA2AError(0)).toBe(false);
    });
  });
});

// ============================================================================
// HTTP Binding
// ============================================================================

describe('HTTP Binding', () => {
  describe('Endpoint constants', () => {
    it('should define SendMessage as POST', () => {
      expect(HTTP_ENDPOINTS.SendMessage.method).toBe('POST');
      expect(HTTP_ENDPOINTS.SendMessage.path).toBe('/message:send');
    });

    it('should define GetTask as GET with param', () => {
      expect(HTTP_ENDPOINTS.GetTask.method).toBe('GET');
      expect(HTTP_ENDPOINTS.GetTask.path).toContain(':id');
    });

    it('should define all endpoints', () => {
      const names = Object.keys(HTTP_ENDPOINTS);
      expect(names).toContain('SendMessage');
      expect(names).toContain('GetTask');
      expect(names).toContain('CancelTask');
      expect(names).toContain('GetExtendedAgentCard');
    });
  });

  describe('HTTP status codes', () => {
    it('TaskNotFound should map to 404', () => {
      expect(A2A_HTTP_STATUS_CODES.TaskNotFound).toBe(404);
    });

    it('TaskNotCancelable should map to 409', () => {
      expect(A2A_HTTP_STATUS_CODES.TaskNotCancelable).toBe(409);
    });

    it('ContentTypeNotSupported should map to 415', () => {
      expect(A2A_HTTP_STATUS_CODES.ContentTypeNotSupported).toBe(415);
    });

    it('InvalidAgentResponse should map to 502', () => {
      expect(A2A_HTTP_STATUS_CODES.InvalidAgentResponse).toBe(502);
    });

    it('should cover all 9 error types', () => {
      expect(Object.keys(A2A_HTTP_STATUS_CODES)).toHaveLength(9);
    });
  });

  describe('Error type URIs', () => {
    it('should use a2a-protocol.org domain', () => {
      for (const uri of Object.values(A2A_ERROR_TYPE_URIS)) {
        expect(uri).toMatch(/^https:\/\/a2a-protocol\.org\/errors\//);
      }
    });

    it('should use kebab-case paths', () => {
      expect(A2A_ERROR_TYPE_URIS.TaskNotFound).toBe(
        'https://a2a-protocol.org/errors/task-not-found'
      );
      expect(A2A_ERROR_TYPE_URIS.ContentTypeNotSupported).toBe(
        'https://a2a-protocol.org/errors/content-type-not-supported'
      );
    });
  });

  describe('Problem Details (RFC 9457)', () => {
    it('should create compliant Problem Details object', () => {
      const pd = createProblemDetails('TaskNotFound', 'Task xyz not found');
      expect(pd.type).toBe('https://a2a-protocol.org/errors/task-not-found');
      expect(pd.title).toBe('Task Not Found');
      expect(pd.status).toBe(404);
      expect(pd.detail).toBe('Task xyz not found');
    });

    it('should include extension members', () => {
      const pd = createProblemDetails('TaskNotFound', 'Not found', {
        taskId: 'task-123',
      });
      expect(pd['taskId']).toBe('task-123');
    });

    it('should have required RFC 9457 fields', () => {
      const pd = createProblemDetails('UnsupportedOperation', 'Not supported');
      expect(pd).toHaveProperty('type');
      expect(pd).toHaveProperty('title');
      expect(pd).toHaveProperty('status');
      expect(pd).toHaveProperty('detail');
    });
  });

  describe('URL building', () => {
    it('should substitute path parameters', () => {
      const url = buildUrl(HTTP_ENDPOINTS.GetTask, { id: 'task-123' });
      expect(url).toBe('/tasks/task-123');
    });

    it('should encode special characters', () => {
      const url = buildUrl(HTTP_ENDPOINTS.GetTask, { id: 'task/123' });
      expect(url).toContain('task%2F123');
    });

    it('should return path as-is without params', () => {
      const url = buildUrl(HTTP_ENDPOINTS.SendMessage);
      expect(url).toBe('/message:send');
    });
  });

  describe('Query parameter parsing', () => {
    it('should parse all camelCase params', () => {
      const result = parseListTasksQuery({
        contextId: 'ctx-1',
        state: 'working',
        limit: '10',
        pageToken: 'abc',
      });
      expect(result.contextId).toBe('ctx-1');
      expect(result.state).toBe('working');
      expect(result.limit).toBe(10);
      expect(result.pageToken).toBe('abc');
    });

    it('should handle missing params', () => {
      const result = parseListTasksQuery({});
      expect(result.contextId).toBeUndefined();
      expect(result.state).toBeUndefined();
      expect(result.limit).toBeUndefined();
      expect(result.pageToken).toBeUndefined();
    });
  });
});

// ============================================================================
// gRPC Binding
// ============================================================================

describe('gRPC Binding', () => {
  describe('Status codes', () => {
    it('should define standard gRPC codes', () => {
      expect(GRPC_STATUS_CODE.OK).toBe(0);
      expect(GRPC_STATUS_CODE.NOT_FOUND).toBe(5);
      expect(GRPC_STATUS_CODE.INTERNAL).toBe(13);
      expect(GRPC_STATUS_CODE.FAILED_PRECONDITION).toBe(9);
      expect(GRPC_STATUS_CODE.UNIMPLEMENTED).toBe(12);
    });
  });

  describe('A2A gRPC status mapping', () => {
    it('TaskNotFound should map to NOT_FOUND', () => {
      expect(A2A_GRPC_STATUS_CODES.TaskNotFound).toBe('NOT_FOUND');
    });

    it('InvalidAgentResponse should map to INTERNAL', () => {
      expect(A2A_GRPC_STATUS_CODES.InvalidAgentResponse).toBe('INTERNAL');
    });

    it('should cover all 9 error types', () => {
      expect(Object.keys(A2A_GRPC_STATUS_CODES)).toHaveLength(9);
    });
  });

  describe('Error reasons', () => {
    it('should use UPPER_SNAKE_CASE without Error suffix', () => {
      expect(A2A_GRPC_ERROR_REASONS.TaskNotFound).toBe('TASK_NOT_FOUND');
      expect(A2A_GRPC_ERROR_REASONS.ContentTypeNotSupported).toBe('CONTENT_TYPE_NOT_SUPPORTED');
      expect(A2A_GRPC_ERROR_REASONS.InvalidAgentResponse).toBe('INVALID_AGENT_RESPONSE');
    });

    it('should not contain "Error" in any reason', () => {
      for (const reason of Object.values(A2A_GRPC_ERROR_REASONS)) {
        expect(reason).not.toContain('ERROR');
      }
    });
  });

  describe('Error domain', () => {
    it('should be a2a-protocol.org', () => {
      expect(A2A_GRPC_ERROR_DOMAIN).toBe('a2a-protocol.org');
    });
  });

  describe('Service methods', () => {
    it('should define SendMessage as non-streaming', () => {
      expect(GRPC_SERVICE_METHODS['SendMessage']!.streaming).toBe(false);
    });

    it('should define SendStreamingMessage as streaming', () => {
      expect(GRPC_SERVICE_METHODS['SendStreamingMessage']!.streaming).toBe(true);
    });

    it('should define SubscribeToTask as streaming', () => {
      expect(GRPC_SERVICE_METHODS['SubscribeToTask']!.streaming).toBe(true);
    });
  });

  describe('Metadata constants', () => {
    it('should define version key', () => {
      expect(GRPC_METADATA_VERSION_KEY).toBe('a2a-version');
    });

    it('should define extensions key', () => {
      expect(GRPC_METADATA_EXTENSIONS_KEY).toBe('a2a-extensions');
    });
  });

  describe('createGrpcStatus', () => {
    it('should create status with correct code and ErrorInfo', () => {
      const status = createGrpcStatus('TaskNotFound', 'Task not found');
      expect(status.code).toBe(GRPC_STATUS_CODE.NOT_FOUND);
      expect(status.message).toBe('Task not found');
      expect(status.details).toHaveLength(1);
      expect(status.details![0]!.reason).toBe('TASK_NOT_FOUND');
      expect(status.details![0]!.domain).toBe('a2a-protocol.org');
    });

    it('should include metadata when provided', () => {
      const status = createGrpcStatus('TaskNotFound', 'Not found', { taskId: 't-123' });
      expect(status.details![0]!.metadata).toEqual({ taskId: 't-123' });
    });
  });
});

// ============================================================================
// Cross-Binding Error Mapping
// ============================================================================

describe('Cross-binding error mapping', () => {
  const ALL_ERROR_TYPES: A2AErrorType[] = [
    'TaskNotFound',
    'TaskNotCancelable',
    'PushNotificationNotSupported',
    'UnsupportedOperation',
    'ContentTypeNotSupported',
    'InvalidAgentResponse',
    'AuthenticatedExtendedCardNotConfigured',
    'ExtensionSupportRequired',
    'VersionNotSupported',
  ];

  it('should have mappings for all 9 error types', () => {
    expect(A2A_ERROR_MAPPINGS.size).toBe(9);
  });

  it('getErrorCodeMapping should return consistent values for all error types', () => {
    for (const errorType of ALL_ERROR_TYPES) {
      const mapping = getErrorCodeMapping(errorType);

      // Verify JSON-RPC code matches
      expect(mapping.jsonRpcCode).toBe(JSONRPC_A2A_ERROR_CODES[errorType]);

      // Verify HTTP status matches
      expect(mapping.httpStatus).toBe(A2A_HTTP_STATUS_CODES[errorType]);

      // Verify HTTP type URI matches
      expect(mapping.httpTypeUri).toBe(A2A_ERROR_TYPE_URIS[errorType]);

      // Verify gRPC status matches
      expect(mapping.grpcStatus).toBe(A2A_GRPC_STATUS_CODES[errorType]);

      // Verify gRPC code is a valid status code
      expect(mapping.grpcCode).toBeGreaterThanOrEqual(0);
      expect(mapping.grpcCode).toBeLessThanOrEqual(16);
    }
  });

  it('should throw for unknown error type', () => {
    expect(() => getErrorCodeMapping('UnknownError' as A2AErrorType)).toThrow();
  });

  it('TaskNotFound mapping should be consistent', () => {
    const mapping = getErrorCodeMapping('TaskNotFound');
    expect(mapping.jsonRpcCode).toBe(-32001);
    expect(mapping.httpStatus).toBe(404);
    expect(mapping.httpTypeUri).toContain('task-not-found');
    expect(mapping.grpcStatus).toBe('NOT_FOUND');
    expect(mapping.grpcCode).toBe(5);
  });

  it('ExtensionSupportRequired mapping should be consistent', () => {
    const mapping = getErrorCodeMapping('ExtensionSupportRequired');
    expect(mapping.jsonRpcCode).toBe(-32008);
    expect(mapping.httpStatus).toBe(400);
    expect(mapping.grpcStatus).toBe('FAILED_PRECONDITION');
    expect(mapping.grpcCode).toBe(9);
  });
});

describe('A2A version negotiation', () => {
  it('exposes supported versions and default', () => {
    expect(SUPPORTED_A2A_VERSIONS).toContain('1.0');
    expect(DEFAULT_A2A_VERSION).toBe('1.0');
  });

  it('parses version header values', () => {
    expect(parseA2AVersionHeader('1.0, 1.1')).toEqual(['1.0', '1.1']);
    expect(parseA2AVersionHeader(undefined)).toEqual([]);
  });

  it('negotiates a supported version', () => {
    expect(negotiateA2AVersion(['1.1', '1.0'])).toBe('1.0');
    expect(negotiateA2AVersion([])).toBe('1.0');
  });

  it('returns null when no compatible version exists', () => {
    expect(negotiateA2AVersion(['2.0', '1.1'])).toBeNull();
  });
});
