/**
 * `cleo cant validate` (T14642): the help states the rule count, and an
 * old cant-napi binary without the import-graph entry point leaves one
 * W_CANT_IMPORT_RULES_NOT_RUN warning instead of validating silently
 * without the import rules.
 *
 * @task T14642
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainWarnings } from '@cleocode/core/output';
import type { Warning } from '@cleocode/lafs';
import type { CommandDef } from 'citty';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Warnings pending when the command emitted its result. */
let warningsAtOutput: Warning[] = [];
let importRulesRun = true;
let importRuleCoverage: 'full' | 'partial' | 'none' = 'full';

vi.mock('../../renderers/index.js', () => ({
  cliError: vi.fn(),
  cliOutput: vi.fn().mockImplementation(() => {
    warningsAtOutput = drainWarnings() ?? [];
  }),
  humanWarn: vi.fn(),
}));

vi.mock('@cleocode/cant', () => ({
  parseDocument: vi.fn(),
  validateDocument: vi.fn().mockImplementation(async (file: string) => ({
    file,
    valid: true,
    total: 0,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    importRulesRun,
    importRuleCoverage,
  })),
  listSections: vi.fn(),
  executePipeline: vi.fn(),
}));

import { cantCommand } from '../cant.js';

const dir = mkdtempSync(join(tmpdir(), 'cant-validate-t14642-'));
const file = join(dir, 'main.cant');
writeFileSync(file, 'agent a:\n  model: opus\n');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Resolves the `validate` subcommand. */
async function validateCommand(): Promise<CommandDef> {
  const subs =
    typeof cantCommand.subCommands === 'function'
      ? await cantCommand.subCommands()
      : cantCommand.subCommands;
  const cmd = (subs as Record<string, CommandDef> | undefined)?.['validate'];
  if (!cmd) throw new Error('cant validate is not registered');
  return typeof cmd === 'function' ? await cmd() : cmd;
}

/** Runs `cleo cant validate <file>` and returns the import-rule warnings it left. */
async function runValidate(): Promise<Warning[]> {
  const cmd = await validateCommand();
  if (!cmd.run) throw new Error('cant validate has no run function');
  await cmd.run({ args: { _: [file], file }, rawArgs: [file], cmd } as never);
  return warningsAtOutput.filter((w) => w.code.startsWith('W_CANT_IMPORT_RULES_'));
}

describe('cleo cant validate (T14642)', () => {
  beforeEach(() => {
    drainWarnings();
    warningsAtOutput = [];
  });

  it('states the updated rule count in --help', async () => {
    const resolvable = (await validateCommand()).meta;
    const meta = await (typeof resolvable === 'function' ? resolvable() : resolvable);
    const description = meta?.description;
    expect(description).toContain('all 42 numbered rules');
    expect(description).not.toContain('S04 is not implemented');
  });

  it('warns once when the binary lacks the import-graph entry point', async () => {
    importRulesRun = false;
    importRuleCoverage = 'none';
    const warnings = await runValidate();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('W_CANT_IMPORT_RULES_NOT_RUN');
    expect(warnings[0]?.message).toContain('import rules (S03, S04, S11, S12) were not run');
  });

  it('warns once, narrower, when the binary walks imports but lacks cantValidateFile', async () => {
    importRulesRun = true;
    importRuleCoverage = 'partial';
    const warnings = await runValidate();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('W_CANT_IMPORT_RULES_PARTIAL');
    expect(warnings[0]?.message).toContain('S04 missing-import check');
    expect(warnings[0]?.message).toContain('imported-file diagnostic locations');
  });

  it('does not warn when every import rule ran', async () => {
    importRulesRun = true;
    importRuleCoverage = 'full';
    expect(await runValidate()).toHaveLength(0);
  });
});
