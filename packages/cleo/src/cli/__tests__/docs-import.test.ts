/**
 * cleo docs import — CLI integration tests for T9639 (5 subtasks).
 *
 * The orchestrator is unit-tested in
 * packages/core/src/docs/__tests__/import/import-orchestrator.test.ts.
 * Here we verify the CLI wiring:
 *   - The `import` subcommand is registered on docsCommand
 *   - The subcommand exposes the documented flags
 *   - The args schema matches the spec (--dry-run, --force, --audit-manifest, --json)
 *
 * @epic T9628 (Saga T9625)
 * @task T9639
 */

import { describe, expect, it } from 'vitest';
import { docsCommand } from '../commands/docs.js';

interface CittyCommand {
  meta?: unknown;
  args?: Record<string, { type?: string; required?: boolean; description?: string }>;
  subCommands?: Record<string, CittyCommand>;
}

function getMeta(cmd: CittyCommand): { name: string; description: string } {
  const meta = typeof cmd.meta === 'function' ? (cmd.meta as () => unknown)() : cmd.meta;
  return meta as { name: string; description: string };
}

describe('cleo docs import — CLI registration', () => {
  it('is registered as a subcommand of docs', () => {
    const subs = (docsCommand as unknown as CittyCommand).subCommands ?? {};
    expect(subs.import).toBeDefined();
  });

  it('declares meta.name === "import" with a description mentioning .md', () => {
    const subs = (docsCommand as unknown as CittyCommand).subCommands ?? {};
    const importCmd = subs.import as CittyCommand;
    const meta = getMeta(importCmd);
    expect(meta.name).toBe('import');
    expect(meta.description).toMatch(/\.md/);
  });

  it('exposes the spec-defined flags', () => {
    const subs = (docsCommand as unknown as CittyCommand).subCommands ?? {};
    const importCmd = subs.import as CittyCommand;
    const args = importCmd.args ?? {};
    expect(args.dir).toBeDefined();
    expect(args.dir?.type).toBe('positional');
    expect(args.dir?.required).toBe(true);

    expect(args['dry-run']?.type).toBe('boolean');
    expect(args.force?.type).toBe('boolean');
    expect(args['audit-manifest']?.type).toBe('string');
    expect(args.json?.type).toBe('boolean');
  });
});
