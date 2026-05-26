import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const commandsDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readCommand(name: string): string {
  return readFileSync(join(commandsDir, `${name}.ts`), 'utf8');
}

describe('T10614 docs/relations/context operation wrapper contracts', () => {
  it('routes relates query modes through the CLI operation wrapper instead of raw dispatch', () => {
    const source = readCommand('relates');

    expect(source).not.toContain('dispatchRaw');
    expect(source).not.toContain('handleRawError');
    expect(source).toContain("dispatchFromCli(\n      'query',\n      'tasks',\n      'relates'");
  });

  it('keeps context commands behind admin.context operation wrappers', () => {
    const source = readCommand('context');

    expect(source).not.toContain("from '@cleocode/core/internal'");
    expect(source).toContain("dispatchRaw('query', 'admin', 'context'");
    expect(source).toContain(
      "dispatchFromCli(\n      'query',\n      'admin',\n      'context.pull'",
    );
  });

  it('keeps canonical docs attachment verbs routed through docs operations', () => {
    const source = readCommand('docs');

    for (const operation of ['add', 'list', 'fetch', 'remove', 'generate', 'update']) {
      expect(source).toContain(`'docs',\n      '${operation}'`);
    }
    expect(source).toContain("resolveOperation('mutate', 'docs', 'update')");
  });

  it('keeps docs CLI domain actions behind dispatch wrappers instead of direct engine calls', () => {
    const source = readCommand('docs');

    expect(source).toContain('dispatchDocsRaw');
    for (const directEngineCall of [
      'exportDocument(',
      'searchDocs(',
      'searchAllProjectDocs(',
      'findSimilarDocs(',
      'mergeDocs(',
      'rankDocs(',
      'listDocVersions(',
      'publishDocs(',
      'publishDocsAsPr(',
      'syncFromGit(',
      'statusDocs(',
      'runDocsImport(',
    ]) {
      expect(source).not.toContain(directEngineCall);
    }
  });
});
