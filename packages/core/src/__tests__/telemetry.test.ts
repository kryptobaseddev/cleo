/**
 * Tests for the telemetry module (T624 — diagnostic feedback loop).
 *
 * Covers:
 *   - Opt-in / opt-out config management
 *   - Anonymous ID generation (stable across calls, new on first enable)
 *   - recordTelemetryEvent is a no-op when disabled
 *   - buildDiagnosticsReport returns null when disabled
 *   - buildDiagnosticsReport returns correct aggregates when enabled
 *
 * @task T624
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticsReport,
  disableTelemetry,
  enableTelemetry,
  isTelemetryEnabled,
  loadTelemetryConfig,
  recordTelemetryEvent,
} from '../telemetry/index.js';
import { resetTelemetryDbState } from '../telemetry/sqlite.js';

// ---------------------------------------------------------------------------
// Test setup: redirect CLEO_HOME to a temp directory for isolation
// ---------------------------------------------------------------------------

let tempDir: string;
const origCleoHome = process.env['CLEO_HOME'];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-telemetry-test-'));
  process.env['CLEO_HOME'] = tempDir;
  // Reset the DB singleton so each test starts clean
  resetTelemetryDbState();
});

afterEach(async () => {
  resetTelemetryDbState();
  await rm(tempDir, { recursive: true, force: true });
  if (origCleoHome !== undefined) {
    process.env['CLEO_HOME'] = origCleoHome;
  } else {
    delete process.env['CLEO_HOME'];
  }
});

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

describe('loadTelemetryConfig', () => {
  it('returns disabled config when file does not exist', () => {
    const config = loadTelemetryConfig();
    expect(config.enabled).toBe(false);
    expect(config.anonymousId).toBe('');
  });
});

describe('enableTelemetry', () => {
  it('sets enabled=true and generates a non-empty anonymousId', () => {
    const config = enableTelemetry();
    expect(config.enabled).toBe(true);
    expect(config.anonymousId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('preserves existing anonymousId on subsequent calls', () => {
    const first = enableTelemetry();
    const second = enableTelemetry();
    expect(second.anonymousId).toBe(first.anonymousId);
  });
});

describe('disableTelemetry', () => {
  it('sets enabled=false', () => {
    enableTelemetry();
    const config = disableTelemetry();
    expect(config.enabled).toBe(false);
  });

  it('preserves anonymousId after disable', () => {
    const { anonymousId } = enableTelemetry();
    const after = disableTelemetry();
    expect(after.anonymousId).toBe(anonymousId);
  });
});

describe('isTelemetryEnabled', () => {
  it('returns false by default', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns true after enable', () => {
    enableTelemetry();
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false after disable', () => {
    enableTelemetry();
    disableTelemetry();
    expect(isTelemetryEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event recording
// ---------------------------------------------------------------------------

describe('recordTelemetryEvent', () => {
  it('is a no-op when telemetry is disabled (no error thrown)', async () => {
    // Ensure disabled
    disableTelemetry();
    await expect(
      recordTelemetryEvent({
        domain: 'tasks',
        gateway: 'query',
        operation: 'show',
        durationMs: 42,
        exitCode: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('writes an event to the DB when enabled', async () => {
    enableTelemetry();
    await recordTelemetryEvent({
      domain: 'tasks',
      gateway: 'mutate',
      operation: 'add',
      durationMs: 100,
      exitCode: 0,
    });
    // Verify by building a report
    const report = await buildDiagnosticsReport(1);
    expect(report).not.toBeNull();
    expect(report!.totalEvents).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics report
// ---------------------------------------------------------------------------

describe('buildDiagnosticsReport', () => {
  it('returns null when telemetry is disabled', async () => {
    disableTelemetry();
    const report = await buildDiagnosticsReport(30);
    expect(report).toBeNull();
  });

  it('returns a report with zero events when DB is empty', async () => {
    enableTelemetry();
    const report = await buildDiagnosticsReport(30);
    expect(report).not.toBeNull();
    expect(report!.totalEvents).toBe(0);
    expect(report!.topFailing).toHaveLength(0);
    expect(report!.topSlow).toHaveLength(0);
  });

  it('surfaces high-failure-rate commands in topFailing', async () => {
    enableTelemetry();

    // Record 10 failures and 2 successes for tasks.add
    for (let i = 0; i < 10; i++) {
      await recordTelemetryEvent({
        domain: 'tasks',
        gateway: 'mutate',
        operation: 'add',
        durationMs: 50,
        exitCode: 6,
        errorCode: 'E_VALIDATION',
      });
    }
    for (let i = 0; i < 2; i++) {
      await recordTelemetryEvent({
        domain: 'tasks',
        gateway: 'mutate',
        operation: 'add',
        durationMs: 50,
        exitCode: 0,
      });
    }

    const report = await buildDiagnosticsReport(1);
    expect(report).not.toBeNull();
    const failing = report!.topFailing.find((c) => c.command === 'tasks.add');
    expect(failing).toBeDefined();
    expect(failing!.failureCount).toBe(10);
    expect(failing!.failureRate).toBeCloseTo(10 / 12);
    expect(failing!.topErrorCode).toBe('E_VALIDATION');
  });

  it('generates BRAIN observation text for failing commands', async () => {
    enableTelemetry();

    // Need at least 5 invocations to appear in topFailing
    for (let i = 0; i < 8; i++) {
      await recordTelemetryEvent({
        domain: 'session',
        gateway: 'mutate',
        operation: 'start',
        durationMs: 200,
        exitCode: i < 7 ? 1 : 0,
        errorCode: i < 7 ? 'E_GENERAL' : null,
      });
    }

    const report = await buildDiagnosticsReport(1);
    expect(report).not.toBeNull();
    expect(report!.observations.length).toBeGreaterThan(0);
    const obs = report!.observations[0]!;
    expect(obs).toContain('session.start');
    expect(obs).toContain('%');
  });
});
