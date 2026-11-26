/**
 * An addon built before the import-graph entry point (T14642): the
 * `filePath` argument would be ignored silently, so `validateDocument` runs
 * the single-document rules and reports `importRulesRun: false`.
 *
 * @task T14642
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const empty = { valid: true, total: 0, errorCount: 0, warningCount: 0, diagnostics: [] };
const validateDocumentNative = vi.fn().mockReturnValue(empty);

vi.mock('../src/native-loader', () => ({
  cantExecutePipelineNative: vi.fn(),
  cantParseDocumentNative: vi.fn(),
  cantValidateDocumentNative: (...args: unknown[]) => validateDocumentNative(...args),
  // What the loader returns when the addon has no `cantValidateFile` export.
  cantValidateFileNative: vi.fn().mockReturnValue(null),
}));

import { validateDocument } from '../src/document';

const dir = mkdtempSync(join(tmpdir(), 'cant-validate-fallback-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('validateDocument with an addon lacking the import-graph entry point', () => {
  it('runs the single-document rules and reports that import rules did not run', async () => {
    const file = join(dir, 'main.cant');
    writeFileSync(file, '@import "./missing.cant"\n');
    const result = await validateDocument(file);
    expect(result.importRulesRun).toBe(false);
    expect(validateDocumentNative).toHaveBeenCalledWith('@import "./missing.cant"\n');
  });
});
