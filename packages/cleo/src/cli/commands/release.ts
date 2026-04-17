/**
 * CLI release command group — release lifecycle management.
 *
 * Commands:
 *   cleo release ship <version>    — composite release: gates → changelog → commit → tag → push
 *   cleo release list              — list all releases
 *   cleo release show <version>    — show release details
 *   cleo release cancel <version>  — cancel a draft/prepared release
 *   cleo release rollback <version> — roll back a shipped release
 *   cleo release channel           — show current release channel
 *
 * REMOVED: release add/plan commands were consolidated into release.ship as part
 * of the API rationalization (T5615). For preview/dry-run: cleo release ship <version> --epic <id> --dry-run
 *
 * @task T4467
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo release ship — composite release: prepare → gates → changelog → commit → tag → push.
 *
 * Requires --epic <id>. Use --dry-run to preview without writing anything.
 */
const shipCommand = defineCommand({
  meta: {
    name: 'ship',
    description: 'Ship a release: gates → changelog → commit → tag → push',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Version string (e.g. 2026.4.77)',
      required: true,
    },
    epic: {
      type: 'string',
      description: 'Epic task ID for commit message (e.g. T5576)',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview all actions without writing anything',
    },
    push: {
      type: 'boolean',
      description: 'Push commit and tag (default: true)',
      default: true,
    },
    bump: {
      type: 'boolean',
      description: 'Bump version files (default: true)',
      default: true,
    },
    remote: {
      type: 'string',
      description: 'Git remote to push to (default: origin)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.ship',
      {
        version: args.version,
        epicId: args.epic,
        dryRun: args['dry-run'],
        push: args.push !== false,
        bump: args.bump !== false,
        remote: args.remote as string | undefined,
      },
      { command: 'release' },
    );
  },
});

/** cleo release list — list all releases */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all releases' },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'release.list', {}, { command: 'release' });
  },
});

/** cleo release show — show details for a specific release */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show release details' },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to show',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'release.show',
      { version: args.version },
      { command: 'release' },
    );
  },
});

/** cleo release cancel — cancel and remove a release in draft or prepared state */
const cancelCommand = defineCommand({
  meta: {
    name: 'cancel',
    description: 'Cancel and remove a release in draft or prepared state',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to cancel',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.cancel',
      { version: args.version },
      { command: 'release' },
    );
  },
});

/** cleo release rollback — roll back a shipped release */
const rollbackCommand = defineCommand({
  meta: {
    name: 'rollback',
    description: 'Roll back a shipped release (marks it as rolled-back in CLEO records)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to roll back',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for rollback',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.rollback',
      {
        version: args.version,
        reason: args.reason as string | undefined,
      },
      { command: 'release' },
    );
  },
});

/** cleo release channel — show the current release channel based on git branch */
const channelCommand = defineCommand({
  meta: {
    name: 'channel',
    description: 'Show the current release channel based on git branch (latest/beta/alpha)',
  },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'release.channel.show', {}, { command: 'release' });
  },
});

/**
 * Root release command group — release lifecycle management.
 *
 * Dispatches to `pipeline.release.*` registry operations.
 */
export const releaseCommand = defineCommand({
  meta: { name: 'release', description: 'Release lifecycle management' },
  subCommands: {
    ship: shipCommand,
    list: listCommand,
    show: showCommand,
    cancel: cancelCommand,
    rollback: rollbackCommand,
    channel: channelCommand,
  },
});
