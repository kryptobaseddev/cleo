/**
 * `importMemoryFiles` handles an observe refusal per entry (T13949, T13988):
 * a merged duplicate is skipped as already in BRAIN, a deferred or rejected
 * write is an error, and neither stops the import.
 *
 * @task T13988
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ImportDispatchResponse, importMemoryFiles } from '../import-from-provider.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-import-provider-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'memory'));
  for (const name of ['merged', 'pending', 'fresh']) {
    writeFileSync(
      join(dir, 'memory', `${name}.md`),
      `---\nname: ${name} lesson\ntype: project\n---\n\nBody of the ${name} entry.\n`,
    );
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A refusal envelope as the CLI observe operation returns it. */
function refused(gateAction: string, id: string): ImportDispatchResponse {
  return {
    success: false,
    error: { code: 'E_OBSERVE_NOT_STORED', message: 'Nothing stored', details: { id, gateAction } },
  };
}

describe('importMemoryFiles observe refusals (T13988)', () => {
  it('skips a merged duplicate, counts a deferred write as an error, imports the rest', async () => {
    const result = await importMemoryFiles({
      sourceDir: join(dir, 'memory'),
      projectRoot: join(dir, 'project'),
      dispatch: async (_gateway, _domain, _operation, params) => {
        const text = String(params['text']);
        if (text.includes('merged lesson')) return refused('merged', 'O-existing');
        if (text.includes('pending lesson')) return refused('pending', 'O-gate-placeholder');
        return { success: true };
      },
    });
    expect(result).toMatchObject({ total: 3, imported: 1, skipped: 1, errors: 1 });
    expect(result.skippedEntries).toEqual([
      { file: 'merged.md', reason: 'already in BRAIN as O-existing' },
    ]);
    expect(result.importedEntries.map((entry) => entry.file)).toEqual(['fresh.md']);
  });
});
