/**
 * Schema Validator
 *
 * Validates CLEO JSON data against JSON Schema using Ajv.
 * Reuses existing schemas from the schemas/ directory.
 */

import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction, ErrorObject } from 'ajv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

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
 * Schema types that can be validated
 */
export type SchemaType = 'todo' | 'config' | 'archive' | 'log' | 'sessions';

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
    join(__dirname, '..', '..', '..', 'schemas', filename), // relative from dist/mcp/engine/
    join(__dirname, '..', '..', 'schemas', filename),        // relative from dist/mcp/
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
 * Validate a single task object against the task definition in todo.schema.json.
 * This extracts the task definition from the full schema for targeted validation.
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

  // Validate required fields exist
  const requiredFields = ['id', 'title', 'status', 'priority', 'createdAt'];
  const errors: ValidationError[] = [];

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

  // Validate ID format
  if (typeof taskObj.id === 'string' && !/^T\d{3,}$/.test(taskObj.id)) {
    errors.push({
      path: '/id',
      message: 'Task ID must match pattern T followed by 3+ digits (e.g., T001)',
      keyword: 'pattern',
      params: { pattern: '^T\\d{3,}$' },
    });
  }

  // Validate status enum
  const validStatuses = ['pending', 'active', 'blocked', 'done', 'cancelled'];
  if (taskObj.status && !validStatuses.includes(taskObj.status as string)) {
    errors.push({
      path: '/status',
      message: `Status must be one of: ${validStatuses.join(', ')}`,
      keyword: 'enum',
      params: { allowedValues: validStatuses },
    });
  }

  // Validate priority enum
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  if (taskObj.priority && !validPriorities.includes(taskObj.priority as string)) {
    errors.push({
      path: '/priority',
      message: `Priority must be one of: ${validPriorities.join(', ')}`,
      keyword: 'enum',
      params: { allowedValues: validPriorities },
    });
  }

  // Validate title length
  if (typeof taskObj.title === 'string') {
    if (taskObj.title.length === 0) {
      errors.push({
        path: '/title',
        message: 'Title cannot be empty',
        keyword: 'minLength',
        params: { limit: 1 },
      });
    }
    if (taskObj.title.length > 120) {
      errors.push({
        path: '/title',
        message: 'Title cannot exceed 120 characters',
        keyword: 'maxLength',
        params: { limit: 120 },
      });
    }
  }

  // Validate description length
  if (typeof taskObj.description === 'string' && taskObj.description.length > 2000) {
    errors.push({
      path: '/description',
      message: 'Description cannot exceed 2000 characters',
      keyword: 'maxLength',
      params: { limit: 2000 },
    });
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
