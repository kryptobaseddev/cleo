/**
 * CLI federation command group — manage trusted federation peers.
 *
 * Subcommands:
 *   cleo federation add <url> [--trust <level>]   — add (or update) a peer
 *   cleo federation remove <url>                  — remove a peer
 *   cleo federation list [--json]                 — list all peers
 *
 * The federation index lives at `~/.cleo/federation.json` (operator-managed).
 * See {@link addFederationPeer} for URL normalisation + trust-level rules.
 *
 * @task T9729
 * @epic T9571
 * @saga T9560
 * @see packages/core/src/skills/federation-store.ts (storage layer)
 */

import { ExitCode } from '@cleocode/contracts';
import {
  type FederationTrustLevel,
  addFederationPeer,
  listFederationPeers,
  removeFederationPeer,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput, humanLine } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// cleo federation add
// ---------------------------------------------------------------------------

/**
 * `cleo federation add <url> [--trust <level>]` — add or update a federation peer.
 *
 * URL is normalised before being stored (lowercase scheme/host, trailing slash).
 * Trust level defaults to `unverified`; valid values are
 * `verified | unverified | blocked`.
 *
 * @task T9729
 */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Add (or update) a federation peer in ~/.cleo/federation.json',
  },
  args: {
    url: {
      type: 'positional',
      description: 'Peer URL (must use http:// or https://)',
      required: true,
    },
    trust: {
      type: 'string',
      description: 'Trust level: verified | unverified | blocked (default: unverified)',
      default: 'unverified',
    },
  },
  async run({ args }) {
    try {
      const trust = String(args.trust) as FederationTrustLevel;
      const result = addFederationPeer(String(args.url), trust);
      cliOutput(
        {
          entry: result.entry,
          updated: result.updated,
        },
        { command: 'federation add', operation: 'federation.add' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`federation add failed: ${message}`, ExitCode.VALIDATION_ERROR);
    }
  },
});

// ---------------------------------------------------------------------------
// cleo federation remove
// ---------------------------------------------------------------------------

/**
 * `cleo federation remove <url>` — drop a federation peer from the index.
 *
 * Exits `0` whether the URL was present or not (idempotent remove); the
 * `removed` boolean in the response distinguishes the two cases.
 *
 * @task T9729
 */
const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a federation peer from ~/.cleo/federation.json',
  },
  args: {
    url: {
      type: 'positional',
      description: 'Peer URL to remove (normalised before lookup)',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const removed = removeFederationPeer(String(args.url));
      cliOutput(
        { url: String(args.url), removed },
        { command: 'federation remove', operation: 'federation.remove' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`federation remove failed: ${message}`, ExitCode.VALIDATION_ERROR);
    }
  },
});

// ---------------------------------------------------------------------------
// cleo federation list
// ---------------------------------------------------------------------------

/**
 * `cleo federation list [--json]` — list all known federation peers.
 *
 * Default output is human-readable (one line per peer). `--json` emits the
 * raw envelope for scripting.
 *
 * @task T9729
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all federation peers in ~/.cleo/federation.json',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit raw JSON envelope instead of human-readable list',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const entries = listFederationPeers();
      if (args.json) {
        cliOutput(
          { count: entries.length, entries },
          { command: 'federation list', operation: 'federation.list' },
        );
        return;
      }
      if (entries.length === 0) {
        humanLine('(no federation peers configured)');
        return;
      }
      for (const entry of entries) {
        humanLine(`${entry.trust.padEnd(11)}  ${entry.url}  (added ${entry.addedAt})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`federation list failed: ${message}`, ExitCode.GENERAL_ERROR);
    }
  },
});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

/**
 * Root `cleo federation` command — federation peer management.
 *
 * @example
 * ```bash
 * cleo federation add https://peer.example/ --trust verified
 * cleo federation list
 * cleo federation remove https://peer.example/
 * ```
 *
 * @task T9729
 */
export const federationCommand = defineCommand({
  meta: {
    name: 'federation',
    description: 'Federation peer management: add, remove, list trusted peers',
  },
  subCommands: {
    add: addCommand,
    remove: removeCommand,
    list: listCommand,
  },
  run({ rawArgs }) {
    const sub = rawArgs?.find((a) => !a.startsWith('-'));
    if (!sub) {
      showUsage(federationCommand);
    }
  },
});
