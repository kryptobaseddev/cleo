/**
 * gh#1370 / T12187 — `release-prepare.yml` must not hand a summary envelope
 * downstream as if it were a release plan.
 *
 * The defect: the step ran `cleo release plan ... --json > "$PLAN_FILE"`, but
 * `release plan` does not print the plan — it WRITES the plan file itself and
 * prints a summary (version, taskCount, evidenceComplete, changelogWritten,
 * planPath; no `tasks`). Two writers therefore aimed at one path, and whichever
 * landed last became the artifact that `plan-blob-sha256` was computed over.
 *
 * These tests run the validator **extracted from the shipped workflow**, not a
 * copy of it. A checker that reads its own copy of the thing it checks cannot
 * catch the two drifting apart.
 *
 * @task T12187
 * @epic T12119 (E-CLI-OUTPUT-CONTRACT)
 * @see https://github.com/kryptobaseddev/cleo/issues/1370
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const WORKFLOW = '.github/workflows/release-prepare.yml';
const TEMPLATE = 'packages/core/templates/workflows/release-prepare.yml.tmpl';
const STEP_NAME = 'Resolve release plan';
const HEREDOC_OPEN = `cat > "$ASSERT_PLAN" <<'ASSERT_PLAN_EOF'`;
const HEREDOC_CLOSE = 'ASSERT_PLAN_EOF';

/** Read the `run:` body of the named step out of a workflow file. */
function readStepRun(path) {
  const doc = parseYaml(readFileSync(path, 'utf8'));
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.name === STEP_NAME) return step.run;
    }
  }
  throw new Error(`step ${STEP_NAME} not found in ${path}`);
}

/** Extract the validator program from the step's heredoc. */
function extractValidator(run) {
  const lines = run.split('\n');
  const open = lines.findIndex((l) => l.startsWith(HEREDOC_OPEN));
  if (open === -1) throw new Error('validator heredoc not found');
  const close = lines.findIndex((l, i) => i > open && l.trim() === HEREDOC_CLOSE);
  if (close === -1) throw new Error('validator heredoc not terminated');
  return lines.slice(open + 1, close).join('\n');
}

let dir;
let validatorPath;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh1370-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Materialise the validator lazily rather than in `beforeAll`.
 *
 * A throw in `beforeAll` SKIPS every test in the file, so against an unfixed
 * workflow the suite reported "8 skipped" — one generic failure instead of
 * seven specific ones. Extracting on first use lets each test fail on its own
 * assertion, which is what makes the failure legible.
 */
function getValidator() {
  if (!validatorPath) {
    validatorPath = join(dir, 'assert-release-plan.cjs');
    writeFileSync(validatorPath, extractValidator(readStepRun(WORKFLOW)), 'utf8');
  }
  return validatorPath;
}

/** Run the extracted validator against a fixture; return {code, output}. */
function check(name, contents) {
  const target = join(dir, `${name}.json`);
  writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  try {
    const stdout = execFileSync(process.execPath, [getValidator(), target], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('gh#1370 — the plan-shape assertion rejects what the redirect produced', () => {
  it('accepts a real plan', () => {
    const { code, output } = check('real-plan', {
      $schema: 'https://cleo.dev/release-plan.json',
      version: 'v2026.9.1',
      resolvedVersion: 'v2026.9.1',
      tasks: [{ id: 'T1' }, { id: 'T2' }],
    });
    expect(code).toBe(0);
    expect(output).toContain('plan OK: 2 tasks');
  });

  // The load-bearing case: this is the artifact the redirect actually left on
  // disk. It is valid JSON and hashes cleanly, so sha256 alone cannot see it.
  it('REJECTS the summary envelope that `release plan` prints on stdout', () => {
    const { code, output } = check('summary', {
      version: 'v2026.9.1',
      taskCount: 25,
      evidenceComplete: true,
      changelogWritten: true,
      planPath: '/x/.cleo/release/v2026.9.1.plan.json',
    });
    expect(code).toBe(1);
    expect(output).toContain('has no "tasks" array');
    expect(output).toContain('gh#1370');
  });

  // Measured 2026-09-13: stdout carried a Spawn Readiness banner ahead of the
  // envelope (gh#1368), so the redirected file did not even parse.
  it('REJECTS a prose-prefixed capture', () => {
    const { code, output } = check(
      'prose',
      `Spawn Readiness Check - 2026-09-13T15:33:22.134Z\n${'='.repeat(50)}\n{"success":true,"data":{"taskCount":25}}\n`,
    );
    expect(code).toBe(1);
    expect(output).toContain('is not valid JSON');
  });

  it('REJECTS a plan with an empty tasks array', () => {
    const { code, output } = check('empty', { resolvedVersion: 'v1', tasks: [] });
    expect(code).toBe(1);
    expect(output).toContain('EMPTY "tasks" array');
  });
});

describe('gh#1370 — the step no longer aims two writers at the plan path', () => {
  const run = () => readStepRun(WORKFLOW);

  it('does not redirect `cleo release plan` stdout onto the plan file', () => {
    expect(run()).not.toMatch(/cleo release plan[^\n]*>\s*"\$PLAN_FILE"/);
  });

  it('normalises the version the same way `normalizeVersion` does (leading v)', () => {
    // plan.ts `normalizeVersion` ADDS a leading `v`; every plan on disk is
    // `v<version>.plan.json`. Building the path from the raw input made a
    // dispatch of `2026.9.1` read a file the command never wrote.
    const body = run();
    expect(body).toContain('PLAN_VERSION="v$RAW_VERSION"');
    // Regexes rather than literals: the shell/Actions `${...}` forms trip
    // biome's noTemplateCurlyInString inside a plain JS string.
    expect(body).toMatch(/PLAN_FILE="\.cleo\/release\/\$\{PLAN_VERSION\}\.plan\.json"/);
    expect(body).not.toMatch(/PLAN_FILE="\.cleo\/release\/\$\{\{ inputs\.version \}\}/);
  });

  it('asserts the plan shape on BOTH the fresh-plan and sha-verify branches', () => {
    const occurrences = run().match(/node "\$ASSERT_PLAN" "\$PLAN_FILE"/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it('keeps the deployed workflow and the shipped template in step', () => {
    // The template is what `cleo init --workflows` gives every consuming
    // project, so a fix applied to only one of them ships the bug onward.
    expect(extractValidator(readStepRun(TEMPLATE))).toBe(extractValidator(readStepRun(WORKFLOW)));
  });
});
