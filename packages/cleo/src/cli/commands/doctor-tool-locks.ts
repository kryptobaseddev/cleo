/**
 * `cleo doctor tool-locks` — what holds the machine-wide admission budget, what
 * waits for it, and is each holder even alive?
 *
 * Every heavy run (a `cleo verify` evidence run, a `cleo run` job, the vitest
 * project probe) is admitted through one ledger (T13133). When a holder is
 * killed, its entry stays until admission sees the holder pid and every tool
 * group it started are gone; this command shows the ledger and why a run is
 * waiting. It replaced the per-tool slot listing of gh#1222.
 *
 * Read-only by default. `--reap` drops entries whose holder is provably gone;
 * `--remove <id>` drops one entry whatever its liveness, for a holder the
 * probes cannot identify but the operator knows is gone.
 *
 * @task T12113 (gh#1222)
 * @task T13133
 */

import {
  admissionCapacityBytes,
  entryLiveness,
  readForeignEntries,
  readLedger,
  reapLedger,
  removeLedgerEntry,
} from '@cleocode/core/resources/admission-ledger.js';
import { CANONICAL_TOOLS } from '@cleocode/core/tasks/tool-resolver.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor tool-locks` subcommand.
 *
 * Exits non-zero when an entry whose holder is gone is present and was not
 * reaped, so it can gate a pre-flight script.
 *
 * @task T12113 (gh#1222)
 * @task T13133
 */
export const doctorToolLocksCommand = defineCommand({
  meta: {
    name: 'tool-locks',
    description:
      'Inspect the machine-wide admission ledger: which heavy runs hold the memory budget or ' +
      'wait for it, by which pid, and whether that pid is still alive. Read-only; --reap drops ' +
      'entries whose holder is provably gone; --remove <id> drops one entry.',
  },
  args: {
    reap: {
      type: 'boolean',
      description:
        'Drop entries whose holder process and tool process groups are gone. Fails safe: an ' +
        'unreadable probe or a fresh heartbeat counts as ALIVE and is never reaped.',
    },
    remove: {
      type: 'string',
      description:
        'Drop the entry with this id whatever its liveness (an entry whose holder cannot be ' +
        'identified is otherwise kept until its heartbeat is 10 minutes old).',
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
    if (requested && !CANONICAL_TOOLS.some((t) => t === requested)) {
      cliOutput(
        { error: `Unknown canonical tool "${requested}"`, known: [...CANONICAL_TOOLS] },
        { command: 'doctor', operation: 'doctor.tool-locks.run' },
      );
      process.exitCode = 1;
      return;
    }

    const reaped = args.reap === true ? await reapLedger() : [];
    const removeId = typeof args.remove === 'string' && args.remove.length > 0 ? args.remove : null;
    const removed = removeId === null ? null : await removeLedgerEntry(removeId);

    // Report state AFTER any reap, so what is shown is what is actually in force.
    const now = Date.now();
    const entries = readLedger()
      .filter((e) => requested === null || e.label === `tool:${requested}`)
      .map((e) => {
        const alive = entryLiveness(e, now) === 'alive';
        return {
          id: e.id,
          label: e.label,
          state: e.state,
          pid: e.pid,
          host: e.host,
          command: e.command,
          cwd: e.cwd,
          footprintBytes: e.footprintBytes,
          enqueuedAt: new Date(e.enqueuedAtMs).toISOString(),
          admittedAt: e.admittedAtMs === null ? null : new Date(e.admittedAtMs).toISOString(),
          toolGroups: e.toolGroups,
          alive,
          orphaned: !alive,
        };
      });
    const orphaned = entries.filter((e) => e.orphaned);
    const held = entries.filter((e) => e.state === 'admitted');
    // Entries a newer CLEO wrote: kept verbatim and charged, shown as found.
    const foreignEntries = requested === null ? readForeignEntries() : [];

    cliOutput(
      {
        capacityBytes: admissionCapacityBytes(),
        usedBytes: held.reduce((n, e) => n + e.footprintBytes, 0),
        entries,
        heldCount: held.length,
        waitingCount: entries.length - held.length,
        orphanedCount: orphaned.length,
        foreignEntries,
        reaped,
        reapApplied: args.reap === true,
        ...(removeId === null ? {} : { removeId, removed }),
      },
      { command: 'doctor', operation: 'doctor.tool-locks.run' },
    );

    // An orphan left in place holds budget until admission reaps it; asking to
    // remove an id that is not there is an error too.
    if ((orphaned.length > 0 || removed === false) && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
