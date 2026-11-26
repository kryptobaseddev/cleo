/**
 * An addon without the import-graph entry point `cantValidateFile` (T14642):
 * `validateDocument` falls back to `cantValidateDocument(content, filePath)`.
 * A v2026.11.17 addon honours the path (S03/S11/S12 run, `importRulesRun`
 * stays `true`); an older one ignores it, and only then is `importRulesRun`
 * `false`.
 *
 * @task T14642
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const empty = { valid: true, total: 0, errorCount: 0, warningCount: 0, diagnostics: [] };
const validateDocumentNative = vi.fn().mockReturnValue(empty);
const legacyWalksImports = vi.fn();

vi.mock('../src/native-loader', () => ({
  cantExecutePipelineNative: vi.fn(),
  cantParseDocumentNative: vi.fn(),
  cantValidateDocumentNative: (...args: unknown[]) => validateDocumentNative(...args),
  // What the loader returns when the addon has no `cantValidateFile` export.
  cantValidateFileNative: vi.fn().mockReturnValue(null),
  cantLegacyEntryPointWalksImports: () => legacyWalksImports(),
}));

import { validateDocument } from '../src/document';

const dir = mkdtempSync(join(tmpdir(), 'cant-validate-fallback-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const content = '@import "./missing.cant"\n';

describe('validateDocument with an addon lacking cantValidateFile', () => {
  it('passes filePath to the old entry point; a v2026.11.17 addon still runs import rules', async () => {
    const file = join(dir, 'main.cant');
    writeFileSync(file, content);
    legacyWalksImports.mockReturnValue(true);
    const result = await validateDocument(file);
    expect(validateDocumentNative).toHaveBeenCalledWith(content, file);
    expect(result.importRulesRun).toBe(true);
  });

  it('reports importRulesRun false only when the old entry point ignores filePath', async () => {
    const file = join(dir, 'older.cant');
    writeFileSync(file, content);
    legacyWalksImports.mockReturnValue(false);
    const result = await validateDocument(file);
    expect(validateDocumentNative).toHaveBeenCalledWith(content, file);
    expect(result.importRulesRun).toBe(false);
  });
});
