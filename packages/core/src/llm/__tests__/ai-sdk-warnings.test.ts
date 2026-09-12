/**
 * The AI SDK's warning banner must not reach stdout (T12142 · GH #1223).
 *
 * ADR-086: stdout is ONE LAFS envelope per call; all logs go to stderr.
 * `ai@6`'s `logWarnings` emits its one-time banner with `console.info`, which
 * is stdout in Node — and it lands AFTER the envelope, so parsing the whole of
 * stdout as JSON fails with `Extra data`. Measured on `cleo update` before
 * this fix.
 *
 * @task T12142
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installAiSdkWarningHandler,
  resetAiSdkWarningHandlerForTests,
} from '../ai-sdk-warnings.js';

type GlobalWithWarnings = typeof globalThis & { AI_SDK_LOG_WARNINGS?: unknown };

describe('installAiSdkWarningHandler (T12142)', () => {
  beforeEach(() => {
    resetAiSdkWarningHandlerForTests();
  });

  afterEach(() => {
    resetAiSdkWarningHandlerForTests();
    vi.restoreAllMocks();
  });

  it('installs a FUNCTION, not `false` — the warnings are kept, just moved', () => {
    // Silencing would satisfy ADR-086 by destroying information. The warning
    // that surfaced this said `responseFormat is not supported` for a local
    // ollama model, which is worth knowing when a model silently ignores a
    // JSON-schema request.
    expect(installAiSdkWarningHandler()).toBe(true);
    expect(typeof (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS).toBe('function');
  });

  it('writes NOTHING to stdout when the SDK reports a warning', () => {
    installAiSdkWarningHandler();
    const logger = (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS as (p: unknown) => void;

    // console.info is what `ai@6` uses for its banner, and it is stdout.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logger({
      warnings: [{ type: 'unsupported-setting', message: 'responseFormat is not supported' }],
      provider: 'ollama.chat',
      model: 'qwen2.5-coder:3b',
    });

    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('is idempotent — a second install does not replace the handler', () => {
    expect(installAiSdkWarningHandler()).toBe(true);
    const first = (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS;
    expect(installAiSdkWarningHandler()).toBe(false);
    expect((globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS).toBe(first);
  });

  it('never overwrites a handler an embedder already set', () => {
    // A host application that configured its own routing — or set `false` to
    // silence deliberately — keeps its choice.
    const embedder = () => {};
    (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS = embedder;
    expect(installAiSdkWarningHandler()).toBe(false);
    expect((globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS).toBe(embedder);
  });

  it('respects an explicit `false`', () => {
    (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS = false;
    expect(installAiSdkWarningHandler()).toBe(false);
    expect((globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS).toBe(false);
  });

  it('tolerates a warning payload with no message field', () => {
    installAiSdkWarningHandler();
    const logger = (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS as (p: unknown) => void;
    expect(() => logger({ warnings: ['bare string', 42, null] })).not.toThrow();
  });

  it('does nothing for an empty warning list', () => {
    installAiSdkWarningHandler();
    const logger = (globalThis as GlobalWithWarnings).AI_SDK_LOG_WARNINGS as (p: unknown) => void;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger({ warnings: [] });
    expect(stdout).not.toHaveBeenCalled();
  });
});
