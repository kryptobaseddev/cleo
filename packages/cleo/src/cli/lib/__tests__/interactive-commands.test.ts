import { describe, expect, it } from 'vitest';
import { resolveFormat } from '../../middleware/output-format.js';
import { INTERACTIVE_COMMAND_PATHS, isInteractiveInvocation } from '../interactive-commands.js';

describe('isInteractiveInvocation', () => {
  it('matches the auth/login interactive command paths', () => {
    expect(isInteractiveInvocation(['llm', 'login'])).toBe(true);
    expect(isInteractiveInvocation(['llm', 'login', 'openai'])).toBe(true);
    expect(isInteractiveInvocation(['llm', 'login', '--json'])).toBe(true);
    expect(isInteractiveInvocation(['llm', 'add', 'anthropic', '--api-key-stdin'])).toBe(true);
    expect(isInteractiveInvocation(['llm', 'refresh-catalog'])).toBe(true);
    expect(isInteractiveInvocation(['setup'])).toBe(true);
    expect(isInteractiveInvocation(['setup', '--reset'])).toBe(true);
    expect(isInteractiveInvocation(['init'])).toBe(true);
    expect(isInteractiveInvocation(['login'])).toBe(true);
    expect(isInteractiveInvocation(['auth', 'login'])).toBe(true);
  });

  it('does NOT match agent-first commands (they keep the JSON default)', () => {
    expect(isInteractiveInvocation(['llm', 'list'])).toBe(false);
    expect(isInteractiveInvocation(['auth', 'list'])).toBe(false);
    expect(isInteractiveInvocation(['list'])).toBe(false);
    expect(isInteractiveInvocation(['add', 'a new task'])).toBe(false);
    expect(isInteractiveInvocation([])).toBe(false);
  });

  it('degrades safely to false when a flag/flag-value leads the argv', () => {
    // A leading flag-value shifts the positionals, so the path no longer matches
    // its required index-0 token — safer to fall back to JSON than to misfire.
    expect(isInteractiveInvocation(['--field', 'id', 'setup'])).toBe(false);
  });

  it('exposes a non-empty registry', () => {
    expect(INTERACTIVE_COMMAND_PATHS.length).toBeGreaterThan(0);
  });
});

describe('resolveFormat tty fallback (interactive-output class)', () => {
  it('defaults to human when tty=true and no flags/defaults', () => {
    expect(resolveFormat({}, undefined, true).format).toBe('human');
  });

  it('defaults to json when tty is false or omitted (agent-first)', () => {
    expect(resolveFormat({}, undefined, false).format).toBe('json');
    expect(resolveFormat({}).format).toBe('json');
  });

  it('honors --json as an escape hatch even on an interactive tty', () => {
    expect(resolveFormat({ json: true }, undefined, true).format).toBe('json');
  });

  it('keeps --human regardless of tty', () => {
    expect(resolveFormat({ human: true }, undefined, false).format).toBe('human');
  });
});
