/**
 * `cleo tui` is deprecated (T13996, ADR-098): it prints a notice on stderr,
 * then starts the cockpit as before.
 *
 * @task T13996
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const runCockpit = vi.fn(async () => ({ mode: 'plain' as const }));
vi.mock('../../lib/tui/cockpit.js', () => ({ runCockpit }));

import { TUI_DEPRECATION_NOTICE, tuiCommand } from '../tui.js';

afterEach(() => {
  vi.restoreAllMocks();
  runCockpit.mockClear();
});

describe('cleo tui deprecation (T13996)', () => {
  it('warns naming ADR-098 on stderr, then runs the cockpit unchanged', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = (tuiCommand as { run?: (ctx: unknown) => Promise<void> }).run;
    if (!run) throw new Error('tui has no run function');
    await run({ args: { once: true }, rawArgs: [], cmd: tuiCommand });
    expect(stderr).toHaveBeenCalledWith(`${TUI_DEPRECATION_NOTICE}\n`);
    expect(TUI_DEPRECATION_NOTICE).toContain('ADR-098');
    expect(runCockpit).toHaveBeenCalledWith({ once: true });
  });
});
