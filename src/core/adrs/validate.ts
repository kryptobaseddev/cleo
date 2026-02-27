/**
 * ADR Frontmatter Validation (ADR-017)
 *
 * Validates all ADR markdown files against schemas/adr-frontmatter.schema.json.
 *
 * @task T4792
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';
// Handle ESM/CJS interop for Ajv
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
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

/** Validate all ADRs in .cleo/adrs/ against the schema */
export async function validateAllAdrs(projectRoot: string): Promise<ValidationResult> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');
  const schemaPath = join(projectRoot, 'schemas', 'adr-frontmatter.schema.json');

  if (!existsSync(schemaPath)) {
    return {
      valid: false,
      errors: [{ file: 'schemas/adr-frontmatter.schema.json', field: 'schema', message: 'Schema file not found' }],
      checked: 0,
    };
  }

  if (!existsSync(adrsDir)) {
    return { valid: true, errors: [], checked: 0 };
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const files = readdirSync(adrsDir)
    .filter(f => f.endsWith('.md') && f.startsWith('ADR-'))
    .map(f => join(adrsDir, f));

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
