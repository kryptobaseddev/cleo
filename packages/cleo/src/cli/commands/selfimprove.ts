/**
 * `cleo selfimprove` CLI command group (T11889 · T11889-D).
 *
 * Thin CLI surface over the CORE self-improvement loop engine (`runSelfImprove`).
 * The ONLY verb is `run`: it boots ONE sandbox, replays a canned dogfood
 * scenario, diffs the result envelopes vs a golden, and — ONLY when `--execute`
 * is passed AND a regression is found — emits ONE leased `selfimprove_dhq` row
 * and opens ONE DRAFT PR.
 *
 * Self-dogfooding guardrails (NON-NEGOTIABLE — P5 self-improvement spec §B.7):
 *   - **Default OFF.** Without `--execute` the loop runs DRY-RUN (replay + diff +
 *     report; NO DB write, NO PR). Mutation + egress require the explicit flag.
 *   - The CORE engine owns boot/replay/diff/persist/egress + the budget caps +
 *     the circuit-breaker; this command is a pure dispatch delegate (Gate-6 — no
 *     standalone helper logic > 30 LOC lives here).
 *
 * Gate-1: `defineCommand` / `showUsage` come from the `define-cli-command`
 * SSoT — the ONLY module permitted to import `citty`.
 *
 * @module @cleocode/cleo/cli/commands/selfimprove
 * @epic T11889
 * @task T11914
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';

/**
 * `cleo selfimprove run --scenario <n>` — run ONE self-improvement loop iteration.
 *
 * Dispatches `mutate selfimprove.run`. The CORE engine validates the scenario,
 * boots one sandbox, replays it, and diffs vs the golden. DEFAULT OFF: pass
 * `--execute` to permit the leased DHQ write + the draft PR (otherwise DRY-RUN).
 */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run ONE self-improvement loop iteration: boot a sandbox, replay a canned scenario, ' +
      'diff vs golden; on regression emit ONE leased DHQ row + ONE DRAFT PR. ' +
      'DEFAULT OFF — pass --execute to act (else DRY-RUN: replay + diff + report only).',
  },
  args: {
    scenario: {
      type: 'string',
      description: 'Canned dogfood scenario name to replay (e.g. dhq-replay-find)',
      required: true,
    },
    execute: {
      type: 'boolean',
      description:
        'Permit mutation (leased DHQ UPSERT) + egress (draft PR). DEFAULT off ⇒ DRY-RUN ' +
        '(replay + diff + report only — no DB write, no PR).',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Force DRY-RUN explicitly (no DB write, no PR). The loop is default-OFF.',
    },
    backend: {
      type: 'string',
      description:
        "Confinement backend preference: 'gondolin' (micro-VM; degrades to the in-process " +
        "guarded env when VM infra is absent) | 'in-process'. Default: gondolin.",
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'selfimprove',
      'run',
      {
        scenario: args.scenario,
        execute: args.execute === true,
        dryRun: args['dry-run'] === true,
        backend: args.backend as string | undefined,
      },
      { command: 'selfimprove' },
    );
  },
});

/**
 * `cleo selfimprove` command group — the self-dogfooding loop surface.
 *
 * Groups the `run` verb. Running `cleo selfimprove` with no subcommand prints
 * usage (the loop never fires implicitly — it is default-OFF and explicit).
 */
export const selfimproveCommand = defineCommand({
  meta: {
    name: 'selfimprove',
    description:
      'Self-improvement loop — replay a canned dogfood scenario, diff vs golden, and surface ' +
      'regressions as leased DHQ rows + DRAFT PRs. Default OFF (requires --execute to act).',
  },
  subCommands: {
    run: runCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
