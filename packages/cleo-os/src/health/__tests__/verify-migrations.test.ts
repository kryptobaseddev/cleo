/**
 * Tests for the cleo-os startup migration verify check (T1185).
 *
 * All tests stub the {@link CliRunner} interface — no real `cleo` binary is
 * invoked. Coverage:
 *
 * 1. Happy path — all findings ok → `ok: true`, `severity: "ok"`, empty drift.
 * 2. Drift fixture (warning) — `status:"warning"` finding → `warn`, non-blocking.
 * 3. Drift fixture (error) — `status:"error"` finding → `fatal`, blocking.
 * 4. Classification — Scenario 1 (name-backfill warning) is `warn`, not `fatal`.
 * 5. Classification — ENOENT binary failure is `fatal`.
 * 6. Mixed warn+ok — aggregate is `warn`, `ok: true`.
 * 7. Mixed fatal+warn — aggregate is `fatal`, `ok: false`.
 * 8. Malformed JSON output → `fatal` with parse check.
 * 9. Missing findings array → `fatal` with parse check.
 * 10. Subprocess spawn error (non-ENOENT) → `fatal`.
 * 11. `usedDedicatedVerb` is always `false` (dedicated verb not yet implemented).
 * 12. `renderFatalDriftError` output includes remediation instructions.
 * 13. `renderWarnDrift` output lists the warning check name.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import type { CliRunner, MigrationVerifyResult } from '../verify-migrations.js';
import { renderFatalDriftError, renderWarnDrift, verifyMigrations } from '../verify-migrations.js';

// ---------------------------------------------------------------------------
// Stub runner factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link CliRunner} stub that resolves to a given JSON string.
 *
 * @param output - Raw JSON string to return from `runDiagnose()`.
 */
function stubRunner(output: string): CliRunner {
  return {
    async runDiagnose(): Promise<string> {
      return output;
    },
  };
}

/**
 * Build a {@link CliRunner} stub that rejects with the given error.
 *
 * @param message - Error message to throw from `runDiagnose()`.
 */
function failRunner(message: string): CliRunner {
  return {
    async runDiagnose(): Promise<string> {
      throw new Error(message);
    },
  };
}

/**
 * Build a well-formed `cleo upgrade --diagnose --json` envelope where all
 * findings have the given status list.
 */
function makeEnvelope(
  findings: Array<{
    check: string;
    status: 'ok' | 'warning' | 'error';
    details: string;
    fix?: string;
  }>,
): string {
  const ok = findings.filter((f) => f.status === 'ok').length;
  const warnings = findings.filter((f) => f.status === 'warning').length;
  const errors = findings.filter((f) => f.status === 'error').length;
  return JSON.stringify({
    success: true,
    data: {
      success: true,
      findings,
      summary: { ok, warnings, errors },
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_OK_ENVELOPE = makeEnvelope([
  { check: 'tasks.db.columns', status: 'ok', details: 'All required columns present' },
  { check: 'tasks.db.journal', status: 'ok', details: '17 migrations in journal, all valid' },
  { check: 'tasks.db.integrity', status: 'ok', details: 'SQLite integrity check passed' },
  { check: 'brain.db.tables', status: 'ok', details: 'All 4 expected tables present' },
  { check: 'brain.db.journal', status: 'ok', details: '15 migrations in journal, all valid' },
  { check: 'brain.db.schema_columns', status: 'ok', details: 'All brain schema columns present' },
  { check: 'signaldock.db', status: 'ok', details: 'signaldock.db exists' },
  { check: 'conduit.db', status: 'ok', details: 'conduit.db exists' },
]);

const WARNING_ENVELOPE = makeEnvelope([
  { check: 'tasks.db.columns', status: 'ok', details: 'All required columns present' },
  {
    check: 'signaldock.db',
    status: 'warning',
    details: 'signaldock.db not found',
    fix: 'Run: cleo upgrade',
  },
  { check: 'conduit.db', status: 'ok', details: 'conduit.db exists' },
]);

const ERROR_ENVELOPE = makeEnvelope([
  { check: 'tasks.db.columns', status: 'ok', details: 'All required columns present' },
  {
    check: 'tasks.db.journal',
    status: 'error',
    details: 'Migration folder missing: .cleo/migrations/tasks does not exist',
    fix: 'Run: cleo init or cleo upgrade',
  },
]);

const MIXED_WARN_OK_ENVELOPE = makeEnvelope([
  { check: 'tasks.db.journal', status: 'ok', details: 'Journal valid' },
  {
    check: 'brain.db.schema_columns',
    status: 'warning',
    details: 'provenance column missing (auto-backfilled)',
    fix: 'Run: cleo upgrade',
  },
]);

const MIXED_FATAL_WARN_ENVELOPE = makeEnvelope([
  {
    check: 'tasks.db.journal',
    status: 'error',
    details: 'Required tasks table missing from schema',
  },
  {
    check: 'signaldock.db',
    status: 'warning',
    details: 'signaldock.db not found',
    fix: 'Run: cleo upgrade',
  },
]);

// ---------------------------------------------------------------------------
// Test 1: Happy path
// ---------------------------------------------------------------------------

describe('verifyMigrations', () => {
  it('1: happy path — all findings ok → ok: true, severity ok, empty drift', async () => {
    const result = await verifyMigrations(stubRunner(ALL_OK_ENVELOPE));

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('ok');
    expect(result.drift).toHaveLength(0);
    expect(result.usedDedicatedVerb).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: Warning drift fixture
  // -------------------------------------------------------------------------

  it('2: drift fixture (warning) → warn severity, ok: true (non-blocking)', async () => {
    const result = await verifyMigrations(stubRunner(WARNING_ENVELOPE));

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('warn');
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.severity).toBe('warn');
    expect(result.drift[0]?.check).toBe('signaldock.db');
  });

  // -------------------------------------------------------------------------
  // Test 3: Error drift fixture
  // -------------------------------------------------------------------------

  it('3: drift fixture (error) → fatal severity, ok: false (blocking)', async () => {
    const result = await verifyMigrations(stubRunner(ERROR_ENVELOPE));

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.severity).toBe('fatal');
    expect(result.drift[0]?.check).toBe('tasks.db.journal');
  });

  // -------------------------------------------------------------------------
  // Test 4: Scenario 1 classification (name-backfill warning → warn)
  // -------------------------------------------------------------------------

  it('4: Scenario 1 — name-backfill warning is classified as warn, not fatal', async () => {
    const scenario1Envelope = makeEnvelope([
      {
        check: 'brain.db.schema_columns',
        status: 'warning',
        details: 'provenance column missing (name-backfill auto-applied)',
        fix: 'Run: cleo upgrade',
      },
    ]);

    const result = await verifyMigrations(stubRunner(scenario1Envelope));

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('warn');
    expect(result.drift[0]?.severity).toBe('warn');
  });

  // -------------------------------------------------------------------------
  // Test 5: ENOENT binary failure → fatal
  // -------------------------------------------------------------------------

  it('5: ENOENT — cleo binary not on PATH → fatal, ok: false', async () => {
    const result = await verifyMigrations(failRunner('spawn cleo ENOENT'));

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.check).toBe('cleo-binary');
    expect(result.drift[0]?.severity).toBe('fatal');
    expect(result.drift[0]?.details).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // Test 6: Mixed warn + ok → aggregate warn, ok: true
  // -------------------------------------------------------------------------

  it('6: mixed warn+ok — aggregate severity is warn, ok: true', async () => {
    const result = await verifyMigrations(stubRunner(MIXED_WARN_OK_ENVELOPE));

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('warn');
  });

  // -------------------------------------------------------------------------
  // Test 7: Mixed fatal + warn → aggregate fatal, ok: false
  // -------------------------------------------------------------------------

  it('7: mixed fatal+warn — aggregate severity is fatal, ok: false', async () => {
    const result = await verifyMigrations(stubRunner(MIXED_FATAL_WARN_ENVELOPE));

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    // Both findings should be in drift (warn is included because severity !== ok)
    expect(result.drift.some((d) => d.severity === 'fatal')).toBe(true);
    expect(result.drift.some((d) => d.severity === 'warn')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8: Malformed JSON output → fatal
  // -------------------------------------------------------------------------

  it('8: malformed JSON output → fatal with parse check', async () => {
    const result = await verifyMigrations(stubRunner('not-valid-json'));

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    expect(result.drift[0]?.check).toBe('parse');
    expect(result.drift[0]?.severity).toBe('fatal');
  });

  // -------------------------------------------------------------------------
  // Test 9: Missing findings array → fatal
  // -------------------------------------------------------------------------

  it('9: missing findings array in response → fatal with parse check', async () => {
    const badEnvelope = JSON.stringify({ success: true, data: { success: true } });
    const result = await verifyMigrations(stubRunner(badEnvelope));

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    expect(result.drift[0]?.check).toBe('parse');
  });

  // -------------------------------------------------------------------------
  // Test 10: Subprocess non-ENOENT error → fatal
  // -------------------------------------------------------------------------

  it('10: subprocess spawn error (non-ENOENT) → fatal with details', async () => {
    const result = await verifyMigrations(
      failRunner('Process exited with code 1: permission denied'),
    );

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('fatal');
    expect(result.drift[0]?.check).toBe('cleo-binary');
    // Non-ENOENT: details should describe the actual error, not "not found"
    expect(result.drift[0]?.details).toMatch(/failed|permission/i);
  });

  // -------------------------------------------------------------------------
  // Test 11: usedDedicatedVerb is always false
  // -------------------------------------------------------------------------

  it('11: usedDedicatedVerb is always false (dedicated verb not yet implemented)', async () => {
    const okResult = await verifyMigrations(stubRunner(ALL_OK_ENVELOPE));
    expect(okResult.usedDedicatedVerb).toBe(false);

    const failResult = await verifyMigrations(failRunner('ENOENT'));
    expect(failResult.usedDedicatedVerb).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

describe('renderFatalDriftError', () => {
  it('12: includes remediation instructions and fatal check name', () => {
    const result: MigrationVerifyResult = {
      ok: false,
      severity: 'fatal',
      drift: [
        {
          check: 'tasks.db.journal',
          severity: 'fatal',
          details: 'Migration folder missing',
          fix: 'Run: cleo init',
        },
      ],
      usedDedicatedVerb: false,
    };

    const output = renderFatalDriftError(result);

    expect(output).toContain('CleoOS startup blocked');
    expect(output).toContain('tasks.db.journal');
    expect(output).toContain('Migration folder missing');
    expect(output).toContain('cleo upgrade');
    expect(output).toContain('cleo init --force');
  });
});

describe('renderWarnDrift', () => {
  it('13: lists warning check name and includes upgrade hint', () => {
    const result: MigrationVerifyResult = {
      ok: true,
      severity: 'warn',
      drift: [
        {
          check: 'signaldock.db',
          severity: 'warn',
          details: 'signaldock.db not found',
          fix: 'Run: cleo upgrade',
        },
      ],
      usedDedicatedVerb: false,
    };

    const output = renderWarnDrift(result);

    expect(output).toContain('signaldock.db');
    expect(output).toContain('signaldock.db not found');
    expect(output).toContain('cleo upgrade');
  });
});
