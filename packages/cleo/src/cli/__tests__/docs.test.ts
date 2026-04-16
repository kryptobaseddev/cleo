/**
 * Tests for docs CLI command (T4551 legacy + T797 attachment subcommands).
 * @task T4551 (sync/gap-check), T797 (add/list/fetch/remove)
 * @epic T4545 (legacy), T760 (attachments)
 */

import { describe, expect, it } from 'vitest';
import { ShimCommand as Command } from '../commander-shim.js';
import { registerDocsCommand } from '../commands/docs.js';

describe('registerDocsCommand', () => {
  it('registers a docs command with subcommands', () => {
    const program = new Command();
    registerDocsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'docs');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Documentation');
  });

  it('has sync and gap-check subcommands', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const subNames = docsCmd.commands.map((c) => c.name());
    expect(subNames).toContain('sync');
    expect(subNames).toContain('gap-check');
  });

  it('sync subcommand has --quick and --strict options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const syncCmd = docsCmd.commands.find((c) => c.name() === 'sync')!;
    const optionNames = syncCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--quick');
    expect(optionNames).toContain('--strict');
  });

  it('gap-check subcommand has --epic and --task options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const gapCmd = docsCmd.commands.find((c) => c.name() === 'gap-check')!;
    const optionNames = gapCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--epic');
    expect(optionNames).toContain('--task');
  });

  // T797: attachment management subcommands
  it('has add, list, fetch, remove subcommands', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const subNames = docsCmd.commands.map((c) => c.name());
    expect(subNames).toContain('add');
    expect(subNames).toContain('list');
    expect(subNames).toContain('fetch');
    expect(subNames).toContain('remove');
  });

  it('add subcommand has --url, --desc, --labels, --attached-by options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const addCmd = docsCmd.commands.find((c) => c.name() === 'add')!;
    expect(addCmd).toBeDefined();
    const optionNames = addCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--url');
    expect(optionNames).toContain('--desc');
    expect(optionNames).toContain('--labels');
    expect(optionNames).toContain('--attached-by');
  });

  it('list subcommand has --task, --session, --observation options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const listCmd = docsCmd.commands.find((c) => c.name() === 'list')!;
    expect(listCmd).toBeDefined();
    const optionNames = listCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--task');
    expect(optionNames).toContain('--session');
    expect(optionNames).toContain('--observation');
  });

  it('remove subcommand has --from option', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const removeCmd = docsCmd.commands.find((c) => c.name() === 'remove')!;
    expect(removeCmd).toBeDefined();
    const optionNames = removeCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--from');
  });
});
