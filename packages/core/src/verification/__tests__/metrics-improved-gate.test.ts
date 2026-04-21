/**
 * Tests for packages/core/src/verification/evidence-atoms.ts and
 * packages/core/src/verification/gates.ts
 *
 * Covers:
 *   - Green path: before (5 tests passing) → after (6 tests passing) → gate green
 *   - Regression path: before (6 tests) → after (5 tests) → gate rejects
 *   - Gaming path: after event predates before event (timestamp check) → E_EVIDENCE_TAMPERED
 *   - Missing signature: unsigned / tampered event → E_EVIDENCE_TAMPERED
 *   - isTier3Task: detects tier 3, rejects tier 1/2, handles null/malformed input
 *   - computeRequiredGates: injects metricsImproved for tier 3 only
 *   - parseMetricsDeltaAtom: valid, missing colon, empty parts
 *
 * @task T1023
 */

import crypto from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BaselineEvent } from '../../sentient/events.js';
import { SENTIENT_EVENTS_FILE } from '../../sentient/events.js';
import {
  isMetricImproved,
  parseMetricsDeltaAtom,
  validateMetricsDeltaAtom,
} from '../evidence-atoms.js';
import { computeRequiredGates, isExtendedGateName, isTier3Task } from '../gates.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const TEST_SEED_HEX = crypto.randomBytes(32).toString('hex');

let tmpDir: string;
let identity: AgentIdentity;

// Saved env so tests don't bleed into each other.
let savedAdapter: string | undefined;
let savedSeed: string | undefined;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `cleo-metrics-gate-test-${crypto.randomBytes(6).toString('hex')}`);
  await mkdir(join(tmpDir, '.cleo', 'audit'), { recursive: true });

  // Use the env KMS adapter for test-time signing.
  savedAdapter = process.env['CLEO_KMS_ADAPTER'];
  savedSeed = process.env['CLEO_SIGNING_SEED'];
  process.env['CLEO_KMS_ADAPTER'] = 'env';
  process.env['CLEO_SIGNING_SEED'] = TEST_SEED_HEX;

  identity = await identityFromSeed(Buffer.from(TEST_SEED_HEX, 'hex'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (savedAdapter === undefined) {
    delete process.env['CLEO_KMS_ADAPTER'];
  } else {
    process.env['CLEO_KMS_ADAPTER'] = savedAdapter;
  }
  if (savedSeed === undefined) {
    delete process.env['CLEO_SIGNING_SEED'];
  } else {
    process.env['CLEO_SIGNING_SEED'] = savedSeed;
  }
});

// ---------------------------------------------------------------------------
// Internal helper: build + sign a baseline event and append it to the log
// ---------------------------------------------------------------------------

/**
 * Create a signed baseline event with given metrics and write it to the
 * tmpDir event log.  Returns the `receiptId` so tests can reference it.
 *
 * We craft the event manually rather than calling `captureBaseline` to avoid
 * the 5-second anti-gaming guard and git dependencies in unit tests.
 */
async function appendTestBaselineEvent(
  metrics: Record<string, number>,
  timestampOverride?: string,
): Promise<string> {
  const receiptId = `TEST${crypto.randomBytes(9).toString('hex').slice(0, 17)}`;
  const timestamp = timestampOverride ?? new Date().toISOString();
  const metricsJson = JSON.stringify(metrics);
  const parentHash = '0'.repeat(64);

  const unsigned: Omit<BaselineEvent, 'sig'> = {
    kind: 'baseline',
    receiptId,
    experimentId: '',
    taskId: '',
    parentHash,
    timestamp,
    pub: identity.pubkeyHex,
    payload: {
      commitSha: 'a'.repeat(40),
      baselineHash: 'b'.repeat(64),
      metricsJson,
      worktreeNotCreatedYet: true,
    },
  };

  // Deterministically sort + sign (mirrors appendSentientEvent internals).
  const sortKeysDeep = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return (v as unknown[]).map(sortKeysDeep);
    const o = v as Record<string, unknown>;
    const s: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) s[k] = sortKeysDeep(o[k]);
    return s;
  };
  const canonicalBytes = Buffer.from(JSON.stringify(sortKeysDeep(unsigned)), 'utf-8');
  const sigBytes = await identity.sign(canonicalBytes);
  const sig = Buffer.from(sigBytes).toString('hex');

  const event: BaselineEvent = { ...unsigned, sig };
  const eventsPath = join(tmpDir, SENTIENT_EVENTS_FILE);
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');

  return receiptId;
}

/**
 * Build a signed baseline event string but deliberately corrupt the signature
 * so `verifySentientEventSignature` returns false.
 */
async function appendTamperedBaselineEvent(metrics: Record<string, number>): Promise<string> {
  const receiptId = `TAMPERED${crypto.randomBytes(7).toString('hex').slice(0, 13)}`;
  const timestamp = new Date().toISOString();
  const metricsJson = JSON.stringify(metrics);

  const event: BaselineEvent = {
    kind: 'baseline',
    receiptId,
    experimentId: '',
    taskId: '',
    parentHash: '0'.repeat(64),
    timestamp,
    pub: identity.pubkeyHex,
    // Deliberately wrong signature (all zeros).
    sig: '0'.repeat(128),
    payload: {
      commitSha: 'a'.repeat(40),
      baselineHash: 'b'.repeat(64),
      metricsJson,
      worktreeNotCreatedYet: true,
    },
  };

  const eventsPath = join(tmpDir, SENTIENT_EVENTS_FILE);
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');

  return receiptId;
}

// ---------------------------------------------------------------------------
// parseMetricsDeltaAtom
// ---------------------------------------------------------------------------

describe('parseMetricsDeltaAtom', () => {
  it('parses a valid payload', () => {
    const result = parseMetricsDeltaAtom('ABC123:DEF456');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atom.kind).toBe('metrics-delta');
    expect(result.atom.beforeReceiptId).toBe('ABC123');
    expect(result.atom.afterReceiptId).toBe('DEF456');
  });

  it('rejects payload without colon separator', () => {
    const result = parseMetricsDeltaAtom('NOCOLON');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/metrics-delta atom requires format/);
  });

  it('rejects payload with empty beforeReceiptId', () => {
    const result = parseMetricsDeltaAtom(':DEF456');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/metrics-delta atom requires format/);
  });

  it('rejects payload with empty afterReceiptId', () => {
    const result = parseMetricsDeltaAtom('ABC123:');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/metrics-delta atom requires format/);
  });
});

// ---------------------------------------------------------------------------
// isMetricImproved
// ---------------------------------------------------------------------------

describe('isMetricImproved', () => {
  it('treats higher-is-better keys as improved when after ≥ before', () => {
    expect(isMetricImproved('testsPassed', 5, 6)).toBe(true);
    expect(isMetricImproved('testsPassed', 5, 5)).toBe(true);
    expect(isMetricImproved('testsPassed', 6, 5)).toBe(false);
  });

  it('treats coveragePct as improved when after ≥ before', () => {
    expect(isMetricImproved('coveragePct', 80, 85)).toBe(true);
    expect(isMetricImproved('coveragePct', 85, 80)).toBe(false);
  });

  it('treats bundleSizeKb as improved when after ≤ before (lower-is-better)', () => {
    expect(isMetricImproved('bundleSizeKb', 100, 90)).toBe(true);
    expect(isMetricImproved('bundleSizeKb', 100, 100)).toBe(true);
    expect(isMetricImproved('bundleSizeKb', 90, 100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateMetricsDeltaAtom — green path
// ---------------------------------------------------------------------------

describe('validateMetricsDeltaAtom — green path', () => {
  it('accepts: before (5 tests passing) → after (6 tests passing)', async () => {
    const beforeId = await appendTestBaselineEvent(
      { testsPassed: 5 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTestBaselineEvent({ testsPassed: 6 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected ok but got: ${result.reason}`);
    }
    expect(result.atom.beforeMetrics.testsPassed).toBe(5);
    expect(result.atom.afterMetrics.testsPassed).toBe(6);
  });

  it('accepts: same test count (equal is not a regression)', async () => {
    const beforeId = await appendTestBaselineEvent(
      { testsPassed: 10 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTestBaselineEvent({ testsPassed: 10 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(true);
  });

  it('accepts: bundleSizeKb decreased (lower is better)', async () => {
    const beforeId = await appendTestBaselineEvent(
      { bundleSizeKb: 500 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTestBaselineEvent({ bundleSizeKb: 450 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateMetricsDeltaAtom — regression path
// ---------------------------------------------------------------------------

describe('validateMetricsDeltaAtom — regression path', () => {
  it('rejects: before (6 tests) → after (5 tests) is a regression', async () => {
    const beforeId = await appendTestBaselineEvent(
      { testsPassed: 6 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTestBaselineEvent({ testsPassed: 5 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(result.reason).toMatch(/testsPassed.*before=6.*after=5/);
  });

  it('rejects: bundleSizeKb increased (lower is better, so increase is regression)', async () => {
    const beforeId = await appendTestBaselineEvent(
      { bundleSizeKb: 400 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTestBaselineEvent({ bundleSizeKb: 500 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(result.reason).toMatch(/bundleSizeKb/);
  });
});

// ---------------------------------------------------------------------------
// validateMetricsDeltaAtom — gaming path (timestamp check)
// ---------------------------------------------------------------------------

describe('validateMetricsDeltaAtom — gaming path', () => {
  it('rejects: after event predates before event (swapped order)', async () => {
    // Intentionally write the "after" event with an earlier timestamp.
    const afterId = await appendTestBaselineEvent(
      { testsPassed: 6 },
      new Date(Date.now() - 20_000).toISOString(), // OLDER timestamp
    );
    const beforeId = await appendTestBaselineEvent(
      { testsPassed: 5 },
      new Date().toISOString(), // NEWER timestamp
    );

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TAMPERED');
    expect(result.reason).toMatch(/must be strictly later/);
  });

  it('rejects: after event has the same timestamp as before event', async () => {
    const sameTimestamp = new Date(Date.now() - 5_000).toISOString();
    const beforeId = await appendTestBaselineEvent({ testsPassed: 5 }, sameTimestamp);
    const afterId = await appendTestBaselineEvent({ testsPassed: 6 }, sameTimestamp);

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TAMPERED');
  });
});

// ---------------------------------------------------------------------------
// validateMetricsDeltaAtom — missing / tampered signature
// ---------------------------------------------------------------------------

describe('validateMetricsDeltaAtom — signature validation', () => {
  it('rejects: before event has an invalid (zeroed) signature', async () => {
    const beforeId = await appendTamperedBaselineEvent({ testsPassed: 5 });
    const afterId = await appendTestBaselineEvent({ testsPassed: 6 }, new Date().toISOString());

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TAMPERED');
    expect(result.reason).toMatch(/before baseline.*invalid/i);
  });

  it('rejects: after event has an invalid (zeroed) signature', async () => {
    const beforeId = await appendTestBaselineEvent(
      { testsPassed: 5 },
      new Date(Date.now() - 10_000).toISOString(),
    );
    const afterId = await appendTamperedBaselineEvent({ testsPassed: 6 });

    const parsed = parseMetricsDeltaAtom(`${beforeId}:${afterId}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_TAMPERED');
    expect(result.reason).toMatch(/after baseline.*invalid/i);
  });

  it('rejects: receiptId not found in event log', async () => {
    const parsed = parseMetricsDeltaAtom('NONEXISTENT001:NONEXISTENT002');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await validateMetricsDeltaAtom(parsed.atom, tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_MISSING');
    expect(result.reason).toMatch(/NONEXISTENT001/);
  });
});

// ---------------------------------------------------------------------------
// isTier3Task
// ---------------------------------------------------------------------------

describe('isTier3Task', () => {
  it('returns true for tier 3', () => {
    expect(isTier3Task('{"sentient":{"tier":3}}')).toBe(true);
  });

  it('returns false for tier 1', () => {
    expect(isTier3Task('{"sentient":{"tier":1}}')).toBe(false);
  });

  it('returns false for tier 2', () => {
    expect(isTier3Task('{"sentient":{"tier":2}}')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTier3Task(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTier3Task(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTier3Task('')).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(isTier3Task('{not json')).toBe(false);
  });

  it('returns false when sentient key is absent', () => {
    expect(isTier3Task('{"other":"value"}')).toBe(false);
  });

  it('returns false when tier is a string, not a number', () => {
    expect(isTier3Task('{"sentient":{"tier":"3"}}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeRequiredGates
// ---------------------------------------------------------------------------

describe('computeRequiredGates', () => {
  it('injects metricsImproved for Tier-3 tasks', () => {
    const gates = computeRequiredGates(['implemented', 'testsPassed'], '{"sentient":{"tier":3}}');
    expect(gates).toContain('metricsImproved');
  });

  it('does NOT inject metricsImproved for Tier-1 tasks', () => {
    const gates = computeRequiredGates(['implemented', 'testsPassed'], '{"sentient":{"tier":1}}');
    expect(gates).not.toContain('metricsImproved');
  });

  it('does NOT inject metricsImproved for tasks with no sentient metadata', () => {
    const gates = computeRequiredGates(['implemented', 'testsPassed'], null);
    expect(gates).not.toContain('metricsImproved');
  });

  it('injects metricsImproved when explicitly requested regardless of tier', () => {
    const gates = computeRequiredGates(['implemented'], '{"sentient":{"tier":1}}', [
      'metricsImproved',
    ]);
    expect(gates).toContain('metricsImproved');
  });

  it('preserves canonical gate order', () => {
    const gates = computeRequiredGates(
      ['documented', 'implemented', 'testsPassed'],
      '{"sentient":{"tier":3}}',
    );
    const implIdx = gates.indexOf('implemented');
    const testsIdx = gates.indexOf('testsPassed');
    const docIdx = gates.indexOf('documented');
    const metricsIdx = gates.indexOf('metricsImproved');
    expect(implIdx).toBeLessThan(testsIdx);
    expect(docIdx).toBeLessThan(metricsIdx);
  });

  it('deduplicates gates when metricsImproved appears in both base and explicit', () => {
    const gates = computeRequiredGates(
      ['implemented', 'metricsImproved'],
      '{"sentient":{"tier":3}}',
      ['metricsImproved'],
    );
    const count = gates.filter((g) => g === 'metricsImproved').length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isExtendedGateName
// ---------------------------------------------------------------------------

describe('isExtendedGateName', () => {
  it('accepts all standard gates', () => {
    for (const gate of [
      'implemented',
      'testsPassed',
      'qaPassed',
      'cleanupDone',
      'securityPassed',
      'documented',
      'metricsImproved',
    ]) {
      expect(isExtendedGateName(gate)).toBe(true);
    }
  });

  it('rejects unknown names', () => {
    expect(isExtendedGateName('unknown')).toBe(false);
    expect(isExtendedGateName('')).toBe(false);
    expect(isExtendedGateName('IMPLEMENTED')).toBe(false);
  });
});
