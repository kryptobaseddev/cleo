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

import { nonInteractiveLoginTarget, runLoginCommand } from '../login.js';

const savedTTY = process.stdin.isTTY;
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  runNexusLoginCommand.mockClear();
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
