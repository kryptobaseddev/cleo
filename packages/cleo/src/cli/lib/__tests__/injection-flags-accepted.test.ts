/**
 * Gate 21 — every `--flag` documented in CLEO-INJECTION.md is ACCEPTED by the
 * command it is shown with (T12139).
 *
 * Third member of a family: gate 14 asserts documented COMMANDS resolve,
 * T12127 asserts documented POINTERS resolve, this asserts documented FLAGS
 * are accepted. Same template — injected verbatim into every spawned agent and
 * phrased as instruction — so a documented flag the binary refuses costs every
 * agent a turn and teaches it to distrust the protocol.
 *
 * Asserted THROUGH `assertKnownFlags`, never a re-implementation. Three
 * hand-written surveys were tried while finding the `--title` defect below:
 * two had false positives, and the third disagreed with the guard and was
 * wrong. A gate that re-implements the predicate can drift from it; one that
 * calls it cannot.
 *
 * @task T12139
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArgsDef, CommandDef } from 'citty';
import { describe, expect, it } from 'vitest';
import { extractDocumentedFlags } from '../../../../../../scripts/lint-injection-flags.mjs';
import { assertKnownFlags, CLI_GLOBAL_FLAGS, UnknownFlagError } from '../strict-args.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const TEMPLATE = join(REPO_ROOT, 'packages/core/templates/CLEO-INJECTION.md');
const MANIFEST = join(REPO_ROOT, 'packages/cleo/src/cli/generated/command-manifest.ts');

/** verb → command-module basename, read from the generated manifest source. */
function moduleByVerb(): Map<string, string> {
  const src = readFileSync(MANIFEST, 'utf-8');
  return new Map(
    [
      ...src.matchAll(/name:\s*'([^']+)',[\s\S]{0,400}?import\('\.\.\/commands\/([^']+)\.js'\)/g),
    ].map((m) => [m[1] as string, m[2] as string]),
  );
}

/**
 * Is `flag` accepted by this command, or by any of its subcommands?
 *
 * Subcommands matter because the template documents `cleo memory digest
 * --brief` and `cleo saga create --title`, where the flag belongs to the leaf
 * rather than the parent — comparing against the parent alone was one of the
 * false positives that made an earlier survey untrustworthy.
 */
async function accepts(cmd: CommandDef, flag: string): Promise<boolean> {
  const args = typeof cmd.args === 'function' ? await cmd.args : cmd.args;
  if (args) {
    try {
      assertKnownFlags([flag], args as ArgsDef, 'probe');
      return true;
    } catch (err) {
      if (!(err instanceof UnknownFlagError)) throw err;
    }
  }
  const subs = typeof cmd.subCommands === 'function' ? await cmd.subCommands : cmd.subCommands;
  if (subs) {
    for (const sub of Object.values(subs)) {
      const resolved = typeof sub === 'function' ? await sub() : await sub;
      if (resolved && (await accepts(resolved as CommandDef, flag))) return true;
    }
  }
  return false;
}

const documented = extractDocumentedFlags(readFileSync(TEMPLATE, 'utf-8')) as Map<string, string[]>;

describe('gate 21 — documented flags are accepted (T12139)', () => {
  it('extracts a non-trivial number of flags (vacuous-pass guard)', () => {
    // A parser that stopped matching would make every assertion below pass by
    // checking nothing — the "absence reads as success" shape this family
    // exists to prevent. Same guard as gate 20's minimum-count check.
    const total = [...documented.values()].reduce((n, f) => n + f.length, 0);
    expect(total).toBeGreaterThan(20);
    expect(documented.size).toBeGreaterThan(5);
  });

  it('every documented flag is accepted by its command', async () => {
    const mods = moduleByVerb();
    const globals = new Set(CLI_GLOBAL_FLAGS);
    const rejected: string[] = [];

    for (const [verb, flags] of documented) {
      const mod = mods.get(verb);
      if (!mod) continue; // not a top-level command (e.g. a doc-only example)
      let cmd: CommandDef;
      try {
        cmd = (await import(`../../commands/${mod}.js`))[
          `${verb.replace(/-./g, (m) => m[1].toUpperCase())}Command`
        ] as CommandDef;
      } catch {
        continue;
      }
      if (!cmd) continue;
      for (const flag of flags) {
        if (globals.has(flag)) continue;
        if (!(await accepts(cmd, flag))) rejected.push(`cleo ${verb} ${flag}`);
      }
    }

    // Any entry here is either a flag the protocol documents and the binary
    // refuses, or a flag that exists only on a subcommand path this resolver
    // could not reach. Both are worth a human look.
    expect(rejected).toEqual([]);
  });

  /**
   * Pinned explicitly, because the generic sweep above would not survive a
   * "tidy-up" of `collectKnownLongFlags`. `cleo add`'s `title` is declared
   * `type: 'positional'`, yet `cleo add --title "..."` is the form
   * CLEO-INJECTION.md documents everywhere and every agent uses — it works
   * because citty's non-strict parse populates `args.title` for both
   * spellings. An earlier revision of T12139 skipped positionals when building
   * the known-flag set and broke exactly this, with green unit tests:
   *
   *   E_UNKNOWN_FLAG: unknown flag '--title' for 'add'.
   *                   Did you mean: --files, --note, --size, --type?
   */
  it('accepts --title on `add`, whose title is POSITIONAL-backed', async () => {
    const { addCommand } = await import('../../commands/add.js');
    expect(await accepts(addCommand as CommandDef, '--title')).toBe(true);
  });

  it('still rejects a flag `add` genuinely does not have', async () => {
    const { addCommand } = await import('../../commands/add.js');
    expect(await accepts(addCommand as CommandDef, '--ttile')).toBe(false);
  });
});
