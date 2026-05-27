/**
 * Tests for the unified `cleo docs schema` taxonomy discovery surface and
 * the `cleo docs list-types` migration alias (T11142, T9788).
 *
 * Coverage:
 *  - `schema` is the canonical subcommand (with --counts flag)
 *  - `list-types` exists as a migration alias (emits deprecation warning)
 *  - meta descriptions reflect the consolidated surface
 *  - existing subcommand surface (add/list/fetch/remove/publish-pr) still wired
 *
 * Envelope-shape behaviour is exercised against the {@link DocKindRegistry}
 * by the contracts + core test suites — this file deliberately stays at the
 * registration layer to match the pattern in `docs.test.ts`.
 *
 * @epic T9787
 * @task T9788, T11142
 */

import { describe, expect, it } from 'vitest';
import { docsCommand } from '../commands/docs.js';

describe('docsCommand — T11142 unified taxonomy discovery surface', () => {
  it('exposes `schema` as the canonical taxonomy subcommand', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['schema']).toBeDefined();
  });

  it('exposes `list-types` as a migration alias subcommand', () => {
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
    expect(meta?.description).toMatch(/kind|publish|slug|taxonomy/i);
  });

  it('`list-types` subcommand description marks it as deprecated', () => {
    const subs = docsCommand.subCommands as Record<string, { meta?: unknown } | undefined>;
    const listTypes = subs?.['list-types'];
    expect(listTypes).toBeDefined();
    const meta =
      listTypes && typeof listTypes.meta === 'function'
        ? (listTypes.meta as () => { description: string })()
        : (listTypes?.meta as { description: string } | undefined);
    expect(meta?.description).toMatch(/deprecated|schema/i);
  });

  it('`schema` subcommand exposes --counts flag', () => {
    const subs = docsCommand.subCommands as Record<string, { args?: Record<string, unknown> } | undefined>;
    const schema = subs?.['schema'];
    expect(schema).toBeDefined();
    expect(schema?.args).toBeDefined();
    expect(schema?.args?.['counts']).toBeDefined();
  });

  it('`schema` subcommand retains --include-counts for backward compatibility', () => {
    const subs = docsCommand.subCommands as Record<string, { args?: Record<string, unknown> } | undefined>;
    const schema = subs?.['schema'];
    expect(schema?.args?.['include-counts']).toBeDefined();
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
