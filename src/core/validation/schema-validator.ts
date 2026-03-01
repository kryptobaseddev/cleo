/**
 * Schema Validator
 *
 * Task validation uses drizzle-zod schemas (src/store/validation-schemas.ts)
 * as the single source of truth for field-level constraints.
 *
 * AJV/JSON Schema validation is retained for the `config` type and backward-
 * compatible `validateSchema()` calls with raw data.
 */

import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction, ErrorObject } from 'ajv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { insertTaskSchema } from '../../store/validation-schemas.js';

// Handle ESM/CJS interop for Ajv and ajv-formats
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Individual validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

/**
 * Schema types that can be validated via AJV/JSON Schema.
 * SQLite-backed types (todo, archive, log, sessions) use drizzle-zod validation instead.
 */
export type SchemaType = 'config';

/**
 * Schema cache to avoid re-reading/re-compiling
 */
const schemaCache = new Map<string, ValidateFunction>();

/**
 * Create an Ajv instance configured for CLEO schemas
 */
function createAjv(): InstanceType<typeof Ajv> {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Shared Ajv instance
 */
let ajvInstance: InstanceType<typeof Ajv> | null = null;

function getAjv(): InstanceType<typeof Ajv> {
  if (!ajvInstance) {
    ajvInstance = createAjv();
  }
  return ajvInstance;
}

/**
 * Resolve path to a schema file.
 * Looks in multiple locations: project schemas/, dist-relative schemas/
 */
function resolveSchemaPath(schemaType: SchemaType): string | null {
  const filename = `${schemaType}.schema.json`;

  // Check project root schemas/ and dist-relative locations
  const projectRoot = process.env.CLEO_ROOT || process.cwd();
  const paths = [
    join(projectRoot, 'schemas', filename),
    join(__dirname, '..', '..', '..', 'schemas', filename), // relative from dist/core/validation/
    join(__dirname, '..', '..', 'schemas', filename),        // relative from dist/core/
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Load and compile a schema, with caching
 */
function getValidator(schemaType: SchemaType): ValidateFunction | null {
  const cached = schemaCache.get(schemaType);
  if (cached) {
    return cached;
  }

  const schemaPath = resolveSchemaPath(schemaType);
  if (!schemaPath) {
    return null;
  }

  try {
    const schemaContent = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);
    const ajv = getAjv();
    const validate = ajv.compile(schema);
    schemaCache.set(schemaType, validate);
    return validate;
  } catch {
    return null;
  }
}

/**
 * Validate data against a CLEO schema
 *
 * @param schemaType - Which schema to validate against
 * @param data - The data to validate
 * @returns Validation result with errors if invalid
 */
export function validateSchema(
  schemaType: SchemaType,
  data: unknown
): ValidationResult {
  const validate = getValidator(schemaType);

  if (!validate) {
    return {
      valid: false,
      errors: [{
        path: '',
        message: `Schema '${schemaType}' not found. Ensure schemas/ directory is accessible.`,
        keyword: 'schema-not-found',
        params: { schemaType },
      }],
    };
  }

  const valid = validate(data);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = (validate.errors || []).map(
    (err: ErrorObject) => ({
      path: err.instancePath || '/',
      message: err.message || 'Validation failed',
      keyword: err.keyword,
      params: err.params as Record<string, unknown>,
    })
  );

  return { valid: false, errors };
}

/**
 * Validate a single task object against the drizzle-zod insert schema.
 * Uses drizzle-derived Zod schemas as the single source of truth for
 * field-level constraints (pattern, length, enum).
 *
 * @param task - Task object to validate
 * @returns Validation result
 */
export function validateTask(task: unknown): ValidationResult {
  if (!task || typeof task !== 'object') {
    return {
      valid: false,
      errors: [{
        path: '',
        message: 'Task must be a non-null object',
        keyword: 'type',
        params: { type: 'object' },
      }],
    };
  }

  const taskObj = task as Record<string, unknown>;
  const errors: ValidationError[] = [];

  // Check required fields that insertTaskSchema marks optional (they have DB defaults)
  const requiredFields = ['id', 'title', 'status', 'priority', 'createdAt'];
  for (const field of requiredFields) {
    if (taskObj[field] === undefined || taskObj[field] === null) {
      errors.push({
        path: `/${field}`,
        message: `Required field '${field}' is missing`,
        keyword: 'required',
        params: { missingProperty: field },
      });
    }
  }

  // Run drizzle-zod schema validation for field-level constraints
  const result = insertTaskSchema.safeParse(task);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = '/' + issue.path.join('/');
      // Skip duplicates already reported by required-fields check
      if (!errors.some((e) => e.path === path)) {
        errors.push({
          path,
          message: issue.message,
          keyword: issue.code,
          params: {},
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Clear the schema cache (useful for testing)
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
  ajvInstance = null;
}
