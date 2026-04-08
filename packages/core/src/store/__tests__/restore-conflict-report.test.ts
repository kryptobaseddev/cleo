/**
 * Tests for the T357 conflict report generator.
 *
 * Verifies that {@link buildConflictReport} and {@link writeConflictReport}
 * produce correctly structured markdown output per T311 spec §6.5 and that
 * all edge-cases (empty warnings, missing values, multi-file reports) are
 * handled consistently.
 *
 * @task T357
 * @epic T311
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConflictReport, writeConflictReport } from '../restore-conflict-report.js';
import type { JsonRestoreReport } from '../restore-json-merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(
  filename: 'config.json' | 'project-info.json' | 'project-context.json',
): JsonRestoreReport {
  return {
    filename,
    localGenerated: { x: 1 },
    imported: { x: 2 },
    classifications: [
      {
        path: 'projectRoot',
        local: '/local',
        imported: '/source',
        category: 'machine-local',
        resolution: 'A',
        rationale: 'expected to differ between machines',
      },
      {
        path: 'brain.embeddingProvider',
        local: 'local',
        imported: 'openai',
        category: 'user-intent',
        resolution: 'B',
        rationale: 'user intent — preserve from source',
      },
      {
        path: 'somethingNew',
        local: undefined,
        imported: 'value',
        category: 'unknown',
        resolution: 'manual-review',
        rationale: 'unclassified field — needs human review',
      },
    ],
    applied: {},
    conflictCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('T357 conflict report generator', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t357-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('buildConflictReport returns a non-empty markdown string', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/test.cleobundle.tar.gz',
      sourceMachineFingerprint: 'aaaa',
      targetMachineFingerprint: 'bbbb',
      cleoVersion: '2026.4.13',
    });
    expect(md).toContain('# T311 Import Conflict Report');
    expect(md).toContain('config.json');
    expect(md).toContain('projectRoot');
    expect(md).toContain('brain.embeddingProvider');
    expect(md).toContain('somethingNew');
    expect(md).toContain('manual-review');
  });

  it('groups Resolved and Manual review sections separately', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
    });
    const resolvedIdx = md.indexOf('Resolved');
    const manualIdx = md.indexOf('Manual review');
    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
    expect(manualIdx).toBeGreaterThanOrEqual(0);
    expect(manualIdx).toBeGreaterThan(resolvedIdx);
  });

  it('includes reauth warnings section when warnings present', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
      reauthWarnings: [
        { agentId: 'agent-1', reason: 'KDF mismatch' },
        { agentId: 'agent-2', reason: 'KDF mismatch' },
      ],
    });
    expect(md).toContain('Agent re-authentication required');
    expect(md).toContain('agent-1');
    expect(md).toContain('agent-2');
  });

  it('includes schema warnings section when present', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
      schemaWarnings: [
        { db: 'tasks', bundleVersion: '1', localVersion: '2', severity: 'older-bundle' },
      ],
    });
    expect(md).toContain('Schema compatibility warnings');
    expect(md).toContain('tasks');
    expect(md).toContain('older-bundle');
  });

  it('handles empty reauth and schema warnings gracefully', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
    });
    // Should still produce valid markdown — either skip the empty sections or print "None"
    expect(md.length).toBeGreaterThan(100);
  });

  it('writeConflictReport writes to .cleo/restore-conflicts.md', () => {
    const md = '# Test Report\n';
    fs.mkdirSync(path.join(tmpRoot, '.cleo'), { recursive: true });
    const written = writeConflictReport(tmpRoot, md);
    expect(written).toBe(path.join(tmpRoot, '.cleo', 'restore-conflicts.md'));
    expect(fs.readFileSync(written, 'utf-8')).toBe(md);
  });

  it('writeConflictReport creates .cleo/ if missing', () => {
    const md = '# Test\n';
    const written = writeConflictReport(tmpRoot, md);
    expect(fs.existsSync(written)).toBe(true);
  });

  it('handles missing fields (undefined values) in formatValue', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
    });
    // somethingNew has local=undefined → should render as "(not present)"
    expect(md).toContain('not present');
  });

  it('multi-file reports include all three filenames', () => {
    const md = buildConflictReport({
      reports: [
        makeReport('config.json'),
        makeReport('project-info.json'),
        makeReport('project-context.json'),
      ],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
    });
    expect(md).toContain('## config.json');
    expect(md).toContain('## project-info.json');
    expect(md).toContain('## project-context.json');
  });

  it('includes RESOLVED placeholder in manual-review items', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
    });
    expect(md).toContain('RESOLVED:');
    expect(md).toContain('cleo restore finalize');
  });

  it('includes source bundle path in header', () => {
    const bundlePath = '/home/user/my-project.cleobundle.tar.gz';
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath,
      sourceMachineFingerprint: 'src-fingerprint',
      targetMachineFingerprint: 'tgt-fingerprint',
      cleoVersion: '2026.4.13',
    });
    expect(md).toContain(bundlePath);
    expect(md).toContain('src-fingerprint');
    expect(md).toContain('tgt-fingerprint');
    expect(md).toContain('2026.4.13');
  });

  it('shows _None_ for empty reauth warnings', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
      reauthWarnings: [],
    });
    // When no re-auth warnings, the section should contain _None_
    const reauthIdx = md.indexOf('Agent re-authentication required');
    expect(reauthIdx).toBeGreaterThanOrEqual(0);
    const afterReauth = md.slice(reauthIdx);
    expect(afterReauth).toContain('_None_');
  });

  it('shows _None_ for empty schema warnings', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
      schemaWarnings: [],
    });
    const schemaIdx = md.indexOf('Schema compatibility warnings');
    expect(schemaIdx).toBeGreaterThanOrEqual(0);
    const afterSchema = md.slice(schemaIdx);
    expect(afterSchema).toContain('_None_');
  });

  it('newer-bundle schema warning contains correct status text', () => {
    const md = buildConflictReport({
      reports: [makeReport('config.json')],
      bundlePath: '/tmp/x',
      sourceMachineFingerprint: 'a',
      targetMachineFingerprint: 'b',
      cleoVersion: '2026.4.13',
      schemaWarnings: [
        { db: 'conduit', bundleVersion: '99', localVersion: '1', severity: 'newer-bundle' },
      ],
    });
    expect(md).toContain('newer-bundle: upgrade cleo for full support');
  });

  it('writeConflictReport returns absolute path', () => {
    const md = '# X\n';
    const written = writeConflictReport(tmpRoot, md);
    expect(path.isAbsolute(written)).toBe(true);
  });
});
