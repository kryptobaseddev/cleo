/**
 * ADR Frontmatter Validation (ADR-017)
 *
 * Validates all ADR markdown files against schemas/adr-frontmatter.schema.json.
 *
 * @task T4792
 * @task T14108 — reads the canon ADR home instead of `.cleo/adrs/`
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ajv as AjvInstance } from 'ajv';
import { default as AjvImport } from 'ajv';

// Handle ESM/CJS interop for Ajv
const ajvMod = AjvImport as Record<string, unknown>;
const Ajv = (typeof ajvMod.default === 'function' ? ajvMod.default : AjvImport) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

import { getPackageRoot } from '../scaffold/ensure-config.js';
import { listAdrFiles } from './home.js';
import { parseAdrFile } from './parse.js';

export interface ValidationError {
  file: string;
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  checked: number;
}

/** @alias ValidationError — canonical name per ADR-017 spec */
export type AdrValidationError = ValidationError;

/** @alias ValidationResult — canonical name per ADR-017 spec */
export type AdrValidationResult = ValidationResult;

/** Validate all ADRs in the ADR home against the schema */
// SSoT-EXEMPT: zero-params op — no Params contract needed; ADR-057 D1 applies to parameterized ops only
export async function validateAllAdrs(projectRoot: string): Promise<ValidationResult> {
  // A project may pin its own schema; otherwise use the one @cleocode/core ships (T14108).
  const projectSchema = join(projectRoot, 'schemas', 'adr-frontmatter.schema.json');
  const schemaPath = existsSync(projectSchema)
    ? projectSchema
    : join(getPackageRoot(), 'schemas', 'adr-frontmatter.schema.json');

  if (!existsSync(schemaPath)) {
    return {
      valid: false,
      errors: [
        {
          file: 'schemas/adr-frontmatter.schema.json',
          field: 'schema',
          message: 'Schema file not found',
        },
      ],
      checked: 0,
    };
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const files = listAdrFiles(projectRoot).map((f) => f.absPath);

  const errors: ValidationError[] = [];

  for (const filePath of files) {
    const record = parseAdrFile(filePath, projectRoot);
    const valid = validate(record.frontmatter);
    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        errors.push({
          file: filePath.replace(projectRoot + '/', ''),
          field: err.instancePath ? err.instancePath.replace('/', '') : 'root',
          message: err.message ?? 'Validation error',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, checked: files.length };
}
