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

/** Combined input for both format and field extraction layers. */
export interface UnifiedFlagInput {
  // Format layer (§5.1–5.3)
  human?: boolean;
  json?: boolean;
  quiet?: boolean;
  requestedFormat?: 'json' | 'human';
  projectDefault?: 'json' | 'human';
  userDefault?: 'json' | 'human';
  /**
   * TTY detection hint. When true, defaults to human format if no
   * explicit format flag or project/user default is set.
   * CLI tools should pass `process.stdout.isTTY ?? false`.
   */
  tty?: boolean;
  // Field extraction layer (§9.2)
  field?: string;
  fields?: string | string[];
  mvi?: string;
}

/** Combined resolution result with cross-layer warnings. */
export interface UnifiedFlagResolution {
  /** Resolved format layer. */
  format: FlagResolution;
  /** Resolved field extraction layer. */
  fields: FieldExtractionResolution;
  /** Warnings for cross-layer interactions (non-fatal). */
  warnings: string[];
}

/**
 * Resolve all flags across both layers and validate cross-layer semantics.
 *
 * Per §5.4, cross-layer combinations are valid but MAY produce warnings.
 * Format-layer conflicts (E_FORMAT_CONFLICT) and field-layer conflicts
 * (E_FIELD_CONFLICT) still throw as before — they are delegated to the
 * existing single-layer resolvers.
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
