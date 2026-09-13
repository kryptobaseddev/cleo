/**
 * `cleo nexus status` must not report this project's index under another
 * project's identity (gh#1329 · T12174).
 *
 * ## What was wrong
 *
 * The command derived a `projectId` from a user-supplied path and reported it
 * alongside counts that ignore it. `getIndexStats` documents its parameter as
 * `_projectId` — deliberately unused since ADR-090/T11648, because the graph DB
 * is project-scoped: one store per project, and `getNexusDb()` opens THIS
 * project's store. So the counts always describe the current project.
 *
 * Measured before the fix:
 *
 *     $ cleo nexus status /definitely/not/a/real/repo --json
 *     success=true  indexed=true  nodes=26964
 *     repoPath=/definitely/not/a/real/repo
 *     projectId=L2RlZmluaXRlbHkvbm90L2EvcmVhbC9y
 *
 * A path that does not exist reported `indexed: true` with the real project's
 * full node count, under a projectId derived from the bogus path.
 *
 * ## Why it mattered more than a cosmetic mislabel
 *
 * CLEO-INJECTION.md makes this the MANDATED first call for the whole nexus
 * subsystem, specifically so an agent does not read `E_NOT_FOUND` as "no such
 * symbol" when the truth is a stale or wrong index. A confident false `yes`
 * here defeats the surface written to prevent that failure.
 *
 * @task T12174
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nexusCommand } from '../nexus.js';

/**
 * Source of the command under test.
 *
 * The guards below are ORDERING and REACHABILITY assertions — a guard placed
 * after the value it protects guards nothing — and ordering is not observable
 * from the command's declared `args`. Behaviour itself is verified live against
 * a control (a bogus path, a foreign `--project-id`, and a swallowed flag all
 * exit 2; the no-argument invocation still exits 0 and returns real counts).
 */
const NEXUS_COMMAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'nexus.ts');

/** The `status` subcommand, as the CLI resolves it. */
function statusCommand(): { args: Record<string, unknown> } {
  const sub = (nexusCommand as unknown as { subCommands?: Record<string, unknown> }).subCommands;
  expect(sub, 'nexus command must expose subCommands').toBeDefined();
  const status = (sub as Record<string, { args: Record<string, unknown> }>)['status'];
  expect(status, 'nexus must expose a `status` subcommand').toBeDefined();
  return status;
}

describe('nexus status — scope honesty (gh#1329)', () => {
  it('declares a positional `path`, which is what made a foreign identity reachable', () => {
    // Pinning the surface that carries the hazard: the command accepts a path,
    // so the guard has to exist. If `path` is ever removed, this test should be
    // revisited rather than silently passing on a command that no longer takes
    // one.
    const { args } = statusCommand();
    expect(args['path']).toMatchObject({ type: 'positional' });
  });

  it('gh#1329: a path that is not a directory must be refused before an id is derived', () => {
    // The id is `base64url(path).slice(0,32)`, which succeeds for ANY string —
    // so a non-existent path produced a well-formed project id and was reported
    // alongside THIS project's counts. Measured:
    //   cleo nexus status /definitely/not/a/real/repo
    //     -> indexed: true, nodeCount: 26964, projectId derived from the bogus path
    const src = readFileSync(NEXUS_COMMAND, 'utf-8');
    expect(src).toContain('E_NEXUS_PATH_NOT_A_DIRECTORY');
    // The guard must run BEFORE the id is derived, or it guards nothing.
    expect(src.indexOf('E_NEXUS_PATH_NOT_A_DIRECTORY')).toBeLessThan(
      src.indexOf('const derivedProjectId'),
    );
  });

  it('gh#1329: a foreign --project-id is refused, since the id cannot select a store', () => {
    // `getIndexStats` documents its `_projectId` as unused since ADR-090/T11648
    // — the graph DB is project-scoped, so an override relabels this project's
    // counts as another's rather than selecting anything.
    const src = readFileSync(NEXUS_COMMAND, 'utf-8');
    expect(src).toContain('derivedProjectId');
    expect(src).toMatch(
      /projectIdOverride !== undefined && projectIdOverride !== derivedProjectId/,
    );
  });

  it('declares no `output` flag — so `--output <x>` is swallowed as the path', () => {
    // The second route to the same defect: `--output` is not declared here, so
    // citty consumes its VALUE positionally and `--output envelope` silently
    // asked about `<cwd>/envelope`. The cross-project guard catches that route
    // too, which is why this PR does not also need to change flag parsing —
    // but the absence of the flag is the precondition and is worth pinning.
    const { args } = statusCommand();
    expect(args['output']).toBeUndefined();
  });
});
