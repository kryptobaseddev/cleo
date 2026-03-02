/**
 * Tests for syncComplianceMetrics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncComplianceMetrics } from '../index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cleo-compliance-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.cleo', 'metrics'), { recursive: true });
  return dir;
}

function writeJsonl(dir: string, entries: Record<string, unknown>[]): void {
  const path = join(dir, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function readSummary(dir: string): Record<string, unknown> {
  const path = join(dir, '.cleo', 'metrics', 'compliance-summary.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-03-01T10:00:00Z',
    source_id: 'agent-1',
    source_type: 'subagent',
    compliance: {
      compliance_pass_rate: 1.0,
      rule_adherence_score: 0.9,
      violation_count: 0,
      violation_severity: 'none',
      manifest_integrity: 'valid',
    },
    efficiency: { input_tokens: 0, output_tokens: 0 },
    _context: { agent_type: 'test' },
    ...overrides,
  };
}

describe('syncComplianceMetrics', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts when no JSONL file exists', async () => {
    const result = await syncComplianceMetrics({ cwd: tmpDir });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.message).toBe('No compliance data found');
  });

  it('syncs entries and writes summary file', async () => {
    writeJsonl(tmpDir, [makeEntry(), makeEntry({ source_type: 'cli' })]);

    const result = await syncComplianceMetrics({ cwd: tmpDir });
    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.message).toBe('Synced 2 compliance entries');
    expect(result.globalStats).toBeDefined();

    const summary = readSummary(tmpDir);
    expect(summary.totalEntries).toBe(2);
    expect(summary.averagePassRate).toBe(1);
    expect(summary.averageAdherence).toBe(0.9);
    expect(summary.totalViolations).toBe(0);
    expect(summary.entriesByType).toEqual({ subagent: 1, cli: 1 });
  });

  it('computes violations correctly', async () => {
    writeJsonl(tmpDir, [
      makeEntry({
        compliance: {
          compliance_pass_rate: 0.5,
          rule_adherence_score: 0.6,
          violation_count: 3,
          violation_severity: 'high',
        },
      }),
      makeEntry(),
    ]);

    const result = await syncComplianceMetrics({ cwd: tmpDir });
    const stats = result.globalStats as Record<string, unknown>;
    expect(stats.totalViolations).toBe(3);
    expect(stats.averagePassRate).toBe(0.75);
  });

  it('skips sync when summary is newer than JSONL', async () => {
    writeJsonl(tmpDir, [makeEntry()]);

    // First sync creates the summary
    await syncComplianceMetrics({ cwd: tmpDir });

    // Backdate the JSONL so summary is newer
    const jsonlPath = join(tmpDir, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    const past = new Date(Date.now() - 60000);
    utimesSync(jsonlPath, past, past);

    const result = await syncComplianceMetrics({ cwd: tmpDir });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    expect((result.message as string)).toContain('up-to-date');
  });

  it('re-syncs when force is true even if summary is fresh', async () => {
    writeJsonl(tmpDir, [makeEntry()]);

    // First sync
    await syncComplianceMetrics({ cwd: tmpDir });

    // Backdate JSONL
    const jsonlPath = join(tmpDir, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    const past = new Date(Date.now() - 60000);
    utimesSync(jsonlPath, past, past);

    // Force sync should still recompute
    const result = await syncComplianceMetrics({ force: true, cwd: tmpDir });
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('handles empty JSONL file', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'metrics', 'COMPLIANCE.jsonl'), '', 'utf-8');

    const result = await syncComplianceMetrics({ cwd: tmpDir });
    expect(result.synced).toBe(0);
    expect(result.message).toBe('No entries to sync');

    const summary = readSummary(tmpDir);
    expect(summary.totalEntries).toBe(0);
  });
});
