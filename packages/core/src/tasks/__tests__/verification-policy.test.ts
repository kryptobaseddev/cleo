/**
 * Per-kind verification gates (T14001, review of #2413): the non-code kinds
 * keep the project's own gates without testsPassed/qaPassed, and any code
 * path raises a task to the code gates whatever its kind or labels.
 *
 * @task T14001
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyEvidenceTask,
  isDocumentArtifact,
  isDocumentEvidencePath,
  loadVerificationGatePolicy,
  requiredGatesFor,
} from '../verification-policy.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-t14001-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  // Pin CLEO_DIR so path resolution reads this store's config.
  process.env['CLEO_DIR'] = join(root, '.cleo');
});
afterEach(() => {
  delete process.env['CLEO_DIR'];
  rmSync(root, { recursive: true, force: true });
});

function config(verification: Record<string, unknown>): void {
  writeFileSync(join(root, '.cleo', 'config.json'), JSON.stringify({ verification }));
}

describe('per-kind gates (T14001)', () => {
  it('non-code kinds keep the configured gates without testsPassed/qaPassed', async () => {
    config({ requiredGates: ['implemented', 'testsPassed', 'qaPassed', 'securityPassed'] });
    const policy = await loadVerificationGatePolicy(root);
    expect(requiredGatesFor(policy, 'code')).toEqual([
      'implemented',
      'testsPassed',
      'qaPassed',
      'securityPassed',
    ]);
    expect(requiredGatesFor(policy, 'research')).toEqual(['implemented', 'securityPassed']);
    expect(requiredGatesFor(policy, 'documentation')).toEqual(['implemented', 'securityPassed']);
  });

  it('a project override wins for its kind', async () => {
    config({
      requiredGates: ['implemented', 'testsPassed'],
      requiredGatesByKind: { research: ['implemented', 'testsPassed'] },
    });
    const policy = await loadVerificationGatePolicy(root);
    expect(requiredGatesFor(policy, 'research')).toEqual(['implemented', 'testsPassed']);
  });

  it('documents and CLEO blobs are document evidence; code and config are not', () => {
    expect(isDocumentEvidencePath('src/x.ts')).toBe(false);
    expect(isDocumentEvidencePath('package.json')).toBe(false);
    for (const doc of [
      'docs/findings.md',
      '.cleo/blobs/blobs/0123abcd',
      '.cleo/attachments/sha256/01/23abcd.md',
    ]) {
      expect(isDocumentEvidencePath(doc), doc).toBe(true);
    }
  });

  it('a docs label never hides a declared code file', () => {
    const task = (files: string[]) => ({ kind: 'work' as const, labels: ['docs'], files });
    expect(classifyEvidenceTask({ task: task(['src/x.ts']) })).toBe('code');
    expect(classifyEvidenceTask({ task: task([]) })).toBe('documentation');
  });

  it('document names count only with document extensions; a bare .txt is not one', () => {
    for (const doc of ['docs/a.md', 'README', 'pkg/README.md', 'LICENSE.txt', 'CHANGELOG.rst']) {
      expect(isDocumentArtifact(doc), doc).toBe(true);
    }
    for (const code of [
      'src/README.ts',
      'lib/CHANGELOG.mjs',
      'CMakeLists.txt',
      'requirements.txt',
      'notes.txt',
    ]) {
      expect(isDocumentArtifact(code), code).toBe(false);
    }
  });
});
