/**
 * Field extraction resolution for LAFS envelopes.
 *
 * Implements section 9.2 of the LAFS spec: `--field` extracts a single value
 * as plain text (no envelope), `--fields` filters the JSON envelope to a subset,
 * and `--mvi` controls envelope verbosity.
 *
 * @remarks
 * This module provides both resolution (flag parsing) and runtime extraction/filtering
 * functions. The resolution layer is consumed by the unified resolver in `flagResolver.ts`.
 *
 * @since 1.5.0
 */

import { LAFSFlagError } from './flagSemantics.js';
import type { LAFSEnvelope, MVILevel } from './types.js';
import { isMVILevel } from './types.js';

/**
 * Input flags for the field extraction layer.
 *
 * @remarks
 * Mutually exclusive: `fieldFlag` and `fieldsFlag` cannot both be set.
 * Providing both causes an `E_FIELD_CONFLICT` error during resolution.
 */
export interface FieldExtractionInput {
  /**
   * `--field <name>`: extract a single field as plain text, discarding the envelope.
   * @defaultValue undefined
   */
  fieldFlag?: string;
  /**
   * `--fields <a,b,c>`: filter result to these fields while preserving the envelope.
   * Accepts a comma-separated string or an array of field names.
   * @defaultValue undefined
   */
  fieldsFlag?: string | string[];
  /**
   * `--mvi <level>`: requested envelope verbosity level (client-requestable levels only).
   * The `'custom'` level is server-set and not valid here.
   * @defaultValue undefined
   */
  mviFlag?: MVILevel | string;
}

/**
 * Resolved field extraction configuration.
 *
 * @remarks
 * Produced by {@link resolveFieldExtraction}. Contains the parsed and validated
 * field extraction settings ready for use by extraction and filtering functions.
 */
export interface FieldExtractionResolution {
  /**
   * When set, extract this field as plain text, discarding the envelope.
   * @defaultValue undefined
   */
  field?: string;
  /**
   * When set, filter the result to these fields (envelope is preserved).
   * @defaultValue undefined
   */
  fields?: string[];
  /** Resolved MVI level. Falls back to `'minimal'` when no valid flag is provided. */
  mvi: MVILevel;
  /** Which input determined the mvi value: `'flag'` when mviFlag was valid, `'default'` otherwise. */
  mviSource: 'flag' | 'default';
  /**
   * True when `fields` are requested, indicating the server SHOULD set
   * `_meta.mvi = 'custom'` in the response per section 9.1.
   * Separate from the client-resolved mvi level.
   */
  expectsCustomMvi: boolean;
}

/**
 * Resolve field extraction flags into a validated configuration.
 *
 * @param input - The field extraction flag inputs
 * @returns The resolved extraction configuration with mvi level and source
 *
 * @remarks
 * Parses and validates the `--field`, `--fields`, and `--mvi` flags. Throws
 * `E_FIELD_CONFLICT` if both `--field` and `--fields` are provided. The `'custom'`
 * MVI level is server-set per section 9.1 and is rejected as a client-requested value;
 * invalid or absent `--mvi` falls back to `'minimal'`.
 *
 * @example
 * ```ts
 * const resolution = resolveFieldExtraction({ fieldsFlag: 'id,title' });
 * // => { fields: ['id', 'title'], mvi: 'minimal', mviSource: 'default', expectsCustomMvi: true }
 * ```
 *
 * @throws {@link LAFSFlagError} When both `fieldFlag` and `fieldsFlag` are set.
 */
export function resolveFieldExtraction(input: FieldExtractionInput): FieldExtractionResolution {
  if (input.fieldFlag && input.fieldsFlag) {
    throw new LAFSFlagError(
      'E_FIELD_CONFLICT',
      'Cannot combine --field and --fields: --field extracts a single value ' +
        'as plain text (no envelope); --fields filters the JSON envelope. ' +
        'Use one or the other.',
      { conflictingModes: ['single-field-extraction', 'multi-field-filter'] },
    );
  }

  const fields =
    typeof input.fieldsFlag === 'string'
      ? input.fieldsFlag
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      : Array.isArray(input.fieldsFlag)
        ? input.fieldsFlag.map((f) => f.trim()).filter(Boolean)
        : undefined;

  // 'custom' is server-set (§9.1) — not a client-requestable level
  const validMvi = isMVILevel(input.mviFlag) && input.mviFlag !== 'custom';
  const mvi: MVILevel = validMvi ? (input.mviFlag as MVILevel) : 'minimal';
  const mviSource: FieldExtractionResolution['mviSource'] = validMvi ? 'flag' : 'default';

  const hasFields = (fields?.length ?? 0) > 0;

  return {
    field: input.fieldFlag || undefined,
    fields: hasFields ? fields : undefined,
    mvi,
    mviSource,
    expectsCustomMvi: hasFields,
  };
}

/**
 * Extract a named field from a LAFS result object.
 *
 * @param result - The envelope result value (object, array, or null)
 * @param field - The field name to extract
 * @returns The extracted value, or `undefined` if not found at any level
 *
 * @remarks
 * Handles four result shapes:
 *   1. Direct array: `result[0][field]` (list operations where result IS an array)
 *   2. Direct: `result[field]` (flat result object)
 *   3. Nested: `result.<key>[field]` (wrapper-entity, e.g. `result.task.title`)
 *   4. Array value: `result.<key>[0][field]` (wrapper-array, e.g. `result.items[0].title`)
 *
 * Returns the value from the first match only. For array results (shapes 1
 * and 4), returns the first element's field value only. To extract from all
 * elements, iterate the array or use {@link applyFieldFilter}.
 *
 * When multiple wrapper keys contain the requested field (shapes 3 and 4),
 * the first key in property insertion order wins.
 *
 * @example
 * ```ts
 * const result = { task: { id: 'T1', title: 'Fix bug' } };
 * extractFieldFromResult(result, 'title'); // => 'Fix bug'
 * ```
 */
export function extractFieldFromResult(result: LAFSEnvelope['result'], field: string): unknown {
  if (result === null || typeof result !== 'object') return undefined;

  // Shape 1: result is a direct array
  if (Array.isArray(result)) {
    if (result.length === 0) return undefined;
    const first = result[0] as Record<string, unknown>;
    if (first && typeof first === 'object' && field in first) return first[field];
    return undefined;
  }

  // Shape 2: direct property on result object
  const record = result as Record<string, unknown>;
  if (field in record) return record[field];

  // Shapes 3 & 4: one level down (first matching key in insertion order wins)
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if (field in nested) return nested[field];
    }
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as Record<string, unknown>;
      if (first && typeof first === 'object' && field in first) return first[field];
    }
  }

  return undefined;
}

/**
 * Extract a named field from an envelope's result.
 *
 * @param envelope - The LAFS envelope to extract from
 * @param field - The field name to extract
 * @returns The extracted value, or `undefined` if not found
 *
 * @remarks
 * Convenience wrapper around {@link extractFieldFromResult} that accepts
 * the full envelope and delegates to the result extraction logic.
 *
 * @example
 * ```ts
 * const value = extractFieldFromEnvelope(envelope, 'title');
 * ```
 */
export function extractFieldFromEnvelope(envelope: LAFSEnvelope, field: string): unknown {
  return extractFieldFromResult(envelope.result, field);
}

/**
 * Filter result fields in a LAFS envelope to the requested subset.
 *
 * @param envelope - The LAFS envelope whose result will be filtered
 * @param fields - Array of field names to retain in the result
 * @returns A new envelope with the filtered result and `_meta.mvi` set to `'custom'`
 *
 * @remarks
 * Handles the same four result shapes as {@link extractFieldFromResult}:
 *   1. Direct array: project each element
 *   2. Flat result: project top-level keys
 *   3. Wrapper-entity: project nested entity's keys, preserve wrapper
 *   4. Wrapper-array: project each element's keys, preserve wrapper
 *
 * Sets `_meta.mvi = 'custom'` per section 9.1.
 * Returns a new envelope with a new `_meta` object. Result values are not
 * deep-cloned; nested object references are shared with the original.
 * Unknown field names are silently omitted per section 9.2.
 *
 * When result is a wrapper (shapes 3/4) with multiple keys, each key is
 * projected independently. Primitive values at the wrapper level (numbers,
 * strings, booleans) are preserved as-is; field filtering is applied to nested
 * entity or array keys only, not to the wrapper's own primitive keys.
 *
 * @example
 * ```ts
 * const filtered = applyFieldFilter(envelope, ['id', 'title']);
 * // filtered.result contains only 'id' and 'title' fields
 * // filtered._meta.mvi === 'custom'
 * ```
 */
export function applyFieldFilter(envelope: LAFSEnvelope, fields: string[]): LAFSEnvelope {
  if (fields.length === 0 || envelope.result === null) return envelope;

  const pick = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));

  let filtered: LAFSEnvelope['result'];

  if (Array.isArray(envelope.result)) {
    // Shape 1: direct array
    filtered = (envelope.result as Record<string, unknown>[]).map(pick);
  } else {
    const record = envelope.result as Record<string, unknown>;
    const topLevelMatch = fields.some((f) => f in record);

    if (topLevelMatch) {
      // Shape 2: flat result
      filtered = pick(record);
    } else {
      // Shapes 3 & 4: wrapper — apply pick one level down, preserve wrapper keys
      filtered = Object.fromEntries(
        Object.entries(record).map(([k, v]) => {
          if (Array.isArray(v)) {
            return [k, v.map((item) => pick(item as Record<string, unknown>))];
          }
          if (v && typeof v === 'object') {
            return [k, pick(v as Record<string, unknown>)];
          }
          return [k, v];
        }),
      );
    }
  }

  return {
    ...envelope,
    _meta: { ...envelope._meta, mvi: 'custom' as MVILevel },
    result: filtered,
  };
}
