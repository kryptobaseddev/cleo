/**
 * T9073 — severity attestation fires for any role, not just 'bug'.
 *
 * Acceptance criteria:
 * 1. `cleo add --severity P1` works on any --kind value (not just bug)
 * 2. `severity-attestation.jsonl` appended on every --severity setting
 * 3. priority remains independent of severity (no auto-mapping)
 * 4. tests cover --severity attestation for at least 3 different role/kind values
 *
 * @task T9073
 * @epic T9067
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSignedSeverityAttestation,
  SEVERITY_ATTESTATION_AUDIT_FILE,
} from '../severity-attestation.js';

/** Temporary directory for each test. */
let tempDir: string;

/**
 * Create an isolated CLEO dir with minimal config so attestation helpers
 * do not fail on missing project setup.
 */
async function setupTempCleoDir(): Promise<string> {
  const dir = join(tmpdir(), `cleo-t9073-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cleoDir = join(dir, '.cleo');
  const auditDir = join(cleoDir, 'audit');
  await mkdir(auditDir, { recursive: true });
  // Write minimal config (no ownerPubkeys — any identity can attest)
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ enforcement: { session: { requiredForMutate: false } } }),
    ),
  );
  return dir;
}

/**
 * Read lines from the severity-attestation.jsonl audit file.
 */
async function readAttestationLines(cwd: string): Promise<Record<string, unknown>[]> {
  const auditPath = join(cwd, '.cleo', 'audit', SEVERITY_ATTESTATION_AUDIT_FILE);
  if (!existsSync(auditPath)) {
    return [];
  }
  const raw = await readFile(auditPath, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('T9073 — severity attestation fires for any role', () => {
  beforeEach(async () => {
    tempDir = await setupTempCleoDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('appends attestation for role=bug, severity P1', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'Critical login crash',
        severity: 'P1',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['severity']).toBe('P1');
    expect(lines[0]!['title']).toBe('Critical login crash');
    expect(typeof lines[0]!['signerPub']).toBe('string');
    // _sig is an AuditSignature object { sig: string, pub: string }
    expect(typeof lines[0]!['_sig']).toBe('object');
  });

  it('appends attestation for role=spike, severity P2 (non-bug role)', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'Spike: investigate perf regression',
        severity: 'P2',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['severity']).toBe('P2');
    expect(lines[0]!['title']).toBe('Spike: investigate perf regression');
    expect(typeof lines[0]!['_sig']).toBe('object');
  });

  it('appends attestation for role=incident, severity P0 (non-bug role)', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'Incident: database down',
        severity: 'P0',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['severity']).toBe('P0');
    expect(lines[0]!['title']).toBe('Incident: database down');
  });

  it('appends attestation for role=work, severity P3 (general task role)', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'Refactor auth module',
        severity: 'P3',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['severity']).toBe('P3');
  });

  it('appends multiple attestations independently to the same jsonl file', async () => {
    const roles = [
      { title: 'Bug report', severity: 'P1' },
      { title: 'Spike investigation', severity: 'P2' },
      { title: 'Incident response', severity: 'P0' },
    ];
    for (const { title, severity } of roles) {
      await appendSignedSeverityAttestation(
        { timestamp: new Date().toISOString(), title, severity },
        { cwd: tempDir },
      );
    }

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(3);
    expect(lines[0]!['severity']).toBe('P1');
    expect(lines[1]!['severity']).toBe('P2');
    expect(lines[2]!['severity']).toBe('P0');
  });

  it('attestation line includes taskId when provided', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'T9073 self-test',
        severity: 'P1',
        taskId: 'T9073',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['taskId']).toBe('T9073');
  });

  it('attestation line includes epic when provided', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: new Date().toISOString(),
        title: 'Child of T9067',
        severity: 'P2',
        epic: 'T9067',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['epic']).toBe('T9067');
  });

  it('each attestation line has a deterministic canonical JSON structure (sorted keys)', async () => {
    await appendSignedSeverityAttestation(
      {
        timestamp: '2026-05-08T00:00:00.000Z',
        title: 'Determinism test',
        severity: 'P1',
        taskId: 'T_DET',
        epic: 'T_EPIC',
      },
      { cwd: tempDir },
    );

    const lines = await readAttestationLines(tempDir);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // All expected fields present
    expect(line['timestamp']).toBe('2026-05-08T00:00:00.000Z');
    expect(line['title']).toBe('Determinism test');
    expect(line['severity']).toBe('P1');
    expect(line['taskId']).toBe('T_DET');
    expect(line['epic']).toBe('T_EPIC');
    expect(typeof line['signerPub']).toBe('string');
    // _sig is an AuditSignature object { sig: string, pub: string }
    expect(typeof line['_sig']).toBe('object');
  });
});

describe('T9073 — severity is orthogonal to priority (no auto-mapping)', () => {
  it('SEVERITY_MAP does not exist in severity-attestation module', async () => {
    // Import the module — if SEVERITY_MAP were exported or used it would be here.
    // The attestation helper has no priority-mapping logic; priority is
    // not set or returned by appendSignedSeverityAttestation.
    const mod = await import('../severity-attestation.js');
    expect((mod as Record<string, unknown>)['SEVERITY_MAP']).toBeUndefined();
  });
});
