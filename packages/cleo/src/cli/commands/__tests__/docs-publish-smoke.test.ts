/**
 * CLI surface smoke tests for publish verb consolidation (T11190 / T10516-K1).
 *
 * Covers:
 *   AC4 — backward-compatible alias resolution (publish-pr → publish --target pr)
 *   AC5 — migration warnings for deprecated verbs
 *
 * @task T11190
 * @saga T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 * @epic T10521 (T10516-E: Docs dogfood regression harness)
 */

import { describe, expect, it } from 'vitest';

describe('AC4: backward-compatible alias resolution (publish-pr → publish --target pr)', () => {
  it('publish-pr is registered under docs subCommands', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (docsCommand as unknown as { subCommands: Record<string, unknown> }).subCommands;
    expect(subs['publish-pr']).toBeDefined();
  });

  it('publish-pr meta declares itself as deprecated', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (
      docsCommand as unknown as {
        subCommands: Record<string, { meta: { name: string; description: string } }>;
      }
    ).subCommands;
    const publishPr = subs['publish-pr'];
    expect(publishPr).toBeDefined();
    const desc = (publishPr.meta.description ?? '').toLowerCase();
    expect(desc).toContain('deprecated');
    expect(desc).toContain('publish');
  });

  it('publish-pr has the expected arg shape for PR publish delegation', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (
      docsCommand as unknown as {
        subCommands: Record<string, { meta: { name: string }; args: Record<string, unknown> }>;
      }
    ).subCommands;
    const publishPr = subs['publish-pr'];
    expect(publishPr.args['slug-or-id']).toBeDefined();
    expect(publishPr.args.slug).toBeDefined();
    expect(publishPr.args.type).toBeDefined();
  });

  it('unified publish command has --target flag with both file and pr support', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (
      docsCommand as unknown as {
        subCommands: Record<
          string,
          {
            meta: { name: string; description: string };
            args: Record<string, { type: string; description: string; default?: string }>;
          }
        >;
      }
    ).subCommands;
    const publish = subs['publish'];
    expect(publish.meta.name).toBe('publish');
    expect(publish.meta.description.toLowerCase()).toContain('target');
    expect(publish.args.target).toBeDefined();
    // File-target args
    expect(publish.args.for).toBeDefined();
    expect(publish.args.to).toBeDefined();
    // PR-target args
    expect(publish.args.slug).toBeDefined();
  });
});

describe('AC5: migration warnings for deprecated verbs', () => {
  it('list-types description indicates deprecation → schema', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (
      docsCommand as unknown as {
        subCommands: Record<string, { meta: { name: string; description: string } }>;
      }
    ).subCommands;
    const desc = (subs['list-types'].meta.description ?? '').toLowerCase();
    expect(desc).toContain('deprecated');
    expect(desc).toContain('schema');
  });

  it('search description indicates deprecation', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (
      docsCommand as unknown as {
        subCommands: Record<string, { meta: { name: string; description: string } }>;
      }
    ).subCommands;
    expect((subs['search'].meta.description ?? '').toLowerCase()).toContain('deprecated');
  });

  it('legacy verbs are registered', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (docsCommand as unknown as { subCommands: Record<string, unknown> }).subCommands;
    expect(subs['sync']).toBeDefined();
    expect(subs['status']).toBeDefined();
    expect(subs['gap-check']).toBeDefined();
    expect(subs['import']).toBeDefined();
  });

  it('canonical six verbs are all registered', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (docsCommand as unknown as { subCommands: Record<string, unknown> }).subCommands;
    expect(subs['add']).toBeDefined();
    expect(subs['update']).toBeDefined();
    expect(subs['fetch']).toBeDefined();
    expect(subs['list']).toBeDefined();
    expect(subs['remove']).toBeDefined();
    expect(subs['publish']).toBeDefined();
  });

  it('advanced primitives present', async () => {
    const { docsCommand } = await import('../docs.js');
    const subs = (docsCommand as unknown as { subCommands: Record<string, unknown> }).subCommands;
    expect(subs['supersede']).toBeDefined();
    expect(subs['find']).toBeDefined();
    expect(subs['generate']).toBeDefined();
    expect(subs['export']).toBeDefined();
    expect(subs['merge']).toBeDefined();
    expect(subs['graph']).toBeDefined();
    expect(subs['rank']).toBeDefined();
    expect(subs['versions']).toBeDefined();
  });

  it('root docs description mentions canonical six-verb path', async () => {
    const { docsCommand } = await import('../docs.js');
    const meta = docsCommand.meta as { name: string; description: string };
    expect(meta.name).toBe('docs');
    const desc = meta.description.toLowerCase();
    expect(desc).toContain('canonical');
    expect(desc).toContain('six-verb');
    expect(desc).toContain('legacy');
  });
});
