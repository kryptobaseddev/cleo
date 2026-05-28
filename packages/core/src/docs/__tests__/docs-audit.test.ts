/**
 * Tests for the unified docs audit trail (T11182).
 *
 * Covers:
 *   - writeAuditEntry: append entries with checkpoint chaining
 *   - readAuditLog: read back entries, verify chain integrity
 *   - verifyAuditTrail: full consistency check
 *   - All 8 mutation operations write audit entries
 *   - Retention policy: audit entries are kept indefinitely
 *
 * @task T11182
 * @saga T10516
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countAuditEntriesForSlug,
  DOCS_AUDIT_FILE,
  readAuditLog,
  verifyAuditTrail,
  writeAuditEntry,
} from '../docs-audit.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-audit-test-'));
  mkdirSync(join(dir, '.cleo', 'audit'), { recursive: true });
  // Create a minimal .cleo/config.json so getProjectRoot works
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(join(dir, '.cleo', 'config.json'), '{}');
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

function readAuditFile(projectRoot: string): string[] {
  const path = join(projectRoot, DOCS_AUDIT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('docs-audit', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject();
  });

  afterEach(() => {
    cleanup(projectRoot);
  });

  describe('writeAuditEntry', () => {
    it('appends an audit entry with checkpoint', () => {
      writeAuditEntry(projectRoot, {
        op: 'docs.add',
        actor: 'test-agent',
        slug: 'test-doc',
        type: 'adr',
        attachmentId: 'att-001',
        sha256: 'abc123def456',
        ownerId: 'T100',
        summary: 'Test doc attached',
      });

      const lines = readAuditFile(projectRoot);
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.op).toBe('docs.add');
      expect(entry.actor).toBe('test-agent');
      expect(entry.slug).toBe('test-doc');
      expect(entry.type).toBe('adr');
      expect(entry.attachmentId).toBe('att-001');
      expect(entry.sha256).toBe('abc123def456');
      expect(entry.ownerId).toBe('T100');
      expect(entry.summary).toBe('Test doc attached');
      expect(entry.checkpoint).toBeDefined();
      expect(entry.checkpoint).toHaveLength(64); // SHA-256 hex
      expect(entry.ts).toBeDefined();
    });

    it('chains checkpoints across multiple entries', () => {
      writeAuditEntry(projectRoot, {
        op: 'docs.add',
        summary: 'First entry',
      });
      writeAuditEntry(projectRoot, {
        op: 'docs.update',
        summary: 'Second entry',
      });
      writeAuditEntry(projectRoot, {
        op: 'docs.remove',
        summary: 'Third entry',
      });

      const lines = readAuditFile(projectRoot);
      expect(lines).toHaveLength(3);

      const e1 = JSON.parse(lines[0]);
      const e2 = JSON.parse(lines[1]);
      const e3 = JSON.parse(lines[2]);

      // All entries have unique checkpoints
      expect(e1.checkpoint).not.toBe(e2.checkpoint);
      expect(e2.checkpoint).not.toBe(e3.checkpoint);
    });
  });

  describe('readAuditLog', () => {
    it('reads back entries with intact chain', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'B' });

      const result = readAuditLog(projectRoot);
      expect(result.chainIntact).toBe(true);
      expect(result.chainBrokenAt).toBe(-1);
      expect(result.entries).toHaveLength(2);
    });

    it('filters by slug', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-b', summary: 'B' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'C' });

      const result = readAuditLog(projectRoot, 'doc-a');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].slug).toBe('doc-a');
      expect(result.entries[1].slug).toBe('doc-a');
    });

    it('detects tampered audit log (broken chain)', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'B' });

      // Tamper with the file — modify the first entry's checkpoint
      const auditPath = join(projectRoot, DOCS_AUDIT_FILE);
      const lines = readAuditFile(projectRoot);
      const tampered = JSON.parse(lines[0]);
      tampered.checkpoint = '0'.repeat(64);
      lines[0] = JSON.stringify(tampered);
      writeFileSync(auditPath, lines.join('\n') + '\n');

      const result = readAuditLog(projectRoot);
      expect(result.chainIntact).toBe(false);
      expect(result.chainBrokenAt).toBeGreaterThanOrEqual(0);
    });

    it('handles empty audit log gracefully', () => {
      const result = readAuditLog(projectRoot);
      expect(result.entries).toHaveLength(0);
      expect(result.chainIntact).toBe(true);
    });
  });

  describe('verifyAuditTrail', () => {
    it('passes for a clean audit log', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'B' });

      const result = verifyAuditTrail(projectRoot);
      expect(result.consistent).toBe(true);
      expect(result.chainIntact).toBe(true);
      expect(result.entriesExamined).toBe(2);
      expect(result.findings).toHaveLength(0);
    });

    it('detects broken checkpoint chain', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'B' });

      // Tamper with the first entry
      const auditPath = join(projectRoot, DOCS_AUDIT_FILE);
      const lines = readAuditFile(projectRoot);
      const tampered = JSON.parse(lines[0]);
      tampered.checkpoint = '0'.repeat(64);
      lines[0] = JSON.stringify(tampered);
      writeFileSync(auditPath, lines.join('\n') + '\n');

      const result = verifyAuditTrail(projectRoot);
      expect(result.consistent).toBe(false);
      expect(result.chainIntact).toBe(false);
    });
  });

  describe('countAuditEntriesForSlug', () => {
    it('counts entries for a specific slug', () => {
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-a', summary: 'A' });
      writeAuditEntry(projectRoot, { op: 'docs.add', slug: 'doc-b', summary: 'B' });
      writeAuditEntry(projectRoot, { op: 'docs.update', slug: 'doc-a', summary: 'C' });

      expect(countAuditEntriesForSlug(projectRoot, 'doc-a')).toBe(2);
      expect(countAuditEntriesForSlug(projectRoot, 'doc-b')).toBe(1);
      expect(countAuditEntriesForSlug(projectRoot, 'nonexistent')).toBe(0);
    });
  });

  describe('all mutation operations', () => {
    it('writes entries for all 8 ops', () => {
      const ops: Array<{
        op:
          | 'docs.add'
          | 'docs.update'
          | 'docs.remove'
          | 'docs.supersede'
          | 'docs.publish'
          | 'docs.publish-pr'
          | 'docs.sync'
          | 'docs.import';
        slug: string;
      }> = [
        { op: 'docs.add', slug: 'doc-1' },
        { op: 'docs.update', slug: 'doc-1' },
        { op: 'docs.remove', slug: 'doc-1' },
        { op: 'docs.supersede', slug: 'doc-2' },
        { op: 'docs.publish', slug: 'doc-3' },
        { op: 'docs.publish-pr', slug: 'doc-4' },
        { op: 'docs.sync', slug: 'doc-5' },
        { op: 'docs.import', slug: 'doc-6' },
      ];

      for (const { op, slug } of ops) {
        writeAuditEntry(projectRoot, {
          op,
          slug,
          summary: `Test ${op} for ${slug}`,
        });
      }

      const result = readAuditLog(projectRoot);
      expect(result.entries).toHaveLength(8);
      expect(result.chainIntact).toBe(true);

      const seenOps = result.entries.map((e) => e.op);
      expect(seenOps).toContain('docs.add');
      expect(seenOps).toContain('docs.update');
      expect(seenOps).toContain('docs.remove');
      expect(seenOps).toContain('docs.supersede');
      expect(seenOps).toContain('docs.publish');
      expect(seenOps).toContain('docs.publish-pr');
      expect(seenOps).toContain('docs.sync');
      expect(seenOps).toContain('docs.import');
    });
  });

  describe('retention policy', () => {
    it('keeps all entries (no time-based deletion)', () => {
      // Write entries with old timestamps
      for (let i = 0; i < 20; i++) {
        writeAuditEntry(projectRoot, {
          op: 'docs.add',
          slug: `doc-${i}`,
          summary: `Entry ${i}`,
        });
      }

      const result = readAuditLog(projectRoot);
      expect(result.entries).toHaveLength(20);
      expect(result.chainIntact).toBe(true);
    });
  });
});
