/**
 * `cleo login` with no terminal and no target signs in to Cleo Nexus instead
 * of falling into the LLM-provider "No --provider supplied" error (T13288);
 * `cleo llm login` and LLM-only flags keep the LLM front door. The Nexus sign-in
 * and the LLM front door are mocked: nothing touches the network or a CLEO home.
 *
 * @task T13288
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runNexusLoginCommand = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../lib/nexus-first-run-cli.js', () => ({ runNexusLoginCommand }));
/** The target picker: it must not open without a terminal on stdin AND stderr (T13308). */
const pickerSelect = vi.hoisted(() => vi.fn(async () => 'Cleo Nexus account'));
vi.mock('../../lib/readline-wizard-io.js', () => ({
  ReadlineWizardIO: class {
    select = pickerSelect;
    close(): void {}
  },
}));

import { nonInteractiveLoginTarget, runLoginCommand } from '../login.js';

const savedTTY = process.stdin.isTTY;
const savedErrTTY = process.stderr.isTTY;
const savedCI = process.env['CI'];
const setTTY = (stdin: boolean, stderr: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: stderr, configurable: true });
};
beforeEach(() => {
  setTTY(false, false);
  delete process.env['CI'];
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: savedErrTTY, configurable: true });
  if (savedCI === undefined) delete process.env['CI'];
  else process.env['CI'] = savedCI;
  runNexusLoginCommand.mockClear();
  pickerSelect.mockClear();
  vi.restoreAllMocks();
});

describe('nonInteractiveLoginTarget (T13288)', () => {
  it('cleo login with no target and no LLM flag is the Cleo Nexus account', () => {
    expect(nonInteractiveLoginTarget({}, 'login.run')).toBe('nexus');
    expect(nonInteractiveLoginTarget({ yes: true, json: true }, 'login.run')).toBe('nexus');
  });

  it.each([
    ['api-key'],
    ['model'],
    ['role'],
    ['auth'],
    ['label'],
  ])('an LLM-only flag (--%s) keeps the LLM front door', (flag) => {
    expect(nonInteractiveLoginTarget({ [flag]: 'x' }, 'login.run')).toBeUndefined();
  });

  it('--api-key-stdin keeps the LLM front door', () => {
    expect(nonInteractiveLoginTarget({ 'api-key-stdin': true }, 'login.run')).toBeUndefined();
  });

  it('cleo llm login keeps the LLM front door', () => {
    expect(nonInteractiveLoginTarget({}, 'llm.login')).toBeUndefined();
  });
});

describe('runLoginCommand with no terminal (T13288)', () => {
  it('a bare cleo login runs the Cleo Nexus sign-in, never the LLM error', async () => {
    await runLoginCommand({}, 'login.run');
    expect(runNexusLoginCommand).toHaveBeenCalledTimes(1);
    expect(runNexusLoginCommand.mock.calls[0]?.[1]).toBe('login.run');
  });

  it('an explicit provider is honoured as before', async () => {
    await runLoginCommand({ provider: 'nexus' }, 'login.run');
    expect(runNexusLoginCommand).toHaveBeenCalledTimes(1);
  });
});

describe('the target picker needs stdin AND stderr on a terminal, outside CI (T13308)', () => {
  it('stdin on a terminal but stderr redirected: no picker, the Cleo Nexus sign-in', async () => {
    setTTY(true, false);
    await runLoginCommand({}, 'login.run');
    expect(pickerSelect).not.toHaveBeenCalled();
    expect(runNexusLoginCommand).toHaveBeenCalledTimes(1);
  });

  it('both on a terminal under CI: no picker either', async () => {
    setTTY(true, true);
    process.env['CI'] = 'true';
    await runLoginCommand({}, 'login.run');
    expect(pickerSelect).not.toHaveBeenCalled();
    expect(runNexusLoginCommand).toHaveBeenCalledTimes(1);
  });

  it('both on a terminal outside CI: the picker asks', async () => {
    setTTY(true, true);
    process.env['CI'] = 'false';
    await runLoginCommand({}, 'login.run');
    expect(pickerSelect).toHaveBeenCalledTimes(1);
    expect(runNexusLoginCommand).toHaveBeenCalledTimes(1);
  });
});
