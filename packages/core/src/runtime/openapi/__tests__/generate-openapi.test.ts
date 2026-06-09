/**
 * Tests for {@link generateOpenApi} — the zod→OpenAPI 3.1 bridge (T11918 / M5).
 *
 * Coverage maps to the task acceptance criteria:
 *   - AC1: the builder emits a valid OpenAPI 3.1 document.
 *   - AC2: each op → `POST /v1/<domain>/<operation>` with requestBody from the
 *          input schema and a 200 response from the resolved output schema.
 *   - AC4: the document validates against an OpenAPI 3.1 meta-schema AND every
 *          embedded Schema Object compiles under the JSON Schema 2020-12 dialect.
 *   - AC5: the number of paths equals OPERATIONS.length.
 *
 * @task T11918
 */

import { OPERATIONS } from '@cleocode/contracts';
// Ajv 2020 carries the JSON Schema 2020-12 vocabulary OpenAPI 3.1 mandates.
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { generateOpenApi, type OpenApiDocument } from '../generate-openapi.js';

// ---------------------------------------------------------------------------
// OpenAPI 3.1 meta-schema (focused — enforces the spec's structural invariants
// this builder is contractually bound to). Authored against
// https://spec.openapis.org/oas/v3.1.0. Embedded schema objects are validated
// SEPARATELY by compiling them under the 2020-12 dialect (AC4, second half).
// ---------------------------------------------------------------------------
const OPENAPI_31_META_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['openapi', 'info', 'paths'],
  properties: {
    openapi: { type: 'string', pattern: '^3\\.1\\.\\d+$' },
    jsonSchemaDialect: { type: 'string', format: 'uri' },
    info: {
      type: 'object',
      required: ['title', 'version'],
      properties: {
        title: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
        summary: { type: 'string' },
        description: { type: 'string' },
      },
    },
    paths: {
      type: 'object',
      // Every path key MUST be a templated route starting with '/'.
      propertyNames: { pattern: '^/' },
      additionalProperties: {
        type: 'object',
        properties: {
          post: { $ref: '#/$defs/operation' },
          get: { $ref: '#/$defs/operation' },
          put: { $ref: '#/$defs/operation' },
          delete: { $ref: '#/$defs/operation' },
        },
        additionalProperties: false,
      },
    },
  },
  $defs: {
    operation: {
      type: 'object',
      required: ['responses'],
      properties: {
        operationId: { type: 'string', minLength: 1 },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        requestBody: {
          type: 'object',
          required: ['content'],
          properties: {
            required: { type: 'boolean' },
            description: { type: 'string' },
            content: { $ref: '#/$defs/content' },
          },
        },
        responses: {
          type: 'object',
          minProperties: 1,
          // Response keys are HTTP status codes or 'default'.
          propertyNames: { pattern: '^([1-5][0-9]{2}|default)$' },
          additionalProperties: {
            type: 'object',
            required: ['description'],
            properties: {
              description: { type: 'string' },
              content: { $ref: '#/$defs/content' },
            },
          },
        },
      },
    },
    content: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['schema'],
        properties: { schema: { type: 'object' } },
      },
    },
  },
} as const;

function makeAjv(): Ajv2020 {
  // strict:false — OpenAPI/JSON-Schema docs carry annotation keywords ajv would
  // otherwise warn on; allErrors for diagnosable failures.
  return new Ajv2020({ strict: false, allErrors: true });
}

describe('generateOpenApi', () => {
  const doc: OpenApiDocument = generateOpenApi();

  it('emits an OpenAPI 3.1.0 document (AC1)', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('validates against the OpenAPI 3.1 meta-schema (AC4)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(OPENAPI_31_META_SCHEMA);
    const ok = validate(doc);
    if (!ok) {
      // Surface the first few errors for a diagnosable failure.
      throw new Error(
        `OpenAPI 3.1 meta-schema validation failed: ${ajv.errorsText(validate.errors)}`,
      );
    }
    expect(ok).toBe(true);
  });

  it('has exactly OPERATIONS.length paths — one route per registry entry (AC5)', () => {
    expect(Object.keys(doc.paths)).toHaveLength(OPERATIONS.length);
  });

  it('every path is POST-only with a 200 JSON response and an x-cleo-gateway tag (AC2)', () => {
    for (const route of Object.keys(doc.paths)) {
      const item = doc.paths[route];
      // POST-only path item.
      expect(Object.keys(item)).toEqual(['post']);
      const post = item.post;
      // Route begins with the /v1 prefix and the operation's domain segment.
      expect(route.startsWith('/v1/')).toBe(true);
      expect(post.tags.length).toBeGreaterThan(0);
      expect(post['x-cleo-gateway']).toMatch(/^(query|mutate)$/);
      // AC2: every op has a 200 response carrying a JSON schema.
      const ok200 = post.responses['200'];
      expect(ok200, `${route} missing 200 response`).toBeDefined();
      expect(ok200.content?.['application/json']?.schema).toBeDefined();
    }
  });

  it('routes every registry entry to its clean /v1/<domain>/<operation> form (AC2)', () => {
    // Non-colliding ops (the vast majority) use the clean path verbatim.
    const pairCounts = new Map<string, number>();
    for (const op of OPERATIONS) {
      const pair = `${op.domain}/${op.operation}`;
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    }
    for (const op of OPERATIONS) {
      const pair = `${op.domain}/${op.operation}`;
      if ((pairCounts.get(pair) ?? 0) > 1) continue; // collisions are gateway-suffixed
      const route = `/v1/${op.domain}/${op.operation}`;
      const item = doc.paths[route];
      expect(item, `missing clean path ${route}`).toBeDefined();
      expect(item.post.operationId).toBe(`${op.gateway}.${op.domain}.${op.operation}`);
      expect(item.post.tags).toContain(op.domain);
    }
  });

  it('all operationIds are unique across the document (OpenAPI invariant)', () => {
    const ids = Object.values(doc.paths).map((p) => p.post.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('projects a representative read op (tasks.show) with requestBody from its params (AC2)', () => {
    const showItem = doc.paths['/v1/tasks/show'];
    expect(showItem).toBeDefined();
    const post = showItem.post;
    expect(post.operationId).toBe('query.tasks.show');
    expect(post['x-cleo-gateway']).toBe('query');

    // requestBody is derived from the op's params — taskId is a required string.
    const reqSchema = post.requestBody?.content['application/json']?.schema as
      | { type?: string; properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(reqSchema).toBeDefined();
    expect(reqSchema?.type).toBe('object');
    expect(reqSchema?.properties).toHaveProperty('taskId');
    expect(reqSchema?.required).toContain('taskId');

    // 200 response wraps the resolved output schema in the LAFS envelope.
    const respSchema = post.responses['200'].content?.['application/json']?.schema as
      | { properties?: { data?: unknown } }
      | undefined;
    expect(respSchema?.properties).toHaveProperty('success');
    expect(respSchema?.properties).toHaveProperty('data');
    expect(respSchema?.properties).toHaveProperty('meta');
  });

  it('every embedded request/response Schema Object compiles under JSON Schema 2020-12 (AC4)', () => {
    const ajv = makeAjv();
    let compiled = 0;
    for (const route of Object.keys(doc.paths)) {
      const post = doc.paths[route].post;
      const reqSchema = post.requestBody?.content['application/json']?.schema;
      if (reqSchema !== undefined) {
        expect(() => ajv.compile(reqSchema), `request schema invalid for ${route}`).not.toThrow();
        compiled++;
      }
      const respSchema = post.responses['200'].content?.['application/json']?.schema;
      expect(respSchema, `${route} missing 200 schema`).toBeDefined();
      if (respSchema !== undefined) {
        expect(() => ajv.compile(respSchema), `response schema invalid for ${route}`).not.toThrow();
        compiled++;
      }
    }
    // Sanity: we actually exercised a substantial number of schemas.
    expect(compiled).toBeGreaterThan(OPERATIONS.length);
  });

  it('honors the version + pathPrefix options', () => {
    const custom = generateOpenApi({ version: '2.5.0', pathPrefix: '/api/v2' });
    expect(custom.info.version).toBe('2.5.0');
    const someOp = OPERATIONS[0];
    expect(custom.paths[`/api/v2/${someOp.domain}/${someOp.operation}`]).toBeDefined();
  });
});
