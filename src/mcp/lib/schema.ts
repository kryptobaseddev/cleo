/**
 * JSON Schema constants and validation helpers for CLEO MCP Server
 *
 * Defines schema URLs and validation utilities for CLEO data structures.
 *
 * @task T2912
 */

/**
 * Schema URL for output response envelope
 */
export const SCHEMA_URL_OUTPUT = 'https://cleo-dev.com/schemas/v1/output.schema.json';

/**
 * Schema URL for task objects
 */
export const SCHEMA_URL_TASK = 'https://cleo-dev.com/schemas/v1/task.schema.json';

/**
 * Schema URL for session objects
 */
export const SCHEMA_URL_SESSION = 'https://cleo-dev.com/schemas/v1/session.schema.json';

/**
 * Schema URL for manifest entries
 */
export const SCHEMA_URL_MANIFEST = 'https://cleo-dev.com/schemas/v1/manifest.schema.json';

/**
 * Schema URL for config objects
 */
export const SCHEMA_URL_CONFIG = 'https://cleo-dev.com/schemas/v1/config.schema.json';

/**
 * All schema URLs by type
 */
export const SCHEMA_URLS = {
  output: SCHEMA_URL_OUTPUT,
  task: SCHEMA_URL_TASK,
  session: SCHEMA_URL_SESSION,
  manifest: SCHEMA_URL_MANIFEST,
  config: SCHEMA_URL_CONFIG,
} as const;

/**
 * Get schema URL by type
 */
export function getSchemaUrl(type: keyof typeof SCHEMA_URLS): string {
  return SCHEMA_URLS[type];
}

/**
 * Validate that an object has the expected schema reference
 */
export function hasValidSchema(obj: unknown, expectedType: keyof typeof SCHEMA_URLS): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const record = obj as Record<string, unknown>;
  const expectedUrl = SCHEMA_URLS[expectedType];

  return record.$schema === expectedUrl;
}

/**
 * Schema validation error
 */
export class SchemaValidationError extends Error {
  constructor(
    public schemaType: string,
    public field: string,
    public constraint: string
  ) {
    super(`Schema validation failed for ${schemaType}.${field}: ${constraint}`);
    this.name = 'SchemaValidationError';
  }
}
