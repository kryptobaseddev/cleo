/**
 * Snapshot test for the release-fanout.yml.tmpl workflow template (T9534).
 *
 * Renders the template with a sample placeholder set and compares against a
 * checked-in snapshot at __snapshots__/release-fanout.yml.snap. If
 * `actionlint` is available on PATH, the rendered output is also fed through
 * actionlint to catch syntax errors that snapshot diffing alone misses.
 *
 * Asserts every SPEC-T9345-release-pipeline-v2.md §5.3 invariant:
 *   - R-240 trigger on `release: published` only (NOT `release: created`).
 *   - R-241 contents:read + per-job pages:write only.
 *   - R-242 five independent best-effort jobs each `continue-on-error: true`.
 *   - R-243 concurrency group fanout-<tag>, cancel-in-progress=false.
 *   - R-244 fanout jobs are advisory (verified by absence of any
 *           required-checks marker — checked via per-job continue-on-error).
 *   - R-260 actionlint clean.
 *   - R-262 defaults.run.shell: bash.
 *   - R-263 third-party Actions pinned to major+minor.
 *
 * @task T9534
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
  'release-fanout.yml.tmpl',
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
 * `.cleo/config.json` `release.fanout` overrides.
 */
const SAMPLE_VALUES: Record<string, string> = {
  NODE_VERSION: '22.x',
  INSTALL_CMD: 'pnpm install --frozen-lockfile',
  DOCS_BUILD_CMD: 'pnpm --filter @cleocode/docs run build',
  ENABLE_DOCS_DEPLOY: 'true',
  ENABLE_DOCKER_RETAG: 'true',
  ENABLE_SENTINEL_NOTIFY: 'true',
  ENABLE_STUDIO_DEPLOY: 'true',
  ENABLE_NIGHTLY_TRIGGER: 'true',
  DOCKER_IMAGE: 'cleocode/cleo',
  DOCKER_HUB_USER: 'cleocode',
  SENTINEL_WEBHOOK_URL: 'https://sentinel.example.com/hooks/release',
  STUDIO_DEPLOY_HOOK: 'https://studio.example.com/deploy',
};

const FANOUT_JOB_NAMES = [
  'docs-deploy',
  'docker-retag',
  'sentinel-notify',
  'studio-deploy',
  'nightly-trigger',
] as const;

describe('release-fanout.yml.tmpl', () => {
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

  it('triggers on release: published ONLY, not release: created (R-240)', () => {
    // R-240: trigger is exactly `release: { types: [published] }`.
    expect(nonComment).toMatch(/on:\s*\n\s*release:\s*\n\s*types:\s*\[\s*published\s*\]/);
    // Negative: MUST NOT include `created` in the trigger types list.
    const triggerMatch = nonComment.match(/on:\s*\n\s*release:\s*\n\s*types:\s*\[([^\]]+)\]/);
    expect(triggerMatch, 'release trigger block present').not.toBeNull();
    const triggerTypes = triggerMatch?.[1] ?? '';
    expect(triggerTypes).not.toMatch(/\bcreated\b/);
    expect(triggerTypes).not.toMatch(/\bedited\b/);
    expect(triggerTypes).not.toMatch(/\bprereleased\b/);
  });

  it('declares the permission surface from SPEC §5.3 (R-241)', () => {
    // R-241: workflow-level permissions block contains contents:read ONLY.
    const workflowPermsMatch = nonComment.match(
      /^permissions:\s*\n((?:\s{2,}.+\n?)+)/m,
    );
    expect(workflowPermsMatch, 'workflow-level permissions block').not.toBeNull();
    const workflowPerms = workflowPermsMatch?.[1] ?? '';
    expect(workflowPerms).toMatch(/contents:\s*read/);
    // Negative: no top-level write scope of any kind.
    expect(workflowPerms).not.toMatch(/contents:\s*write/);
    expect(workflowPerms).not.toMatch(/packages:\s*write/);
    expect(workflowPerms).not.toMatch(/pages:\s*write/);

    // Per-job pages:write granted in docs-deploy ONLY.
    const docsDeployStart = nonComment.indexOf('docs-deploy:');
    const dockerRetagStart = nonComment.indexOf('docker-retag:');
    expect(docsDeployStart).toBeGreaterThan(-1);
    expect(dockerRetagStart).toBeGreaterThan(docsDeployStart);
    const docsDeployBody = nonComment.slice(docsDeployStart, dockerRetagStart);
    expect(docsDeployBody).toMatch(/pages:\s*write/);
    expect(docsDeployBody).toMatch(/id-token:\s*write/);
  });

  it('declares 5 best-effort fanout jobs (R-242)', () => {
    // R-242: jobs `docs-deploy`, `docker-retag`, `sentinel-notify`,
    // `studio-deploy`, `nightly-trigger`.
    for (const jobName of FANOUT_JOB_NAMES) {
      expect(nonComment, `expected job ${jobName} in template`).toMatch(
        new RegExp(`\\b${jobName}:\\s*\\n`),
      );
    }
  });

  it('marks EVERY fanout job continue-on-error: true (R-242)', () => {
    // Slice the template into per-job bodies and assert each carries
    // continue-on-error: true at the JOB level (not just step level).
    for (let i = 0; i < FANOUT_JOB_NAMES.length; i++) {
      const jobName = FANOUT_JOB_NAMES[i]!;
      const start = nonComment.indexOf(`${jobName}:`);
      expect(start, `${jobName} job declared`).toBeGreaterThan(-1);
      const nextName = FANOUT_JOB_NAMES[i + 1];
      const end = nextName ? nonComment.indexOf(`${nextName}:`) : nonComment.length;
      const body = nonComment.slice(start, end);
      expect(body, `${jobName} declares continue-on-error: true at job level`).toMatch(
        /continue-on-error:\s*true/,
      );
    }
  });

  it('declares timeout-minutes on every fanout job', () => {
    // Every job MUST have a job-level timeout-minutes to bound stalls.
    for (let i = 0; i < FANOUT_JOB_NAMES.length; i++) {
      const jobName = FANOUT_JOB_NAMES[i]!;
      const start = nonComment.indexOf(`${jobName}:`);
      const nextName = FANOUT_JOB_NAMES[i + 1];
      const end = nextName ? nonComment.indexOf(`${nextName}:`) : nonComment.length;
      const body = nonComment.slice(start, end);
      expect(body, `${jobName} declares job-level timeout-minutes`).toMatch(
        /^\s{2,4}timeout-minutes:\s*\d+/m,
      );
    }
  });

  it('gates every fanout job behind its ENABLE_* env toggle (R-242)', () => {
    // Each job hoists ENABLE_<JOB> into env and gates `if:` on
    // `env.ENABLE_<JOB> == 'true'`. The hoist matters for actionlint —
    // hard-coded `'true' == 'true'` is a constant-expression warning.
    const toggleByJob: Record<(typeof FANOUT_JOB_NAMES)[number], string> = {
      'docs-deploy': 'ENABLE_DOCS_DEPLOY',
      'docker-retag': 'ENABLE_DOCKER_RETAG',
      'sentinel-notify': 'ENABLE_SENTINEL_NOTIFY',
      'studio-deploy': 'ENABLE_STUDIO_DEPLOY',
      'nightly-trigger': 'ENABLE_NIGHTLY_TRIGGER',
    };
    for (let i = 0; i < FANOUT_JOB_NAMES.length; i++) {
      const jobName = FANOUT_JOB_NAMES[i]!;
      const toggle = toggleByJob[jobName];
      const start = nonComment.indexOf(`${jobName}:`);
      const nextName = FANOUT_JOB_NAMES[i + 1];
      const end = nextName ? nonComment.indexOf(`${nextName}:`) : nonComment.length;
      const body = nonComment.slice(start, end);
      // Hoisted into env.
      expect(body, `${jobName} hoists ${toggle} into env`).toMatch(
        new RegExp(`${toggle}:\\s*'\\{\\{${toggle}\\}\\}'`),
      );
      // if: env.ENABLE_* == 'true'
      expect(body, `${jobName} gates if: on env.${toggle}`).toMatch(
        new RegExp(`if:\\s*\\$\\{\\{\\s*env\\.${toggle}\\s*==\\s*'true'\\s*\\}\\}`),
      );
    }
  });

  it('enforces concurrency group fanout-<tag> + cancel-in-progress=false (R-243)', () => {
    expect(raw).toMatch(
      /group:\s*fanout-\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/,
    );
    expect(raw).toMatch(/cancel-in-progress:\s*false/);
  });

  it('keeps fanout jobs advisory — no required-checks marker (R-244)', () => {
    // R-244 is enforced at the BRANCH PROTECTION layer, not the workflow YAML.
    // The workflow-side signal that a job is advisory is the combination of:
    //   - continue-on-error: true on the job
    //   - no `needs:` edge from a downstream gate
    // We verify both:
    //   (a) every fanout job has continue-on-error: true (covered above)
    //   (b) no fanout job is referenced by `needs:` of any other job.
    for (const jobName of FANOUT_JOB_NAMES) {
      const needsPattern = new RegExp(
        `needs:\\s*(?:${jobName}|\\[\\s*[^\\]]*\\b${jobName}\\b[^\\]]*\\]|(?:-\\s*\\S+\\s*\\n)*\\s*-\\s*${jobName}\\b)`,
      );
      expect(raw, `${jobName} MUST NOT be in any needs: edge (R-244)`).not.toMatch(
        needsPattern,
      );
    }
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

  it('renders deterministically and matches the checked-in snapshot', async () => {
    const rendered = renderTemplate(raw, SAMPLE_VALUES);

    // No unsubstituted placeholders left.
    expect(rendered).not.toMatch(/{{[A-Z_]+}}/);

    // Rendered output has the sample values inlined where expected.
    expect(rendered).toContain("node-version: '22.x'");
    expect(rendered).toContain('pnpm install --frozen-lockfile');
    expect(rendered).toContain('pnpm --filter @cleocode/docs run build');
    expect(rendered).toContain("ENABLE_DOCS_DEPLOY: 'true'");
    expect(rendered).toContain("DOCKER_IMAGE: 'cleocode/cleo'");
    expect(rendered).toContain("DOCKER_HUB_USER: 'cleocode'");
    expect(rendered).toContain("SENTINEL_WEBHOOK_URL: 'https://sentinel.example.com/hooks/release'");
    expect(rendered).toContain("STUDIO_DEPLOY_HOOK: 'https://studio.example.com/deploy'");

    await expect(rendered).toMatchFileSnapshot(
      './__snapshots__/release-fanout.yml.snap',
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

ACTIONLINT_DESCRIBE('release-fanout.yml.tmpl actionlint gate', () => {
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
