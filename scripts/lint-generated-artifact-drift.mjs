#!/usr/bin/env node
/**
 * Generated-Artifact Drift Check (T12150 · gh#1281)
 *
 * Some generated files are COMMITTED to the repo. When two PRs each regenerate
 * one, git merges it **textually** rather than regenerating — so entries are
 * silently lost at merge time, in a defect that exists in neither PR.
 *
 * Measured 2026-09-12 on a dry-run composition of the 14 open PRs: three PRs
 * each registered a `cleo doctor` subcommand, and the composed
 * `command-manifest.ts` carried ONE of the three while `doctor.ts` registered
 * all three. Regenerating restored 13 lines.
 *
 * ## Why nothing noticed
 *
 * `prebuild` AND `pretypecheck` both regenerate the manifest, so every build
 * and every typecheck — local or CI — silently regenerates before doing
 * anything. **No command in normal use ever reads the committed file.** The
 * staleness was not merely unchecked; it was unobservable by construction.
 *
 * That is why this check must run BEFORE any step that invokes
 * `prebuild`/`pretypecheck`: otherwise the regeneration masks the very drift
 * the check exists to find — the same trap as the defect itself.
 *
 * ## What this does
 *
 * Regenerates each registered artifact and fails if the result differs from
 * what is committed. It MUTATES the working tree by design (regeneration is
 * the only way to learn the answer); on failure the fix is to commit what it
 * produced.
 *
 * @task T12150 (gh#1281)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Generated files that are committed, with the command that produces each.
 *
 * Four more artifacts share this exposure and have no generator wired here
 * yet (`core/src/llm/generated/provider-profiles.ts`,
 * `core/src/gateway-client/generated/namespaces.gen.ts`,
 * `core/src/config/build-config.ts`, `caamp/src/core/hooks/generated.ts`).
 * Add them as their generators become runnable in CI — the hazard is general,
 * this registry is what makes coverage explicit rather than assumed.
 */
const ARTIFACTS = [
  {
    label: 'CLI command manifest',
    path: 'packages/cleo/src/cli/generated/command-manifest.ts',
    regenerate: ['pnpm', ['--filter', '@cleocode/cleo', 'run', 'gen:manifest']],
    /**
     * The generator emits unwrapped lines; the committed file is biome-formatted
     * because the normal flow formats after generating. Without this the check
     * would fail on EVERY pr for formatting alone — and a gate that cries wolf
     * is a gate someone disables, which is worse than not having it.
     */
    format: true,
    remedy: 'pnpm --filter @cleocode/cleo run gen:manifest',
  },
];

let failed = false;

for (const artifact of ARTIFACTS) {
  const abs = resolve(REPO_ROOT, artifact.path);
  if (!existsSync(abs)) {
    console.error(`lint-generated-artifact-drift: MISSING ${artifact.path}`);
    failed = true;
    continue;
  }

  const [cmd, args] = artifact.regenerate;
  try {
    execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: 'ignore' });
  } catch (err) {
    console.error(
      `lint-generated-artifact-drift: could not regenerate ${artifact.label} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    failed = true;
    continue;
  }

  if (artifact.format) {
    try {
      execFileSync('./node_modules/.bin/biome', ['format', '--write', artifact.path], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
    } catch {
      // Formatting is a normalisation step, not the assertion. If biome is
      // unavailable the diff below still runs — it will simply be noisier.
    }
  }

  try {
    execFileSync('git', ['diff', '--exit-code', '--', artifact.path], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    console.log(`lint-generated-artifact-drift: OK — ${artifact.label} is current.`);
  } catch {
    failed = true;
    const diff = execFileSync('git', ['diff', '--stat', '--', artifact.path], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    console.error(
      `\nlint-generated-artifact-drift: FAIL — ${artifact.label} is STALE.\n\n` +
        `  ${artifact.path}\n` +
        `  ${diff}\n\n` +
        `The committed file does not match what its generator produces. This happens\n` +
        `when two PRs each regenerate it and git merges the result textually — entries\n` +
        `are lost with no conflict (gh#1281).\n\n` +
        `  FIX:  ${artifact.remedy}\n` +
        `        git add ${artifact.path} && git commit\n\n` +
        `The regenerated file is already in your working tree — commit it.\n`,
    );
  }
}

process.exit(failed ? 1 : 0);
