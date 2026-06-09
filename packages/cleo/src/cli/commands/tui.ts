/**
 * `cleo tui` — the Pi-powered terminal cockpit (T11933 · T11934 · epic T11916).
 *
 * The mission's SECOND human surface (alongside Studio): a keyboard-first
 * terminal client that boots over the M5 generated gateway SDK and renders the
 * agent-lifecycle Kanban HOME view (Backlog → Ready → Running → Review →
 * Blocked → Done → Cancelled) over the live task graph.
 *
 * Design contracts:
 *  - **SDK-only data access (AC2).** Every read goes through
 *    `createCleoClient` ({@link import('@cleocode/core/gateway-client')}, T11920)
 *    against the daemon's `/v1` listener — NO direct `@cleocode/core` domain
 *    import, secrets never on the wire.
 *  - **Canonical command factory (AC3).** Registered via the
 *    {@link import('../lib/define-cli-command.js') | SSoT `defineCommand` wrapper}
 *    (no raw `citty` import — Gate-1).
 *  - **Graceful degrade (AC1).** pi-tui absent → plain-text board + install
 *    hint, exit 0. Daemon unreachable → "start `cleo daemon serve`" message,
 *    exit 0. Neither path crashes.
 *
 * The command shell is intentionally thin: it parses args and hands off to the
 * {@link import('../lib/tui/cockpit.js') | cockpit runtime} (which owns the
 * loader + SDK + board-render glue), keeping the CLI package boundary clean.
 *
 * @task T11933 — command shell over the gateway SDK
 * @task T11934 — Kanban home view
 * @epic T11916
 */

import { defineCommand } from '../lib/define-cli-command.js';

/**
 * `cleo tui` — launch the keyboard-first terminal cockpit.
 *
 * Boots the gateway SDK client, renders the Kanban home view, and (when
 * `@earendil-works/pi-tui` is installed and stdout is a TTY) enters the
 * interactive differential-rendered loop. Otherwise it prints the board as
 * plain text and exits 0.
 */
export const tuiCommand = defineCommand({
  meta: {
    name: 'tui',
    description:
      'Launch the Pi-powered terminal cockpit (keyboard-first Kanban over the daemon /v1 gateway)',
  },
  args: {
    'base-url': {
      type: 'string',
      description:
        'Gateway base URL (default http://127.0.0.1:7777 — the `cleo daemon serve` listener)',
    },
    once: {
      type: 'boolean',
      description:
        'Render the board once (plain text) and exit — do not enter the interactive loop',
      default: false,
    },
  },
  async run({ args }) {
    // Lazy import keeps the gateway SDK + pi-tui loader off the `cleo --help`
    // fast path (the command module only loads when `cleo tui` actually runs).
    const { runCockpit } = await import('../lib/tui/cockpit.js');
    const baseUrlArg = args['base-url'] as string | undefined;
    const result = await runCockpit({
      ...(typeof baseUrlArg === 'string' && baseUrlArg.length > 0 ? { baseUrl: baseUrlArg } : {}),
      once: args.once === true,
    });

    // Always exit 0 for the expected outcomes — degradation is not an error.
    // The cockpit has already written human-readable lines to stdout, so there
    // is nothing more to emit; `result` is consumed for type-completeness.
    void result;
  },
});
