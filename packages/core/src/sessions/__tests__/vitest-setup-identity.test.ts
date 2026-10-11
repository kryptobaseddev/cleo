/**
 * `vitest.setup.ts` gives a fork a terminal identity only when it inherited
 * none (T13517). Plain Node loads that file too, so it lists the identity env
 * vars itself; this keeps the list equal to {@link TERMINAL_KEY_SOURCES}.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TERMINAL_KEY_SOURCES } from '../terminal-identity.js';

describe('vitest.setup.ts identity env list (T13517)', () => {
  it('names exactly the TERMINAL_KEY_SOURCES env vars', () => {
    const setup = readFileSync(new URL('../../../../../vitest.setup.ts', import.meta.url), 'utf8');
    const list = /const TERMINAL_KEY_ENV_VARS = \[([^\]]*)\]/.exec(setup)?.[1] ?? '';
    const listed = [...list.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(listed.sort()).toEqual(TERMINAL_KEY_SOURCES.map((source) => source.envVar).sort());
  });
});
