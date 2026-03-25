import { LAFSFlagError } from "./flagSemantics.js";
import { isMVILevel } from "./types.js";
import type { LAFSEnvelope, MVILevel } from "./types.js";

export interface FieldExtractionInput {
  /** --field <name>: extract single field as plain text, no envelope */
  fieldFlag?: string;
  /** --fields <a,b,c>: filter result to these fields, preserve envelope */
  fieldsFlag?: string | string[];
  /** --mvi <level>: envelope verbosity (client-requestable levels only) */
  mviFlag?: MVILevel | string;
}

export interface FieldExtractionResolution {
  /** When set: extract this field as plain text, discard envelope. */
  field?: string;
  /** When set: filter result to these fields (envelope preserved). */
  fields?: string[];
  /** Resolved MVI level. Defaults to 'standard'. */
  mvi: MVILevel;
  /** Which input determined the mvi value: 'flag' when mviFlag was valid, 'default' otherwise. */
  mviSource: "flag" | "default";
  /**
   * True when _fields are requested, indicating the server SHOULD set
   * _meta.mvi = 'custom' in the response per §9.1.
   * Separate from the client-resolved mvi level.
   */
  expectsCustomMvi: boolean;
}

export function resolveFieldExtraction(
  input: FieldExtractionInput,
): FieldExtractionResolution {
  if (input.fieldFlag && input.fieldsFlag) {
    throw new LAFSFlagError(
      'E_FIELD_CONFLICT',
      'Cannot combine --field and --fields: --field extracts a single value '
      + 'as plain text (no envelope); --fields filters the JSON envelope. '
      + 'Use one or the other.',
      { conflictingModes: ['single-field-extraction', 'multi-field-filter'] },
    );
  }

  const fields = typeof input.fieldsFlag === 'string'
    ? input.fieldsFlag.split(',').map(f => f.trim()).filter(Boolean)
    : Array.isArray(input.fieldsFlag)
      ? input.fieldsFlag.map(f => f.trim()).filter(Boolean)
      : undefined;

  // 'custom' is server-set (§9.1) — not a client-requestable level
  const validMvi = isMVILevel(input.mviFlag) && input.mviFlag !== 'custom';
  const mvi: MVILevel = validMvi ? input.mviFlag as MVILevel : 'minimal';
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
 * Handles four result shapes:
 *   1. Direct array: result[0][field]       (list operations where result IS an array)
 *   2. Direct:       result[field]          (flat result object)
 *   3. Nested:       result.<key>[field]    (wrapper-entity, e.g. result.task.title)
 *   4. Array value:  result.<key>[0][field] (wrapper-array, e.g. result.items[0].title)
 *
 * Returns the value from the first match only. For array results (shapes 1
 * and 4), returns the first element's field value only. To extract from all
 * elements, iterate the array or use applyFieldFilter().
 *
 * When multiple wrapper keys contain the requested field (shapes 3 and 4),
 * the first key in property insertion order wins.
 *
 * Returns undefined if not found at any level.
 */
export function extractFieldFromResult(
  result: LAFSEnvelope['result'],
  field: string,
): unknown {
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

/** Convenience wrapper — extracts a field from an envelope's result. */
export function extractFieldFromEnvelope(
  envelope: LAFSEnvelope,
  field: string,
): unknown {
  return extractFieldFromResult(envelope.result, field);
}

/**
 * Filter result fields in a LAFS envelope to the requested subset.
 *
 * Handles the same four result shapes as extractFieldFromResult:
 *   1. Direct array:    project each element
 *   2. Flat result:     project top-level keys
 *   3. Wrapper-entity:  project nested entity's keys, preserve wrapper
 *   4. Wrapper-array:   project each element's keys, preserve wrapper
 *
 * Sets _meta.mvi = 'custom' per §9.1.
 * Returns a new envelope with a new _meta object. Result values are not
 * deep-cloned; nested object references are shared with the original.
 * Unknown field names are silently omitted per §9.2.
 *
 * When result is a wrapper (shapes 3/4) with multiple keys, each key is
 * projected independently. Primitive values at the wrapper level (numbers,
 * strings, booleans) are preserved as-is — _fields is applied to nested
 * entity or array keys only, not to the wrapper's own primitive keys.
 */
export function applyFieldFilter(
  envelope: LAFSEnvelope,
  fields: string[],
): LAFSEnvelope {
  if (fields.length === 0 || envelope.result === null) return envelope;

  const pick = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(fields.filter(f => f in obj).map(f => [f, obj[f]]));

  let filtered: LAFSEnvelope['result'];

  if (Array.isArray(envelope.result)) {
    // Shape 1: direct array
    filtered = (envelope.result as Record<string, unknown>[]).map(pick);
  } else {
    const record = envelope.result as Record<string, unknown>;
    const topLevelMatch = fields.some(f => f in record);

    if (topLevelMatch) {
      // Shape 2: flat result
      filtered = pick(record);
    } else {
      // Shapes 3 & 4: wrapper — apply pick one level down, preserve wrapper keys
      filtered = Object.fromEntries(
        Object.entries(record).map(([k, v]) => {
          if (Array.isArray(v)) {
            return [k, v.map(item => pick(item as Record<string, unknown>))];
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
