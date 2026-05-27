/**
 * Confirms the one-cycle deprecation contract for the legacy
 * `<projectRoot>/.cleo/worktree-include` path (T9983).
 *
 * - When only the legacy file exists, the reader still returns its patterns.
 * - The reader emits a `DeprecationWarning` via `process.emitWarning` at
 *   most ONCE per process for the legacy code-path.
 *
 * @task T9983
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorktreeIncludePatterns } from '../worktree-include.js';

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('legacy .cleo/worktree-include deprecation warning (T9983)', () => {
  // process.emitWarning is process-global — capture the WARNING event.
  let emitted: Array<{ name: string; message: string }> = [];
  const listener = (warning: Error) => {
    emitted.push({ name: warning.name, message: warning.message });
  };

  beforeEach(() => {
    emitted = [];
    process.on('warning', listener);
  });

  afterEach(() => {
    process.off('warning', listener);
  });

  it('emits a DeprecationWarning when only the legacy path is present', async () => {
    const dir = makeTmpDir('legacy-warn');
    mkdirSync(join(dir, '.cleo'), { recursive: true });
    writeFileSync(join(dir, '.cleo', 'worktree-include'), '.env.local\n');

    const patterns = loadWorktreeIncludePatterns(dir);
    // Allow the event loop to flush the warning event.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Functional contract — patterns are still returned.
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ pattern: '.env.local', negated: false });

    // Deprecation contract — at least one DeprecationWarning was emitted
    // mentioning the legacy file or the migrate verb.
    const deprecations = emitted.filter((e) => e.name === 'DeprecationWarning');
    const mentionsLegacy = deprecations.some(
      (e) =>
        e.message.includes('.cleo/worktree-include') ||
        e.message.includes('cleo doctor --migrate-worktree-include'),
    );
    expect(mentionsLegacy).toBe(true);

    rmSync(dir, { recursive: true });
  });
});
