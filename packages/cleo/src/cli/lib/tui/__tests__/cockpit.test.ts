/**
 * Tests for the `cleo tui` cockpit runtime + command registration (T11933).
 *
 * Exercises the graceful-degrade paths WITHOUT a real daemon or pi-tui:
 *  - daemon unreachable → `daemon-down` outcome + a "start `cleo daemon serve`"
 *    message, never throwing;
 *  - the `tui` command is registered in the generated manifest and resolves to
 *    the canonical `defineCommand`-built command.
 *
 * The rich interactive loop is NOT unit-tested here (it needs the optional
 * pi-tui dep + a TTY); its inputs — the board model + plain-text render — are
 * covered by `kanban-board.test.ts`, and the loader degrade by
 * `pi-tui-loader.test.ts`.
 *
 * @task T11933
 * @epic T11916
 */

import { describe, expect, it } from 'vitest';
import { COMMAND_MANIFEST } from '../../../generated/command-manifest.js';
import { isInteractiveInvocation } from '../../interactive-commands.js';
import { runCockpit } from '../cockpit.js';

describe('runCockpit — daemon unreachable (T11933 · AC1)', () => {
  it('returns daemon-down + prints the start hint when the gateway refuses', async () => {
    const lines: string[] = [];
    // Port 1 on loopback is never a CLEO gateway — the fetch rejects fast.
    const result = await runCockpit({ baseUrl: 'http://127.0.0.1:1', once: true }, (line) =>
      lines.push(line),
    );
    expect(result.outcome).toBe('daemon-down');
    expect(result.piTui).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('not reachable');
    expect(text).toContain('cleo daemon serve');
  });

  it('never throws on the unreachable path', async () => {
    await expect(
      runCockpit({ baseUrl: 'http://127.0.0.1:1', once: true }, () => {}),
    ).resolves.toBeDefined();
  });
});

describe('cleo tui command registration (T11933 · AC3)', () => {
  it('is present in the generated command manifest', () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'tui');
    expect(entry).toBeDefined();
    expect(entry?.exportName).toBe('tuiCommand');
  });

  it('loads a citty-style CommandDef with the canonical meta', async () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'tui');
    const cmd = await entry?.load();
    expect(cmd).toBeDefined();
    const meta = cmd?.meta as { name?: string } | undefined;
    expect(meta?.name).toBe('tui');
    expect(typeof cmd?.run).toBe('function');
  });

  it('is classified as a human-default interactive command', () => {
    expect(isInteractiveInvocation(['tui'])).toBe(true);
    expect(isInteractiveInvocation(['tui', '--base-url', 'http://x'])).toBe(true);
    expect(isInteractiveInvocation(['show', 'T1'])).toBe(false);
  });
});
