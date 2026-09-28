/**
 * T12606 — spawn adapters write prompts under os.tmpdir(), never `/tmp`.
 *
 * The claude-code, codex and pi adapters wrote `/tmp/<provider>-spawn-<id>.txt`.
 * Windows has no `/tmp`, so every spawn failed there; macOS ignored `$TMPDIR`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeSpawnPromptFile, writeSpawnPromptFile } from '../providers/shared/prompt-file.js';

describe('writeSpawnPromptFile (T12606)', () => {
  it('writes under a fresh mkdtemp dir in os.tmpdir() and removes the dir', async () => {
    const file = await writeSpawnPromptFile('claude-spawn', 'hello');
    try {
      expect(readFileSync(file, 'utf-8')).toBe('hello');
      const rel = relative(realpathSync(tmpdir()), realpathSync(dirname(file)));
      expect(rel.startsWith('cleo-claude-spawn-')).toBe(true);
      expect(file.startsWith('/tmp/')).toBe(tmpdir() === '/tmp');
    } finally {
      await removeSpawnPromptFile(file);
    }
    expect(existsSync(dirname(file))).toBe(false);
  });

  it('gives concurrent spawns distinct directories', async () => {
    const [a, b] = await Promise.all([
      writeSpawnPromptFile('codex-spawn', 'a'),
      writeSpawnPromptFile('codex-spawn', 'b'),
    ]);
    expect(dirname(a)).not.toBe(dirname(b));
    await Promise.all([removeSpawnPromptFile(a), removeSpawnPromptFile(b)]);
  });
});
