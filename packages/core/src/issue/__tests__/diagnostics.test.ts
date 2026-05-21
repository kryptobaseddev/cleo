/**
 * Tests for `collectDiagnostics` — primarily that the CLEO version is read
 * from package.json SSoT instead of a hardcoded literal (gh-402).
 *
 * @task T9839 (gh-402)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { collectDiagnostics, formatDiagnosticsTable } from '../diagnostics.js';

describe('collectDiagnostics — gh-402: version SSoT', () => {
  it('returns the CLEO version from @cleocode/cleo/package.json (not a hardcoded literal)', () => {
    const diag = collectDiagnostics();

    expect(diag.cleoVersion).toBeDefined();
    expect(typeof diag.cleoVersion).toBe('string');
    expect(diag.cleoVersion).not.toBe('2026.2.1');
    expect(diag.cleoVersion).not.toBe('');
    expect(diag.cleoVersion).not.toBe('not installed');
  });

  it('matches the version field in packages/cleo/package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cleoPkgPath = join(here, '..', '..', '..', '..', 'cleo', 'package.json');
    const cleoPkg = JSON.parse(readFileSync(cleoPkgPath, 'utf-8')) as { version: string };

    const diag = collectDiagnostics();
    expect(diag.cleoVersion).toBe(cleoPkg.version);
  });

  it('CalVer format (YYYY.M.patch) — guards against future hardcode regression', () => {
    const diag = collectDiagnostics();
    expect(diag.cleoVersion).toMatch(/^\d{4}\.\d{1,2}\.\d+(?:-[a-z0-9.]+)?$/);
  });

  it('exposes nodeVersion, os, shell, cleoHome, installLocation, ghVersion fields', () => {
    const diag = collectDiagnostics();
    expect(diag.nodeVersion).toMatch(/^v\d+/);
    expect(diag.os).toBeTruthy();
    expect(diag.shell).toBeTruthy();
    expect(diag.cleoHome).toBeTruthy();
    expect(diag.installLocation).toBeTruthy();
    expect(diag.ghVersion).toBeTruthy();
  });
});

describe('formatDiagnosticsTable', () => {
  it('renders a markdown table containing the resolved CLEO version', () => {
    const diag = collectDiagnostics();
    const md = formatDiagnosticsTable(diag);

    expect(md).toContain('## Environment');
    expect(md).toContain('| Component | Version |');
    expect(md).toContain(`| CLEO | ${diag.cleoVersion} |`);
    expect(md).not.toContain('| CLEO | 2026.2.1 |');
  });
});
