/**
 * T13420 — `cleo hook ask-enforce`: Stop payload parsing, transcript scan,
 * per-provider answers, loop guard and fail-open behaviour.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ASK_ENFORCE_PROVIDERS,
  type AskToolLookup,
  askEnforceHook,
  askEnforceMode,
  parseStopTurn,
  readTranscriptTail,
  scanTranscriptTail,
} from '../ask-enforce-entry.js';
import { type HookIo, runHookCli } from '../hook-entry.js';

const LOOKUP: AskToolLookup = {
  toolFor: (p) => (p === 'kimi' || p === 'claude-code' ? 'AskUserQuestion' : null),
  allNames: () => ['AskUserQuestion', 'request_user_input', 'ask_user', 'question'],
};

const QUESTION = 'Tests pass and CI is green.\n\nShould I merge it now?';

const claudeLine = (type: 'user' | 'assistant', content: unknown) =>
  JSON.stringify({ type, message: { role: type, content } });

describe('scanTranscriptTail (T13420)', () => {
  it('reads the final assistant text and the tools since the last Claude Code prompt', () => {
    const jsonl = [
      claudeLine('user', 'old prompt'),
      claudeLine('assistant', [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }]),
      claudeLine('user', 'new prompt'),
      claudeLine('assistant', [{ type: 'tool_use', name: 'Bash', input: {} }]),
      claudeLine('user', [{ type: 'tool_result', content: 'ok' }]),
      claudeLine('assistant', [{ type: 'text', text: QUESTION }]),
    ].join('\n');
    expect(scanTranscriptTail(jsonl)).toEqual({ lastAssistantText: QUESTION, toolCalls: ['Bash'] });
  });

  it('reads Codex rollout function calls', () => {
    const line = (payload: unknown) => JSON.stringify({ type: 'response_item', payload });
    const jsonl = [
      line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }),
      line({ type: 'function_call', name: 'request_user_input', arguments: '{}' }),
      line({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }),
    ].join('\n');
    expect(scanTranscriptTail(jsonl)).toEqual({
      lastAssistantText: 'Done.',
      toolCalls: ['request_user_input'],
    });
  });

  it('ignores unparseable lines', () => {
    expect(scanTranscriptTail('not json\n{"also": "noise"}')).toEqual({
      lastAssistantText: null,
      toolCalls: [],
    });
  });
});

describe('readTranscriptTail (T13420)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('drops the partial first line of a tail cut from a large file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ask-enforce-'));
    const file = join(dir, 't.jsonl');
    const filler = claudeLine('user', 'x'.repeat(300 * 1024));
    writeFileSync(
      file,
      `${filler}\n${claudeLine('assistant', [{ type: 'text', text: QUESTION }])}\n`,
    );
    const tail = readTranscriptTail(file);
    expect(tail.length).toBeLessThanOrEqual(256 * 1024);
    expect(scanTranscriptTail(tail).lastAssistantText).toBe(QUESTION);
  });

  it('returns empty for a missing file', () => {
    expect(readTranscriptTail('/nonexistent/ask-enforce.jsonl')).toBe('');
  });
});

describe('askEnforceHook per provider (T13420)', () => {
  const run = (provider: (typeof ASK_ENFORCE_PROVIDERS)[number], payload: object, env = {}) =>
    askEnforceHook(provider, JSON.stringify(payload), env, LOOKUP);

  it('blocks a prose question with each harness protocol', async () => {
    const msg = { last_assistant_message: QUESTION };
    expect(JSON.parse((await run('claude-code', msg)).stdout)).toMatchObject({
      decision: 'block',
    });
    expect(JSON.parse((await run('codex', msg)).stdout).decision).toBe('block');
    expect(JSON.parse((await run('copilot-cli', msg)).stdout).decision).toBe('block');
    expect(
      JSON.parse((await run('gemini-cli', { prompt_response: QUESTION })).stdout).decision,
    ).toBe('deny');
    expect(
      JSON.parse((await run('cursor', { ...msg, status: 'completed' })).stdout).followup_message,
    ).toContain('ask-enforce');
    expect(JSON.parse((await run('opencode', { ...msg, tool_calls: [] })).stdout).block).toBe(true);
    const kimi = await run('kimi', msg);
    expect(kimi).toMatchObject({ stdout: '', exitCode: 2 });
    expect(kimi.stderr).toContain('`AskUserQuestion`');
  });

  it('names the provider ask tool, or the hitl.request fallback', async () => {
    const msg = { last_assistant_message: QUESTION };
    expect(JSON.parse((await run('claude-code', msg)).stdout).reason).toContain(
      '`AskUserQuestion`',
    );
    expect(JSON.parse((await run('codex', msg)).stdout).reason).toContain('hitl.request');
  });

  it('allows when the turn called an ask tool, on the second stop, and for cursor errors', async () => {
    expect(
      (await run('opencode', { last_assistant_message: QUESTION, tool_calls: ['question'] }))
        .stdout,
    ).toBe('');
    expect(
      (await run('claude-code', { last_assistant_message: QUESTION, stop_hook_active: true }))
        .stdout,
    ).toBe('');
    expect((await run('cursor', { last_assistant_message: QUESTION, loop_count: 1 })).stdout).toBe(
      '',
    );
    expect(
      (await run('cursor', { last_assistant_message: QUESTION, status: 'error' })).stdout,
    ).toBe('');
  });

  it('allows a clean reply and a payload with no message (Kimi today)', async () => {
    expect((await run('claude-code', { last_assistant_message: 'All green.' })).stdout).toBe('');
    expect(await run('kimi', { hook_event_name: 'Stop', stop_hook_active: false })).toMatchObject({
      stdout: '',
      exitCode: 0,
    });
  });

  it('honours CLEO_ASK_ENFORCE warn and off', async () => {
    const msg = { last_assistant_message: QUESTION };
    expect(askEnforceMode({})).toBe('block');
    const warn = JSON.parse((await run('claude-code', msg, { CLEO_ASK_ENFORCE: 'warn' })).stdout);
    expect(warn.decision).toBeUndefined();
    expect(warn.systemMessage).toContain('ask-enforce');
    expect((await run('gemini-cli', msg, { CLEO_ASK_ENFORCE: 'warn' })).stdout).toBe('');
    expect((await run('claude-code', msg, { CLEO_ASK_ENFORCE: 'off' })).stdout).toBe('');
  });

  it('parses nothing from non-JSON stdin', () => {
    expect(parseStopTurn('not json')).toBeNull();
  });
});

describe('runHookCli ask-enforce (T13420)', () => {
  function io(stdin: string) {
    const out: string[] = [];
    const err: string[] = [];
    const hookIo: HookIo = {
      readStdin: async () => stdin,
      writeStdout: (t) => out.push(t),
      writeStderr: (t) => err.push(t),
      env: {},
      cwd: tmpdir(),
    };
    return { hookIo, out, err };
  }

  it('fails open on garbage stdin and rejects an unknown provider', async () => {
    const garbage = io('}{');
    expect(await runHookCli(['ask-enforce', '--provider', 'codex'], garbage.hookIo)).toBe(0);
    expect(garbage.out).toEqual([]);
    const bad = io('{}');
    expect(await runHookCli(['ask-enforce', '--provider', 'nope'], bad.hookIo)).toBe(1);
  });

  it('blocks through the real CAAMP lookup', async () => {
    const t = io(JSON.stringify({ last_assistant_message: QUESTION }));
    expect(await runHookCli(['ask-enforce', '--provider', 'claude-code'], t.hookIo)).toBe(0);
    const answer = JSON.parse(t.out.join(''));
    expect(answer.decision).toBe('block');
    expect(answer.reason).toContain('`AskUserQuestion`');
  });
});
