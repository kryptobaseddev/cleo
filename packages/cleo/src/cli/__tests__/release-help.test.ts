/**
 * Unit test — `resolveSubCommandForHelp` walks nested subcommand trees so
 * `cleo release <verb> --help` (and every other `<group> <verb> --help`)
 * renders verb-specific help instead of the top-level command listing (T9765).
 *
 * Pre-fix bug: `runMainWithLafsEnvelope` (packages/cleo/src/cli/index.ts)
 * detected `--help` anywhere in `rawArgs` and called `showUsage(rootCmd)`
 * directly. That dumped the grouped top-level help for EVERY subcommand
 * invocation — `cleo release plan --help`, `cleo session start --help`, `cleo
 * nexus impact --help` all collapsed to the same screen. This regression
 * made `--help` useless as a discovery tool for option flags on nested verbs.
 *
 * Fix: walk the subcommand tree via `resolveSubCommandForHelp` (a local port
 * of citty 0.2.1's unexported `resolveSubCommand`, lifted into its own module
 * to avoid index.ts's top-level `void startCli()` side effect) before calling
 * showUsage, so we hand the leaf command + its parent to the renderer.
 *
 * This file exercises the resolver directly with mock CommandDefs — pure
 * tree-walk semantics, no process spawn, no global IO, fast enough to run
 * under heavy CI load. We assert the resolver:
 *
 *   1. Walks down to the leaf for `release plan --help`.
 *   2. Stops at the group for `release --help`.
 *   3. Stops at root for bare `--help` / `-h`.
 *   4. Handles `lazyCommand`-style thunks for `subCommands`.
 *   5. Ignores leading flags before the subcommand token (the original bug).
 *
 * @task T9765
 * @epic T9758 (Saga: release system becomes a product)
 */

import type { CommandDef } from 'citty';
import { defineCommand } from 'citty';
import { describe, expect, it } from 'vitest';
import { resolveSubCommandForHelp } from '../resolve-subcommand.js';

// ---------------------------------------------------------------------------
// Fixture: a 3-level command tree mirroring the real cleo > release > <verb>
// shape. Each verb has its own `args` block (the help renderer reads these),
// so an assertion against `args` proves we walked to the correct level.
// ---------------------------------------------------------------------------

const planCmd: CommandDef = defineCommand({
  meta: { name: 'plan', description: 'Build the release plan.' },
  args: {
    version: { type: 'positional', description: 'Release version', required: true },
    epic: { type: 'string', description: 'Epic ID', required: true },
  },
  run() {
    // intentionally empty — fixture
  },
});

const openCmd: CommandDef = defineCommand({
  meta: { name: 'open', description: 'Open the release PR.' },
  args: {
    version: { type: 'positional', description: 'Release version', required: true },
    workflow: { type: 'string', description: 'Workflow file' },
  },
  run() {
    // intentionally empty — fixture
  },
});

const releaseCmd: CommandDef = defineCommand({
  meta: { name: 'release', description: 'Release lifecycle group.' },
  subCommands: { plan: planCmd, open: openCmd },
  run() {
    // intentionally empty — fixture
  },
});

const rootCmd: CommandDef = defineCommand({
  meta: { name: 'cleo', description: 'CLEO root.' },
  subCommands: { release: releaseCmd },
  run() {
    // intentionally empty — fixture
  },
});

// Lazy-command variant — mirrors what `lazyCommand` produces: `subCommands`
// is a function thunk that returns the resolved map. The resolver MUST
// transparently await it.
const lazyRootCmd: CommandDef = {
  meta: { name: 'cleo', description: 'CLEO root (lazy).' },
  subCommands: (async () => ({ release: releaseCmd })) as unknown as CommandDef['subCommands'],
};

describe('T9765 — resolveSubCommandForHelp', () => {
  it('walks down to the leaf for `release plan --help`', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, ['release', 'plan', '--help']);
    expect(leaf).toBe(planCmd);
    expect(parent).toBe(releaseCmd);
    // Sanity: the leaf has the plan-specific `--epic` arg.
    expect(leaf.args).toMatchObject({ epic: { type: 'string', required: true } });
  });

  it('walks down to the leaf for `release open --help`', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, ['release', 'open', '--help']);
    expect(leaf).toBe(openCmd);
    expect(parent).toBe(releaseCmd);
    expect(leaf.args).toMatchObject({ workflow: { type: 'string' } });
  });

  it('stops at the group for `release --help`', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, ['release', '--help']);
    expect(leaf).toBe(releaseCmd);
    expect(parent).toBe(rootCmd);
  });

  it('stops at root for bare `--help`', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, ['--help']);
    expect(leaf).toBe(rootCmd);
    expect(parent).toBeUndefined();
  });

  it('stops at root for bare `-h`', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, ['-h']);
    expect(leaf).toBe(rootCmd);
    expect(parent).toBeUndefined();
  });

  it('stops at root for empty rawArgs', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, []);
    expect(leaf).toBe(rootCmd);
    expect(parent).toBeUndefined();
  });

  it('stops at the unknown subcommand boundary', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, [
      'release',
      'nonexistent-verb',
      '--help',
    ]);
    expect(leaf).toBe(releaseCmd);
    expect(parent).toBe(rootCmd);
  });

  it('skips leading flags before the subcommand token', async () => {
    // Pre-fix: `--json release plan --help` would still trigger the buggy
    // help fast-path. Resolver must ignore leading flags and find the first
    // non-flag token.
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, [
      '--json',
      'release',
      'plan',
      '--help',
    ]);
    expect(leaf).toBe(planCmd);
    expect(parent).toBe(releaseCmd);
  });

  it('handles lazy-command thunks for subCommands', async () => {
    const [leaf, parent] = await resolveSubCommandForHelp(lazyRootCmd, [
      'release',
      'plan',
      '--help',
    ]);
    expect(leaf).toBe(planCmd);
    expect(parent).toBe(releaseCmd);
  });

  it('returns root when leaf has no subCommands and rawArgs has further tokens', async () => {
    // E.g. `release plan extra-token --help` — plan is a leaf, we stop there.
    const [leaf, parent] = await resolveSubCommandForHelp(rootCmd, [
      'release',
      'plan',
      'extra-token',
      '--help',
    ]);
    expect(leaf).toBe(planCmd);
    expect(parent).toBe(releaseCmd);
  });
});
