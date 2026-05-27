/**
 * Unified cross-layer flag resolver.
 *
 * Composes format resolution (§5.1–5.3) with field extraction resolution (§9.2)
 * and validates cross-layer interactions per §5.4.
 *
 * @since 1.6.0
 */

import type { FieldExtractionInput } from './fieldExtraction.js';
import { type FieldExtractionResolution, resolveFieldExtraction } from './fieldExtraction.js';
import { type FlagResolution, resolveOutputFormat } from './flagSemantics.js';
import type { FlagInput } from './types.js';

/**
 * Combined input for both format and field extraction layers.
 *
 * @remarks
 * Merges the format-layer flags (sections 5.1-5.3) with the field extraction
 * flags (section 9.2) into a single input object for {@link resolveFlags}.
 */
export interface UnifiedFlagInput {
  /**
   * Request human-readable output (`--human` flag).
   * @defaultValue undefined
   */
  human?: boolean;
  /**
   * Request JSON output (`--json` flag).
   * @defaultValue undefined
   */
  json?: boolean;
  /**
   * Suppress non-essential output for scripting (`--quiet` flag).
   * @defaultValue undefined
   */
  quiet?: boolean;
  /**
   * Explicit format override, taking highest precedence in the format layer.
   * @defaultValue undefined
   */
  requestedFormat?: 'json' | 'human';
  /**
   * Project-level default format from configuration.
   * @defaultValue undefined
   */
  projectDefault?: 'json' | 'human';
  /**
   * User-level default format from configuration.
   * @defaultValue undefined
   */
  userDefault?: 'json' | 'human';
  /**
   * TTY detection hint. When true, defaults to human format if no
   * explicit format flag or project/user default is set.
   * CLI tools should pass `process.stdout.isTTY ?? false`.
   * @defaultValue undefined
   */
  tty?: boolean;
  /**
   * Extract a single field as plain text, discarding the envelope (`--field` flag).
   * @defaultValue undefined
   */
  field?: string;
  /**
   * Filter result to these fields while preserving the envelope (`--fields` flag).
   * Accepts a comma-separated string or an array of field names.
   * @defaultValue undefined
   */
  fields?: string | string[];
  /**
   * Requested MVI verbosity level (`--mvi` flag).
   * @defaultValue undefined
   */
  mvi?: string;
}

/**
 * Combined resolution result with cross-layer warnings.
 *
 * @remarks
 * Contains the independently resolved format and field extraction layers plus
 * any cross-layer interaction warnings produced during validation (section 5.4).
 */
export interface UnifiedFlagResolution {
  /** Resolved format layer from the format precedence chain. */
  format: FlagResolution;
  /** Resolved field extraction layer from field/fields/mvi flags. */
  fields: FieldExtractionResolution;
  /** Warnings for cross-layer interactions (non-fatal, informational only). */
  warnings: string[];
}

/**
 * Resolve all flags across both layers and validate cross-layer semantics.
 *
 * @param input - Combined format and field extraction flags
 * @returns The unified resolution containing format, fields, and any cross-layer warnings
 *
 * @remarks
 * Delegates to {@link resolveOutputFormat} for the format layer and
 * {@link resolveFieldExtraction} for the field extraction layer, then performs
 * cross-layer validation per section 5.4. Cross-layer combinations are valid but
 * MAY produce informational warnings. Format-layer conflicts (`E_FORMAT_CONFLICT`)
 * and field-layer conflicts (`E_FIELD_CONFLICT`) still throw as before; they are
 * delegated to the existing single-layer resolvers.
 *
 * @example
 * ```ts
 * const result = resolveFlags({ human: true, field: 'title' });
 * // result.format => { format: 'human', source: 'flag', quiet: false }
 * // result.fields => { field: 'title', mvi: 'minimal', ... }
 * // result.warnings => ['Cross-layer: --human + --field "title". ...']
 * ```
 *
 * @throws {@link LAFSFlagError} When format or field layer flags conflict.
 */
export function resolveFlags(input: UnifiedFlagInput): UnifiedFlagResolution {
  const formatInput: FlagInput = {
    humanFlag: input.human,
    jsonFlag: input.json,
    quiet: input.quiet,
    requestedFormat: input.requestedFormat,
    projectDefault: input.projectDefault,
    userDefault: input.userDefault,
    tty: input.tty,
  };
  const format = resolveOutputFormat(formatInput);

  const fieldInput: FieldExtractionInput = {
    fieldFlag: input.field,
    fieldsFlag: input.fields,
    mviFlag: input.mvi,
  };
  const fields = resolveFieldExtraction(fieldInput);

  // Cross-layer validation (§5.4)
  const warnings: string[] = [];

  if (format.format === 'human' && fields.field) {
    warnings.push(
      `Cross-layer: --human + --field "${fields.field}". ` +
        'Field extraction applies first, then human rendering (§5.4.1).',
    );
  }

  if (format.format === 'human' && fields.fields && fields.fields.length > 0) {
    warnings.push(
      `Cross-layer: --human + --fields [${fields.fields.join(', ')}]. ` +
        'Field filtering applies first, then human rendering (§5.4.1).',
    );
  }

  return { format, fields, warnings };
}
