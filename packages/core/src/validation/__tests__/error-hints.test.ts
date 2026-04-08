/**
 * Regression tests: CleoError fix hints on validation-layer throws.
 *
 * Each test invokes a validation function with invalid input and asserts that
 * the thrown CleoError carries a non-empty `fix` string and, where applicable,
 * a `details.field` identifying the failing field.
 *
 * @task T341
 * @epic T335
 */

import { describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { sanitizeFilePath } from '../engine.js';
import { loadManifestEntryByTaskId, loadManifestEntryFromFile } from '../protocols/_shared.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertErrorHints(
  fn: () => unknown,
  opts: { fixIncludes?: string; detailsField?: string },
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CleoError);
  const e = caught as CleoError;
  expect(e.fix).toBeTruthy();
  if (opts.fixIncludes) {
    expect(e.fix).toContain(opts.fixIncludes);
  }
  if (opts.detailsField) {
    expect(e.details).toBeDefined();
    expect(e.details!.field).toBe(opts.detailsField);
  }
}

// ---------------------------------------------------------------------------
// sanitizeFilePath — engine.ts
// ---------------------------------------------------------------------------

describe('error-hints: sanitizeFilePath', () => {
  it('empty path — fix mentions file path, field=path', () => {
    assertErrorHints(() => sanitizeFilePath(''), {
      detailsField: 'path',
    });
  });

  it('path with shell metachar — fix mentions shell metacharacters, field=path', () => {
    assertErrorHints(() => sanitizeFilePath('/tmp/file;rm -rf /'), {
      fixIncludes: 'metacharacter',
      detailsField: 'path',
    });
  });

  it('path ending in backslash — fix mentions backslash, field=path', () => {
    assertErrorHints(() => sanitizeFilePath('/tmp/file\\'), {
      fixIncludes: 'backslash',
      detailsField: 'path',
    });
  });

  it('path with newline — fix mentions newline, field=path', () => {
    assertErrorHints(() => sanitizeFilePath('/tmp/file\ninjected'), {
      fixIncludes: 'newline',
      detailsField: 'path',
    });
  });
});

// ---------------------------------------------------------------------------
// loadManifestEntryByTaskId — protocols/_shared.ts
// ---------------------------------------------------------------------------

describe('error-hints: loadManifestEntryByTaskId', () => {
  it('task not in manifest — fix mentions manifest entry, field=taskId', () => {
    // This will always throw NOT_FOUND since no manifest exists in test env
    assertErrorHints(() => loadManifestEntryByTaskId('T9999'), {
      fixIncludes: 'manifest',
      detailsField: 'taskId',
    });
  });
});

describe('error-hints: loadManifestEntryFromFile', () => {
  it('manifest file not found — fix mentions manifest file path, field=manifestFile', () => {
    assertErrorHints(() => loadManifestEntryFromFile('/nonexistent/path/manifest.json'), {
      fixIncludes: 'manifest',
      detailsField: 'manifestFile',
    });
  });
});
