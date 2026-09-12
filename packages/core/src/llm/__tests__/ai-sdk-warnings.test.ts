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

describe('WHERE the handler is installed — the half the in-process tests cannot check', () => {
  /**
   * Every other test in this file calls `installAiSdkWarningHandler()` directly and
   * then asserts nothing reaches stdout. They prove the handler WORKS. They cannot
   * prove it is INSTALLED on the path that emits, and they pass either way.
   *
   * That gap shipped once: the handler was installed at module load of
   * `model-runner.ts`, reasoning from gate 13 that the LLM chokepoint is where all
   * consumers pass through. `memory/llm-backend-resolver.ts` builds its own clients
   * and imports `ai` only as `import type { LanguageModel }` — type-only, erased at
   * runtime — so it never loaded `model-runner.ts`, never installed the handler, and
   * ai@6's `console.info` banner went to STDOUT, appending an English sentence to the
   * LAFS envelope. `--field /data/created/0` then returned a task id with a newline
   * and that sentence attached.
   *
   * So this test asserts placement, structurally, because placement is the property
   * that was wrong. A test that can only fail when the guard is broken — and never
   * when the guard is bypassed — is the shape that let this through.
   */
  it('is installed from the CLI envelope funnel, not only from the LLM chokepoint', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const cliIndex = resolve(here, '../../../../cleo/src/cli/index.ts');
    const src = readFileSync(cliIndex, 'utf8');

    expect(src).toContain('installAiSdkWarningHandler');

    // It must sit inside the funnel every command passes through, so that a path
    // which never touches the LLM chokepoint is still covered.
    const funnelAt = src.indexOf('async function runMainWithLafsEnvelope(');
    const installAt = src.indexOf('installAiSdkWarningHandler');
    expect(funnelAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(funnelAt);
  });

  it('the bypassing module still does not import the chokepoint — the reason placement matters', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const resolver = resolve(here, '../../memory/llm-backend-resolver.ts');
    const src = readFileSync(resolver, 'utf8');

    // It constructs AI SDK clients of its own...
    expect(src).toMatch(/createOpenAICompatible|createAnthropic/);
    // ...and its only `ai` import is type-only, so importing it installs nothing.
    expect(src).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'ai'/m);
    expect(src).not.toContain("from './model-runner.js'");
    expect(src).not.toContain("from '../llm/model-runner.js'");
  });
});
