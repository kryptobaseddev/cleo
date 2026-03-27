import type { LAFSEnvelope, Warning } from './types.js';

export interface DeprecationEntry {
  id: string;
  code: string;
  message: string;
  deprecated: string;
  replacement?: string;
  removeBy: string;
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

export function getDeprecationRegistry(): DeprecationEntry[] {
  return DEPRECATION_REGISTRY;
}

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
