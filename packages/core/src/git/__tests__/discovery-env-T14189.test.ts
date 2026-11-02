/**
 * T14189 — `discoveryEnv()` is the one place CLEO strips the variables git
 * exports to a hook (and to receive-side quarantine) that name a repository,
 * an index or an object store. Every git spawn that must act on its own
 * checkout builds on it.
 *
 * @task T14189
 */

import { describe, expect, it } from 'vitest';
import { discoveryEnv, GIT_AMBIENT_REPO_VARS } from '../work-tree.js';

describe('T14189: discoveryEnv strips every ambient repository variable', () => {
  it('covers what a hook inherits, including the index, prefix and namespace', () => {
    expect(GIT_AMBIENT_REPO_VARS).toEqual(
      expect.arrayContaining([
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_NAMESPACE',
        'GIT_PREFIX',
        'GIT_SHALLOW_FILE',
        'GIT_QUARANTINE_PATH',
      ]),
    );
  });

  it('removes each listed variable and keeps everything else', () => {
    const hookEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'kept',
      ...Object.fromEntries(GIT_AMBIENT_REPO_VARS.map((name) => [name, `/hook/${name}`])),
    };
    const env = discoveryEnv(hookEnv);
    for (const name of GIT_AMBIENT_REPO_VARS) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'kept',
    });
    // The caller's environment is never mutated.
    expect(hookEnv['GIT_INDEX_FILE']).toBe('/hook/GIT_INDEX_FILE');
  });
});
