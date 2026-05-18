/**
 * GitHub Actions workflow scaffolder for `cleo init --workflows`.
 *
 * Renders the `*.yml.tmpl` templates shipped with `@cleocode/cleo` into a
 * consuming project's `.github/workflows/` directory. Placeholder
 * substitution draws from three sources, in precedence order:
 *
 *   1. `.cleo/release-config.json` — project-supplied overrides
 *      (`nodeVersion`, `releaseBranchPrefix`, `prLabel`, fanout/rollback
 *      knobs, etc.).
 *   2. ADR-061 tool resolver — `tool:install|lint|typecheck|test|build`
 *      resolution via `resolveToolCommand`, honouring
 *      `.cleo/project-context.json` plus per-`primaryType` defaults.
 *   3. Hard-coded fallbacks — `22.x` for Node, `release` for branch/label
 *      prefixes, the conventional pnpm-flavoured commands.
 *
 * For T9531 (Phase 3 of T9494) we ship the prepare scaffold only —
 * `release-prepare.yml.tmpl` → `.github/workflows/release-prepare.yml`.
 * T9536 will extend this primitive to walk the full four-template set
 * (`prepare` + `publish` + `fanout` + `rollback`) without further
 * scaffolder changes.
 *
 * Implementation notes:
 *
 *   - Substitution is deterministic regex `s/{{NAME}}/value/g` per
 *     `packages/cleo/templates/workflows/README.md` — no Mustache /
 *     Handlebars / nested templating. A re-render against the same
 *     inputs MUST produce a byte-identical output (idempotence).
 *   - Writes are atomic via tmp-then-rename so partial files cannot leak
 *     onto disk if the process crashes mid-write.
 *   - `force=true` audit-logs the overwrite event to
 *     `.cleo/audit/init-workflows.jsonl` so reviewers can prove a CI
 *     deviation was operator-initiated. Same convention as
 *     `force-bypass.jsonl` (ADR-039).
 *   - The scaffolder returns the rendered YAML in the result envelope
 *     even on `dryRun=true` — the CLI uses this for stdout preview.
 *
 * @module init/scaffold-workflows
 * @task T9531
 * @epic T9494
 * @adr ADR-061
 * @adr ADR-065
 */

import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveToolCommand } from '../tasks/tool-resolver.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Logical name of a renderable workflow template. The scaffolder reads
 * `<templatesDir>/<name>.yml.tmpl` and writes
 * `<projectRoot>/.github/workflows/<name>.yml`.
 *
 * For T9531 only `release-prepare` is wired. The other three names are
 * declared here so T9536 can extend the scaffolder by flipping the
 * default `templates` set without further type changes.
 */
export type WorkflowName =
  | 'release-prepare'
  | 'release-publish'
  | 'release-fanout'
  | 'release-rollback';

/**
 * The four canonical placeholder values resolved from
 * `.cleo/project-context.json` via ADR-061. Exposed for testability — the
 * unit test asserts against the resolved shape instead of recomputing it.
 */
export interface ResolvedToolPlaceholders {
  install: string;
  lint: string;
  typecheck: string;
  test: string;
  build: string;
}

/**
 * Inputs read from `.cleo/release-config.json` that influence
 * substitution. All fields are optional — missing fields fall back to
 * hard-coded defaults documented in
 * `packages/cleo/templates/workflows/README.md`.
 */
export interface ScaffoldReleaseConfig {
  /**
   * Override the package-install command. NOT part of the ADR-061 canonical
   * tool list (those are test/build/lint/typecheck/audit/security-scan), so
   * it falls through `.cleo/release-config.json` instead of the resolver.
   * Defaults to {@link DEFAULT_INSTALL_CMD}.
   */
  installCmd?: string;
  nodeVersion?: string;
  releaseBranchPrefix?: string;
  prLabel?: string;
  npmPublishCmd?: string;
  publishers?: string;
  fanout?: {
    docsBuildCmd?: string;
    docsDeploy?: boolean;
    dockerRetag?: boolean;
    sentinelNotify?: boolean;
    studioDeploy?: boolean;
    nightlyTrigger?: boolean;
    dockerImage?: string;
    dockerHubUser?: string;
    sentinelWebhookUrl?: string;
    studioDeployHook?: string;
  };
  rollback?: {
    npmPackages?: string;
    cargoCrates?: string;
  };
}

/**
 * Options for {@link scaffoldWorkflows}.
 */
export interface ScaffoldWorkflowsOptions {
  /**
   * Absolute path to the consuming project's root (NOT the cleocode
   * monorepo). Required — the scaffolder writes
   * `<projectRoot>/.github/workflows/*.yml`.
   */
  projectRoot: string;
  /**
   * Absolute path to the directory containing `*.yml.tmpl` files. In
   * normal usage the CLI resolves this against the `@cleocode/cleo`
   * package root. Exposed as an input so the unit test can point at a
   * fixture tree without depending on package layout.
   */
  templatesDir: string;
  /**
   * Which templates to render. Defaults to `['release-prepare']` for
   * T9531 (prepare-only scaffolder). T9536 flips this to all four.
   */
  templates?: ReadonlyArray<WorkflowName>;
  /**
   * `true` ⇒ skip the actual write. The rendered YAML is still returned
   * in the result envelope so the caller can pipe it to stdout. Idempotent
   * with `force=true`.
   */
  dryRun?: boolean;
  /**
   * `true` ⇒ overwrite an existing `<projectRoot>/.github/workflows/*.yml`
   * even when its content already differs from the rendered output.
   * Appends an audit-log row to `.cleo/audit/init-workflows.jsonl`.
   */
  force?: boolean;
  /**
   * Override the loaded release config — primarily for unit tests. When
   * omitted the scaffolder reads `<projectRoot>/.cleo/release-config.json`.
   */
  releaseConfigOverride?: ScaffoldReleaseConfig;
}

/**
 * Per-template scaffold outcome.
 */
export interface ScaffoldWorkflowOutcome {
  /** Which template was rendered. */
  template: WorkflowName;
  /** Absolute path to the destination workflow file. */
  targetPath: string;
  /** Rendered YAML contents (returned regardless of `dryRun`). */
  rendered: string;
  /**
   * Disposition of the write step:
   *   - `'created'`   — the destination did not exist; new file written.
   *   - `'updated'`   — destination existed with different content; rewritten
   *                     (requires `force=true`).
   *   - `'unchanged'` — destination existed with identical content; no-op.
   *   - `'skipped'`   — destination existed with different content but
   *                     `force=false`. No write occurred.
   *   - `'dry-run'`   — `dryRun=true`; no write attempted.
   */
  status: 'created' | 'updated' | 'unchanged' | 'skipped' | 'dry-run';
}

/**
 * Result envelope returned by {@link scaffoldWorkflows}.
 */
export interface ScaffoldWorkflowsResult {
  /** Per-template outcomes in the order they were rendered. */
  outcomes: ScaffoldWorkflowOutcome[];
  /** The resolved placeholder set (useful for surfacing in CLI output). */
  resolvedTools: ResolvedToolPlaceholders;
}

// ---------------------------------------------------------------------------
// Defaults & helpers
// ---------------------------------------------------------------------------

const DEFAULT_NODE_VERSION = '22.x' as const;
const DEFAULT_BRANCH_PREFIX = 'release' as const;
const DEFAULT_PR_LABEL = 'release' as const;
const DEFAULT_INSTALL_CMD = 'pnpm install --frozen-lockfile' as const;
const DEFAULT_LINT_CMD = 'pnpm run lint' as const;
const DEFAULT_TYPECHECK_CMD = 'pnpm run typecheck' as const;
const DEFAULT_TEST_CMD = 'pnpm run test' as const;
const DEFAULT_BUILD_CMD = 'pnpm run build' as const;
const DEFAULT_NPM_PUBLISH_CMD = 'pnpm publish --access public --tag latest' as const;
const DEFAULT_PUBLISHERS = 'npm' as const;
const DEFAULT_DOCS_BUILD_CMD = 'pnpm run docs:build' as const;

/**
 * Read `.cleo/release-config.json` from `<projectRoot>/.cleo/`. Returns
 * `{}` on parse failure or missing file — the scaffolder simply falls
 * through to language-default placeholder values in that case.
 *
 * Exposed as a separate function (instead of inlining) so tests can
 * supply an override via {@link ScaffoldWorkflowsOptions.releaseConfigOverride}
 * without touching the filesystem.
 *
 * @internal
 */
async function loadReleaseConfigJson(projectRoot: string): Promise<ScaffoldReleaseConfig> {
  const configPath = join(projectRoot, '.cleo', 'release-config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as ScaffoldReleaseConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolve a canonical ADR-061 tool to a single shell-line command string
 * suitable for substitution into a YAML `run:` step. Falls back to the
 * supplied default when the resolver reports the tool unavailable.
 *
 * @internal
 */
function resolveToolLine(
  canonical: 'test' | 'build' | 'lint' | 'typecheck',
  projectRoot: string,
  fallback: string,
): string {
  const result = resolveToolCommand(canonical, projectRoot);
  if (!result.ok) return fallback;
  const { cmd, args } = result.command;
  return args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
}

/**
 * Build the resolved placeholder set used by the substitution pass.
 *
 * The "install" tool is NOT part of the ADR-061 canonical tool list — it
 * comes from `release-config.json#installCmd` (when present) and
 * otherwise from {@link DEFAULT_INSTALL_CMD}. This mirrors the contract
 * stated in `packages/cleo/templates/workflows/README.md`.
 */
function resolvePlaceholders(
  projectRoot: string,
  cfg: ScaffoldReleaseConfig,
): ResolvedToolPlaceholders {
  return {
    install: cfg.installCmd ?? DEFAULT_INSTALL_CMD,
    lint: resolveToolLine('lint', projectRoot, DEFAULT_LINT_CMD),
    typecheck: resolveToolLine('typecheck', projectRoot, DEFAULT_TYPECHECK_CMD),
    test: resolveToolLine('test', projectRoot, DEFAULT_TEST_CMD),
    build: resolveToolLine('build', projectRoot, DEFAULT_BUILD_CMD),
  };
}

/**
 * Apply regex `s/{{NAME}}/value/g` substitutions in a single pass. The
 * Map keys are bare placeholder names (no surrounding braces); the
 * function brackets them. Unused placeholders left in the template are
 * preserved verbatim — the README guarantees that downstream tooling
 * (actionlint) will surface any leftover `{{...}}` tokens as YAML
 * errors.
 *
 * @internal
 */
function renderTemplate(template: string, substitutions: ReadonlyMap<string, string>): string {
  let out = template;
  for (const [name, value] of substitutions) {
    const pattern = new RegExp(`\\{\\{${name}\\}\\}`, 'g');
    out = out.replace(pattern, value);
  }
  return out;
}

/**
 * Construct the placeholder Map for the given template name. Each
 * template draws from the same vocabulary documented in
 * `packages/cleo/templates/workflows/README.md`; unused entries are
 * simply ignored (no replacement happens).
 *
 * @internal
 */
function buildSubstitutionMap(
  template: WorkflowName,
  cfg: ScaffoldReleaseConfig,
  tools: ResolvedToolPlaceholders,
): Map<string, string> {
  const subs = new Map<string, string>();

  // Common placeholders (used by prepare + publish + fanout + rollback).
  subs.set('NODE_VERSION', cfg.nodeVersion ?? DEFAULT_NODE_VERSION);
  subs.set('INSTALL_CMD', tools.install);
  subs.set('LINT_CMD', tools.lint);
  subs.set('TYPECHECK_CMD', tools.typecheck);
  subs.set('TEST_CMD', tools.test);
  subs.set('BUILD_CMD', tools.build);
  subs.set('BRANCH_PREFIX', cfg.releaseBranchPrefix ?? DEFAULT_BRANCH_PREFIX);
  subs.set('PR_LABEL', cfg.prLabel ?? DEFAULT_PR_LABEL);

  // Template-specific (publish/fanout/rollback): provided here so T9536's
  // multi-template scaffolder needs no further changes to this helper.
  if (template === 'release-publish' || template === 'release-rollback') {
    subs.set('NPM_PUBLISH_CMD', cfg.npmPublishCmd ?? DEFAULT_NPM_PUBLISH_CMD);
    subs.set('PUBLISHERS', cfg.publishers ?? DEFAULT_PUBLISHERS);
  }
  if (template === 'release-fanout') {
    subs.set('DOCS_BUILD_CMD', cfg.fanout?.docsBuildCmd ?? DEFAULT_DOCS_BUILD_CMD);
    subs.set('ENABLE_DOCS_DEPLOY', String(cfg.fanout?.docsDeploy ?? false));
    subs.set('ENABLE_DOCKER_RETAG', String(cfg.fanout?.dockerRetag ?? false));
    subs.set('ENABLE_SENTINEL_NOTIFY', String(cfg.fanout?.sentinelNotify ?? false));
    subs.set('ENABLE_STUDIO_DEPLOY', String(cfg.fanout?.studioDeploy ?? false));
    subs.set('ENABLE_NIGHTLY_TRIGGER', String(cfg.fanout?.nightlyTrigger ?? false));
    subs.set('DOCKER_IMAGE', cfg.fanout?.dockerImage ?? '');
    subs.set('DOCKER_HUB_USER', cfg.fanout?.dockerHubUser ?? '');
    subs.set('SENTINEL_WEBHOOK_URL', cfg.fanout?.sentinelWebhookUrl ?? '');
    subs.set('STUDIO_DEPLOY_HOOK', cfg.fanout?.studioDeployHook ?? '');
  }
  if (template === 'release-rollback') {
    subs.set('NPM_PACKAGES', cfg.rollback?.npmPackages ?? '');
    subs.set('CARGO_CRATES', cfg.rollback?.cargoCrates ?? '');
  }

  return subs;
}

/**
 * Atomic file write via tmp-then-rename. Creates the parent directory
 * if it does not exist (mirrors the convention from `gc/state.ts`).
 *
 * @internal
 */
async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, contents, 'utf-8');
  await rename(tmpPath, targetPath);
}

/**
 * Append an audit-log row to `.cleo/audit/init-workflows.jsonl`. Best-effort:
 * a failure to write the audit row MUST NOT prevent the scaffold operation
 * itself (the caller would otherwise have no way to recover).
 *
 * @internal
 */
async function appendAuditLog(
  projectRoot: string,
  row: {
    timestamp: string;
    operation: 'workflow-overwrite';
    template: WorkflowName;
    targetPath: string;
    reason: 'force';
  },
): Promise<void> {
  try {
    const auditDir = join(projectRoot, '.cleo', 'audit');
    await mkdir(auditDir, { recursive: true });
    const auditPath = join(auditDir, 'init-workflows.jsonl');
    await appendFile(auditPath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch {
    // Best-effort — the workflow scaffold is what matters.
  }
}

/**
 * Read a file if it exists; return `null` on `ENOENT`. Used to detect
 * idempotency (same content ⇒ `unchanged`).
 *
 * @internal
 */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Render and write the requested workflow templates.
 *
 * Default behaviour for T9531 is to render `release-prepare` only. Pass
 * `templates: ['release-prepare', 'release-publish', ...]` to extend.
 *
 * @example
 * ```ts
 * const result = await scaffoldWorkflows({
 *   projectRoot: '/path/to/my-project',
 *   templatesDir: '/path/to/@cleocode/cleo/templates/workflows',
 * });
 * for (const o of result.outcomes) {
 *   console.log(`${o.status}: ${o.targetPath}`);
 * }
 * ```
 *
 * @task T9531
 */
export async function scaffoldWorkflows(
  opts: ScaffoldWorkflowsOptions,
): Promise<ScaffoldWorkflowsResult> {
  const { projectRoot, templatesDir } = opts;
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const templates: ReadonlyArray<WorkflowName> =
    opts.templates && opts.templates.length > 0 ? opts.templates : ['release-prepare'];

  // 1. Inputs: release-config.json (override-aware) + ADR-061 resolved tools.
  const cfg =
    opts.releaseConfigOverride !== undefined
      ? opts.releaseConfigOverride
      : await loadReleaseConfigJson(projectRoot);
  const resolvedTools = resolvePlaceholders(projectRoot, cfg);

  // 2. Sanity-check the templates dir up front so a bad path produces a
  //    single clear error instead of N per-template ENOENTs.
  await stat(templatesDir); // throws if missing

  const outcomes: ScaffoldWorkflowOutcome[] = [];

  for (const name of templates) {
    const templatePath = join(templatesDir, `${name}.yml.tmpl`);
    const template = await readFile(templatePath, 'utf-8');
    const subs = buildSubstitutionMap(name, cfg, resolvedTools);
    const rendered = renderTemplate(template, subs);

    const targetPath = join(projectRoot, '.github', 'workflows', `${name}.yml`);

    if (dryRun) {
      outcomes.push({ template: name, targetPath, rendered, status: 'dry-run' });
      continue;
    }

    const existing = await readIfExists(targetPath);

    if (existing === null) {
      await atomicWriteFile(targetPath, rendered);
      outcomes.push({ template: name, targetPath, rendered, status: 'created' });
      continue;
    }

    if (existing === rendered) {
      outcomes.push({ template: name, targetPath, rendered, status: 'unchanged' });
      continue;
    }

    if (!force) {
      outcomes.push({ template: name, targetPath, rendered, status: 'skipped' });
      continue;
    }

    // force=true + content drift ⇒ overwrite + audit-log.
    await atomicWriteFile(targetPath, rendered);
    await appendAuditLog(projectRoot, {
      timestamp: new Date().toISOString(),
      operation: 'workflow-overwrite',
      template: name,
      targetPath,
      reason: 'force',
    });
    outcomes.push({ template: name, targetPath, rendered, status: 'updated' });
  }

  return { outcomes, resolvedTools };
}

/**
 * Enumerate the template files actually present in `templatesDir`. Used
 * by diagnostics surfaces (e.g. `cleo doctor`) — NOT used by the
 * scaffolder itself, which prefers the explicit
 * {@link ScaffoldWorkflowsOptions.templates} list so a bad input fails
 * deterministically.
 *
 * @task T9531
 */
export async function listAvailableWorkflowTemplates(
  templatesDir: string,
): Promise<WorkflowName[]> {
  const entries: Dirent[] = await readdir(templatesDir, { withFileTypes: true });
  const out: WorkflowName[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yml.tmpl')) continue;
    const stem = entry.name.replace(/\.yml\.tmpl$/, '');
    if (
      stem === 'release-prepare' ||
      stem === 'release-publish' ||
      stem === 'release-fanout' ||
      stem === 'release-rollback'
    ) {
      out.push(stem);
    }
  }
  return out;
}
