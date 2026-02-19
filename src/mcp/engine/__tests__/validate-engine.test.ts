/**
 * Validate Engine Tests
 *
 * Tests native TypeScript validate operations.
 *
 * @task T4477
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  validateManifest as validateManifestOp,
  validateOutput,
  validateComplianceSummary,
  validateComplianceViolations,
  validateComplianceRecord,
  validateTestStatus,
} from '../validate-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-validate-engine');
const CLEO_DIR = join(TEST_ROOT, '.cleo');
const METRICS_DIR = join(CLEO_DIR, 'metrics');
const MANIFEST_DIR = join(TEST_ROOT, '.cleo', 'agent-outputs');

function writeTodoJson(tasks: any[]): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'todo.json'),
    JSON.stringify({ tasks, _meta: { schemaVersion: '2.6.0' } }, null, 2),
    'utf-8'
  );
}

function writeManifest(entries: any[]): void {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(MANIFEST_DIR, 'MANIFEST.jsonl'), content, 'utf-8');
}

function writeCompliance(entries: any[]): void {
  mkdirSync(METRICS_DIR, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(METRICS_DIR, 'COMPLIANCE.jsonl'), content, 'utf-8');
}

describe('Validate Engine', () => {
  beforeEach(() => {
    mkdirSync(CLEO_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('validateManifest', () => {
    it('should validate well-formed manifest', () => {
      writeManifest([
        { id: 'T001-test', file: 'out.md', title: 'Test', date: '2026-01-01', status: 'complete', agent_type: 'research', topics: ['test'], actionable: true },
      ]);

      const result = validateManifestOp(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect((result.data as any).validEntries).toBe(1);
    });

    it('should detect invalid entries', () => {
      writeManifest([
        { id: 'T001-test' }, // missing fields
      ]);

      const result = validateManifestOp(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(false);
      expect((result.data as any).invalidEntries).toBe(1);
    });

    it('should handle missing manifest', () => {
      const result = validateManifestOp(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).totalEntries).toBe(0);
    });
  });

  describe('validateOutput', () => {
    it('should validate output file', () => {
      mkdirSync(join(TEST_ROOT, 'out'), { recursive: true });
      writeFileSync(
        join(TEST_ROOT, 'out', 'test.md'),
        '# Test Output\n\n## Summary\n\nThis is a test output for T001.\n',
        'utf-8'
      );

      const result = validateOutput('out/test.md', 'T001', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
    });

    it('should report missing file', () => {
      const result = validateOutput('nonexistent.md', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('validateComplianceSummary', () => {
    it('should return compliance summary', () => {
      writeCompliance([
        { timestamp: '2026-01-01T00:00:00Z', taskId: 'T001', protocol: 'research', result: 'pass' },
        { timestamp: '2026-01-02T00:00:00Z', taskId: 'T002', protocol: 'research', result: 'fail', violations: [{ code: 'P_MISSING', message: 'Missing' }] },
        { timestamp: '2026-01-03T00:00:00Z', taskId: 'T003', protocol: 'implementation', result: 'pass' },
      ]);

      const result = validateComplianceSummary(TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(3);
      expect(data.pass).toBe(2);
      expect(data.fail).toBe(1);
      expect(data.passRate).toBe(67);
    });

    it('should return empty when no data', () => {
      const result = validateComplianceSummary(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(0);
    });
  });

  describe('validateComplianceRecord', () => {
    it('should record compliance result', () => {
      const result = validateComplianceRecord('T001', 'pass', 'research', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).recorded).toBe(true);

      // Verify written
      const summary = validateComplianceSummary(TEST_ROOT);
      expect((summary.data as any).total).toBe(1);
    });

    it('should reject invalid result', () => {
      const result = validateComplianceRecord('T001', 'invalid', undefined, undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('validateComplianceViolations', () => {
    it('should list violations', () => {
      writeCompliance([
        { timestamp: '2026-01-01T00:00:00Z', taskId: 'T001', protocol: 'research', result: 'pass' },
        { timestamp: '2026-01-02T00:00:00Z', taskId: 'T002', protocol: 'research', result: 'fail', violations: [{ code: 'P1', message: 'error' }] },
      ]);

      const result = validateComplianceViolations(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });

  describe('validateTestStatus', () => {
    it('should report test directory status', () => {
      const result = validateTestStatus(TEST_ROOT);
      expect(result.success).toBe(true);
    });
  });
});
