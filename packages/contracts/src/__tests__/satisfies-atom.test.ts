/**
 * Tests for the ADR-079-r2 `satisfies:<task-id>#<ac-id>` evidence atom
 * grammar (T10506).
 *
 * Coverage:
 *   - Schema-level: per-field regex validation (task-id, ac-uuid, ac-alias,
 *     version-pin) and discriminated-union acceptance.
 *   - Parser-level: full {@link parseEvidenceString} round-trips for both
 *     UUID and alias forms, mixed evidence strings, and the optional
 *     `@<version-pin>` suffix.
 *   - Malformed inputs: missing colon, missing hash, missing T-prefix,
 *     mixed-case UUID, non-UUID non-alias ac-id, malformed version-pin.
 *
 * This file covers PARSING ONLY per T10506 acceptance criteria. The 5-check
 * validator semantics (target exists, target not terminal, AC exists, same-
 * saga scope rule, alias drift detection) ship in T10507 and are tested
 * separately in `packages/core/src/tasks/__tests__/satisfies-validator.test.ts`.
 *
 * @task T10506
 * @saga T10377
 * @adr ADR-079-r2
 */

import { describe, expect, it } from 'vitest';

import {
  AC_ALIAS_REGEX,
  AC_UUID_REGEX,
  EvidenceAtomSchema,
  EvidenceParseError,
  parseEvidenceString,
  SATISFIES_TASK_ID_REGEX,
  SATISFIES_VERSION_PIN_REGEX,
  satisfiesAtomSchema,
} from '../index.js';

// ─── Per-field regex parity (ADR-079-r2 §2.1 ABNF) ────────────────────────

describe('satisfies atom regexes (ADR-079-r2 §2.1)', () => {
  describe('SATISFIES_TASK_ID_REGEX', () => {
    it('accepts T<1-7 digits>', () => {
      expect(SATISFIES_TASK_ID_REGEX.test('T1')).toBe(true);
      expect(SATISFIES_TASK_ID_REGEX.test('T1234')).toBe(true);
      expect(SATISFIES_TASK_ID_REGEX.test('T1234567')).toBe(true);
    });
    it('rejects T<8+ digits>', () => {
      expect(SATISFIES_TASK_ID_REGEX.test('T12345678')).toBe(false);
    });
    it('rejects missing T prefix', () => {
      expect(SATISFIES_TASK_ID_REGEX.test('1234')).toBe(false);
    });
    it('rejects lowercase t', () => {
      expect(SATISFIES_TASK_ID_REGEX.test('t1234')).toBe(false);
    });
    it('rejects non-digit suffix', () => {
      expect(SATISFIES_TASK_ID_REGEX.test('T12a')).toBe(false);
    });
  });

  describe('AC_UUID_REGEX', () => {
    it('accepts strict lowercase UUIDv4 and deterministic UUIDv5-shaped AC ids', () => {
      expect(AC_UUID_REGEX.test('a1b2c3d4-5e6f-4890-abcd-ef1234567890')).toBe(true);
      expect(AC_UUID_REGEX.test('00000000-0000-4000-8000-000000000000')).toBe(true);
      expect(AC_UUID_REGEX.test('a1b2c3d4-5e6f-5890-abcd-ef1234567890')).toBe(true);
    });
    it('rejects mixed-case', () => {
      // Council-mandated strictness (ADR-079-r2 §2.2): "Validators MUST
      // reject mixed-case to prevent silent dedupe failures."
      expect(AC_UUID_REGEX.test('A1B2C3D4-5E6F-4890-ABCD-EF1234567890')).toBe(false);
    });
    it('rejects wrong version nibble (not 4/5)', () => {
      expect(AC_UUID_REGEX.test('a1b2c3d4-5e6f-6890-abcd-ef1234567890')).toBe(false);
    });
    it('rejects wrong variant nibble (not 8/9/a/b)', () => {
      expect(AC_UUID_REGEX.test('a1b2c3d4-5e6f-4890-cbcd-ef1234567890')).toBe(false);
    });
    it('rejects non-UUID strings', () => {
      expect(AC_UUID_REGEX.test('not-a-uuid')).toBe(false);
      expect(AC_UUID_REGEX.test('a1b2c3d45e6f4890abcdef1234567890')).toBe(false);
    });
  });

  describe('AC_ALIAS_REGEX', () => {
    it('accepts AC<1-4 digits>', () => {
      expect(AC_ALIAS_REGEX.test('AC1')).toBe(true);
      expect(AC_ALIAS_REGEX.test('AC9999')).toBe(true);
    });
    it('rejects AC<5+ digits>', () => {
      expect(AC_ALIAS_REGEX.test('AC10000')).toBe(false);
    });
    it('rejects lowercase ac', () => {
      expect(AC_ALIAS_REGEX.test('ac1')).toBe(false);
    });
    it('rejects bare integer', () => {
      expect(AC_ALIAS_REGEX.test('1')).toBe(false);
    });
  });

  describe('SATISFIES_VERSION_PIN_REGEX', () => {
    it('accepts exactly 14 digits', () => {
      expect(SATISFIES_VERSION_PIN_REGEX.test('20260524223045')).toBe(true);
    });
    it('rejects fewer than 14 digits', () => {
      expect(SATISFIES_VERSION_PIN_REGEX.test('2026052422304')).toBe(false);
    });
    it('rejects more than 14 digits', () => {
      expect(SATISFIES_VERSION_PIN_REGEX.test('202605242230451')).toBe(false);
    });
    it('rejects non-digit characters', () => {
      expect(SATISFIES_VERSION_PIN_REGEX.test('2026-05-24T22:30')).toBe(false);
    });
  });
});

// ─── Zod schema (post-parse client-side validation) ────────────────────────

describe('satisfiesAtomSchema (ADR-079-r2 §5.2)', () => {
  it('accepts UUID form without version-pin', () => {
    const a = satisfiesAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e',
    });
    expect(a.targetTaskId).toBe('T10495');
    expect(a.targetAcId).toBe('8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e');
    expect(a.targetAcAlias).toBeUndefined();
    expect(a.versionPin).toBeUndefined();
  });

  it('accepts deterministic UUIDv5-shaped AC id form without version-pin', () => {
    const a = satisfiesAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-5f6a-9c3e-7a1d4f8c0b2e',
    });
    expect(a.targetAcId).toBe('8f4a2c1e-b09d-5f6a-9c3e-7a1d4f8c0b2e');
  });

  it('accepts alias form without version-pin', () => {
    const a = satisfiesAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
    });
    expect(a.targetAcAlias).toBe('AC2');
    expect(a.targetAcId).toBeUndefined();
  });

  it('accepts alias form with version-pin', () => {
    const a = satisfiesAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
      versionPin: '20260524223045',
    });
    expect(a.versionPin).toBe('20260524223045');
  });

  it('accepts UUID form with version-pin (highest-trust)', () => {
    const a = satisfiesAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e',
      versionPin: '20260524223045',
    });
    expect(a.targetAcId).toBeDefined();
    expect(a.versionPin).toBe('20260524223045');
  });

  it('rejects malformed targetTaskId via schema', () => {
    const r = satisfiesAtomSchema.safeParse({
      kind: 'satisfies',
      targetTaskId: 'task-1234',
      targetAcAlias: 'AC2',
    });
    expect(r.success).toBe(false);
  });

  it('rejects mixed-case UUID via schema', () => {
    const r = satisfiesAtomSchema.safeParse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8F4A2C1E-B09D-4F6A-9C3E-7A1D4F8C0B2E',
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed version-pin via schema', () => {
    const r = satisfiesAtomSchema.safeParse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
      versionPin: '2026-05-24T22:30',
    });
    expect(r.success).toBe(false);
  });

  it('round-trips through the EvidenceAtomSchema discriminated union', () => {
    const a = EvidenceAtomSchema.parse({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
    });
    expect(a.kind).toBe('satisfies');
  });
});

// ─── parseEvidenceString (CLI parser) ──────────────────────────────────────

describe('parseEvidenceString — satisfies atom (T10506)', () => {
  // ─── Valid forms ─────────────────────────────────────────────────────────

  it('parses UUID form', () => {
    const atoms = parseEvidenceString('satisfies:T10495#8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e');
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e',
    });
  });

  it('parses deterministic UUIDv5-shaped AC id form', () => {
    const atoms = parseEvidenceString('satisfies:T10495#8f4a2c1e-b09d-5f6a-9c3e-7a1d4f8c0b2e');
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-5f6a-9c3e-7a1d4f8c0b2e',
    });
  });

  it('parses alias form', () => {
    const atoms = parseEvidenceString('satisfies:T10495#AC2');
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
    });
  });

  it('parses alias form with version-pin', () => {
    const atoms = parseEvidenceString('satisfies:T10495#AC2@20260524223045');
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
      versionPin: '20260524223045',
    });
  });

  it('parses UUID form with version-pin (canonical highest-trust)', () => {
    const atoms = parseEvidenceString(
      'satisfies:T10495#8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e@20260524223045',
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcId: '8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e',
      versionPin: '20260524223045',
    });
  });

  it('parses multiple satisfies atoms in one evidence string', () => {
    const atoms = parseEvidenceString('satisfies:T10495#AC2;satisfies:T10493#AC1');
    expect(atoms).toHaveLength(2);
    expect(atoms[0]).toMatchObject({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
    });
    expect(atoms[1]).toMatchObject({
      kind: 'satisfies',
      targetTaskId: 'T10493',
      targetAcAlias: 'AC1',
    });
  });

  it('parses mixed evidence: commit + files + satisfies', () => {
    const atoms = parseEvidenceString(
      'commit:abc1234;files:src/foo.ts,src/bar.ts;satisfies:T10495#AC2',
    );
    expect(atoms).toHaveLength(3);
    expect(atoms[0]).toEqual({ kind: 'commit', sha: 'abc1234' });
    expect(atoms[1]).toEqual({ kind: 'files', paths: ['src/foo.ts', 'src/bar.ts'] });
    expect(atoms[2]).toEqual({
      kind: 'satisfies',
      targetTaskId: 'T10495',
      targetAcAlias: 'AC2',
    });
  });

  it('parses mixed evidence: satisfies + pr (single PR landing multiple ACs)', () => {
    const atoms = parseEvidenceString('satisfies:T10506#AC1;satisfies:T10506#AC2;pr:773');
    expect(atoms).toHaveLength(3);
    expect(atoms[2]).toEqual({ kind: 'pr', prNumber: 773 });
  });

  // ─── Malformed: missing colon ────────────────────────────────────────────

  it('rejects atom missing the kind-payload colon', () => {
    // "satisfiesT10495#AC2" — no `:` separator at all
    expect(() => parseEvidenceString('satisfiesT10495#AC2')).toThrow(EvidenceParseError);
  });

  // ─── Malformed: missing hash ─────────────────────────────────────────────

  it('rejects atom missing the # separator between task-id and ac-id', () => {
    expect(() => parseEvidenceString('satisfies:T10495-AC2')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('satisfies:T10495AC2')).toThrow(EvidenceParseError);
  });

  it('rejects atom with # at start of payload (empty task-id)', () => {
    expect(() => parseEvidenceString('satisfies:#AC2')).toThrow(EvidenceParseError);
  });

  it('rejects atom with # at end of payload (empty ac-id)', () => {
    expect(() => parseEvidenceString('satisfies:T10495#')).toThrow(EvidenceParseError);
  });

  // ─── Malformed: missing T-prefix on task-id ──────────────────────────────

  it('rejects atom with non-T-prefixed task-id', () => {
    expect(() => parseEvidenceString('satisfies:10495#AC2')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('satisfies:task-10495#AC2')).toThrow(EvidenceParseError);
  });

  it('rejects atom with lowercase t prefix', () => {
    expect(() => parseEvidenceString('satisfies:t10495#AC2')).toThrow(EvidenceParseError);
  });

  it('rejects atom with task-id exceeding 7 digits', () => {
    expect(() => parseEvidenceString('satisfies:T12345678#AC2')).toThrow(EvidenceParseError);
  });

  // ─── Malformed: ac-id ────────────────────────────────────────────────────

  it('rejects atom with mixed-case UUID', () => {
    // Council §2.2 strictness — silent dedupe prevention
    expect(() =>
      parseEvidenceString('satisfies:T10495#8F4A2C1E-B09D-4F6A-9C3E-7A1D4F8C0B2E'),
    ).toThrow(EvidenceParseError);
  });

  it('rejects atom with ac-id that is neither UUID nor AC<digits> alias', () => {
    expect(() => parseEvidenceString('satisfies:T10495#hello')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('satisfies:T10495#2')).toThrow(EvidenceParseError);
  });

  it('rejects atom with alias exceeding 4 digits', () => {
    expect(() => parseEvidenceString('satisfies:T10495#AC10000')).toThrow(EvidenceParseError);
  });

  // ─── Malformed: version-pin ──────────────────────────────────────────────

  it('rejects atom with malformed version-pin (not 14 digits)', () => {
    expect(() => parseEvidenceString('satisfies:T10495#AC2@2026-05-24')).toThrow(
      EvidenceParseError,
    );
    expect(() => parseEvidenceString('satisfies:T10495#AC2@2026052422304')).toThrow(
      EvidenceParseError,
    );
  });

  it('rejects atom with @ but empty version-pin payload', () => {
    expect(() => parseEvidenceString('satisfies:T10495#AC2@')).toThrow(EvidenceParseError);
  });

  // ─── Error message smoke: ensures kind name appears in default-case ──────

  it('includes "satisfies" in the unknown-kind error suggestion list', () => {
    try {
      parseEvidenceString('unknownkind:foo');
      throw new Error('expected EvidenceParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(EvidenceParseError);
      expect((err as EvidenceParseError).fix).toContain('satisfies');
    }
  });
});
