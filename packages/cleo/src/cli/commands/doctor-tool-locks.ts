/**
 * `cleo doctor tool-locks` — who is holding the evidence-tool semaphore, and
 * are they even alive?
 *
 * The global per-tool semaphore bounds concurrent evidence runs machine-wide.
 * When a `cleo verify` is killed without releasing its slot, `proper-lockfile`
 * keeps the slot held until its mtime goes stale — 10 minutes by default —
 * during which every later verify fails with `E_EVIDENCE_TOOL_BUSY` and no
 * indication of who is responsible. Answering "is this a stuck semaphore or a
 * slow suite?" previously meant reading `~/.local/share/cleo/locks/` by hand
 * (gh#1222).
 *
 * Read-only by default. `--reap` frees slots whose holder is provably gone.
 *
 * @task T12113 (gh#1222)
 */

import { CANONICAL_TOOLS } from '@cleocode/core/tasks/tool-resolver.js';
import { listSlotHolders, reapOrphanedSlots } from '@cleocode/core/tasks/tool-semaphore.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor tool-locks` subcommand.
 *
 * Exits non-zero when an orphaned slot is present and was not reaped, so it
 * can gate a pre-flight script.
 *
 * @task T12113 (gh#1222)
 */
export const doctorToolLocksCommand = defineCommand({
  meta: {
    name: 'tool-locks',
    description:
      'Inspect the machine-wide evidence-tool semaphore: which slots are held, by which pid, ' +
      'and whether that pid is still alive. Read-only; --reap frees provably-orphaned slots.',
  },
  args: {
    reap: {
      type: 'boolean',
      description:
        'Free slots whose recorded holder is no longer running. Fails safe: an unknown ' +
        'holder, a holder on another host, or any error counts as ALIVE and is never reaped.',
    },
    tool: {
      type: 'string',
      description: 'Restrict to one canonical tool (test, build, lint, typecheck, …).',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const requested = typeof args.tool === 'string' && args.tool.length > 0 ? args.tool : null;
    const tools = requested ? CANONICAL_TOOLS.filter((t) => t === requested) : [...CANONICAL_TOOLS];

    if (requested && tools.length === 0) {
      cliOutput(
        { error: `Unknown canonical tool "${requested}"`, known: [...CANONICAL_TOOLS] },
        { command: 'doctor', operation: 'doctor.tool-locks.run' },
      );
      process.exitCode = 1;
      return;
    }

    const reaped: string[] = [];
    if (args.reap === true) {
      for (const tool of tools) reaped.push(...reapOrphanedSlots(tool));
    }

    // Report state AFTER any reap, so what is shown is what is actually in force.
    const slots = tools.flatMap((tool) =>
      listSlotHolders(tool).map((row) => ({
        tool,
        slot: row.slot,
        held: row.held,
        alive: row.alive,
        orphaned: row.held && !row.alive,
        holder: row.holder,
      })),
    );
    const orphaned = slots.filter((s) => s.orphaned);

    cliOutput(
      {
        slots,
        heldCount: slots.filter((s) => s.held).length,
        orphanedCount: orphaned.length,
        reaped,
        reapApplied: args.reap === true,
      },
      { command: 'doctor', operation: 'doctor.tool-locks.run' },
    );

    // An orphan left in place will block later verifies — worth a non-zero exit.
    if (orphaned.length > 0 && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
