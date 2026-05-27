/**
 * Workflow upgrade primitive — `cleo upgrade workflows`.
 *
 * Phase 4 of T9497 (parent epic) and T9536. Re-renders every shipped
 * workflow template against current `.cleo/release-config.json` +
 * ADR-061 tool-resolver state, compares the rendered YAML against the
 * existing `.github/workflows/release-*.yml` files, and reports a
 * per-template `UpgradeWorkflowOutcome` envelope. An optional
 * `.workflow-overrides.yml` file (if present at the project root)
 * carries operator-declared customizations the upgrade MUST respect so
 * a re-render does not silently clobber hand-tuned env vars or step
 * additions.
 *
 * The first iteration of the 3-way merge is intentionally SIMPLE:
 *
 *   - If `rendered === existing`              ⇒ `unchanged`.
 *   - If `existing === null`                  ⇒ `missing` (drift; the user
 *                                                 needs to re-run
 *                                                 `cleo init --workflows`).
 *   - If `rendered !== existing` AND an override key matches the
 *     template name in `.workflow-overrides.yml`        ⇒ `override-kept`
 *                                                 (we report drift but
 *                                                 do NOT recommend
 *                                                 overwrite — the operator
 *                                                 owns the file).
 *   - If `rendered !== existing` AND no override applies ⇒ `drift-detected`
 *                                                 (caller decides
 *                                                 `force` or `skip`).
 *
 * Full deep-merge of override paths into the rendered template is
 * deferred — the v1 contract is drift-detection plus a copy of the
 * rendered output for diff display. The caller (`cleo upgrade
 * workflows`) consumes this envelope to:
 *
 *   - Print a per-file status table.
 *   - With `--dry-run`: emit the diff and exit 0.
 *   - With `--check`:   exit 0 if every outcome is `unchanged` /
 *                       `override-kept`; exit 1 otherwise.
 *   - With `--force`:   re-write the file in-place (audit-logged).
 *
 * Writes are atomic via tmp-then-rename — exactly the convention
 * {@link scaffoldWorkflows} already uses (DRY across the init/upgrade
 * pair).
 *
 * @module init/upgrade-workflows
 * @task T9536
 * @epic T9497
 * @adr ADR-061
 * @adr ADR-065
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveToolCommand } from '../tasks/tool-resolver.js';
import type {
  ResolvedToolPlaceholders,
  ScaffoldReleaseConfig,
  WorkflowName,
} from './scaffold-workflows.js';
import { DEFAULT_WORKFLOW_TEMPLATES } from './scaffold-workflows.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-template upgrade outcome status.
 *
 *  - `unchanged`      — rendered output matches the file already on disk.
 *  - `missing`        — `.github/workflows/<name>.yml` is absent. The
 *                       operator likely never ran `cleo init --workflows`
 *                       (or deleted the file). Run init to bootstrap.
 *  - `override-kept`  — content drift detected, BUT a key matching the
 *                       template name exists in `.workflow-overrides.yml`.
 *                       The drift is operator-declared; the on-disk file
 *                       is preserved verbatim.
 *  - `drift-detected` — content drift detected and NO override applies.
 *                       Without `force=true`, the file is preserved
 *                       verbatim (caller decides next step).
 *  - `updated`        — `force=true` was passed and the file was
 *                       overwritten with the rendered output. An audit
 *                       row landed in `.cleo/audit/upgrade-workflows.jsonl`.
 *  - `dry-run`        — `dryRun=true`; the rendered YAML is in the
 *                       envelope but no write occurred.
 */
export type UpgradeWorkflowStatus =
  | 'unchanged'
  | 'missing'
  | 'override-kept'
  | 'drift-detected'
  | 'updated'
  | 'dry-run';

/**
 * Per-template upgrade outcome.
 *
 * `rendered` always carries the freshly rendered YAML so the CLI can
 * surface a diff against `existing` (when present) regardless of
 * `status`. `existing` is `null` only when `status === 'missing'`.
 */
export interface UpgradeWorkflowOutcome {
  /** Which template was re-rendered. */
  template: WorkflowName;
  /** Absolute path to the workflow file on disk. */
  targetPath: string;
  /** Freshly rendered YAML (output of {@link scaffoldWorkflows}-style render). */
  rendered: string;
  /** The on-disk file at `targetPath`, or `null` when the file is missing. */
  existing: string | null;
  /** Disposition — see {@link UpgradeWorkflowStatus} for semantics. */
  status: UpgradeWorkflowStatus;
  /**
   * `true` iff `.workflow-overrides.yml` carries a top-level key that
   * matches `template`. Surfaced in the envelope so the CLI can show
   * "operator override declared" in the status table even when
   * `status === 'unchanged'`.
   */
  overrideDeclared: boolean;
}

/**
 * Options for {@link upgradeWorkflows}.
 */
export interface UpgradeWorkflowsOptions {
  /**
   * Absolute path to the consuming project's root.
   */
  projectRoot: string;
  /**
   * Absolute path to the directory containing the `*.yml.tmpl` files —
   * usually the `templates/workflows/` directory of an installed
   * `@cleocode/core` package. Exposed as an option so tests can point at
   * a fixture tree.
   */
  templatesDir: string;
  /**
   * Which templates to inspect. Defaults to the full four-template set
   * declared in {@link DEFAULT_WORKFLOW_TEMPLATES}.
   */
  templates?: ReadonlyArray<WorkflowName>;
  /**
   * `true` ⇒ overwrite `.github/workflows/<name>.yml` even when content
   * drifts. Audited to `.cleo/audit/upgrade-workflows.jsonl`. Ignored
   * when `dryRun=true`.
   */
  force?: boolean;
  /**
   * `true` ⇒ skip the actual write. Every outcome reports `dry-run`
   * regardless of drift; the rendered YAML stays in the envelope so the
   * CLI can show a diff.
   */
  dryRun?: boolean;
  /**
   * Override the loaded release config — primarily for unit tests.
   * When omitted the helper reads `<projectRoot>/.cleo/release-config.json`.
   */
  releaseConfigOverride?: ScaffoldReleaseConfig;
  /**
   * Override the parsed `.workflow-overrides.yml` body — primarily for
   * unit tests. When omitted the helper reads
   * `<projectRoot>/.workflow-overrides.yml` (best-effort; parse failure
   * is treated as "no overrides declared").
   */
  overridesOverride?: WorkflowOverrides;
}

/**
 * Top-level shape of `.workflow-overrides.yml`. Each top-level key
 * names one of the four canonical templates; the value is treated as an
 * opaque "operator-declared customization" — the v1 contract only
 * checks for KEY presence, not value structure.
 */
export type WorkflowOverrides = Partial<Record<WorkflowName, unknown>>;

/**
 * Result envelope returned by {@link upgradeWorkflows}.
 */
export interface UpgradeWorkflowsResult {
  /** Per-template outcomes in the order they were inspected. */
  outcomes: UpgradeWorkflowOutcome[];
  /** The placeholder set used by the substitution pass. */
  resolvedTools: ResolvedToolPlaceholders;
  /**
   * `true` iff at least one outcome reports `drift-detected` or
   * `missing`. Designed to drive the `--check` exit-code contract:
   * `cleo upgrade workflows --check` exits 1 when this is `true` and
   * 0 otherwise.
   */
  hasDrift: boolean;
}

// ---------------------------------------------------------------------------
// Defaults & helpers (DRY with scaffold-workflows.ts — same conventions)
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
 * `{}` on parse failure or missing file. Mirrors the helper in
 * {@link scaffoldWorkflows} so the rendered output is byte-equal across
 * the init/upgrade pair.
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
 * Best-effort load of `.workflow-overrides.yml`. The v1 contract only
 * needs the top-level key set — we extract template names with a
 * surface-level regex so this helper does NOT pull a YAML parser into
 * `@cleocode/core` for one feature. Missing file or parse failure ⇒
 * empty overrides object.
 *
 * @internal
 */
async function loadOverridesYaml(projectRoot: string): Promise<WorkflowOverrides> {
  const overridesPath = join(projectRoot, '.workflow-overrides.yml');
  try {
    const raw = await readFile(overridesPath, 'utf-8');
    return parseOverridesYamlBody(raw);
  } catch {
    return {};
  }
}

/**
 * Parse the body of `.workflow-overrides.yml` and return a
 * {@link WorkflowOverrides} record keyed by template name. The parser
 * is deliberately minimal — it scans for top-level keys matching the
 * four canonical workflow names and records `true` for each. Nested
 * structure is ignored (the v1 contract only checks for KEY presence).
 *
 * Exposed for testability — callers should generally use
 * {@link loadOverridesYaml}.
 *
 * @internal
 */
export function parseOverridesYamlBody(body: string): WorkflowOverrides {
  const out: WorkflowOverrides = {};
  // Top-level keys are non-indented YAML mapping keys: `^name:` on a
  // fresh line, optionally followed by whitespace/comment. We deliberately
  // ignore everything beneath a key.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (
      key === 'release-prepare' ||
      key === 'release-publish' ||
      key === 'release-fanout' ||
      key === 'release-rollback'
    ) {
      out[key] = true;
    }
  }
  return out;
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
 * @internal
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
 * Apply regex `s/{{NAME}}/value/g` substitutions in a single pass.
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
 * Construct the placeholder Map for the given template. Mirrors the
 * implementation in `scaffold-workflows.ts` — the two surfaces MUST
 * produce byte-equal output for the same inputs.
 *
 * @internal
 */
function buildSubstitutionMap(
  template: WorkflowName,
  cfg: ScaffoldReleaseConfig,
  tools: ResolvedToolPlaceholders,
): Map<string, string> {
  const subs = new Map<string, string>();
  subs.set('NODE_VERSION', cfg.nodeVersion ?? DEFAULT_NODE_VERSION);
  subs.set('INSTALL_CMD', tools.install);
  subs.set('LINT_CMD', tools.lint);
  subs.set('TYPECHECK_CMD', tools.typecheck);
  subs.set('TEST_CMD', tools.test);
  subs.set('BUILD_CMD', tools.build);
  subs.set('BRANCH_PREFIX', cfg.releaseBranchPrefix ?? DEFAULT_BRANCH_PREFIX);
  subs.set('PR_LABEL', cfg.prLabel ?? DEFAULT_PR_LABEL);

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
 * if missing — same convention as `scaffold-workflows.ts`.
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
 * Append an audit-log row to `.cleo/audit/upgrade-workflows.jsonl`.
 * Best-effort — a failure to write the audit row MUST NOT prevent the
 * upgrade itself.
 *
 * @internal
 */
async function appendAuditLog(
  projectRoot: string,
  row: {
    timestamp: string;
    operation: 'workflow-upgrade';
    template: WorkflowName;
    targetPath: string;
    reason: 'force' | 'drift-detected';
    previousStatus: UpgradeWorkflowStatus;
  },
): Promise<void> {
  try {
    const auditDir = join(projectRoot, '.cleo', 'audit');
    await mkdir(auditDir, { recursive: true });
    const auditPath = join(auditDir, 'upgrade-workflows.jsonl');
    await appendFile(auditPath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch {
    // Best-effort.
  }
}

/**
 * Read a file if it exists; return `null` on `ENOENT`.
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

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Re-render every shipped workflow template and report drift against
 * the on-disk `.github/workflows/release-*.yml` files. Honours
 * `.workflow-overrides.yml` for operator-declared customizations.
 *
 * See the module docstring for the full 3-way merge contract.
 *
 * @example
 * ```ts
 * // --check semantics — exit 1 when any drift is detected.
 * const result = await upgradeWorkflows({
 *   projectRoot: '/path/to/my-project',
 *   templatesDir: '/path/to/@cleocode/core/templates/workflows',
 * });
 * if (result.hasDrift) process.exit(1);
 * ```
 *
 * @task T9536
 */
export async function upgradeWorkflows(
  opts: UpgradeWorkflowsOptions,
): Promise<UpgradeWorkflowsResult> {
  const { projectRoot, templatesDir } = opts;
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const templates: ReadonlyArray<WorkflowName> =
    opts.templates && opts.templates.length > 0 ? opts.templates : DEFAULT_WORKFLOW_TEMPLATES;

  // 1. Inputs.
  const cfg =
    opts.releaseConfigOverride !== undefined
      ? opts.releaseConfigOverride
      : await loadReleaseConfigJson(projectRoot);
  const overrides =
    opts.overridesOverride !== undefined
      ? opts.overridesOverride
      : await loadOverridesYaml(projectRoot);
  const resolvedTools = resolvePlaceholders(projectRoot, cfg);

  // 2. Sanity-check the templates dir up front.
  await stat(templatesDir);

  const outcomes: UpgradeWorkflowOutcome[] = [];
  let hasDrift = false;

  for (const name of templates) {
    const templatePath = join(templatesDir, `${name}.yml.tmpl`);
    const template = await readFile(templatePath, 'utf-8');
    const subs = buildSubstitutionMap(name, cfg, resolvedTools);
    const rendered = renderTemplate(template, subs);

    const targetPath = join(projectRoot, '.github', 'workflows', `${name}.yml`);
    const existing = await readIfExists(targetPath);
    const overrideDeclared = Object.hasOwn(overrides, name);

    // Dry-run short-circuit: never write, never compute drift bookkeeping.
    if (dryRun) {
      outcomes.push({
        template: name,
        targetPath,
        rendered,
        existing,
        status: 'dry-run',
        overrideDeclared,
      });
      continue;
    }

    if (existing === null) {
      hasDrift = true;
      outcomes.push({
        template: name,
        targetPath,
        rendered,
        existing,
        status: 'missing',
        overrideDeclared,
      });
      continue;
    }

    if (existing === rendered) {
      outcomes.push({
        template: name,
        targetPath,
        rendered,
        existing,
        status: 'unchanged',
        overrideDeclared,
      });
      continue;
    }

    // Drift detected.
    if (overrideDeclared) {
      // Operator owns the file — do not flip hasDrift. The override is
      // declared intent and the CLI should treat this as "current".
      outcomes.push({
        template: name,
        targetPath,
        rendered,
        existing,
        status: 'override-kept',
        overrideDeclared,
      });
      continue;
    }

    if (!force) {
      hasDrift = true;
      outcomes.push({
        template: name,
        targetPath,
        rendered,
        existing,
        status: 'drift-detected',
        overrideDeclared,
      });
      continue;
    }

    // force=true + drift + no override ⇒ overwrite + audit.
    await atomicWriteFile(targetPath, rendered);
    await appendAuditLog(projectRoot, {
      timestamp: new Date().toISOString(),
      operation: 'workflow-upgrade',
      template: name,
      targetPath,
      reason: 'force',
      previousStatus: 'drift-detected',
    });
    outcomes.push({
      template: name,
      targetPath,
      rendered,
      existing,
      status: 'updated',
      overrideDeclared,
    });
  }

  return { outcomes, resolvedTools, hasDrift };
}
