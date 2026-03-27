import { createRequire } from 'node:module';
import envelopeSchema from '../schemas/v1/envelope.schema.json' with { type: 'json' };
import type { LAFSEnvelope } from './types.js';

const require = createRequire(import.meta.url);
const AjvModule = require('ajv') as
  | { default?: new (opts: object) => unknown }
  | (new (
      opts: object,
    ) => unknown);
const AddFormatsModule = require('ajv-formats') as
  | { default?: (ajv: unknown) => void }
  | ((ajv: unknown) => void);

const AjvCtor = (typeof AjvModule === 'function' ? AjvModule : AjvModule.default) as new (
  opts: object,
) => {
  compile: (schema: unknown) => {
    (input: unknown): boolean;
    errors?: Array<{
      instancePath?: string;
      keyword?: string;
      message?: string;
      params?: Record<string, unknown>;
    }>;
  };
};

const addFormats = (
  typeof AddFormatsModule === 'function' ? AddFormatsModule : AddFormatsModule.default
) as (ajv: unknown) => void;

const ajv = new AjvCtor({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const validate = ajv.compile(envelopeSchema);

/** Structured representation of a single validation error from AJV */
export interface StructuredValidationError {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface EnvelopeValidationResult {
  valid: boolean;
  errors: string[];
  structuredErrors: StructuredValidationError[];
}

export function validateEnvelope(input: unknown): EnvelopeValidationResult {
  const valid = validate(input);
  if (valid) {
    return { valid: true, errors: [], structuredErrors: [] };
  }

  const structuredErrors: StructuredValidationError[] = (validate.errors ?? []).map(
    (error: {
      instancePath?: string;
      keyword?: string;
      message?: string;
      params?: Record<string, unknown>;
    }) => ({
      path: error.instancePath || '/',
      keyword: error.keyword ?? 'unknown',
      message: error.message ?? 'validation error',
      params: error.params ?? {},
    }),
  );

  const errors = structuredErrors.map((se) => `${se.path} ${se.message}`.trim());

  return { valid: false, errors, structuredErrors };
}

export function assertEnvelope(input: unknown): LAFSEnvelope {
  const result = validateEnvelope(input);
  if (!result.valid) {
    throw new Error(`Invalid LAFS envelope: ${result.errors.join('; ')}`);
  }
  return input as LAFSEnvelope;
}
