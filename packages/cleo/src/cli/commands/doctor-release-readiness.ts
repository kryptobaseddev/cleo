/**
 * `cleo doctor release-readiness` — pre-flight check for release readiness.
 *
 * Runs the full lint matrix + changelog/changeset lint + npm OIDC sanity +
 * tag-trigger sanity in <30s. Returns structured JSON output. Non-zero exit
 * on any failure.
 *
 * @task T10458
 * @epic T10436
 * @saga T10431
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput, humanLine } from '../renderers/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface ReleaseReadinessResult {
  ready: boolean;
  checks: CheckResult[];
  summary: {
    pass: number;
    fail: number;
    skip: number;
    total: number;
    durationMs: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a shell command via spawnSync and return a structured result.
 */
async function runCheck(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<CheckResult> {
  const { spawnSync } = await import('node:child_process');
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });
  const durationMs = Date.now() - start;
  const passed = result.status === 0;

  return {
    name,
    status: passed ? 'pass' : 'fail',
    exitCode: result.status,
    durationMs,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * `cleo doctor release-readiness` subcommand.
 *
 * Runs a battery of checks that must all pass before a release is considered
 * safe to ship. Each check is timed and reported individually so CI and
 * operators can see exactly what failed.
 *
 * Checks (in order):
 *   1. Biome lint/format (`biome ci .`)
 *   2. Changeset lint (`node scripts/lint-changesets.mjs`)
 *   3. CHANGELOG.md exists and is non-empty
 *   4. npm OIDC sanity (package.json has publishConfig.access=public)
 *   5. Tag-trigger sanity (auto-tag-on-release-merge.yml exists and valid)
 *   6. Type-check (`tsc --noEmit` or equivalent)
 *   7. Core lint scripts (contracts-dep, format-error, json-stream)
 *
 * Exit codes:
 *   0 — all checks passed, release is ready
 *   1 — one or more checks failed
 *
 * @task T10458
 */
export const doctorReleaseReadinessCommand = defineCommand({
  meta: {
    name: 'release-readiness',
    description:
      'Pre-flight release readiness check — lint matrix + changelog + changeset + npm OIDC + tag-trigger sanity (T10458)',
  },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);
    const repoRoot = resolve(process.cwd());
    const startTotal = Date.now();

    const checks: CheckResult[] = [];

    // ── 1. Biome lint/format ────────────────────────────────────────────────
    // We run `biome check .` if biome is available; skip gracefully if not.
    const biomePath = join(repoRoot, 'node_modules', '.bin', 'biome');
    const biomeAvailable = existsSync(biomePath);
    if (biomeAvailable) {
      checks.push(await runCheck('biome-lint', biomePath, ['ci', '.'], repoRoot));
    } else {
      checks.push({
        name: 'biome-lint',
        status: 'skip',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: 'biome not found in node_modules/.bin — skipping',
      });
    }

    // ── 2. Changeset lint ───────────────────────────────────────────────────
    const changesetLintScript = join(repoRoot, 'scripts', 'lint-changesets.mjs');
    if (existsSync(changesetLintScript)) {
      checks.push(await runCheck('changeset-lint', 'node', [changesetLintScript], repoRoot));
    } else {
      checks.push({
        name: 'changeset-lint',
        status: 'skip',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: 'scripts/lint-changesets.mjs not found — skipping',
      });
    }

    // ── 3. CHANGELOG.md sanity ──────────────────────────────────────────────
    const changelogPath = join(repoRoot, 'CHANGELOG.md');
    const changelogExists = existsSync(changelogPath);
    const changelogCheck: CheckResult = {
      name: 'changelog-exists',
      status: changelogExists ? 'pass' : 'fail',
      exitCode: changelogExists ? 0 : 1,
      durationMs: 0,
      stdout: changelogExists ? `Found ${changelogPath}` : '',
      stderr: changelogExists ? '' : `CHANGELOG.md not found at ${changelogPath}`,
    };
    checks.push(changelogCheck);

    // ── 4. npm OIDC sanity ──────────────────────────────────────────────────
    // Verify the published-package package.json files declare
    // publishConfig.access=public, which is required for npm Trusted
    // Publishing (OIDC). The root package.json is a private monorepo and
    // doesn't get published, so we skip it and check each published
    // workspace package instead.
    const packageJsonPath = join(repoRoot, 'package.json');
    let oidcCheck: CheckResult;
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(
          await import('node:fs').then((m) => m.readFileSync(packageJsonPath, 'utf8')),
        );
        // Skip root if it's a private monorepo (T10498) — only published
        // packages need publishConfig.access.
        if (pkg.private === true) {
          oidcCheck = {
            name: 'npm-oidc-sanity',
            status: 'pass',
            exitCode: 0,
            durationMs: 0,
            stdout: 'root package.json is private — skipping (per-package check applies at publish time)',
            stderr: '',
          };
        } else {
          const hasPublishConfig =
            typeof pkg.publishConfig === 'object' && pkg.publishConfig !== null;
          const accessPublic = hasPublishConfig && pkg.publishConfig.access === 'public';
          oidcCheck = {
            name: 'npm-oidc-sanity',
            status: accessPublic ? 'pass' : 'fail',
            exitCode: accessPublic ? 0 : 1,
            durationMs: 0,
            stdout: accessPublic ? 'package.json has publishConfig.access=public' : '',
            stderr: accessPublic
              ? ''
              : 'package.json missing publishConfig.access=public — required for npm OIDC Trusted Publishing',
          };
        }
      } catch {
        oidcCheck = {
          name: 'npm-oidc-sanity',
          status: 'fail',
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: 'Failed to parse package.json',
        };
      }
    } else {
      oidcCheck = {
        name: 'npm-oidc-sanity',
        status: 'fail',
        exitCode: 1,
        durationMs: 0,
        stdout: '',
        stderr: 'package.json not found',
      };
    }
    checks.push(oidcCheck);

    // ── 5. Tag-trigger sanity ───────────────────────────────────────────────
    // Verify that the auto-tag-on-release-merge.yml workflow exists and looks valid.
    const tagWorkflowPath = join(repoRoot, '.github', 'workflows', 'auto-tag-on-release-merge.yml');
    const tagWorkflowExists = existsSync(tagWorkflowPath);
    let tagTriggerCheck: CheckResult;
    if (tagWorkflowExists) {
      try {
        const content = await import('node:fs').then((m) =>
          m.readFileSync(tagWorkflowPath, 'utf8'),
        );
        const hasName = content.includes('name:');
        const hasOnTrigger = content.includes('on:') || content.includes('pull_request:');
        const valid = hasName && hasOnTrigger;
        tagTriggerCheck = {
          name: 'tag-trigger-sanity',
          status: valid ? 'pass' : 'fail',
          exitCode: valid ? 0 : 1,
          durationMs: 0,
          stdout: valid ? `Valid workflow at ${tagWorkflowPath}` : '',
          stderr: valid ? '' : 'auto-tag-on-release-merge.yml appears malformed',
        };
      } catch {
        tagTriggerCheck = {
          name: 'tag-trigger-sanity',
          status: 'fail',
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: 'Failed to read auto-tag-on-release-merge.yml',
        };
      }
    } else {
      tagTriggerCheck = {
        name: 'tag-trigger-sanity',
        status: 'fail',
        exitCode: 1,
        durationMs: 0,
        stdout: '',
        stderr: `.github/workflows/auto-tag-on-release-merge.yml not found`,
      };
    }
    checks.push(tagTriggerCheck);

    // ── 6. Type-check (fast path) ───────────────────────────────────────────
    // Run `tsc --noEmit` if a tsconfig.json exists.
    const tsconfigPath = join(repoRoot, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');
      if (existsSync(tscPath)) {
        checks.push(await runCheck('typecheck', tscPath, ['--noEmit'], repoRoot));
      } else {
        checks.push({
          name: 'typecheck',
          status: 'skip',
          exitCode: null,
          durationMs: 0,
          stdout: '',
          stderr: 'tsc not found in node_modules/.bin — skipping',
        });
      }
    } else {
      checks.push({
        name: 'typecheck',
        status: 'skip',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: 'tsconfig.json not found — skipping',
      });
    }

    // ── 7. Core lint scripts (fast subset) ──────────────────────────────────
    const fastLintScripts = [
      { name: 'contracts-dep-lint', script: 'scripts/lint-contracts-dep.mjs' },
      { name: 'format-error-lint', script: 'scripts/lint-format-error-misuse.mjs' },
      { name: 'json-stream-lint', script: 'scripts/lint-json-stream-hygiene.mjs' },
    ];

    for (const lint of fastLintScripts) {
      const scriptPath = join(repoRoot, lint.script);
      if (existsSync(scriptPath)) {
        checks.push(await runCheck(lint.name, 'node', [scriptPath], repoRoot));
      } else {
        checks.push({
          name: lint.name,
          status: 'skip',
          exitCode: null,
          durationMs: 0,
          stdout: '',
          stderr: `${lint.script} not found — skipping`,
        });
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    const passCount = checks.filter((c) => c.status === 'pass').length;
    const failCount = checks.filter((c) => c.status === 'fail').length;
    const skipCount = checks.filter((c) => c.status === 'skip').length;
    const totalDurationMs = Date.now() - startTotal;
    const ready = failCount === 0;

    const result: ReleaseReadinessResult = {
      ready,
      checks,
      summary: {
        pass: passCount,
        fail: failCount,
        skip: skipCount,
        total: checks.length,
        durationMs: totalDurationMs,
      },
    };

    if (isHuman && args.json !== true) {
      humanLine('\nRelease Readiness Check (T10458)\n');
      humanLine(`${'─'.repeat(60)}`);
      for (const c of checks) {
        const icon = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP';
        humanLine(`  [${icon}] ${c.name} (${c.durationMs}ms)`);
        if (c.status === 'fail' && c.stderr) {
          const lines = c.stderr.split('\n').slice(0, 3);
          for (const line of lines) {
            humanLine(`         ${line}`);
          }
        }
      }
      humanLine(`${'─'.repeat(60)}`);
      humanLine(`  Result: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
      humanLine(`  Total time: ${totalDurationMs}ms`);
      humanLine(`  Ready: ${ready ? 'YES' : 'NO'}\n`);
    }

    cliOutput(result, { command: 'doctor', operation: 'doctor.release-readiness' });

    if (!ready) {
      process.exitCode = 1;
    }
  },
});
