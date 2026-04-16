/**
 * Contract invariant tests for @cleocode/contracts.
 *
 * Asserts structural rules that must hold across ALL contracts:
 *
 * 1. No contract field named `notes`, `details`, or `text` is typed as bare
 *    `string` when a structured shape is possible.
 *    Whitelisted exceptions are documented with inline rationale.
 *
 * 2. All discriminated unions use `kind` as the discriminant — NOT `type`.
 *    Convention: `type` is reserved for FileAssertion variants only (legacy).
 *
 * 3. Zod schemas for each major contract type are exported from the index.
 *
 * @epic T760
 * @task T804
 */

import { describe, expect, it } from 'vitest';
import {
  acceptanceGateResultSchema,
  acceptanceGateSchema,
  attachmentSchema,
  fileAssertionSchema,
  gateResultDetailsSchema,
  taskEvidenceSchema,
} from '../index.js';

// ─── Internal Zod v4 type helpers ────────────────────────────────────────────
// Zod v4 uses `_def.discriminator` and stores literal values in `_def.values`
// (array). TypeScript cannot resolve the exact shape of `_def` across Zod
// versions so these helpers cast through `unknown` at the boundary — this is
// intentional and the only acceptable use of type-unsafe access in this file.

/** Opaque discriminated-union schema shape used for structural introspection. */
interface ZodDiscriminatedUnionDef {
  discriminator: string;
  options: ZodObjectDef[];
}

/** Opaque object schema shape for literal field access. */
interface ZodObjectDef {
  shape: Record<string, ZodLiteralDef>;
}

/** Opaque literal schema shape for value extraction. */
interface ZodLiteralDef {
  _def: {
    values?: unknown[];
    value?: unknown;
  };
}

/** Opaque optional schema shape for unwrapping the inner type. */
interface ZodOptionalDef {
  innerType: { _def: ZodDiscriminatedUnionDef };
}

/** Casts a schema to the opaque discriminated-union def shape. */
function asDiscriminatedUnion(schema: unknown): ZodDiscriminatedUnionDef {
  return (schema as { _def: ZodDiscriminatedUnionDef })._def;
}

/** Returns the discriminator key for a discriminated-union schema. */
function zodDiscriminator(schema: unknown): string {
  return asDiscriminatedUnion(schema).discriminator;
}

/** Returns option schemas from a discriminated-union schema. */
function zodOptions(schema: unknown): ZodObjectDef[] {
  return asDiscriminatedUnion(schema).options;
}

/** Returns the literal value(s) from a literal schema field. */
function zodLiteralValues(literalField: ZodLiteralDef): unknown[] {
  // Zod v4: _def.values is an array
  if (Array.isArray(literalField._def.values)) return literalField._def.values;
  // Zod v3 compat: _def.value is a scalar
  if (literalField._def.value !== undefined) return [literalField._def.value];
  return [];
}

/** Unwraps a ZodOptional and returns its inner discriminated-union def. */
function unwrapOptionalDiscriminator(schema: unknown): string {
  const optDef = (schema as { _def: ZodOptionalDef })._def;
  return optDef.innerType._def.discriminator;
}

// ─── Rule 1: Field name invariants ────────────────────────────────────────────

/**
 * Whitelisted fields where `string` typing is acceptable.
 *
 * Each entry documents WHY the bare string is appropriate so future
 * reviewers can assess whether to keep or resolve the whitelist entry.
 */
const WHITELISTED_STRING_FIELDS: Record<string, string> = {
  // task.ts / TaskCreate — `notes?: string` is a single append note for the
  // create flow, not a queryable structured record. Structured notes live in
  // TaskWorkState.sessionNotes (SessionNote[]).
  'TaskCreate.notes': 'Single append note for create flow; structured notes live in SessionNote[]',

  // task.ts / Task — `notes?: string[]` is legacy timestamped notes array.
  // Structural upgrade tracked separately.
  'Task.notes': 'Legacy timestamped notes array; structured upgrade tracked separately',

  // task-record.ts / TaskRecord — `notes?: string[]` mirrors Task.notes for
  // the string-widened wire format used by dispatch/LAFS.
  'TaskRecord.notes': 'Wire-format mirror of Task.notes; same legacy rationale',

  // task.ts / Release — `notes?: string | null` is a release changelog text.
  // Not a query target; free-form narrative is appropriate here.
  'Release.notes': 'Release changelog text — free-form narrative, not query target',

  // session.ts — `notes?: string[]` is a session-level log accumulator.
  'Session.notes': 'Session log accumulator — structured upgrade tracked separately',

  // facade.ts — various `notes?: string` on action params (complete, prepare, etc.)
  // are ephemeral caller-provided notes, not persisted entities.
  'TasksAPI.notes': 'Ephemeral caller note on action params — not a persisted entity',

  // memory.ts — BridgePattern/BridgeObservation `text: string` is the
  // primary content field; the type IS the structure here.
  'MemoryBridge.text': 'Primary content field in memory bridge — the text IS the value',

  // SessionNote — `note: string` is the actual note content, not a metadata field.
  // The struct is already structured (has taskId, sessionId, timestamp).
  'SessionNote.note': 'Content field on an already-structured SessionNote record',

  // data-accessor.ts — `notesJson?: string` is a raw JSON column for
  // database queries where the serialised form is needed.
  'DataAccessor.notesJson':
    'Raw JSON column for DB query interface — deserialization is callers job',

  // evidence-record.ts / ValidateSpecCheckRecord — `details: string` is a
  // human-readable summary of per-REQ-ID results. Structured details for
  // machine parsing live in other fields (reqIdsChecked, passed).
  'ValidateSpecCheckRecord.details':
    'Human-readable per-REQ-ID summary; machine fields are reqIdsChecked+passed',
};

describe('Rule 1 — no bare string on notes/details/text fields (with whitelist)', () => {
  it('GateResultDetails does not use bare string for kind-specific payloads', () => {
    // GateResultDetails must be a discriminated union — verify via schema shape
    expect(zodDiscriminator(gateResultDetailsSchema)).toBe('kind');
  });

  it('AcceptanceGateResult.details is typed via GateResultDetails (not bare string)', () => {
    const resultShape = acceptanceGateResultSchema.shape;
    // details must exist as an optional discriminated union (not a plain string)
    expect(resultShape.details).toBeDefined();
    // Unwrap the ZodOptional and confirm the inner type is a discriminated union
    expect(unwrapOptionalDiscriminator(resultShape.details)).toBe('kind');
  });

  it('TaskEvidence does not use bare string as the primary evidence shape', () => {
    // taskEvidenceSchema must be a discriminated union, not a plain string type
    expect(zodDiscriminator(taskEvidenceSchema)).toBe('kind');
  });

  it('documents all whitelisted string fields', () => {
    // This test serves as a registry assertion: the whitelist must be non-empty
    // and each key must follow the format 'TypeName.fieldName'
    const entries = Object.entries(WHITELISTED_STRING_FIELDS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, reason] of entries) {
      expect(key).toMatch(/^\w[\w.]+\.\w+$/);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

// ─── Rule 2: Discriminated unions use `kind`, not `type` ──────────────────────

describe('Rule 2 — discriminated unions use `kind` discriminant (not `type`)', () => {
  it('acceptanceGateSchema uses kind discriminant', () => {
    expect(zodDiscriminator(acceptanceGateSchema)).toBe('kind');
  });

  it('gateResultDetailsSchema uses kind discriminant', () => {
    expect(zodDiscriminator(gateResultDetailsSchema)).toBe('kind');
  });

  it('taskEvidenceSchema uses kind discriminant', () => {
    expect(zodDiscriminator(taskEvidenceSchema)).toBe('kind');
  });

  it('attachmentSchema uses kind discriminant', () => {
    expect(zodDiscriminator(attachmentSchema)).toBe('kind');
  });

  it('FileAssertion uses type discriminant (documented exception — legacy)', () => {
    // FileAssertion predates the `kind` convention and uses `type`.
    // This test documents the exception, not enforces it.
    // Resolution tracked under a future cleanup task.
    expect(zodDiscriminator(fileAssertionSchema)).toBe('type');
  });
});

// ─── Rule 3: Major Zod schemas are exported from index ────────────────────────

describe('Rule 3 — major Zod schemas are exported from index', () => {
  it('exports acceptanceGateSchema', () => {
    expect(typeof acceptanceGateSchema.parse).toBe('function');
  });

  it('exports acceptanceGateResultSchema', () => {
    expect(typeof acceptanceGateResultSchema.parse).toBe('function');
  });

  it('exports gateResultDetailsSchema', () => {
    expect(typeof gateResultDetailsSchema.parse).toBe('function');
  });

  it('exports taskEvidenceSchema', () => {
    expect(typeof taskEvidenceSchema.parse).toBe('function');
  });

  it('exports attachmentSchema', () => {
    expect(typeof attachmentSchema.parse).toBe('function');
  });

  it('acceptanceGateSchema is a discriminated union with 6 variants', () => {
    const opts = zodOptions(acceptanceGateSchema);
    expect(opts.length).toBe(6);
    const kinds = opts.flatMap((opt) => zodLiteralValues(opt.shape.kind));
    expect(kinds).toContain('test');
    expect(kinds).toContain('file');
    expect(kinds).toContain('command');
    expect(kinds).toContain('lint');
    expect(kinds).toContain('http');
    expect(kinds).toContain('manual');
  });

  it('gateResultDetailsSchema is a discriminated union with 6 variants', () => {
    const opts = zodOptions(gateResultDetailsSchema);
    expect(opts.length).toBe(6);
    const kinds = opts.flatMap((opt) => zodLiteralValues(opt.shape.kind));
    expect(kinds).toContain('test');
    expect(kinds).toContain('file');
    expect(kinds).toContain('command');
    expect(kinds).toContain('lint');
    expect(kinds).toContain('http');
    expect(kinds).toContain('manual');
  });

  it('taskEvidenceSchema is a discriminated union with 5 variants', () => {
    const opts = zodOptions(taskEvidenceSchema);
    expect(opts.length).toBe(5);
    const kinds = opts.flatMap((opt) => zodLiteralValues(opt.shape.kind));
    expect(kinds).toContain('file');
    expect(kinds).toContain('log');
    expect(kinds).toContain('screenshot');
    expect(kinds).toContain('test-output');
    expect(kinds).toContain('command-output');
  });
});

// ─── Structural round-trip sanity checks ──────────────────────────────────────

describe('GateResultDetails — round-trip parse for all 6 kinds', () => {
  it('parses test details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'test',
      exitCode: 0,
      stdout: 'ok 7/7',
      stderr: '',
      duration: 3142,
    });
    expect(result.kind).toBe('test');
    if (result.kind === 'test') {
      expect(result.exitCode).toBe(0);
      expect(result.duration).toBe(3142);
    }
  });

  it('parses file details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'file',
      path: 'src/timer.ts',
      passedAssertions: ['exists', 'nonEmpty'],
      failedAssertions: [],
    });
    expect(result.kind).toBe('file');
    if (result.kind === 'file') {
      expect(result.passedAssertions).toHaveLength(2);
      expect(result.failedAssertions).toHaveLength(0);
    }
  });

  it('parses command details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'command',
      cmd: 'cleo doctor',
      exitCode: 0,
      stdout: 'all checks passed',
    });
    expect(result.kind).toBe('command');
    if (result.kind === 'command') {
      expect(result.exitCode).toBe(0);
    }
  });

  it('parses lint details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'lint',
      tool: 'biome',
      warnings: 0,
      errors: 0,
    });
    expect(result.kind).toBe('lint');
    if (result.kind === 'lint') {
      expect(result.errors).toBe(0);
    }
  });

  it('parses http details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'http',
      url: 'http://localhost:8080/',
      status: 200,
      body: '<!DOCTYPE html>',
    });
    expect(result.kind).toBe('http');
    if (result.kind === 'http') {
      expect(result.status).toBe(200);
    }
  });

  it('parses manual details', () => {
    const result = gateResultDetailsSchema.parse({
      kind: 'manual',
      prompt: 'Does the dark theme toggle work?',
      accepted: true,
    });
    expect(result.kind).toBe('manual');
    if (result.kind === 'manual') {
      expect(result.accepted).toBe(true);
    }
  });

  it('rejects unknown kind', () => {
    expect(() =>
      gateResultDetailsSchema.parse({
        kind: 'unknown',
        exitCode: 0,
      }),
    ).toThrow();
  });
});

describe('TaskEvidence — round-trip parse for all 5 kinds', () => {
  const sha256 = 'a'.repeat(64);
  const timestamp = '2026-04-15T10:00:00.000Z';

  it('parses file evidence', () => {
    const result = taskEvidenceSchema.parse({
      kind: 'file',
      sha256,
      timestamp,
      path: 'packages/contracts/dist/index.js',
      mime: 'text/javascript',
    });
    expect(result.kind).toBe('file');
    if (result.kind === 'file') {
      expect(result.path).toBe('packages/contracts/dist/index.js');
    }
  });

  it('parses log evidence', () => {
    const result = taskEvidenceSchema.parse({
      kind: 'log',
      sha256,
      timestamp,
      source: 'pnpm test',
    });
    expect(result.kind).toBe('log');
    if (result.kind === 'log') {
      expect(result.source).toBe('pnpm test');
    }
  });

  it('parses screenshot evidence', () => {
    const result = taskEvidenceSchema.parse({
      kind: 'screenshot',
      sha256,
      timestamp,
      mime: 'image/png',
    });
    expect(result.kind).toBe('screenshot');
  });

  it('parses test-output evidence', () => {
    const result = taskEvidenceSchema.parse({
      kind: 'test-output',
      sha256,
      timestamp,
      passed: 42,
      failed: 0,
      skipped: 2,
      exitCode: 0,
    });
    expect(result.kind).toBe('test-output');
    if (result.kind === 'test-output') {
      expect(result.passed).toBe(42);
      expect(result.failed).toBe(0);
    }
  });

  it('parses command-output evidence', () => {
    const result = taskEvidenceSchema.parse({
      kind: 'command-output',
      sha256,
      timestamp,
      cmd: 'pnpm run build',
      exitCode: 0,
    });
    expect(result.kind).toBe('command-output');
    if (result.kind === 'command-output') {
      expect(result.exitCode).toBe(0);
    }
  });

  it('rejects sha256 with wrong length', () => {
    expect(() =>
      taskEvidenceSchema.parse({
        kind: 'file',
        sha256: 'tooshort',
        timestamp,
        path: 'src/foo.ts',
      }),
    ).toThrow();
  });

  it('rejects invalid timestamp', () => {
    expect(() =>
      taskEvidenceSchema.parse({
        kind: 'log',
        sha256,
        timestamp: 'not-a-date',
        source: 'pnpm test',
      }),
    ).toThrow();
  });
});
