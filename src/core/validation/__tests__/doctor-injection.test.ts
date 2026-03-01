/**
 * Tests for injection chain doctor checks:
 * - checkCaampMarkerIntegrity
 * - checkAtReferenceTargetExists
 * - checkTemplateFreshness
 * - checkTierMarkersPresent
 *
 * @task T5153
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkCaampMarkerIntegrity,
  checkAtReferenceTargetExists,
  checkTemplateFreshness,
  checkTierMarkersPresent,
} from '../doctor/checks.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `cleo-injection-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================================
// checkCaampMarkerIntegrity
// ============================================================================

describe('checkCaampMarkerIntegrity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes when both files have balanced markers', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '<!-- CAAMP:START -->\n@AGENTS.md\n<!-- CAAMP:END -->\n',
    );
    writeFileSync(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n',
    );

    const result = checkCaampMarkerIntegrity(tempDir);
    expect(result.status).toBe('passed');
    expect(result.id).toBe('caamp_marker_integrity');
  });

  it('warns when CAAMP markers are unbalanced', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '<!-- CAAMP:START -->\n@AGENTS.md\n',
    );

    const result = checkCaampMarkerIntegrity(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('CAAMP marker issues');
    expect((result.details.issues as string[])).toContainEqual(
      expect.stringContaining('1 CAAMP:START vs 0 CAAMP:END'),
    );
  });

  it('warns when file has no CAAMP markers at all', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# No markers here\n');

    const result = checkCaampMarkerIntegrity(tempDir);
    expect(result.status).toBe('warning');
    expect((result.details.issues as string[])).toContainEqual(
      expect.stringContaining('no CAAMP markers found'),
    );
  });

  it('passes when neither CLAUDE.md nor AGENTS.md exists', () => {
    const result = checkCaampMarkerIntegrity(tempDir);
    expect(result.status).toBe('passed');
  });
});

// ============================================================================
// checkAtReferenceTargetExists
// ============================================================================

describe('checkAtReferenceTargetExists', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns info when AGENTS.md does not exist', () => {
    const result = checkAtReferenceTargetExists(tempDir);
    expect(result.status).toBe('info');
    expect(result.id).toBe('at_reference_targets');
  });

  it('returns info when AGENTS.md has no CAAMP block', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Just a plain file\n');

    const result = checkAtReferenceTargetExists(tempDir);
    expect(result.status).toBe('info');
    expect(result.details.hasCaampBlock).toBe(false);
  });

  it('passes when all @ reference targets exist', () => {
    // Create a local ref target
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', 'project-context.json'), '{}');

    writeFileSync(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@.cleo/project-context.json\n<!-- CAAMP:END -->\n',
    );

    const result = checkAtReferenceTargetExists(tempDir);
    expect(result.status).toBe('passed');
    expect(result.details.totalRefs).toBe(1);
  });

  it('warns when a @ reference target is missing', () => {
    writeFileSync(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@nonexistent/file.md\n<!-- CAAMP:END -->\n',
    );

    const result = checkAtReferenceTargetExists(tempDir);
    expect(result.status).toBe('warning');
    expect((result.details.missing as string[])).toContain('nonexistent/file.md');
  });
});

// ============================================================================
// checkTemplateFreshness
// ============================================================================

describe('checkTemplateFreshness', () => {
  let tempDir: string;
  let fakeCleoHome: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    fakeCleoHome = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(fakeCleoHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns info when source template does not exist', () => {
    const result = checkTemplateFreshness(tempDir, fakeCleoHome);
    expect(result.status).toBe('info');
    expect(result.id).toBe('template_freshness');
  });

  it('warns when deployed template does not exist', () => {
    mkdirSync(join(tempDir, 'templates'), { recursive: true });
    writeFileSync(join(tempDir, 'templates', 'CLEO-INJECTION.md'), '# Source\n');

    const result = checkTemplateFreshness(tempDir, fakeCleoHome);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Deployed template not found');
  });

  it('passes when source and deployed templates match', () => {
    const content = '# CLEO Injection Template\nSome content here.\n';

    mkdirSync(join(tempDir, 'templates'), { recursive: true });
    writeFileSync(join(tempDir, 'templates', 'CLEO-INJECTION.md'), content);

    mkdirSync(join(fakeCleoHome, 'templates'), { recursive: true });
    writeFileSync(join(fakeCleoHome, 'templates', 'CLEO-INJECTION.md'), content);

    const result = checkTemplateFreshness(tempDir, fakeCleoHome);
    expect(result.status).toBe('passed');
    expect(result.details.match).toBe(true);
  });

  it('warns when source and deployed templates differ', () => {
    mkdirSync(join(tempDir, 'templates'), { recursive: true });
    writeFileSync(join(tempDir, 'templates', 'CLEO-INJECTION.md'), '# Source v2\n');

    mkdirSync(join(fakeCleoHome, 'templates'), { recursive: true });
    writeFileSync(join(fakeCleoHome, 'templates', 'CLEO-INJECTION.md'), '# Source v1\n');

    const result = checkTemplateFreshness(tempDir, fakeCleoHome);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('differs from source');
    expect(result.details.match).toBe(false);
  });
});

// ============================================================================
// checkTierMarkersPresent
// ============================================================================

describe('checkTierMarkersPresent', () => {
  let fakeCleoHome: string;

  beforeEach(() => {
    fakeCleoHome = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(fakeCleoHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('warns when template does not exist', () => {
    const result = checkTierMarkersPresent(fakeCleoHome);
    expect(result.status).toBe('warning');
    expect(result.id).toBe('tier_markers_present');
    expect(result.message).toContain('Template not found');
  });

  it('passes when all 3 tier markers are present with close tags', () => {
    mkdirSync(join(fakeCleoHome, 'templates'), { recursive: true });
    writeFileSync(
      join(fakeCleoHome, 'templates', 'CLEO-INJECTION.md'),
      [
        '<!-- TIER:minimal -->',
        'Minimal content',
        '<!-- /TIER:minimal -->',
        '<!-- TIER:standard -->',
        'Standard content',
        '<!-- /TIER:standard -->',
        '<!-- TIER:orchestrator -->',
        'Orchestrator content',
        '<!-- /TIER:orchestrator -->',
      ].join('\n'),
    );

    const result = checkTierMarkersPresent(fakeCleoHome);
    expect(result.status).toBe('passed');
    expect(result.message).toContain('All 3 tier markers');
  });

  it('warns when a tier marker is missing', () => {
    mkdirSync(join(fakeCleoHome, 'templates'), { recursive: true });
    writeFileSync(
      join(fakeCleoHome, 'templates', 'CLEO-INJECTION.md'),
      [
        '<!-- TIER:minimal -->',
        '<!-- /TIER:minimal -->',
        '<!-- TIER:standard -->',
        '<!-- /TIER:standard -->',
        // orchestrator missing entirely
      ].join('\n'),
    );

    const result = checkTierMarkersPresent(fakeCleoHome);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('missing: orchestrator');
    expect((result.details.missing as string[])).toContain('orchestrator');
  });

  it('warns when a tier marker is unclosed', () => {
    mkdirSync(join(fakeCleoHome, 'templates'), { recursive: true });
    writeFileSync(
      join(fakeCleoHome, 'templates', 'CLEO-INJECTION.md'),
      [
        '<!-- TIER:minimal -->',
        '<!-- /TIER:minimal -->',
        '<!-- TIER:standard -->',
        // standard not closed
        '<!-- TIER:orchestrator -->',
        '<!-- /TIER:orchestrator -->',
      ].join('\n'),
    );

    const result = checkTierMarkersPresent(fakeCleoHome);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('unclosed: standard');
    expect((result.details.unclosed as string[])).toContain('standard');
  });
});
