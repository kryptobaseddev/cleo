/**
 * Tests for the `cleo docs schema` and `cleo docs list-types` CLI surfaces
 * introduced by T9788.
 *
 * Coverage:
 *  - subcommand registration on the root `docs` command (both verbs)
 *  - meta description mentions the registry / taxonomy
 *  - existing subcommand surface (add/list/fetch/remove/publish-pr) still wired
 *
 * Envelope-shape behaviour is exercised against the {@link DocKindRegistry}
 * by the contracts + core test suites — this file deliberately stays at the
 * registration layer to match the pattern in `docs.test.ts`.
 *
 * @epic T9787
 * @task T9788
 */

import { describe, expect, it } from 'vitest';
import { docsCommand } from '../commands/docs.js';

describe('docsCommand — T9788 taxonomy discovery subcommands', () => {
  it('exposes `schema` as a subcommand', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['schema']).toBeDefined();
  });

  it('exposes `list-types` as a subcommand', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['list-types']).toBeDefined();
  });

  it('`schema` subcommand carries a meaningful description', () => {
    const subs = docsCommand.subCommands as Record<string, { meta?: unknown } | undefined>;
    const schema = subs?.['schema'];
    expect(schema).toBeDefined();
    const meta =
      schema && typeof schema.meta === 'function'
        ? (schema.meta as () => { description: string })()
        : (schema?.meta as { description: string } | undefined);
    expect(meta?.description).toMatch(/registry|taxonomy/i);
  });

  it('`list-types` subcommand carries a meaningful description', () => {
    const subs = docsCommand.subCommands as Record<string, { meta?: unknown } | undefined>;
    const listTypes = subs?.['list-types'];
    expect(listTypes).toBeDefined();
    const meta =
      listTypes && typeof listTypes.meta === 'function'
        ? (listTypes.meta as () => { description: string })()
        : (listTypes?.meta as { description: string } | undefined);
    expect(meta?.description).toMatch(/kind|publish|slug/i);
  });

  it('keeps the legacy attachment subcommands wired alongside the new ones', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs?.['add']).toBeDefined();
    expect(subs?.['list']).toBeDefined();
    expect(subs?.['fetch']).toBeDefined();
    expect(subs?.['remove']).toBeDefined();
    expect(subs?.['publish-pr']).toBeDefined();
  });
});
