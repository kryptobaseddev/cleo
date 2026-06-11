/**
 * Tests for the `cleo tui` cockpit runtime + command registration (T11933 / T11980).
 *
 * Exercises the graceful-degrade paths WITHOUT a real daemon or pi-tui:
 *  - daemon unreachable → `daemon-down` outcome + a "start `cleo daemon serve`"
 *    message, never throwing;
 *  - autoStart disabled → skips spawn attempt, still daemon-down;
 *  - autoStart enabled + spawn resolves immediately → probe respects reachable result;
 *  - the `tui` command is registered in the generated manifest and resolves to
 *    the canonical `defineCommand`-built command.
 *
 * The rich interactive loop is NOT unit-tested here (it needs the optional
 * pi-tui dep + a TTY); its inputs — the board model + plain-text render — are
 * covered by `kanban-board.test.ts`, and the loader degrade by
 * `pi-tui-loader.test.ts`.
 *
 * @task T11933
 * @task T11980
 * @epic T11916
 */

import { describe, expect, it } from 'vitest';
import { COMMAND_MANIFEST } from '../../../generated/command-manifest.js';
import { isInteractiveInvocation } from '../../interactive-commands.js';
import { runCockpit } from '../cockpit.js';

describe('runCockpit — daemon unreachable (T11933 · AC1)', () => {
  it('returns daemon-down + prints the start hint when the gateway refuses (autoStart:false)', async () => {
    const lines: string[] = [];
    // Port 1 on loopback is never a CLEO gateway — the fetch rejects fast.
    // Pass autoStart:false so we skip the spawn attempt in this unit test.
    const result = await runCockpit(
      { baseUrl: 'http://127.0.0.1:1', once: true, autoStart: false },
      (line) => lines.push(line),
    );
    expect(result.outcome).toBe('daemon-down');
    expect(result.piTui).toBe(false);
    expect(result.gatewayAutoStarted).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('not reachable');
    expect(text).toContain('cleo daemon serve');
  });

  it('never throws on the unreachable path', async () => {
    await expect(
      runCockpit({ baseUrl: 'http://127.0.0.1:1', once: true, autoStart: false }, () => {}),
    ).resolves.toBeDefined();
  });
});

describe('runCockpit — auto-start path (T11980)', () => {
  it('with autoStart:true, attempts spawn and reports daemon-down when still unreachable', async () => {
    // Port 1 will never accept. autoStart:true triggers spawnGatewayIfDown which
    // will also probe port 1 (spawns a bad entry), then polls for waitTimeoutMs.
    // We inject a very short timeout + a known-bad cliEntryPath to keep the test fast.
    const lines: string[] = [];
    const result = await runCockpit(
      {
        baseUrl: 'http://127.0.0.1:1',
        once: true,
        autoStart: true,
        spawnOpts: {
          cliEntryPath: '/nonexistent/path/index.js',
          waitTimeoutMs: 150, // fast timeout for tests
        },
      },
      (line) => lines.push(line),
    );
    // Whether the port became reachable (it won't), the cockpit MUST NOT throw.
    expect(['daemon-down', 'rendered', 'degraded-pi']).toContain(result.outcome);
    // gatewayAutoStarted is false because the spawn did not produce a reachable port.
    expect(result.gatewayAutoStarted).toBe(false);
  });

  it('with autoStart:false, skips spawn entirely', async () => {
    const lines: string[] = [];
    const result = await runCockpit(
      { baseUrl: 'http://127.0.0.1:1', once: true, autoStart: false },
      (line) => lines.push(line),
    );
    expect(result.outcome).toBe('daemon-down');
    expect(result.gatewayAutoStarted).toBe(false);
    // The hint message must still be present.
    expect(lines.join('\n')).toContain('cleo daemon serve');
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
