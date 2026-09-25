/**
 * Every provider's global instruction path is absolute, or the provider is
 * excluded from global scope (T12379).
 *
 * `devin` and `replit-agent` declare `pathGlobal: ""`. Joining that with
 * `AGENTS.md` produced the RELATIVE path `AGENTS.md`, which a global write then
 * created in whatever directory the command ran from.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkAllInjections,
  injectAll,
  resolveGlobalInstructionPath,
} from '../../src/core/instructions/injector.js';
import { getAllProviders, getProvider } from '../../src/core/registry/providers.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('provider registry global instruction paths (T12379)', () => {
  it('resolves every global instruction path to an absolute path or excludes the provider', () => {
    const relative: string[] = [];
    for (const provider of getAllProviders()) {
      const joined = join(provider.pathGlobal, provider.instructFile);
      const resolved = resolveGlobalInstructionPath(provider);
      if (resolved !== null && !isAbsolute(resolved)) relative.push(`${provider.id}: ${resolved}`);
      // A relative join is only tolerated when the provider is excluded (null).
      if (!isAbsolute(joined) && resolved !== null) relative.push(`${provider.id}: ${joined}`);
    }
    expect(relative).toEqual([]);
  });

  it('excludes devin from global scope instead of writing a relative AGENTS.md', async () => {
    const devin = getProvider('devin');
    expect(devin).toBeDefined();
    if (!devin) return;
    expect(resolveGlobalInstructionPath(devin)).toBeNull();

    const cwd = await mkdtemp(join(tmpdir(), 'caamp-devin-'));
    dirs.push(cwd);
    expect((await injectAll([devin], cwd, 'global', 'content')).size).toBe(0);
    expect(await checkAllInjections([devin], cwd, 'global')).toEqual([]);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });
});
