/**
 * Vapor-surface guard for `LlmConfig` TSDoc command references (T11723 · AC3).
 *
 * Every `cleo llm <verb>` command name mentioned in the `LlmConfig` /
 * surrounding TSDoc in `@cleocode/contracts` MUST resolve to a real subcommand
 * registered under `cleo llm` (the `llm.ts` subCommands map). This prevents the
 * regression where docs pointed at non-existent commands (`cleo llm bind`,
 * `cleo llm profiles`, `cleo llm doctor`).
 *
 * @task T11723
 * @epic T11671
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandDef } from 'citty';
import { describe, expect, it, vi } from 'vitest';

// `cleo llm` pulls the dispatch adapter (→ runtime gateway graph) for most
// subcommands; stub it so this thin structural test never loads the heavy graph.
vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn(async () => undefined),
}));
vi.mock('../login.js', () => ({
  runLoginFrontDoor: vi.fn(),
  emitLoginResult: vi.fn(),
  LOGIN_ARGS: {},
}));

import { llmCommand } from '../llm.js';

async function llmSubCommandNames(): Promise<Set<string>> {
  const resolved =
    typeof llmCommand.subCommands === 'function'
      ? await llmCommand.subCommands()
      : llmCommand.subCommands;
  return new Set(Object.keys((resolved ?? {}) as Record<string, CommandDef>));
}

describe('LlmConfig TSDoc command references (T11723)', () => {
  it('AC1 — no TSDoc references to retired vapor commands', () => {
    const configSrc = readFileSync(
      fileURLToPath(new URL('../../../../../contracts/src/config.ts', import.meta.url)),
      'utf8',
    );
    expect(configSrc).not.toContain('cleo llm bind');
    expect(configSrc).not.toContain('cleo llm profiles');
    expect(configSrc).not.toContain('cleo llm doctor');
    expect(configSrc).not.toContain('provider:auto');
  });

  it('AC3 — every `cleo llm <verb>` referenced in config.ts is a real llm subcommand', async () => {
    const configSrc = readFileSync(
      fileURLToPath(new URL('../../../../../contracts/src/config.ts', import.meta.url)),
      'utf8',
    );
    const referenced = new Set<string>();
    for (const m of configSrc.matchAll(/cleo llm ([a-z][a-z-]*)/g)) {
      referenced.add(m[1] as string);
    }

    const real = await llmSubCommandNames();
    for (const verb of referenced) {
      expect(real, `cleo llm ${verb} referenced in config.ts must be a real subcommand`).toContain(
        verb,
      );
    }
  });
});
