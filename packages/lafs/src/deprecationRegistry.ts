import type { LAFSEnvelope, Warning } from './types.js';

/**
 * A single deprecation rule in the registry.
 *
 * @remarks
 * Each entry defines a detector function that inspects an envelope for
 * deprecated usage patterns, along with metadata for generating warnings.
 *
 * @example
 * ```typescript
 * const entry: DeprecationEntry = {
 *   id: "meta-mvi-boolean",
 *   code: "W_DEPRECATED_META_MVI_BOOLEAN",
 *   message: "_meta.mvi boolean values are deprecated",
 *   deprecated: "1.0.0",
 *   replacement: "Use _meta.mvi as one of: minimal|standard|full|custom",
 *   removeBy: "2.0.0",
 *   detector: (env) => typeof env._meta.mvi === "boolean",
 * };
 * ```
 */
export interface DeprecationEntry {
  /** Unique identifier for this deprecation rule */
  id: string;
  /** Warning code emitted when detected */
  code: string;
  /** Human-readable deprecation message */
  message: string;
  /** Version where the feature was deprecated */
  deprecated: string;
  /**
   * Suggested replacement or migration path.
   * @defaultValue `undefined`
   */
  replacement?: string;
  /** Version where the deprecated feature will be removed */
  removeBy: string;
  /** Predicate that returns `true` when the envelope uses the deprecated feature */
  detector: (envelope: LAFSEnvelope) => boolean;
}

const DEPRECATION_REGISTRY: DeprecationEntry[] = [
  {
    id: 'meta-mvi-boolean',
    code: 'W_DEPRECATED_META_MVI_BOOLEAN',
    message: '_meta.mvi boolean values are deprecated',
    deprecated: '1.0.0',
    replacement: 'Use _meta.mvi as one of: minimal|standard|full|custom',
    removeBy: '2.0.0',
    detector: (envelope) =>
      typeof (envelope as { _meta: { mvi: unknown } })._meta.mvi === 'boolean',
  },
];

/**
 * Retrieve all registered deprecation entries.
 *
 * @returns Array of all {@link DeprecationEntry} rules in the registry
 *
 * @remarks
 * Returns the internal registry array by reference. Callers should not
 * mutate the returned array.
 *
 * @example
 * ```typescript
 * const entries = getDeprecationRegistry();
 * console.log(entries.length); // number of registered deprecations
 * ```
 */
export function getDeprecationRegistry(): DeprecationEntry[] {
  return DEPRECATION_REGISTRY;
}

/**
 * Detect deprecated field usage in a LAFS envelope.
 *
 * @param envelope - The LAFS envelope to inspect
 * @returns Array of {@link Warning} objects for each detected deprecation
 *
 * @remarks
 * Runs all registered deprecation detectors against the envelope and returns
 * warnings for each match. Returns an empty array if no deprecations are found.
 *
 * @example
 * ```typescript
 * const warnings = detectDeprecatedEnvelopeFields(envelope);
 * for (const w of warnings) {
 *   console.warn(`${w.code}: ${w.message}`);
 * }
 * ```
 */
export function detectDeprecatedEnvelopeFields(envelope: LAFSEnvelope): Warning[] {
  return getDeprecationRegistry()
    .filter((entry) => entry.detector(envelope))
    .map((entry) => ({
      code: entry.code,
      message: entry.message,
      deprecated: entry.deprecated,
      replacement: entry.replacement,
      removeBy: entry.removeBy,
    }));
}

/**
 * Emit deprecation warnings by attaching them to the envelope metadata.
 *
 * @param envelope - The LAFS envelope to augment
 * @returns A new envelope with deprecation warnings appended to `_meta.warnings`
 *
 * @remarks
 * If no deprecations are detected, the original envelope is returned unchanged
 * (no copy is made). Otherwise, a shallow copy is returned with the warnings
 * array extended.
 *
 * @example
 * ```typescript
 * const enriched = emitDeprecationWarnings(envelope);
 * console.log(enriched._meta.warnings); // includes any deprecation warnings
 * ```
 */
export function emitDeprecationWarnings(envelope: LAFSEnvelope): LAFSEnvelope {
  const detected = detectDeprecatedEnvelopeFields(envelope);
  if (detected.length === 0) {
    return envelope;
  }

  const existingWarnings = envelope._meta.warnings ?? [];
  return {
    ...envelope,
    _meta: {
      ...envelope._meta,
      warnings: [...existingWarnings, ...detected],
    },
  };
}
