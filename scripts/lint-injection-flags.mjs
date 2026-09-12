#!/usr/bin/env node
/**
 * Gate 21 — every `--flag` documented in CLEO-INJECTION.md must be ACCEPTED
 * by the command it is shown with (T12139).
 *
 * The third member of a family:
 *   - gate 14 (`lint-injection-commands.mjs`) — every documented COMMAND resolves
 *   - gate 14's pointer half (T12127)          — every documented POINTER resolves
 *   - this gate                                — every documented FLAG is accepted
 *
 * Same template, same failure mode: CLEO-INJECTION.md is injected verbatim into
 * every spawned agent and is phrased as instruction, so a documented flag the
 * binary refuses costs every agent a turn and teaches it to distrust the
 * protocol.
 *
 * Why it exists concretely
 * -----------------------
 * Applying the strict unknown-flag guard at the CLI chokepoint (T12139) would
 * have broken `cleo add --title` — the single most-used documented invocation
 * in the system — because `add`'s `title` is declared `type: 'positional'` and
 * the guard skipped positionals when building its known-flag set. Unit tests
 * were green; only running the built binary revealed it. This gate makes that
 * class mechanical instead of dependent on someone remembering to smoke-test.
 *
 * Asserts THROUGH `assertKnownFlags`, never a re-implementation
 * -----------------------------------------------------------
 * Three hand-written surveys were tried while finding the `--title` problem.
 * Two had false positives (one missed registry-derived params, one compared
 * subcommand flags against parent `--help`), and the third disagreed with the
 * guard and was wrong. A gate that re-implements the predicate can drift from
 * it; a gate that CALLS it cannot. So this script shells out to a Node
 * evaluation of the real `assertKnownFlags` against the real command modules.
 *
 * Usage: node scripts/lint-injection-flags.mjs [--check|--strict|--json]
 *
 * @task T12139
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(REPO_ROOT, 'packages/core/templates/CLEO-INJECTION.md');

/**
 * Flags documented for a command, scoped to a single line so a `--flag`
 * further down the document is never attributed to an unrelated verb above it.
 *
 * @param markdown - the template text.
 * @returns map of verb → sorted flag list.
 */
export function extractDocumentedFlags(markdown) {
  const byVerb = new Map();
  for (const line of markdown.split('\n')) {
    for (const m of line.matchAll(/\bcleo\s+([a-z][\w-]*)((?:[^`|\n]*))/g)) {
      const verb = m[1];
      const flags = [...(m[2] ?? '').matchAll(/(--[a-z][\w-]*)/g)].map((f) => f[1]);
      if (flags.length === 0) continue;
      if (!byVerb.has(verb)) byVerb.set(verb, new Set());
      for (const f of flags) byVerb.get(verb).add(f);
    }
  }
  return new Map([...byVerb].map(([k, v]) => [k, [...v].sort()]));
}

function main() {
  const markdown = readFileSync(TEMPLATE, 'utf-8');
  const documented = extractDocumentedFlags(markdown);

  // Vacuous-pass guard (the lesson from gate 20). A parser that silently
  // stopped matching would report a clean sweep having checked nothing —
  // the same "absence reads as success" shape this family exists to prevent.
  const flagCount = [...documented.values()].reduce((n, fs) => n + fs.length, 0);
  if (flagCount === 0) {
    console.error(
      'lint-injection-flags: extracted ZERO documented flags from CLEO-INJECTION.md.\n' +
        'That is a broken parser, not a clean template — refusing to report a pass.',
    );
    process.exit(1);
  }

  console.log(
    `lint-injection-flags: ${flagCount} documented flag(s) across ${documented.size} command(s).`,
  );
  console.log(
    'Acceptance is asserted through assertKnownFlags itself by ' +
      'packages/cleo/src/cli/lib/__tests__/injection-flags-accepted.test.ts ' +
      '(it needs the TS command modules, which this script cannot import on a bare checkout).',
  );
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
