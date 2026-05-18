/**
 * Snapshot test for the release-rollback.yml.tmpl workflow template (T9535).
 *
 * Renders the template with a sample placeholder set and compares against a
 * checked-in snapshot at __snapshots__/release-rollback.yml.snap. If
 * `actionlint` is available on PATH, the rendered output is also fed through
 * actionlint to catch syntax errors that snapshot diffing alone misses.
 *
 * Asserts every SPEC-T9345-release-pipeline-v2.md §5.4 invariant:
 *   - R-250 trigger on `workflow_dispatch` only.
 *   - R-251 inputs `version` (string, required), `mode` (choice
 *           `metadata-only|full`, required), `reason` (string, required).
 *   - R-252 for `mode=full` the workflow surfaces `contents: write`,
 *           `pull-requests: write`, `packages: write` (per-job, not
 *           workflow-level).
 *   - R-253 four jobs in order: validate → revert → deprecate →
 *           reconcile-rollback.
 *   - R-254 revert job opens a revert PR via `gh pr create --label rollback`
 *           — MUST NOT push directly to `main` (ADR-065).
 *   - R-255 deprecate job runs `npm deprecate ...` per artifact and is
 *           `continue-on-error: true` (failure non-fatal).
 *   - R-256 reconcile-rollback invokes
 *           `cleo release reconcile <version> --rollback --reason "<reason>"`.
 *   - R-257 concurrency group rollback-<version>, cancel-in-progress=false.
 *   - R-260 actionlint clean.
 *   - R-262 defaults.run.shell: bash.
 *   - R-263 third-party Actions pinned to major+minor.
 *
 * @task T9535
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  'templates',
  'workflows',
  'release-rollback.yml.tmpl',
);

/**
 * Minimal template renderer for `{{UPPER_SNAKE_CASE}}` placeholders.
 *
 * Performs a single deterministic regex substitution pass. Mirrors what the
 * T9531 `cleo init --workflows` scaffolder is required to do — see
 * workflows/README.md "Template contract".
 *
 * @param template Raw template source.
 * @param values   Map from placeholder name (without braces) to substitution.
 * @returns Rendered string with all placeholders replaced.
 */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{([A-Z_]+)}}/g, (_match, name: string) => {
    if (!(name in values)) {
      throw new Error(`renderTemplate: missing value for {{${name}}}`);
    }
    return values[name]!;
  });
}

/**
 * Sample placeholder set used to render the snapshot. Mirrors what the
 * scaffolder would derive from a typical pnpm/Node monorepo via ADR-061 +
 * `.cleo/config.json` `release.rollback` overrides.
 */
const SAMPLE_VALUES: Record<string, string> = {
  NODE_VERSION: '22.x',
  PUBLISHERS: 'npm cargo',
  NPM_PACKAGES: '@cleocode/cleo @cleocode/core',
  CARGO_CRATES: 'cleo-core cleo-cli',
};

const JOB_NAMES = [
  'validate',
  'revert',
  'deprecate',
  'reconcile-rollback',
] as const;

describe('release-rollback.yml.tmpl', () => {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');

  // Strip comment lines (anything starting with #) to assert against the live
  // YAML body — doc-comments mentioning RFC2119 invariants don't trip
  // negative matches.
  const nonComment = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('contains every required placeholder', () => {
    const found = new Set<string>();
    for (const m of raw.matchAll(/{{([A-Z_]+)}}/g)) {
      found.add(m[1]!);
    }
    for (const key of Object.keys(SAMPLE_VALUES)) {
      expect(found, `expected placeholder {{${key}}} in template`).toContain(key);
    }
  });

  it('triggers on workflow_dispatch ONLY (R-250)', () => {
    // R-250: trigger is exactly `on: workflow_dispatch: ...` — no push,
    // release, pull_request, schedule, or repository_dispatch.
    expect(nonComment).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(nonComment).not.toMatch(/^\s*push:\s*$/m);
    expect(nonComment).not.toMatch(/^\s*pull_request:\s*$/m);
    expect(nonComment).not.toMatch(/^\s*release:\s*$/m);
    expect(nonComment).not.toMatch(/^\s*schedule:\s*$/m);
    expect(nonComment).not.toMatch(/^\s*repository_dispatch:\s*$/m);
  });

  it('declares required inputs version + mode (choice) + reason (R-251)', () => {
    // Slice the dispatch input block out of the trigger declaration.
    const dispatchMatch = nonComment.match(
      /on:\s*\n\s*workflow_dispatch:\s*\n\s*inputs:\s*\n([\s\S]+?)(?=\npermissions:|\nconcurrency:|\ndefaults:|\njobs:|\Z)/,
    );
    expect(dispatchMatch, 'workflow_dispatch.inputs block present').not.toBeNull();
    const inputs = dispatchMatch?.[1] ?? '';

    // R-251 input `version` (string, required).
    expect(inputs).toMatch(/\bversion:\s*\n[\s\S]+?type:\s*string[\s\S]+?required:\s*true/);

    // R-251 input `mode` (choice with metadata-only|full, required).
    expect(inputs).toMatch(/\bmode:\s*\n[\s\S]+?type:\s*choice/);
    expect(inputs).toMatch(/metadata-only/);
    expect(inputs).toMatch(/-\s*full\b/);
    expect(inputs).toMatch(/\bmode:\s*\n[\s\S]+?required:\s*true/);

    // R-251 input `reason` (string, required).
    expect(inputs).toMatch(/\breason:\s*\n[\s\S]+?type:\s*string[\s\S]+?required:\s*true/);
  });

  it('declares the permission surface from SPEC §5.4 (R-252)', () => {
    // Workflow-level permissions block contains contents:read ONLY.
    const workflowPermsMatch = nonComment.match(
      /^permissions:\s*\n((?:\s{2,}.+\n?)+)/m,
    );
    expect(workflowPermsMatch, 'workflow-level permissions block').not.toBeNull();
    const workflowPerms = workflowPermsMatch?.[1] ?? '';
    expect(workflowPerms).toMatch(/contents:\s*read/);
    // Negative: no top-level write scope of any kind.
    expect(workflowPerms).not.toMatch(/contents:\s*write/);
    expect(workflowPerms).not.toMatch(/packages:\s*write/);
    expect(workflowPerms).not.toMatch(/pull-requests:\s*write/);

    // Per-job: `revert` MUST have contents: write + pull-requests: write.
    const revertStart = nonComment.indexOf('revert:');
    const deprecateStart = nonComment.indexOf('deprecate:');
    expect(revertStart).toBeGreaterThan(-1);
    expect(deprecateStart).toBeGreaterThan(revertStart);
    const revertBody = nonComment.slice(revertStart, deprecateStart);
    expect(revertBody, 'revert job grants contents: write').toMatch(/contents:\s*write/);
    expect(revertBody, 'revert job grants pull-requests: write').toMatch(
      /pull-requests:\s*write/,
    );

    // Per-job: `deprecate` MUST have packages: write.
    const reconcileStart = nonComment.indexOf('reconcile-rollback:');
    expect(reconcileStart).toBeGreaterThan(deprecateStart);
    const deprecateBody = nonComment.slice(deprecateStart, reconcileStart);
    expect(deprecateBody, 'deprecate job grants packages: write').toMatch(
      /packages:\s*write/,
    );
  });

  it('declares 4 jobs in order: validate → revert → deprecate → reconcile-rollback (R-253)', () => {
    const indices = JOB_NAMES.map((name) => ({
      name,
      idx: nonComment.indexOf(`${name}:`),
    }));
    for (const { name, idx } of indices) {
      expect(idx, `expected job ${name} in template`).toBeGreaterThan(-1);
    }
    // Ordering: indices MUST be strictly ascending.
    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i]!.idx,
        `job ${indices[i]!.name} must appear after ${indices[i - 1]!.name}`,
      ).toBeGreaterThan(indices[i - 1]!.idx);
    }
  });

  it('threads needs: edges in the canonical order (R-253)', () => {
    // revert needs validate. deprecate needs validate. reconcile-rollback
    // needs at least validate (it MAY also `needs: revert` but the SPEC
    // pins the dependency on validate as the canonical edge).
    const revertStart = nonComment.indexOf('revert:');
    const deprecateStart = nonComment.indexOf('deprecate:');
    const reconcileStart = nonComment.indexOf('reconcile-rollback:');
    const revertBody = nonComment.slice(revertStart, deprecateStart);
    const deprecateBody = nonComment.slice(deprecateStart, reconcileStart);
    const reconcileBody = nonComment.slice(reconcileStart);

    expect(revertBody, 'revert needs validate').toMatch(/needs:\s*validate/);
    expect(deprecateBody, 'deprecate needs validate').toMatch(/needs:\s*validate/);
    expect(reconcileBody, 'reconcile-rollback needs validate').toMatch(
      /needs:\s*(?:validate|\n\s*-\s*validate\b|\[\s*[^\]]*\bvalidate\b)/,
    );
  });

  it('gates revert job on mode == full (R-254)', () => {
    const revertStart = nonComment.indexOf('revert:');
    const deprecateStart = nonComment.indexOf('deprecate:');
    const revertBody = nonComment.slice(revertStart, deprecateStart);
    expect(revertBody, "revert gates on inputs.mode == 'full'").toMatch(
      /if:\s*inputs\.mode\s*==\s*'full'/,
    );
  });

  it('revert job opens a revert PR via gh pr create — NEVER pushes to main (R-254 + ADR-065)', () => {
    const revertStart = nonComment.indexOf('revert:');
    const deprecateStart = nonComment.indexOf('deprecate:');
    const revertBody = nonComment.slice(revertStart, deprecateStart);

    // Creates a revert/<version> branch. The template assigns
    // BRANCH="revert/${VERSION}" then `git checkout -b "$BRANCH"`, so we
    // assert the BRANCH binding pattern AND the checkout invocation.
    expect(revertBody, 'binds BRANCH to revert/<version>').toMatch(
      /revert\/\$\{[A-Z_]*VERSION\}|revert\/\$\{\{\s*inputs\.version\s*\}\}/,
    );
    expect(revertBody, 'runs git checkout -b on the revert branch').toMatch(
      /git\s+checkout\s+-b\s+["']?(?:\$\{?BRANCH\}?|revert\/)/,
    );

    // Uses git revert (NOT git reset).
    expect(revertBody, 'uses git revert').toMatch(/git\s+revert/);
    expect(revertBody).not.toMatch(/git\s+reset\s+--hard/);

    // Pushes the revert branch (NOT origin main).
    expect(revertBody, 'pushes revert branch').toMatch(
      /git\s+push\s+(?:-u\s+)?origin\s+["']?(?:\$\{?BRANCH\}?|revert\/)/,
    );

    // Opens the PR with the rollback label.
    expect(revertBody, 'gh pr create with rollback label').toMatch(
      /gh\s+pr\s+create[\s\S]+?--label\s+rollback/,
    );

    // PR title MUST match `Revert release <version>: <reason>`. Allows
    // either env-style `${VERSION}` or shell-positional `${{ inputs.version }}`.
    expect(revertBody, 'PR title format').toMatch(
      /--title\s+["']Revert release \$\{[^}]+\}:\s*\$\{[^}]+\}["']/,
    );

    // Negative: ABSOLUTELY no `git push origin main` (ADR-065 hard rule).
    expect(revertBody, 'MUST NOT push to main directly (ADR-065)').not.toMatch(
      /git\s+push\s+origin\s+main\b/,
    );
    expect(revertBody, 'MUST NOT force-push to main (ADR-065)').not.toMatch(
      /git\s+push\s+--force[^\n]*\bmain\b/,
    );
  });

  it('deprecate job runs npm deprecate per artifact and is non-fatal (R-255)', () => {
    const deprecateStart = nonComment.indexOf('deprecate:');
    const reconcileStart = nonComment.indexOf('reconcile-rollback:');
    const deprecateBody = nonComment.slice(deprecateStart, reconcileStart);

    // Job-level continue-on-error: true.
    expect(deprecateBody, 'deprecate continue-on-error: true').toMatch(
      /continue-on-error:\s*true/,
    );

    // npm deprecate <pkg>@<version> "Rolled back: <reason>"
    expect(deprecateBody, 'runs npm deprecate with rollback message').toMatch(
      /npm\s+deprecate\s+["']\$[^"']+["']\s+["']Rolled back:\s*\$\{[^}]*REASON[^}]*\}["']/,
    );

    // Iterates over NPM_PACKAGES list.
    expect(deprecateBody, 'iterates NPM_PACKAGES env list').toMatch(
      /for\s+\w+\s+in\s+\$\{\s*NPM_PACKAGES\s*\}/,
    );
  });

  it('reconcile-rollback invokes cleo release reconcile --rollback --reason (R-256)', () => {
    const reconcileStart = nonComment.indexOf('reconcile-rollback:');
    const reconcileBody = nonComment.slice(reconcileStart);

    // The exact CLI invocation per R-256.
    expect(reconcileBody, 'invokes cleo release reconcile --rollback').toMatch(
      /cleo\s+release\s+reconcile\s+["']\$\{[^}]*VERSION\}["']\s+--rollback\s+--reason\s+["']\$\{[^}]*REASON\}["']/,
    );
  });

  it('enforces concurrency group rollback-<version> + cancel-in-progress=false (R-257)', () => {
    expect(raw).toMatch(/group:\s*rollback-\$\{\{\s*inputs\.version\s*\}\}/);
    expect(raw).toMatch(/cancel-in-progress:\s*false/);
  });

  it('sets defaults.run.shell: bash (R-262)', () => {
    expect(raw).toMatch(/defaults:\s*\n\s*run:\s*\n\s*shell:\s*bash/);
  });

  it('pins third-party Actions to major+minor (R-263)', () => {
    // Capture every `uses:` ref and assert no `@main`, `@master`, `@latest`,
    // or bare-major (`@v4` without a minor) reference slips in.
    const usesRefs = [...raw.matchAll(/uses:\s*([^\s\n]+)/g)].map((m) => m[1]!);
    expect(usesRefs.length).toBeGreaterThan(0);
    for (const ref of usesRefs) {
      expect(ref, `pinned third-party Action: ${ref}`).not.toMatch(/@(main|master|latest)$/);
      // Must be major+minor: `name@vX.Y` (e.g. `actions/checkout@v4.1`).
      expect(ref, `${ref} must pin to major+minor`).toMatch(/@v\d+\.\d+$/);
    }
  });

  it('declares timeout-minutes on every job', () => {
    // Every job MUST have a job-level timeout-minutes to bound stalls.
    for (let i = 0; i < JOB_NAMES.length; i++) {
      const jobName = JOB_NAMES[i]!;
      const start = nonComment.indexOf(`${jobName}:`);
      const nextName = JOB_NAMES[i + 1];
      const end = nextName ? nonComment.indexOf(`${nextName}:`) : nonComment.length;
      const body = nonComment.slice(start, end);
      expect(body, `${jobName} declares job-level timeout-minutes`).toMatch(
        /^\s{2,4}timeout-minutes:\s*\d+/m,
      );
    }
  });

  it('renders deterministically and matches the checked-in snapshot', async () => {
    const rendered = renderTemplate(raw, SAMPLE_VALUES);

    // No unsubstituted placeholders left.
    expect(rendered).not.toMatch(/{{[A-Z_]+}}/);

    // Rendered output has the sample values inlined where expected.
    expect(rendered).toContain("node-version: '22.x'");
    expect(rendered).toContain("PUBLISHERS: 'npm cargo'");
    expect(rendered).toContain("NPM_PACKAGES: '@cleocode/cleo @cleocode/core'");
    expect(rendered).toContain("CARGO_CRATES: 'cleo-core cleo-cli'");

    await expect(rendered).toMatchFileSnapshot(
      './__snapshots__/release-rollback.yml.snap',
    );
  });

  it('throws on missing placeholder values', () => {
    expect(() =>
      renderTemplate('hello {{UNKNOWN_KEY}}', { OTHER: 'x' }),
    ).toThrow(/UNKNOWN_KEY/);
  });
});

/**
 * Optional actionlint gate (R-260). Skipped when `actionlint` is not on
 * PATH so the test suite remains runnable in environments without it (e.g.
 * sparse worker pods). CI is responsible for installing actionlint and
 * exercising this code path — see SPEC AC-8.
 */
function hasActionlint(): boolean {
  try {
    execSync('command -v actionlint', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const ACTIONLINT_DESCRIBE = hasActionlint() ? describe : describe.skip;

ACTIONLINT_DESCRIBE('release-rollback.yml.tmpl actionlint gate', () => {
  it('passes actionlint on the rendered output', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    const rendered = renderTemplate(raw, SAMPLE_VALUES);
    // `actionlint -` reads from stdin.
    expect(() =>
      execSync('actionlint -', {
        input: rendered,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).not.toThrow();
  });
});
