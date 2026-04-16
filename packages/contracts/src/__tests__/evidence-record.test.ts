/**
 * Round-trip Zod parse tests for `EvidenceRecord` variants.
 *
 * Each variant is exercised with two cases:
 *   1. A minimal (required-fields-only) input.
 *   2. A maximal (all-fields populated) input with a structural type-check.
 *
 * Five variants × 2 cases = 10 core tests, plus union-routing and rejection tests.
 *
 * @epic T810
 * @task T816
 */

import { describe, expect, it } from 'vitest';
import type {
  CommandOutputRecord,
  EvidenceRecord,
  ImplDiffRecord,
  LintReportRecord,
  TestOutputRecord,
  ValidateSpecCheckRecord,
} from '../evidence-record.js';
import {
  commandOutputRecordSchema,
  evidenceRecordSchema,
  implDiffRecordSchema,
  lintReportRecordSchema,
  testOutputRecordSchema,
  validateSpecCheckRecordSchema,
} from '../evidence-record-schema.js';

// ─── Shared fixture helpers ───────────────────────────────────────────────────

const SHA256 = 'a'.repeat(64);
const AGENT = 'T816-worker';
const TIMESTAMP = '2026-04-16T00:00:00.000Z';

// ─── impl-diff ────────────────────────────────────────────────────────────────

describe('implDiffRecordSchema', () => {
  it('round-trips a minimal impl-diff record', () => {
    const input = {
      kind: 'impl-diff' as const,
      phase: 'implement' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      filesChanged: ['packages/contracts/src/evidence-record.ts'],
      linesAdded: 120,
      linesRemoved: 0,
      ranAt: TIMESTAMP,
      durationMs: 850,
    };
    const result = implDiffRecordSchema.parse(input);
    expect(result.kind).toBe('impl-diff');
    expect(result.phase).toBe('implement');
    expect(result.filesChanged).toHaveLength(1);
    expect(result.linesAdded).toBe(120);
    expect(result.linesRemoved).toBe(0);
    expect(result.durationMs).toBe(850);
  });

  it('round-trips a maximal impl-diff record and type-checks as EvidenceRecord', () => {
    const input = {
      kind: 'impl-diff' as const,
      phase: 'implement' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      filesChanged: [
        'packages/contracts/src/evidence-record.ts',
        'packages/contracts/src/evidence-record-schema.ts',
        'packages/contracts/src/index.ts',
      ],
      linesAdded: 300,
      linesRemoved: 5,
      ranAt: TIMESTAMP,
      durationMs: 1200,
    };
    const result = implDiffRecordSchema.parse(input);
    expect(result.filesChanged).toHaveLength(3);
    expect(result.linesRemoved).toBe(5);
    // Structural compatibility with canonical interface
    const typed: ImplDiffRecord = result;
    expect(typed.kind).toBe('impl-diff');
    // Assignable to the union
    const unionTyped: EvidenceRecord = result;
    expect(unionTyped.kind).toBe('impl-diff');
  });
});

// ─── validate-spec-check ─────────────────────────────────────────────────────

describe('validateSpecCheckRecordSchema', () => {
  it('round-trips a minimal validate-spec-check record', () => {
    const input = {
      kind: 'validate-spec-check' as const,
      phase: 'validate' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      reqIdsChecked: ['IVTR-01'],
      passed: true,
      details: 'All checked REQ-IDs satisfied.',
      ranAt: TIMESTAMP,
      durationMs: 300,
    };
    const result = validateSpecCheckRecordSchema.parse(input);
    expect(result.kind).toBe('validate-spec-check');
    expect(result.phase).toBe('validate');
    expect(result.passed).toBe(true);
    expect(result.reqIdsChecked).toEqual(['IVTR-01']);
  });

  it('round-trips a maximal validate-spec-check record with failure', () => {
    const input = {
      kind: 'validate-spec-check' as const,
      phase: 'validate' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      reqIdsChecked: ['IVTR-01', 'IVTR-02', 'IVTR-06'],
      passed: false,
      details: 'IVTR-06: EvidenceRecord schema missing lint-report variant.',
      ranAt: TIMESTAMP,
      durationMs: 550,
    };
    const result = validateSpecCheckRecordSchema.parse(input);
    expect(result.reqIdsChecked).toHaveLength(3);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('lint-report');
    // Structural compatibility with canonical interface
    const typed: ValidateSpecCheckRecord = result;
    expect(typed.kind).toBe('validate-spec-check');
  });
});

// ─── test-output ─────────────────────────────────────────────────────────────

describe('testOutputRecordSchema', () => {
  it('round-trips a minimal test-output record', () => {
    const input = {
      kind: 'test-output' as const,
      phase: 'test' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      command: 'pnpm --filter @cleocode/contracts run test',
      exitCode: 0,
      testsPassed: 10,
      testsFailed: 0,
      ranAt: TIMESTAMP,
      durationMs: 4200,
    };
    const result = testOutputRecordSchema.parse(input);
    expect(result.kind).toBe('test-output');
    expect(result.phase).toBe('test');
    expect(result.exitCode).toBe(0);
    expect(result.testsPassed).toBe(10);
    expect(result.testsFailed).toBe(0);
  });

  it('round-trips a test-output record with failures and type-checks as EvidenceRecord', () => {
    const input = {
      kind: 'test-output' as const,
      phase: 'test' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      command: 'pnpm run test',
      exitCode: 1,
      testsPassed: 8,
      testsFailed: 2,
      ranAt: TIMESTAMP,
      durationMs: 3100,
    };
    const result = testOutputRecordSchema.parse(input);
    expect(result.exitCode).toBe(1);
    expect(result.testsFailed).toBe(2);
    // Structural compatibility
    const typed: TestOutputRecord = result;
    expect(typed.command).toBe('pnpm run test');
    const unionTyped: EvidenceRecord = result;
    expect(unionTyped.kind).toBe('test-output');
  });
});

// ─── lint-report ─────────────────────────────────────────────────────────────

describe('lintReportRecordSchema', () => {
  it('round-trips a minimal lint-report record (implement phase)', () => {
    const input = {
      kind: 'lint-report' as const,
      phase: 'implement' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      tool: 'biome',
      passed: true,
      warnings: 0,
      errors: 0,
      ranAt: TIMESTAMP,
      durationMs: 620,
    };
    const result = lintReportRecordSchema.parse(input);
    expect(result.kind).toBe('lint-report');
    expect(result.phase).toBe('implement');
    expect(result.tool).toBe('biome');
    expect(result.passed).toBe(true);
    expect(result.warnings).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('round-trips a lint-report record with warnings (test phase) and type-checks', () => {
    const input = {
      kind: 'lint-report' as const,
      phase: 'test' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      tool: 'tsc',
      passed: false,
      warnings: 3,
      errors: 2,
      ranAt: TIMESTAMP,
      durationMs: 800,
    };
    const result = lintReportRecordSchema.parse(input);
    expect(result.phase).toBe('test');
    expect(result.warnings).toBe(3);
    expect(result.errors).toBe(2);
    expect(result.passed).toBe(false);
    // Structural compatibility
    const typed: LintReportRecord = result;
    expect(typed.tool).toBe('tsc');
    const unionTyped: EvidenceRecord = result;
    expect(unionTyped.kind).toBe('lint-report');
  });
});

// ─── command-output ───────────────────────────────────────────────────────────

describe('commandOutputRecordSchema', () => {
  it('round-trips a minimal command-output record (implement phase)', () => {
    const input = {
      kind: 'command-output' as const,
      phase: 'implement' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      cmd: 'git diff --stat HEAD',
      exitCode: 0,
      ranAt: TIMESTAMP,
      durationMs: 120,
    };
    const result = commandOutputRecordSchema.parse(input);
    expect(result.kind).toBe('command-output');
    expect(result.phase).toBe('implement');
    expect(result.cmd).toBe('git diff --stat HEAD');
    expect(result.exitCode).toBe(0);
  });

  it('round-trips a command-output record (validate phase) and type-checks as EvidenceRecord', () => {
    const input = {
      kind: 'command-output' as const,
      phase: 'validate' as const,
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      cmd: 'cleo check --task T816',
      exitCode: 0,
      ranAt: TIMESTAMP,
      durationMs: 250,
    };
    const result = commandOutputRecordSchema.parse(input);
    expect(result.phase).toBe('validate');
    // Structural compatibility
    const typed: CommandOutputRecord = result;
    expect(typed.cmd).toBe('cleo check --task T816');
    const unionTyped: EvidenceRecord = result;
    expect(unionTyped.kind).toBe('command-output');
  });
});

// ─── evidenceRecordSchema (discriminated union routing) ──────────────────────

describe('evidenceRecordSchema (discriminated union)', () => {
  it('routes impl-diff by kind', () => {
    const result = evidenceRecordSchema.parse({
      kind: 'impl-diff',
      phase: 'implement',
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      filesChanged: ['src/x.ts'],
      linesAdded: 10,
      linesRemoved: 2,
      ranAt: TIMESTAMP,
      durationMs: 100,
    });
    expect(result.kind).toBe('impl-diff');
  });

  it('routes validate-spec-check by kind', () => {
    const result = evidenceRecordSchema.parse({
      kind: 'validate-spec-check',
      phase: 'validate',
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      reqIdsChecked: ['REQ-01'],
      passed: true,
      details: 'ok',
      ranAt: TIMESTAMP,
      durationMs: 100,
    });
    expect(result.kind).toBe('validate-spec-check');
  });

  it('routes test-output by kind', () => {
    const result = evidenceRecordSchema.parse({
      kind: 'test-output',
      phase: 'test',
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      command: 'pnpm test',
      exitCode: 0,
      testsPassed: 5,
      testsFailed: 0,
      ranAt: TIMESTAMP,
      durationMs: 100,
    });
    expect(result.kind).toBe('test-output');
  });

  it('routes lint-report by kind', () => {
    const result = evidenceRecordSchema.parse({
      kind: 'lint-report',
      phase: 'implement',
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      tool: 'biome',
      passed: true,
      warnings: 0,
      errors: 0,
      ranAt: TIMESTAMP,
      durationMs: 100,
    });
    expect(result.kind).toBe('lint-report');
  });

  it('routes command-output by kind', () => {
    const result = evidenceRecordSchema.parse({
      kind: 'command-output',
      phase: 'test',
      agentIdentity: AGENT,
      attachmentSha256: SHA256,
      cmd: 'cleo doctor',
      exitCode: 0,
      ranAt: TIMESTAMP,
      durationMs: 100,
    });
    expect(result.kind).toBe('command-output');
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        kind: 'unknown-kind',
        agentIdentity: AGENT,
        attachmentSha256: SHA256,
        ranAt: TIMESTAMP,
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('rejects an invalid attachmentSha256 (wrong length)', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        kind: 'command-output',
        phase: 'test',
        agentIdentity: AGENT,
        attachmentSha256: 'tooshort',
        cmd: 'cleo doctor',
        exitCode: 0,
        ranAt: TIMESTAMP,
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('rejects an invalid ranAt (non-datetime string)', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        kind: 'test-output',
        phase: 'test',
        agentIdentity: AGENT,
        attachmentSha256: SHA256,
        command: 'pnpm test',
        exitCode: 0,
        testsPassed: 1,
        testsFailed: 0,
        ranAt: 'not-a-timestamp',
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('rejects negative durationMs', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        kind: 'command-output',
        phase: 'implement',
        agentIdentity: AGENT,
        attachmentSha256: SHA256,
        cmd: 'cleo doctor',
        exitCode: 0,
        ranAt: TIMESTAMP,
        durationMs: -1,
      }),
    ).toThrow();
  });
});
