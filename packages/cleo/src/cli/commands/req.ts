/**
 * CLI `cleo req` command — REQ-ID-addressable acceptance gate management.
 *
 * Subcommands:
 *   cleo req add <taskId> --gate '<json>'   — add a typed AcceptanceGate with a REQ-ID
 *   cleo req list <taskId>                  — list all REQ-ID gates on a task
 *   cleo req migrate <taskId> [--apply]     — heuristic migrator for free-text criteria
 *
 * All output is JSON-envelope compliant (success + data).
 * Validation against the AcceptanceGate Zod schema happens server-side
 * (in the dispatch layer) before any write is performed.
 *
 * @epic T760
 * @task T782
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo req` command group and its subcommands.
 *
 * @param program - The root CLI command
 *
 * @example
 * ```bash
 * # Add a test gate with REQ-ID TIMER-01
 * cleo req add T42 --gate '{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass","req":"TIMER-01"}'
 *
 * # List all REQ-ID gates on T42
 * cleo req list T42
 *
 * # Preview migration proposals for T42 (dry-run)
 * cleo req migrate T42
 *
 * # Apply migration (write typed gates back to the task)
 * cleo req migrate T42 --apply
 * ```
 */
export function registerReqCommand(program: Command): void {
  const reqCmd = program
    .command('req')
    .description('Manage REQ-ID-addressable acceptance gates on tasks');

  // ── cleo req add <taskId> --gate '<json>' ──────────────────────────────────
  reqCmd
    .command('add <task-id>')
    .description("Add a typed AcceptanceGate (with REQ-ID) to a task's acceptance array")
    .option(
      '--gate <json>',
      'AcceptanceGate JSON string (must match the AcceptanceGate schema; include "req" for a REQ-ID)',
    )
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const gate = opts['gate'] as string | undefined;
      if (!gate) {
        process.stderr.write(
          'Error: --gate <json> is required.\n' +
            'Example: cleo req add T42 --gate \'{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass","req":"TIMER-01"}\'\n',
        );
        process.exit(6);
      }

      await dispatchFromCli('mutate', 'tasks', 'req.add', { taskId, gate }, { command: 'req add' });
    });

  // ── cleo req list <taskId> ─────────────────────────────────────────────────
  reqCmd
    .command('list <task-id>')
    .description('List all REQ-ID-addressed acceptance gates on a task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'tasks', 'req.list', { taskId }, { command: 'req list' });
    });

  // ── cleo req migrate <taskId> [--apply] ───────────────────────────────────
  reqCmd
    .command('migrate <task-id>')
    .description(
      'Heuristic migrator: propose (or apply) typed gate replacements for free-text acceptance strings. ' +
        'Heuristics: "tests pass" → test gate, "<file> exists" → file gate, ' +
        '"lint clean" → lint gate, "<cmd> returns 0" → command gate, otherwise → manual gate.',
    )
    .option(
      '--apply',
      'Write the proposed typed gates back to the task (default: dry-run, print proposals only)',
    )
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const apply = Boolean(opts['apply']);
      await dispatchFromCli(
        apply ? 'mutate' : 'query',
        'tasks',
        'req.migrate',
        { taskId, apply },
        { command: 'req migrate' },
      );
    });
}
