/**
 * Tests for manifest validation (subagent output validation).
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findManifestEntry,
  validateManifestEntry,
  logRealCompliance,
  validateAndLog,
} from '../manifest.js';
import type { ManifestEntry, ManifestValidationResult } from '../manifest.js';

// ============================================================================
// Helpers
// ============================================================================

function makeRoot(): string {
  const root = join(tmpdir(), `cleo-manifest-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function makeManifestFile(dir: string, entries: ManifestEntry[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'MANIFEST.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, content);
  return path;
}

function makeEntry(overrides?: Partial<ManifestEntry>): ManifestEntry {
  return {
    id: 'T001-research-2026-01-15',
    file: 'T001-research-2026-01-15.md',
    title: 'Research output for T001',
    date: '2026-01-15',
    status: 'completed',
    agent_type: 'research',
    topics: ['architecture', 'design'],
    key_findings: ['Finding one', 'Finding two', 'Finding three'],
    actionable: true,
    needs_followup: [],
    linked_tasks: ['T001'],
    ...overrides,
  };
}

// ============================================================================
// findManifestEntry
// ============================================================================

describe('findManifestEntry', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns matching manifest entry by taskId', async () => {
    const manifestPath = makeManifestFile(root, [makeEntry()]);
    const result = await findManifestEntry('T001', manifestPath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('T001-research-2026-01-15');
  });

  it('returns null when taskId not found', async () => {
    const manifestPath = makeManifestFile(root, [makeEntry()]);
    const result = await findManifestEntry('T999', manifestPath);
    expect(result).toBeNull();
  });

  it('returns null for non-existent manifest file', async () => {
    const result = await findManifestEntry('T001', join(root, 'missing.jsonl'));
    expect(result).toBeNull();
  });

  it('returns most recent entry when multiple match', async () => {
    const entries = [
      makeEntry({ id: 'T001-research-old', title: 'Old entry' }),
      makeEntry({ id: 'T001-research-new', title: 'New entry' }),
    ];
    const manifestPath = makeManifestFile(root, entries);
    const result = await findManifestEntry('T001', manifestPath);
    // Should return the last matching entry (most recent)
    expect(result!.id).toBe('T001-research-new');
  });

  it('skips malformed JSONL lines', async () => {
    const dir = join(root, 'agent-outputs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'MANIFEST.jsonl');
    writeFileSync(path, [
      'NOT VALID JSON',
      JSON.stringify(makeEntry()),
    ].join('\n'));
    const result = await findManifestEntry('T001', path);
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// validateManifestEntry
// ============================================================================

describe('validateManifestEntry', () => {
  it('passes for a complete, valid entry', async () => {
    const result = await validateManifestEntry('T001', makeEntry());
    expect(result.valid).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.violations).toHaveLength(0);
  });

  it('fails when no manifest entry found', async () => {
    const result = await validateManifestEntry('T001', null);
    expect(result.valid).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].requirement).toBe('MANIFEST-001');
  });

  it('fails when entry missing required id field', async () => {
    const entry = makeEntry({ id: '' });
    const result = await validateManifestEntry('T001', entry);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.requirement === 'BASIC-000')).toBe(true);
  });

  it('fails when entry missing required status field', async () => {
    const entry = makeEntry({ status: '' as ManifestEntry['status'] });
    const result = await validateManifestEntry('T001', entry);
    expect(result.valid).toBe(false);
  });

  it('warns when key_findings has fewer than 3 items', async () => {
    const entry = makeEntry({ key_findings: ['Only one finding'] });
    const result = await validateManifestEntry('T001', entry);
    expect(result.score).toBeLessThan(70);
    expect(result.violations.some(v => v.requirement === 'BASIC-001')).toBe(true);
  });

  it('deducts score for missing key_findings array', async () => {
    const entry = makeEntry({ key_findings: undefined });
    const result = await validateManifestEntry('T001', entry);
    expect(result.score).toBeLessThanOrEqual(50);
    expect(result.violations.some(v => v.severity === 'error')).toBe(true);
  });

  it('deducts score for missing file field', async () => {
    const entry = makeEntry({ file: '' });
    const result = await validateManifestEntry('T001', entry);
    expect(result.violations.some(v => v.requirement === 'BASIC-002')).toBe(true);
  });

  it('deducts score for missing linked_tasks', async () => {
    const entry = makeEntry({ linked_tasks: [] });
    const result = await validateManifestEntry('T001', entry);
    expect(result.violations.some(v => v.requirement === 'BASIC-004')).toBe(true);
  });

  it('includes agent_type in result', async () => {
    const result = await validateManifestEntry('T001', makeEntry({ agent_type: 'consensus' }));
    expect(result.agent_type).toBe('consensus');
  });
});

// ============================================================================
// logRealCompliance
// ============================================================================

describe('logRealCompliance', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes a compliance entry to the JSONL file', async () => {
    const compliancePath = join(root, 'metrics', 'COMPLIANCE.jsonl');
    const validResult: ManifestValidationResult = {
      valid: true,
      score: 90,
      pass: true,
      violations: [],
    };

    await logRealCompliance('T001', validResult, 'research', compliancePath);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(compliancePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.source_id).toBe('T001');
    expect(entry.compliance.compliance_pass_rate).toBe(1.0);
    expect(entry.compliance.violation_count).toBe(0);
    expect(entry._context.agent_type).toBe('research');
  });

  it('creates metrics directory if it does not exist', async () => {
    const compliancePath = join(root, 'deep', 'nested', 'metrics', 'COMPLIANCE.jsonl');
    const result: ManifestValidationResult = { valid: true, score: 75, pass: true, violations: [] };

    await logRealCompliance('T002', result, 'implementation', compliancePath);

    const { existsSync } = await import('node:fs');
    expect(existsSync(compliancePath)).toBe(true);
  });

  it('logs correct severity for error violations', async () => {
    const compliancePath = join(root, 'metrics', 'COMPLIANCE.jsonl');
    const result: ManifestValidationResult = {
      valid: false,
      score: 0,
      pass: false,
      violations: [{ requirement: 'MANIFEST-001', severity: 'error', message: 'No entry' }],
    };

    await logRealCompliance('T003', result, 'unknown', compliancePath);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(compliancePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.compliance.violation_severity).toBe('error');
    expect(entry.compliance.manifest_integrity).toBe('violations_found');
  });

  it('logs correct severity for warning violations', async () => {
    const compliancePath = join(root, 'metrics', 'COMPLIANCE.jsonl');
    const result: ManifestValidationResult = {
      valid: false,
      score: 60,
      pass: false,
      violations: [{ requirement: 'BASIC-001', severity: 'warning', message: 'Few findings' }],
    };

    await logRealCompliance('T004', result, 'research', compliancePath);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(compliancePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.compliance.violation_severity).toBe('warning');
  });
});

// ============================================================================
// validateAndLog (combined)
// ============================================================================

describe('validateAndLog', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('validates and logs a passing entry', async () => {
    const manifestPath = makeManifestFile(root, [makeEntry()]);
    const compliancePath = join(root, 'metrics', 'COMPLIANCE.jsonl');

    const result = await validateAndLog('T001', manifestPath, compliancePath);

    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(compliancePath, 'utf-8');
    const logged = JSON.parse(content.trim());
    expect(logged.source_id).toBe('T001');
  });

  it('logs failure when no manifest entry found', async () => {
    const manifestPath = join(root, 'empty.jsonl');
    writeFileSync(manifestPath, '');
    const compliancePath = join(root, 'metrics', 'COMPLIANCE.jsonl');

    const result = await validateAndLog('T999', manifestPath, compliancePath);

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(compliancePath, 'utf-8');
    const logged = JSON.parse(content.trim());
    expect(logged.compliance.compliance_pass_rate).toBe(0);
  });
});
