/**
 * JSON Schema validation engine using ajv.
 * @epic T4454
 * @task T4458
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { readJson } from '../store/json.js';
import { CleoError } from './errors.js';
import { ExitCode } from '../types/exit-codes.js';

// Handle ESM/CJS interop for Ajv and ajv-formats
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

/** Singleton ajv instance. */
let ajvInstance: any = null;

function getAjv(): any {
  if (!ajvInstance) {
    ajvInstance = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
    });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

/** Compiled schema cache. */
const schemaCache = new Map<string, ValidateFunction>();

/**
 * Validate data against a JSON Schema object.
 * Throws CleoError on validation failure.
 */
export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
  schemaId?: string,
): void {
  const ajv = getAjv();
  const cacheKey = schemaId ?? JSON.stringify(schema);

  let validate = schemaCache.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(schema) as ValidateFunction;
    schemaCache.set(cacheKey, validate);
  }

  if (!validate(data)) {
    const errors = validate.errors
      ?.map((e: { instancePath?: string; message?: string }) =>
        `${e.instancePath || '/'}: ${e.message}`,
      )
      .join('; ');
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Schema validation failed: ${errors ?? 'unknown error'}`,
    );
  }
}

/**
 * Load a JSON Schema file and validate data against it.
 */
export async function validateAgainstSchemaFile(
  data: unknown,
  schemaPath: string,
): Promise<void> {
  const schema = await readJson<Record<string, unknown>>(schemaPath);
  if (!schema) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Schema file not found: ${schemaPath}`,
    );
  }
  validateAgainstSchema(data, schema, schemaPath);
}

/**
 * Check if data is valid against a schema without throwing.
 * Returns an array of error messages (empty if valid).
 */
export function checkSchema(
  data: unknown,
  schema: Record<string, unknown>,
): string[] {
  try {
    validateAgainstSchema(data, schema);
    return [];
  } catch (err) {
    if (err instanceof CleoError) {
      return [err.message];
    }
    return [String(err)];
  }
}
