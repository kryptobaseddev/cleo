/**
 * TemplateManifest contract — SSoT for every template CLEO ships, installs,
 * or rewrites during `cleo init` / `cleo upgrade` / `cleo scaffold-*`.
 *
 * A {@link TemplateManifestEntry} declares one template file: where its
 * source lives in the monorepo, where it installs into a consumer project,
 * how its placeholders are substituted, which placeholders it accepts, and
 * how it MUST be reconciled when the shipped version moves ahead of the
 * deployed copy.
 *
 * This contract is the leaf type. The CORE-side template registry
 * (T9877) consumes it; the CLI verbs (`cleo init --workflows`,
 * `cleo upgrade`, the scaffold sweeper) read the manifest at runtime to
 * decide what to write, what to skip, and what to diff-prompt the user on.
 *
 * @example minimal workflow template entry
 * ```ts
 * import { TemplateManifestEntrySchema, type TemplateManifestEntry } from '@cleocode/contracts';
 *
 * const entry: TemplateManifestEntry = TemplateManifestEntrySchema.parse({
 *   id: 'ci.yml',
 *   kind: 'workflow',
 *   sourcePath: 'packages/core/templates/workflows/ci.yml.tmpl',
 *   installPath: '.github/workflows/ci.yml',
 *   substitution: 'regex-tmpl',
 *   placeholders: [
 *     {
 *       name: 'NODE_VERSION',
 *       source: 'project-context',
 *       sourcePath: 'engines.node',
 *       defaultValue: 24,
 *     },
 *   ],
 *   updateStrategy: 'overwrite-on-bump',
 * });
 * ```
 *
 * @task T9875
 * @epic T9874
 * @saga T9855
 * @see ADR-076 (canonical doc routing — same boundary discipline applies here)
 */

import { z } from 'zod';

// ─── TemplateKind ─────────────────────────────────────────────────────────────

/**
 * Allowed categories of template the manifest can describe.
 *
 * - `workflow`  — GitHub Actions / CI workflow files.
 * - `config`    — Configuration files (e.g. `.editorconfig`, `tsconfig.json`).
 * - `agent`     — Agent definition files shipped to `.claude/agents/` etc.
 * - `skill`     — Skill markdown shipped to `.claude/skills/` etc.
 * - `provider`  — Provider-specific bootstrap files (Anthropic, OpenAI, …).
 * - `doc`       — Documentation scaffolds (e.g. README.md, AGENTS.md).
 */
export const TEMPLATE_KINDS = ['workflow', 'config', 'agent', 'skill', 'provider', 'doc'] as const;

/** Discriminator for the category of file a template represents. */
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

// ─── TemplateSubstitution ─────────────────────────────────────────────────────

/**
 * Allowed substitution strategies a template can request.
 *
 * - `regex-tmpl` — `{{KEY}}` placeholder substitution via regex.
 * - `static`     — No substitution; the file is copied byte-for-byte.
 * - `json-merge` — The template is parsed as JSON and merged into any
 *                  existing JSON file at `installPath`; placeholders inside
 *                  string values still go through `regex-tmpl`.
 */
export const TEMPLATE_SUBSTITUTIONS = ['regex-tmpl', 'static', 'json-merge'] as const;

/** Strategy the installer uses to materialize a template's `sourcePath`. */
export type TemplateSubstitution = (typeof TEMPLATE_SUBSTITUTIONS)[number];

// ─── UpdateStrategy ───────────────────────────────────────────────────────────

/**
 * How an installed template is reconciled with the shipped copy on
 * `cleo upgrade` / `cleo init --force`.
 *
 * - `overwrite-on-bump` — Always overwrite when the manifest version is
 *                        newer than the deployed copy.
 * - `diff-prompt`       — Show a diff and ask the user before overwriting.
 * - `immutable`         — Never overwrite once installed.
 * - `manifest-merge`    — Apply structural merge (e.g. JSON deep-merge,
 *                        respecting existing user keys).
 */
export const TEMPLATE_UPDATE_STRATEGIES = [
  'overwrite-on-bump',
  'diff-prompt',
  'immutable',
  'manifest-merge',
] as const;

/** Reconciliation policy for an installed template on upgrade. */
export type UpdateStrategy = (typeof TEMPLATE_UPDATE_STRATEGIES)[number];

// ─── PlaceholderSpec ──────────────────────────────────────────────────────────

/**
 * Allowed resolver sources a {@link PlaceholderSpec} can reference.
 *
 * - `project-context` — `.cleo/project-context.json` (detected ecosystem hints).
 * - `project-info`    — `.cleo/project-info.json` (per-project metadata).
 * - `.cleo/config`    — Per-project config (`<projectRoot>/.cleo/config.json`).
 * - `~/.cleo/config`  — User-global config (`$XDG_CONFIG_HOME/cleo/config.json`).
 * - `tool-resolver`   — Resolved via the per-language tool resolver
 *                       (e.g. `pnpm` vs `npm` chosen by `primaryType`).
 * - `literal`         — Hard-coded value baked into the manifest entry.
 */
export const PLACEHOLDER_SOURCES = [
  'project-context',
  'project-info',
  '.cleo/config',
  '~/.cleo/config',
  'tool-resolver',
  'literal',
] as const;

/** Resolver source enum for {@link PlaceholderSpec.source}. */
export type PlaceholderSource = (typeof PLACEHOLDER_SOURCES)[number];

/**
 * Zod schema for a single placeholder declaration on a template entry.
 *
 * Each placeholder is resolved at install time by reading `sourcePath` from
 * the named `source`. If resolution returns `undefined`, the installer
 * falls back to `defaultValue`; if neither yields a value, installation
 * fails with `E_PLACEHOLDER_UNRESOLVED`.
 */
export const PlaceholderSpecSchema = z.object({
  /**
   * Placeholder identifier as it appears in the template body
   * (e.g. `NODE_VERSION` matches `{{NODE_VERSION}}`).
   */
  name: z.string().min(1, 'placeholder name must be non-empty'),
  /** Resolver source the installer consults for this placeholder. */
  source: z.enum(PLACEHOLDER_SOURCES),
  /**
   * Path expression evaluated against `source` (e.g. `engines.node` against
   * `project-context`, `defaults.branchModel` against `.cleo/config`).
   * For `literal` source, this MAY be the literal value's identifier.
   */
  sourcePath: z.string().min(1, 'placeholder sourcePath must be non-empty'),
  /**
   * Fallback value used when `source[sourcePath]` resolves to `undefined`.
   * `null` is permitted to explicitly mark "no default — failure required".
   */
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

/**
 * Zod-inferred input shape for a placeholder declaration.
 *
 * Identical to {@link PlaceholderSpec} — there are no schema transforms.
 */
export type PlaceholderSpecInput = z.infer<typeof PlaceholderSpecSchema>;

/** Declared placeholder on a {@link TemplateManifestEntry}. */
export type PlaceholderSpec = PlaceholderSpecInput;

// ─── TemplateManifestEntry ────────────────────────────────────────────────────

/**
 * Zod schema for a single template manifest entry.
 *
 * Validates the full descriptor a template registry consumer needs to
 * install a template file:
 *
 * - `id`             — Stable identifier (kebab-case, matches install basename
 *                      or a domain-unique slug).
 * - `kind`           — One of {@link TEMPLATE_KINDS}.
 * - `sourcePath`     — Repo-relative path of the template source.
 * - `installPath`    — Project-relative path where the rendered file lands.
 * - `substitution`   — One of {@link TEMPLATE_SUBSTITUTIONS}.
 * - `placeholders`   — Declared placeholders the installer must resolve.
 * - `updateStrategy` — Reconciliation policy on upgrade.
 */
export const TemplateManifestEntrySchema = z.object({
  /** Stable identifier for this template entry. */
  id: z.string().min(1, 'id must be non-empty'),
  /** Category of file this template represents. */
  kind: z.enum(TEMPLATE_KINDS),
  /** Repo-relative path of the template source file. */
  sourcePath: z.string().min(1, 'sourcePath must be non-empty'),
  /** Project-relative path where the rendered template installs. */
  installPath: z.string().min(1, 'installPath must be non-empty'),
  /** Substitution strategy the installer applies to `sourcePath`. */
  substitution: z.enum(TEMPLATE_SUBSTITUTIONS),
  /** Declared placeholders this template requires. May be empty. */
  placeholders: z.array(PlaceholderSpecSchema),
  /** Reconciliation policy on upgrade. */
  updateStrategy: z.enum(TEMPLATE_UPDATE_STRATEGIES),
});

/**
 * Zod-inferred input shape for a template manifest entry.
 *
 * Identical to {@link TemplateManifestEntry} — there are no schema transforms.
 */
export type TemplateManifestEntryInput = z.infer<typeof TemplateManifestEntrySchema>;

/** Public type for a fully-validated template manifest entry. */
export type TemplateManifestEntry = TemplateManifestEntryInput;
