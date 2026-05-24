/**
 * CLI docs command - attachment management + documentation drift detection.
 *
 * Subcommands (T797):
 *   cleo docs add <ownerId> <file|--url <url>> [--desc "..."] [--labels tag1,tag2]
 *   cleo docs list [--task T###] [--session ses_*] [--observation O###]
 *   cleo docs fetch <attachmentId|sha256>
 *   cleo docs remove <attachmentId|sha256> --from <ownerId>
 *
 * Legacy subcommands (T4551):
 *   cleo docs sync       — drift detection between scripts and docs index
 *   cleo docs gap-check  — validate knowledge transfer from review docs
 *
 * @task T4551 (sync/gap-check), T797 (add/list/fetch/remove)
 * @epic T4545 (legacy), T760 (attachments)
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DocKindConfigError,
  type DocKindMetadata,
  DocKindRegistry,
  ExitCode,
} from '@cleocode/contracts';
import {
  buildDocsGraph,
  CleoError,
  CounterMismatchError,
  checkSlugSimilarity,
  createAttachmentStoreDocsAccessor,
  DEFAULT_SIMILARITY_MODE,
  DEFAULT_SIMILARITY_THRESHOLD,
  detectStrayCleoDb,
  exportDocument,
  getAgentOutputsAbsolute,
  getProjectRoot,
  listDocVersions,
  makeClassifierForScanRoot,
  mergeDocs,
  publishDocs,
  publishDocsAsPr,
  rankDocs,
  readJson,
  recordPublication,
  resolveWorktreeFilePath,
  resolveWorktreeRouting,
  runDocsImport,
  searchAllProjectDocs,
  searchDocs,
  statusDocs,
  syncFromGit,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { loadCanonRegistry } from '../../dispatch/domains/check/canon-docs.js';
import { assertKnownFlags, UnknownFlagError } from '../lib/strict-args.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';
import { docsViewerSubcommands } from './docs-viewer.js';

/** Drift detection result. */
interface DriftResult {
  status: 'clean' | 'warning' | 'error';
  missingFromIndex: string[];
  missingFromScripts: string[];
  warnings: string[];
}

/**
 * Get list of script files from scripts/ directory.
 * @task T4551
 */
async function getScriptNames(projectRoot: string): Promise<string[]> {
  const scriptsDir = join(projectRoot, 'scripts');
  try {
    const files = await readdir(scriptsDir);
    return files
      .filter((f) => f.endsWith('.sh'))
      .map((f) => f.replace('.sh', ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get command names from COMMANDS-INDEX.json.
 * @task T4551
 */
async function getIndexedCommands(projectRoot: string): Promise<string[]> {
  const indexPath = join(projectRoot, 'docs', 'commands', 'COMMANDS-INDEX.json');
  const index = await readJson<{ commands: Array<{ name: string }> }>(indexPath);
  if (!index) return [];
  return index.commands.map((c) => c.name).sort();
}

/**
 * Run drift detection between scripts and documentation index.
 * @task T4551
 */
async function detectDrift(projectRoot: string): Promise<DriftResult> {
  const scripts = await getScriptNames(projectRoot);
  const indexed = await getIndexedCommands(projectRoot);

  const scriptSet = new Set(scripts);
  const indexSet = new Set(indexed);

  const missingFromIndex = scripts.filter((s) => !indexSet.has(s));
  const missingFromScripts = indexed.filter((i) => !scriptSet.has(i));
  const warnings: string[] = [];

  if (missingFromIndex.length > 0) {
    warnings.push(`${missingFromIndex.length} scripts not in COMMANDS-INDEX.json`);
  }
  if (missingFromScripts.length > 0) {
    warnings.push(`${missingFromScripts.length} index entries without scripts`);
  }

  let status: 'clean' | 'warning' | 'error' = 'clean';
  if (missingFromIndex.length > 0 || missingFromScripts.length > 0) {
    status = missingFromIndex.length > 5 ? 'error' : 'warning';
  }

  return { status, missingFromIndex, missingFromScripts, warnings };
}

/** Gap check result for a review document. */
interface GapEntry {
  file: string;
  taskId: string;
  gaps: string[];
}

/**
 * Run gap-check validation for review docs.
 * @task T4551
 */
async function runGapCheck(_projectRoot: string, filterId?: string): Promise<GapEntry[]> {
  const reviewDir = getAgentOutputsAbsolute();
  const results: GapEntry[] = [];

  try {
    const files = await readdir(reviewDir);
    const reviewFiles = files.filter((f) => f.endsWith('.md'));

    for (const file of reviewFiles) {
      if (filterId && !file.includes(filterId)) continue;

      const filePath = join(reviewDir, file);
      const content = await readFile(filePath, 'utf-8');

      const taskMatch = file.match(/^(T\d+)/);
      const taskId = taskMatch ? taskMatch[1] : 'UNKNOWN';

      const gaps: string[] = [];

      if (!content.includes('## Summary')) {
        gaps.push('Missing ## Summary section');
      }
      if (!content.includes('**Task**:') && !content.includes('**Task:**')) {
        gaps.push('Missing Task provenance header');
      }

      if (gaps.length > 0) {
        results.push({ file, taskId, gaps });
      }
    }
  } catch {
    // Review directory might not exist
  }

  return results;
}

// ── cleo docs add ────────────────────────────────────────────────────────────

/**
 * cleo docs add <ownerId> [<file>] [--url <url>] — attach a local file or remote URL.
 */
/**
 * `cleo docs add` — strict flag validation (T10359 · closes T10238).
 *
 * citty 0.2.1 silently absorbs unknown flags as positionals (parseArgs is
 * called with `strict: false` internally — no public knob exposed). Prior
 * to T10359, `cleo docs add T123 path.md --title 'X'` accepted `--title`
 * as a positional argument and dropped the value, masking typos that the
 * agent caller had no way to detect.
 *
 * The handler runs {@link assertKnownFlags} BEFORE dispatching to surface
 * `E_UNKNOWN_FLAG` with Levenshtein-ranked did-you-mean suggestions and
 * exit code 6 (`VALIDATION_ERROR`). The `--help` description below
 * enumerates the full positional + named shape so agents discover the
 * accepted surface without trial and error.
 *
 * @task T10359
 * @epic T10291
 * @saga T10288
 * @closes T10238
 */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Attach a local file or remote URL to a CLEO entity (task, session, observation). ' +
      'Owner type is inferred from the ID prefix: T### → task, ses_* → session, O-* → observation. ' +
      'Use --slug to set a human-friendly alias (unique per project) (T9636).\n\n' +
      'Positional arguments:\n' +
      '  <owner-id>             Owner entity ID (T###, ses_*, O-*) — required\n' +
      '  [file]                 Local file path to attach — optional when --url is set\n\n' +
      'Named arguments:\n' +
      '  --url <url>            Remote URL to attach (instead of a local file)\n' +
      '  --desc <text>          Free-text description of this attachment\n' +
      '  --labels <csv>         Comma-separated labels (e.g. rfc,spec)\n' +
      '  --attached-by <name>   Agent identity that created the attachment (default: "human")\n' +
      '  --slug <kebab>         Human-friendly alias, unique per project (T9636)\n' +
      '  --type <kind>          Taxonomy classification — run `cleo docs list-types` for kinds\n' +
      '  --allow-similar        Bypass the slug-similarity warn — every bypass is audited\n' +
      '                         to .cleo/audit/similar-bypass.jsonl (T10361)\n' +
      '  --strict               Enforce body-schema (requiredSections) — fail with\n' +
      '                         E_DOC_SCHEMA_MISMATCH instead of warning (T10160)\n\n' +
      'Validation behaviors:\n' +
      '  • Unknown flags → E_UNKNOWN_FLAG with did-you-mean suggestions (T10359)\n' +
      '  • Slug collision → E_SLUG_RESERVED + 3 alternative slugs (T10386)\n' +
      '  • Near-duplicate slug → W_SLUG_SIMILAR warning unless --allow-similar (T10361)\n' +
      '  • TODO(T10360): --type adr will auto-allocate adr-NNN-<title> from a --title flag.',
  },
  args: {
    'owner-id': {
      type: 'positional',
      description: 'Owner entity ID (T###, ses_*, O-*)',
      required: true,
    },
    file: {
      type: 'positional',
      description: 'Local file path to attach',
      required: false,
    },
    url: {
      type: 'string',
      description: 'Remote URL to attach (instead of a local file)',
    },
    desc: {
      type: 'string',
      description: 'Free-text description of this attachment',
    },
    labels: {
      type: 'string',
      description: 'Comma-separated labels (e.g. rfc,spec)',
    },
    'attached-by': {
      type: 'string',
      description: 'Agent identity that created the attachment (default: "human")',
    },
    slug: {
      type: 'string',
      description:
        'Human-friendly kebab-case alias for the attachment, unique per project (T9636). ' +
        'Collision returns E_SLUG_RESERVED with 3 alternative suggestions ' +
        '(legacy E_SLUG_TAKEN aliased under details.aliases for one release — T10386).',
    },
    type: {
      type: 'string',
      description:
        'Taxonomy classification — run `cleo docs list-types` to enumerate registered kinds (T9637 / T9788)',
    },
    'allow-similar': {
      type: 'boolean',
      description:
        'Bypass the T10361 slug-similarity check. Use when you really do mean to ' +
        'add a new doc with a near-duplicate slug (e.g. intentional fork). ' +
        'Every bypass is logged to .cleo/audit/similar-bypass.jsonl.',
    },
    strict: {
      type: 'boolean',
      description:
        "Enforce body-schema validation against the kind's requiredSections (T10160). " +
        'When set, a missing H2 section fails the write with E_DOC_SCHEMA_MISMATCH. ' +
        'Default (advisory) surfaces missing sections as a W_DOC_SCHEMA_MISMATCH warning.',
    },
  },
  async run({ args, rawArgs }) {
    // T10359 — pre-parse strict flag validation. citty's underlying
    // parseArgs has `strict: false` hard-coded with no public knob, so
    // unknown flags would otherwise be silently absorbed as positionals.
    try {
      assertKnownFlags(rawArgs, addCommand.args, 'docs add');
    } catch (err) {
      if (err instanceof UnknownFlagError) {
        cliError(err.message, ExitCode.VALIDATION_ERROR, {
          name: err.code,
          fix: err.fix,
          alternatives: err.suggestions.map((s) => ({ action: s, command: s })),
          details: { flag: err.flag, knownFlags: err.knownFlags },
        });
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      throw err;
    }

    const ownerId = args['owner-id'];
    const fileArg = args.file ?? undefined;
    const url = args.url ?? undefined;
    const allowSimilar = args['allow-similar'] === true;

    if (!fileArg && !url) {
      cliError('provide a file path (positional argument) or --url <url>', 6, {
        name: 'E_VALIDATION',
        fix: 'Example: cleo docs add T123 docs/rfc.md --desc "RFC draft" — or — cleo docs add T123 --url https://example.com/spec',
      });
      process.exit(6);
    }

    // T10389 / ADR-068 amendment §3.1 — worktree-aware file routing.
    //
    // When invoked from a git worktree (e.g. an orchestrator-spawned agent
    // running under `~/.local/share/cleo/worktrees/<hash>/<task>/`), the
    // canonical project root resolves to the MAIN repo (via the gitlink in
    // `getProjectRoot`). A user-supplied relative file path MUST be
    // resolved against the WORKTREE'S cwd, not against the canonical root,
    // before it reaches the dispatch sanitizer — otherwise the sanitizer
    // throws `E_PATH_TRAVERSAL` ("outside project root") OR the dispatch
    // op fails with `E_FILE_ERROR: Cannot read file` because it looked in
    // the wrong directory.
    //
    // The dispatch sanitizer is exempted for `docs.add` in
    // `packages/core/src/security/input-sanitization.ts` so the absolute
    // path computed here passes through unchanged.
    let resolvedFile: string | undefined;
    if (fileArg) {
      const routing = resolveWorktreeRouting();

      // Defensive: detect a stray `.cleo/tasks.db` inside the worktree
      // BEFORE invoking dispatch. The DB chokepoint's worktree-isolation
      // guard (T9806) would otherwise raise the harder-to-act-on
      // `E_WT_DB_ISOLATION_VIOLATION` later in the chain.
      const strayDb = detectStrayCleoDb(routing);
      if (strayDb) {
        cliError(
          `stray .cleo/tasks.db detected inside worktree at ${routing.worktreePath}. ` +
            'This is a leaked CLEO state directory.',
          6,
          {
            name: 'E_STRAY_WORKTREE_DB',
            fix: `Remove it with: rm -rf ${routing.worktreePath}/.cleo — then retry. See ADR-068 §3 for the worktree DB isolation rationale.`,
          },
        );
        process.exit(6);
      }

      if (routing.isWorktree && process.env['CLEO_QUIET'] !== '1') {
        // Emit to stderr so JSON consumers reading stdout never see chrome.
        // This fires BEFORE dispatch sets up the WarningCollector ALS, so
        // `pushWarning` would no-op — direct stderr is the correct surface.
        const routingLog = `[T10389] routing SSoT write from worktree cwd ${routing.cwd} → canonical project root ${routing.canonicalRoot}\n`;
        process.stderr.write(routingLog); // json-stream-hygiene-allowed: pre-dispatch routing UX (T10389)
      }

      resolvedFile = resolveWorktreeFilePath(String(fileArg), routing);
    }

    // T10361 — slug similarity check. Fires only when BOTH --slug and
    // --type are supplied AND the proposed slug fuzzy-matches an existing
    // slug for the same kind (score >= threshold, < 1.0). Exact collisions
    // fall through to the AttachmentStore's slug-collision path.
    if (args.slug && args.type) {
      const projectRoot = await getProjectRoot();
      let warnThreshold = DEFAULT_SIMILARITY_THRESHOLD;
      let mode: 'warn' | 'block' = DEFAULT_SIMILARITY_MODE;
      try {
        const canon = loadCanonRegistry(projectRoot);
        if (canon?.similarity) {
          warnThreshold = canon.similarity.warnThreshold;
          mode = canon.similarity.mode;
        }
      } catch {
        // canon.yml malformed — proceed with defaults rather than blocking
        // the user-requested action. `cleo check canon docs` will surface
        // the real diagnostic separately.
      }

      try {
        const sim = await checkSlugSimilarity({
          slug: args.slug,
          type: args.type,
          projectRoot,
          threshold: warnThreshold,
        });
        if (sim.mostSimilarSlug !== null) {
          const scoreFixed = sim.score.toFixed(2);
          const hint =
            `Similar to '${sim.mostSimilarSlug}' (score ${scoreFixed}) — ` +
            `did you mean: cleo docs update ${sim.mostSimilarSlug}? ` +
            `Pass --allow-similar to bypass.`;

          if (mode === 'block' && !allowSimilar) {
            cliError(hint, ExitCode.VALIDATION_ERROR, {
              name: 'E_SLUG_SIMILARITY',
              fix: `Use \`cleo docs update ${sim.mostSimilarSlug}\` if updating, or pass --allow-similar to add as a new doc.`,
              alternatives: [
                {
                  action: `update '${sim.mostSimilarSlug}' instead`,
                  command: `cleo docs update ${sim.mostSimilarSlug}`,
                },
                {
                  action: 'bypass the similarity check',
                  command: `cleo docs add ${ownerId} ${fileArg ?? `--url ${url}`} --slug ${args.slug} --type ${args.type} --allow-similar`,
                },
              ],
              details: {
                proposedSlug: args.slug,
                mostSimilarSlug: sim.mostSimilarSlug,
                score: sim.score,
                threshold: warnThreshold,
                kind: args.type,
              },
            });
            process.exit(ExitCode.VALIDATION_ERROR);
          }

          // warn mode OR --allow-similar — print the hint, continue.
          humanInfo(hint);

          if (allowSimilar) {
            // Audit-log the bypass (best-effort — never blocks the write).
            const auditLine = `${JSON.stringify({
              ts: new Date().toISOString(),
              reason: 'allow-similar-bypass',
              proposedSlug: args.slug,
              mostSimilarSlug: sim.mostSimilarSlug,
              score: sim.score,
              threshold: warnThreshold,
              kind: args.type,
              ownerId,
            })}\n`;
            try {
              await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
              await appendFile(
                join(projectRoot, '.cleo', 'audit', 'similar-bypass.jsonl'),
                auditLine,
                'utf-8',
              );
            } catch {
              // Audit log is best-effort — never block the user-requested action.
            }
          }
        }
      } catch (err) {
        // Similarity check is a soft gate — DB-open failures, missing
        // tables, etc. must NEVER block a docs add. Surface a debug hint
        // and continue.
        if (process.env['CLEO_DEBUG']) {
          humanInfo(
            `similarity check skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await dispatchFromCli(
      'mutate',
      'docs',
      'add',
      {
        ownerId,
        ...(resolvedFile ? { file: resolvedFile } : {}),
        ...(url ? { url } : {}),
        ...(args.desc ? { desc: args.desc } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
        ...(args['attached-by'] ? { attachedBy: args['attached-by'] } : {}),
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.type ? { type: args.type } : {}),
        ...(args.strict === true ? { strict: true } : {}),
      },
      { command: 'docs add' },
    );
  },
});

// ── cleo docs list ───────────────────────────────────────────────────────────

/**
 * `cleo docs list [--task | --session | --observation | --project] [--type TYPE]
 *  [--limit N] [--orderBy newest|sha|slug]` — list attachments.
 *
 * T9792 — UX cleanup: omitting every scope flag now defaults to project
 * scope (was: `E_VALIDATION`). The dispatch layer attaches a one-line hint
 * when the default kicks in so agents notice the wider scope. Mutual
 * exclusivity between explicit owner scopes is preserved.
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List attachments. With no scope flag, defaults to project scope and surfaces ' +
      'a hint to narrow with --task, --session, or --observation. ' +
      '--type filters across any scope (T9637/T9638). ' +
      '--limit <N> (default 50) and --orderBy <newest|sha|slug> (default newest) ' +
      'control the browsing window (T9792).',
  },
  args: {
    task: {
      type: 'string',
      description: 'Filter by task ID (e.g. T123)',
    },
    session: {
      type: 'string',
      description: 'Filter by session ID (e.g. ses_abc123)',
    },
    observation: {
      type: 'string',
      description: 'Filter by observation ID (e.g. O-abc123)',
    },
    project: {
      type: 'boolean',
      description:
        'List ALL attachments in the project (T9638). Mutually exclusive with ' +
        '--task/--session/--observation. Implicit default when no scope is set (T9792).',
    },
    type: {
      type: 'string',
      description: 'Filter by classification: spec|adr|research|handoff|note|llm-readme (T9637)',
    },
    limit: {
      type: 'string',
      description:
        'Maximum number of rows to return (default 50, <=0 for unlimited). ' +
        'When the limit truncates the result set the response carries a hint + totalCount (T9792).',
    },
    orderBy: {
      type: 'string',
      description:
        'Sort key: newest (default — most recent first), sha (ascending hex), ' +
        'slug (alphabetical, slug-less rows last) (T9792).',
    },
  },
  async run({ args }) {
    const task = args.task ?? undefined;
    const session = args.session ?? undefined;
    const observation = args.observation ?? undefined;
    const project = args.project === true;
    const type = args.type ?? undefined;
    const limitRaw = args.limit ?? undefined;
    const orderByRaw = args.orderBy ?? undefined;

    // T9792 — mutual exclusivity between OWNER scopes stays unchanged.
    // We no longer error when scopeCount === 0; the dispatch layer
    // auto-promotes to project scope and attaches a hint to the envelope.
    const ownerCount = [task, session, observation].filter(Boolean).length;
    if (ownerCount + (project ? 1 : 0) > 1) {
      cliError('--task, --session, --observation, and --project are mutually exclusive', 6, {
        name: 'E_VALIDATION',
      });
      process.exit(6);
    }

    // Validate --limit shape locally so a bad value doesn't reach dispatch.
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(String(limitRaw), 10);
      if (Number.isNaN(parsed)) {
        cliError(`--limit must be an integer — got '${String(limitRaw)}'`, 6, {
          name: 'E_VALIDATION',
        });
        process.exit(6);
      }
      limit = parsed;
    }

    // Validate --orderBy against the closed set; reject anything else.
    let orderBy: 'newest' | 'sha' | 'slug' | undefined;
    if (orderByRaw !== undefined) {
      const candidate = String(orderByRaw);
      if (candidate !== 'newest' && candidate !== 'sha' && candidate !== 'slug') {
        cliError(`--orderBy must be one of: newest|sha|slug — got '${candidate}'`, 6, {
          name: 'E_VALIDATION',
        });
        process.exit(6);
      }
      orderBy = candidate;
    }

    await dispatchFromCli(
      'query',
      'docs',
      'list',
      {
        ...(task ? { task } : {}),
        ...(session ? { session } : {}),
        ...(observation ? { observation } : {}),
        ...(project ? { project: true } : {}),
        ...(type ? { type } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
      },
      { command: 'docs list' },
    );
  },
});

// ── cleo docs fetch ──────────────────────────────────────────────────────────

/** cleo docs fetch <attachmentRef> — retrieve attachment metadata and bytes. */
const fetchCommand = defineCommand({
  meta: {
    name: 'fetch',
    description:
      'Retrieve attachment metadata and bytes by attachment ID (att_*) or SHA-256 hex. ' +
      'Files <= 1 MB are returned base64-encoded inline; larger files report the storage path only.',
  },
  args: {
    'attachment-ref': {
      type: 'positional',
      description: 'Attachment ID (att_*) or SHA-256 hex',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'docs',
      'fetch',
      { attachmentRef: args['attachment-ref'] },
      { command: 'docs fetch' },
    );
  },
});

// ── cleo docs remove ─────────────────────────────────────────────────────────

/** cleo docs remove <attachmentRef> --from <ownerId> — remove an attachment ref. */
const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Remove an attachment ref from an owner entity. ' +
      'When refCount reaches zero the blob file is purged from disk.',
  },
  args: {
    'attachment-ref': {
      type: 'positional',
      description: 'Attachment ID (att_*) or SHA-256 hex',
      required: true,
    },
    from: {
      type: 'string',
      description: 'Owner entity ID to remove the attachment ref from (required)',
    },
  },
  async run({ args }) {
    const from = args.from ?? undefined;
    if (!from) {
      cliError('--from <ownerId> is required', 6, { name: 'E_VALIDATION' });
      process.exit(6);
    }

    await dispatchFromCli(
      'mutate',
      'docs',
      'remove',
      { attachmentRef: args['attachment-ref'], from },
      { command: 'docs remove' },
    );
  },
});

// ── cleo docs generate ───────────────────────────────────────────────────────

/** cleo docs generate --for <id> [--attach] — generate llms.txt document. */
const generateCommand = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Generate an llms.txt-format document summarising all attachments on a CLEO entity. ' +
      'Internally uses the llmtxt npm package for structural section analysis; ' +
      'falls back to a built-in generator when unavailable. ' +
      'Use --attach to save the output back as an llms-txt attachment on the same entity.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Target entity ID (task, session, or observation)',
      required: true,
    },
    attach: {
      type: 'boolean',
      description: 'Save the generated llms.txt content back as an attachment on the target entity',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'docs',
      'generate',
      {
        for: args.for,
        ...(args.attach ? { attach: true } : {}),
      },
      { command: 'docs generate' },
    );
  },
});

// ── cleo docs export ──────────────────────────────────────────────────────────

/**
 * cleo docs export — emit a rich Markdown export of a CLEO task.
 *
 * Uses {@link exportDocument} (llmtxt-backed) to serialise task frontmatter +
 * description + acceptance criteria + optionally the attachment manifest
 * (with content-address backlinks) and BRAIN memory references. The output is
 * a single self-contained Markdown file suitable for publishing to git.
 *
 * @epic T947 (llmtxt v2026.4.9 adoption — this wires the CLI surface the
 *   earlier T947 worker claimed but never registered).
 */
const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description:
      'Generate a rich Markdown export of a CLEO task (frontmatter + body + attachments + memory refs). ' +
      'Uses llmtxt/export.formatMarkdown for canonical serialisation. ' +
      'Use --out <file> to write to disk; omit to print to stdout.',
  },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to export (e.g. T947)',
      required: true,
    },
    out: {
      type: 'string',
      description: 'Output file path (absolute or relative to project root). Omit for stdout.',
    },
    'include-attachments': {
      type: 'boolean',
      default: true,
      description: 'Append attachment manifest section (default: true)',
    },
    'include-memory-refs': {
      type: 'boolean',
      default: false,
      description: 'Append BRAIN memory references section (default: false)',
    },
    json: {
      type: 'boolean',
      description:
        'Emit result envelope as JSON instead of markdown (returns {markdown, pages, path?})',
    },
  },
  async run({ args }) {
    const taskId = String(args.task);
    const includeAttachments = args['include-attachments'] !== false;
    const includeMemoryRefs = args['include-memory-refs'] === true;
    const projectRoot = getProjectRoot();

    try {
      const result = await exportDocument({
        taskId,
        includeAttachments,
        includeMemoryRefs,
        projectRoot,
      });

      let writtenPath: string | undefined;
      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.markdown, 'utf8');
        writtenPath = outPath;
      }

      if (args.json) {
        cliOutput(
          { markdown: result.markdown, pages: result.pages, path: writtenPath ?? null },
          { command: 'docs export', operation: 'docs.export' },
        );
      } else {
        // Human mode: print markdown to stdout, report path to stderr
        if (writtenPath) {
          humanInfo(`Wrote ${result.pages} page(s) to ${writtenPath}`);
        } else {
          // Markdown payload is the user-requested output of this command —
          // emitted to stdout for piping. Not chrome.
          process.stdout.write(result.markdown);
          if (!result.markdown.endsWith('\n')) process.stdout.write('\n');
        }
      }
    } catch (err) {
      // T9789: emit a flat LAFS error envelope (single layer, ADR-039).
      // `cliOutput(formatError(...))` double-wraps — `formatError` already
      // serialises a `{success:false, error, meta}` envelope to JSON, and
      // feeding that string to `cliOutput` produces `{success:true, data:"<json>"}`.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs export failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_EXPORT_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs search ─────────────────────────────────────────────────────────

/**
 * cleo docs search <query> — semantic search over attachments via rankBySimilarity.
 */
const searchCommand = defineCommand({
  meta: {
    name: 'search',
    description:
      'Search attachments by semantic similarity using llmtxt/similarity.rankBySimilarity. ' +
      'Without --owner, ranks every published doc in the project by content (T9647). ' +
      'Pass --owner to scope to a specific entity (T###, ses_*, O-*) and rank by blob name.',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Free-text search query',
      required: true,
    },
    owner: {
      type: 'string',
      description: 'Scope search to a specific owner entity ID (legacy name-only ranking)',
    },
    type: {
      type: 'string',
      description:
        'Filter project-wide search by taxonomy type: spec|adr|research|handoff|note|llm-readme',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results to return (default: 10)',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope instead of human-readable output',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const limit = args.limit ? Number.parseInt(String(args.limit), 10) : 10;
    try {
      const result = args.owner
        ? await searchDocs(String(args.query), {
            ownerId: String(args.owner),
            limit,
            projectRoot,
          })
        : await searchAllProjectDocs(String(args.query), {
            limit,
            type: args.type ? String(args.type) : undefined,
            projectRoot,
          });

      cliOutput(result, { command: 'docs search', operation: 'docs.search' });
    } catch (err) {
      // T9789: flat LAFS error envelope (ADR-039) — no double-wrap.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs search failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_SEARCH_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs merge ───────────────────────────────────────────────────────────

/**
 * cleo docs merge <attA> <attB> — merge two attachment contents via llmtxt/sdk.
 */
const mergeCommand = defineCommand({
  meta: {
    name: 'merge',
    description:
      'Merge two attachment text contents using llmtxt/sdk diff primitives. ' +
      'Strategies: three-way (default), cherry-pick, multi-diff.',
  },
  args: {
    attA: {
      type: 'positional',
      description: 'First attachment ID or text content',
      required: true,
    },
    attB: {
      type: 'positional',
      description: 'Second attachment ID or text content',
      required: true,
    },
    strategy: {
      type: 'string',
      description: 'Merge strategy: three-way | cherry-pick | multi-diff (default: three-way)',
    },
    base: {
      type: 'string',
      description: 'Base content for three-way merge',
    },
    out: {
      type: 'string',
      description: 'Write merged content to this file path',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const rawStrategy = args.strategy ?? 'three-way';
    const strategy =
      rawStrategy === 'cherry-pick' || rawStrategy === 'multi-diff' ? rawStrategy : 'three-way';

    try {
      const result = await mergeDocs(String(args.attA), String(args.attB), {
        strategy,
        base: args.base ?? undefined,
      });

      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.merged, 'utf8');
        humanInfo(`Wrote merged content to ${outPath}`);
      }

      cliOutput(result, { command: 'docs merge', operation: 'docs.merge' });
    } catch (err) {
      // T9789: flat LAFS error envelope (ADR-039) — no double-wrap.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs merge failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_MERGE_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs graph ───────────────────────────────────────────────────────────

/**
 * cleo docs graph --for <id> — build a document relationship graph via llmtxt/graph.
 */
const graphCommand = defineCommand({
  meta: {
    name: 'graph',
    description:
      'Build a document relationship graph for an entity using llmtxt/graph.buildGraph. ' +
      'Output formats: mermaid (default), dot, json.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Owner entity ID (T###, ses_*, O-*)',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: mermaid | dot | json (default: mermaid)',
    },
    out: {
      type: 'string',
      description: 'Write graph to this file path',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const fmt = args.format ?? 'mermaid';

    try {
      const result = await buildDocsGraph({ ownerId: String(args.for), projectRoot });

      let output: string;
      if (fmt === 'dot') {
        const dotLines = ['digraph docs {'];
        for (const node of result.nodes) {
          dotLines.push(`  "${node.id}" [label="${node.label}"];`);
        }
        for (const edge of result.edges) {
          dotLines.push(`  "${edge.source}" -> "${edge.target}" [label="${edge.relation}"];`);
        }
        dotLines.push('}');
        output = dotLines.join('\n');
      } else if (fmt === 'json') {
        output = JSON.stringify(result, null, 2);
      } else {
        // mermaid
        const lines = ['graph LR'];
        for (const edge of result.edges) {
          lines.push(`  ${edge.source} -->|${edge.relation}| ${edge.target}`);
        }
        if (result.edges.length === 0) {
          for (const node of result.nodes) {
            lines.push(`  ${node.id}["${node.label}"]`);
          }
        }
        output = lines.join('\n');
      }

      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, output, 'utf8');
        humanInfo(`Wrote graph to ${outPath}`);
      }

      cliOutput(
        { format: fmt, nodeCount: result.nodes.length, edgeCount: result.edges.length, output },
        { command: 'docs graph', operation: 'docs.graph' },
      );
    } catch (err) {
      // T9789: flat LAFS error envelope (ADR-039) — no double-wrap.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs graph failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_GRAPH_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs rank ────────────────────────────────────────────────────────────

/**
 * cleo docs rank --for <id> — rank attachments by relevance via semanticConsensus.
 */
const rankCommand = defineCommand({
  meta: {
    name: 'rank',
    description:
      'Rank attachments for an entity by relevance using llmtxt/similarity.rankBySimilarity. ' +
      'Pass --query to use a custom query; otherwise the entity ID anchors the ranking.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Owner entity ID (T###, ses_*, O-*)',
      required: true,
    },
    query: {
      type: 'string',
      description: 'Optional free-text query to rank against (default: owner ID)',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    try {
      const result = await rankDocs({
        ownerId: String(args.for),
        query: args.query ?? undefined,
        projectRoot,
      });

      cliOutput(result, { command: 'docs rank', operation: 'docs.rank' });
    } catch (err) {
      // T9789: flat LAFS error envelope (ADR-039) — no double-wrap.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs rank failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_RANK_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs update ──────────────────────────────────────────────────────────

/**
 * `cleo docs update <slug>` — UPDATE-in-place via slug (T10161).
 *
 * Replaces the blob content for an existing slug while preserving the slug
 * itself. Internally:
 *
 *   1. Looks up the existing attachment row by slug (E_NOT_FOUND if missing).
 *   2. Hashes the new content; identical bytes ⇒ NOOP (changed=false).
 *   3. Inside one BEGIN IMMEDIATE transaction: clear the slug on the old
 *      row, insert/upsert a new row carrying the new sha256 + the slug, and
 *      carry every existing owner ref onto the new row.
 *   4. Writes a versioning audit line under
 *      `.cleo/audit/docs-versioning.jsonl`. Updates for the same slug within
 *      a 5-minute window squash into the prior line (revisions[]).
 *
 * Pairs with `cleo docs supersede` (T10162) — supersede creates an explicit
 * lineage edge for major scope shifts; update is for minor edits that
 * shouldn't fragment the slug history.
 *
 * @task T10161 (Epic T10157 · Saga T9855 · E12.C4)
 */
const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description:
      'Replace blob content for an existing slug while preserving the slug. ' +
      'Pass --file <path> OR --content <text> (exactly one). Defaults --status to "draft" ' +
      'on every update so explicit `accepted` docs get back-pressured to draft on edit. ' +
      'Audit log entry appended to .cleo/audit/docs-versioning.jsonl (squashed within 5 min).\n\n' +
      'Positional arguments:\n' +
      '  <slug>                 Slug of the attachment to update (required)\n\n' +
      'Named arguments:\n' +
      '  --file <path>          Local file containing the new content\n' +
      '  --content <text>       Inline UTF-8 content (mutually exclusive with --file)\n' +
      '  --message <text>       One-line summary of the change (audit log)\n' +
      '  --status <status>      Override lifecycle status — default "draft"\n' +
      '  --attached-by <name>   Agent identity for this revision (default "human")',
  },
  args: {
    slug: {
      type: 'positional',
      description: 'Slug of the attachment to update',
      required: true,
    },
    file: {
      type: 'string',
      description: 'Local file containing the new content',
    },
    content: {
      type: 'string',
      description: 'Inline UTF-8 content (mutually exclusive with --file)',
    },
    message: {
      type: 'string',
      description: 'One-line summary of the change (recorded in the audit log)',
    },
    status: {
      type: 'string',
      description:
        'Lifecycle status to set on the new row. Valid: ' +
        'draft|proposed|accepted|superseded|archived|deprecated. Default: draft.',
    },
    'attached-by': {
      type: 'string',
      description: 'Agent identity that performed the update (default: "human")',
    },
  },
  async run({ args, rawArgs }) {
    try {
      assertKnownFlags(rawArgs, updateCommand.args, 'docs update');
    } catch (err) {
      if (err instanceof UnknownFlagError) {
        cliError(err.message, ExitCode.VALIDATION_ERROR, {
          name: err.code,
          fix: err.fix,
          alternatives: err.suggestions.map((s) => ({ action: s, command: s })),
          details: { flag: err.flag, knownFlags: err.knownFlags },
        });
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      throw err;
    }

    const slug = String(args.slug);
    const filePath = typeof args.file === 'string' ? args.file : undefined;
    const inlineContent = typeof args.content === 'string' ? args.content : undefined;

    if (filePath !== undefined && inlineContent !== undefined) {
      cliError('--file and --content are mutually exclusive', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
        fix: 'Use `cleo docs update <slug> --file <path>` OR `--content <text>` (not both).',
      });
      process.exit(ExitCode.VALIDATION_ERROR);
    }
    if (filePath === undefined && inlineContent === undefined) {
      cliError('provide --file <path> OR --content <text>', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
        fix: 'Example: `cleo docs update my-doc --file ./new.md` OR `cleo docs update my-doc --content "..."`.',
      });
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    // T10389 — resolve relative file paths against the worktree cwd so
    // worktree-spawned agents can pass relative paths. Mirrors the
    // discipline used in `cleo docs add`.
    let resolvedFile: string | undefined;
    if (filePath !== undefined) {
      const routing = resolveWorktreeRouting();
      resolvedFile = resolveWorktreeFilePath(filePath, routing);
    }

    await dispatchFromCli(
      'mutate',
      'docs',
      'update',
      {
        slug,
        ...(resolvedFile !== undefined ? { file: resolvedFile } : {}),
        ...(inlineContent !== undefined ? { content: inlineContent } : {}),
        ...(typeof args.message === 'string' ? { message: args.message } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        ...(typeof args['attached-by'] === 'string' ? { attachedBy: args['attached-by'] } : {}),
      },
      { command: 'docs update' },
    );
  },
});

// ── cleo docs versions ────────────────────────────────────────────────────────

/**
 * cleo docs versions --for <id> — list all SHA versions of attachments.
 */
const versionsCommand = defineCommand({
  meta: {
    name: 'versions',
    description:
      'List all SHA-256 content-address versions of attachments for an entity. ' +
      'Use --name to filter by a specific filename.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Owner entity ID (T###, ses_*, O-*)',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Optional filename filter (exact match)',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    try {
      const result = await listDocVersions({
        ownerId: String(args.for),
        name: args.name ?? undefined,
        projectRoot,
      });

      cliOutput(result, { command: 'docs versions', operation: 'docs.versions' });
    } catch (err) {
      // T9789: flat LAFS error envelope (ADR-039) — no double-wrap.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs versions failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_VERSIONS_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs publish ─────────────────────────────────────────────────────────

/**
 * cleo docs publish --for <id> --to <path> — atomic publish from docs SSoT to git path.
 */
const publishCommand = defineCommand({
  meta: {
    name: 'publish',
    description:
      'Atomically publish an attachment from the docs SSoT to a git-tracked file path. ' +
      'Uses tmp-then-rename for atomicity. The --to path may be absolute or relative to project root.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Owner entity ID whose attachment to publish (T###, ses_*, O-*)',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Destination file path (absolute or relative to project root)',
      required: true,
    },
    attachment: {
      type: 'string',
      description: 'Specific attachment ID or SHA-256 to publish (default: latest)',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    try {
      const result = await publishDocs({
        ownerId: String(args.for),
        toPath: String(args.to),
        attachmentId: args.attachment ?? undefined,
        projectRoot,
      });

      // Persist the publication in the docs-publications ledger so the
      // `cleo docs status` drift detector can subsequently check this path.
      // Failure here MUST NOT mask publish success — the file is already on
      // disk and reachable; ledger drift is recoverable on the next publish.
      try {
        await recordPublication({
          ownerId: result.ownerId,
          blobName: result.blobName,
          publishedPath: result.relativePath,
          lastBlobSha: result.blobSha256,
          projectRoot,
        });
      } catch {
        /* Ledger write is best-effort. */
      }

      cliOutput(result, { command: 'docs publish', operation: 'docs.publish' });
    } catch (err) {
      // T9633: emit a flat LAFS error envelope (single layer, ADR-039).
      // The earlier `cliOutput(formatError(...))` form double-wrapped the
      // envelope — `formatError` already serialises a `{success:false, error,
      // meta}` envelope to JSON, and feeding that string to `cliOutput`
      // produced `{success:true, data:"<json>"}` instead of a real error.
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs publish failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_PUBLISH_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs publish-pr ──────────────────────────────────────────────────────

/**
 * cleo docs publish-pr <slug-or-id> — open or update a PR with the doc.
 *
 * Default behaviour:
 *   1. Resolves `<slug-or-id>` to attachment bytes via the docs store.
 *   2. Provisions a temp git worktree on `docs/<slug>`.
 *   3. Writes `docs/<type>/<slug>.md` with YAML frontmatter.
 *   4. Commits, pushes, and either opens a new PR or refreshes the
 *      existing open PR's body atomically (force-with-lease + edit).
 *
 * Errors are emitted as LAFS envelopes with `codeName` + `fix` +
 * `alternatives` — see {@link publishDocsAsPr} for the full taxonomy.
 *
 * @task T9716 / T9717 / T9718 / T9719 (T9644 / Epic T9630 / Saga T9625)
 */
const publishPrCommand = defineCommand({
  meta: {
    name: 'publish-pr',
    description:
      'Publish an attachment to a GitHub PR. ' +
      'Opens a new PR on branch `docs/<slug>` with frontmatter, or ' +
      'atomically updates the existing open PR for the same slug.',
  },
  args: {
    'slug-or-id': {
      type: 'positional',
      description: 'Slug, attachment id, or full sha256 hex of the doc to publish',
      required: true,
    },
    slug: {
      type: 'string',
      description:
        'Override the slug used for the branch + filename. Required when ' +
        '<slug-or-id> is an attachment id or sha256 with no stored slug.',
    },
    type: {
      type: 'string',
      description: 'Override the publish dir taxonomy (spec|adr|research|handoff|note|llm-readme).',
    },
    title: {
      type: 'string',
      description: 'Override the PR title. Default: `docs(<type>): publish <slug>`.',
    },
    body: {
      type: 'string',
      description: 'Override the PR body. Default: an auto-generated summary.',
    },
    base: {
      type: 'string',
      description: 'Base branch for the PR. Default: main.',
    },
  },
  async run({ args }) {
    const slugOrId = String(args['slug-or-id']);

    const result = await publishDocsAsPr({
      slugOrId,
      ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
      ...(typeof args.type === 'string' ? { type: args.type } : {}),
      ...(typeof args.title === 'string' ? { title: args.title } : {}),
      ...(typeof args.body === 'string' ? { body: args.body } : {}),
      ...(typeof args.base === 'string' ? { base: args.base } : {}),
    });

    if (result.success) {
      cliOutput(result.data, { command: 'docs publish-pr', operation: 'docs.publish-pr' });
      return;
    }

    const e = result.error;
    cliError(
      e.message,
      ExitCode.GENERAL_ERROR,
      {
        name: e.codeName,
        ...(e.fix ? { fix: e.fix } : {}),
        ...(e.alternatives
          ? {
              alternatives: e.alternatives.map((alt) => ({ action: alt, command: alt })),
            }
          : {}),
        ...(e.details ? { details: e.details } : {}),
      },
      { operation: 'docs.publish-pr' },
    );
    process.exit(ExitCode.GENERAL_ERROR);
  },
});

// ── cleo docs sync ────────────────────────────────────────────────────────────

/**
 * cleo docs sync — bidirectional surface.
 *
 * Two modes, selected by the presence of `--from`:
 *
 *   1. Reverse-ingest (`--from <git-path> --for <ownerId>` — T9702):
 *      Read the git-tracked file, hash its bytes, and write a new blob
 *      version to the docs SSoT. Idempotent: same content sha → noop.
 *
 *   2. Legacy drift check (no `--from`):
 *      Compare `scripts/` against `COMMANDS-INDEX.json` — pre-existing
 *      behaviour preserved verbatim for backward compatibility.
 *
 * @epic T9626 (W0)
 * @task T9702 (ST-PUB-2b — reverse-ingest)
 */
const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Bidirectional docs sync. Use --from <path> --for <ownerId> to ingest a git file as a new blob version. ' +
      'Without --from, runs the legacy drift check between scripts/ and COMMANDS-INDEX.json.',
  },
  args: {
    from: {
      type: 'string',
      description:
        'Git-tracked file path to ingest as a new blob version (triggers reverse-ingest mode)',
    },
    for: {
      type: 'string',
      description:
        'Owner entity ID for reverse-ingest mode (T###, ses_*, O-*). Required when --from is set.',
    },
    name: {
      type: 'string',
      description: 'Override the blob name used in the manifest. Default: basename of --from.',
    },
    'content-type': {
      type: 'string',
      description:
        'IANA MIME type recorded with the new blob version (default: application/octet-stream)',
    },
    quick: {
      type: 'boolean',
      description: 'Legacy mode only: quick check (commands only)',
    },
    strict: {
      type: 'boolean',
      description: 'Legacy mode only: exit with error on any drift',
    },
  },
  async run({ args }) {
    // Reverse-ingest mode (T9702).
    if (args.from) {
      const projectRoot = getProjectRoot();
      const ownerId = args.for ?? undefined;
      if (!ownerId) {
        cliError(
          '--for <ownerId> is required when --from <path> is set',
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
      }

      try {
        const result = await syncFromGit({
          ownerId: String(ownerId),
          fromPath: String(args.from),
          blobName: args.name ?? undefined,
          contentType: args['content-type'] ?? undefined,
          projectRoot,
        });
        cliOutput(result, { command: 'docs sync', operation: 'docs.sync' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cliError(`docs sync failed: ${message}`, ExitCode.GENERAL_ERROR, {
          name: 'E_DOCS_SYNC_FAILED',
        });
        process.exit(ExitCode.GENERAL_ERROR);
      }
      return;
    }

    // Legacy drift mode (T4551 — preserved unchanged).
    try {
      const projectRoot = process.cwd();
      const result = await detectDrift(projectRoot);

      cliOutput(
        {
          status: result.status,
          missingFromIndex: result.missingFromIndex,
          missingFromScripts: result.missingFromScripts,
          warnings: result.warnings,
        },
        {
          command: 'docs',
          message:
            result.status === 'clean'
              ? 'Documentation is in sync'
              : `Drift detected: ${result.warnings.join('; ')}`,
        },
      );

      if (args.strict && result.status !== 'clean') {
        process.exit(result.status === 'error' ? 2 : 1);
      }
    } catch (err) {
      if (err instanceof CleoError) {
        // T9789: flat LAFS error envelope (ADR-039). Passing `formatError(err)`
        // (a JSON envelope string) as the message overrode the human-readable
        // text with a stringified blob — use the raw `err.message` instead.
        cliError(err.message, err.code, { name: 'E_DOCS_SYNC_FAILED' });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

// ── cleo docs status ──────────────────────────────────────────────────────────

/**
 * cleo docs status — git⇄llmtxt drift detector.
 *
 * Walks the docs-publications ledger and classifies each entry as one of
 * `in-sync`, `modified`, `deleted`, or `added`. Exits non-zero (code 2)
 * when ANY entry has drift — convention from `git diff --exit-code`.
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Compare published files on disk against the docs SSoT and report drift. ' +
      'Exits 0 when all entries are in-sync, 2 when any drift is present.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run() {
    const projectRoot = getProjectRoot();
    try {
      const result = await statusDocs({ projectRoot });
      cliOutput(result, { command: 'docs status', operation: 'docs.status' });
      if (!result.allInSync) {
        process.exit(2);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs status failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_STATUS_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── Legacy: cleo docs gap-check ───────────────────────────────────────────────

/** cleo docs gap-check — validate knowledge transfer from review docs */
const gapCheckCommand = defineCommand({
  meta: {
    name: 'gap-check',
    description: 'Validate knowledge transfer from review docs to canonical docs',
  },
  args: {
    epic: {
      type: 'string',
      description: 'Filter by epic ID',
    },
    task: {
      type: 'string',
      description: 'Filter by task ID',
    },
  },
  async run({ args }) {
    try {
      const projectRoot = process.cwd();
      const filterId = args.epic ?? args.task;
      const gaps = await runGapCheck(projectRoot, filterId);

      if (gaps.length === 0) {
        cliOutput(
          { gapCount: 0, results: [] },
          { command: 'docs', message: 'No documentation gaps found' },
        );
      } else {
        cliOutput(
          { gapCount: gaps.length, results: gaps },
          { command: 'docs', message: `Found ${gaps.length} document(s) with gaps` },
        );
      }
    } catch (err) {
      if (err instanceof CleoError) {
        // T9789: flat LAFS error envelope (ADR-039) — same fix class as syncCommand.
        cliError(err.message, err.code, { name: 'E_DOCS_GAP_CHECK_FAILED' });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

// ── cleo docs import ──────────────────────────────────────────────────────────

/**
 * cleo docs import <dir> — recursive legacy `.md` migration (T9639 / Saga T9625).
 *
 * Walks `dir` for every markdown file, classifies each by source-dir
 * (`.cleo/adrs/* → adr`, `.cleo/research/* → research`,
 * `.cleo/agent-outputs/* → note`, `docs/* → spec`), assigns a unique slug
 * (with collision suffixes), and writes new blobs through `DocsAccessor`.
 * Bytes that already match a stored SHA are skipped (idempotent).
 *
 * Counter integrity (T9709): scanCount MUST equal
 * importCount + noopCount + errorCount or the command exits non-zero with
 * `E_COUNTER_MISMATCH`.
 *
 * @epic T9628 (Saga T9625)
 * @task T9639 / T9709 / T9710 / T9711 / T9712 / T9713
 */
const importCommand = defineCommand({
  meta: {
    name: 'import',
    description:
      'Recursively import .md files from <dir> into the docs SSoT. ' +
      'Auto-classifies type by source-dir (.cleo/adrs/→adr, .cleo/research/→research, ' +
      '.cleo/agent-outputs/→note, docs/→spec). Idempotent via SHA-dedup. ' +
      'Use --dry-run to preview without writing.',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Absolute or project-relative directory to scan recursively',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be imported without writing to the docs SSoT',
    },
    force: {
      type: 'boolean',
      description:
        'Bypass SHA-dedup and re-import existing content. Bypass is logged to ' +
        '.cleo/audit/import-force-bypass.jsonl for traceability.',
    },
    'audit-manifest': {
      type: 'string',
      description:
        'Override the audit manifest output path. Default: <project-root>/docs-import-<ts>.json',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope (default for agent callers)',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const dirArg = String(args.dir);
    const scanRoot = isAbsolute(dirArg) ? dirArg : resolve(projectRoot, dirArg);
    const dryRun = args['dry-run'] === true;
    const force = args.force === true;
    const manifestPath = args['audit-manifest']
      ? isAbsolute(String(args['audit-manifest']))
        ? String(args['audit-manifest'])
        : resolve(projectRoot, String(args['audit-manifest']))
      : undefined;

    if (force) {
      const auditLine = `${JSON.stringify({
        ts: new Date().toISOString(),
        scanRoot,
        reason: 'force-flag-bypass',
      })}\n`;
      try {
        await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
        await appendFile(
          join(projectRoot, '.cleo', 'audit', 'import-force-bypass.jsonl'),
          auditLine,
          'utf-8',
        );
      } catch {
        // Audit log is best-effort — never block the user-requested action.
      }
    }

    // T9791 — use the AttachmentStore-backed accessor for production runs so
    // imported docs land in tasks.db with queryable slug + type columns
    // (default DocsAccessorImpl writes to manifest.db with in-memory state,
    // which breaks idempotency across processes + slug→sha lookups).
    const accessor = createAttachmentStoreDocsAccessor(projectRoot);

    // Resolve a source-dir-aware classifier so files scanned from inside
    // .cleo/adrs/ (etc.) still receive their correct DocImportType.
    const classify = makeClassifierForScanRoot(scanRoot, projectRoot);

    try {
      const result = await runDocsImport({
        root: scanRoot,
        accessor,
        dryRun,
        force,
        manifestPath,
        auditDir: projectRoot,
        classify,
      });

      cliOutput(
        {
          dryRun: result.dryRun,
          counters: result.counters,
          entries: result.entries,
          manifestPath: result.manifestPath ?? null,
        },
        { command: 'docs import', operation: 'docs.import' },
      );
    } catch (err) {
      if (err instanceof CounterMismatchError) {
        cliError(err.message, ExitCode.GENERAL_ERROR, {
          name: 'E_COUNTER_MISMATCH',
        });
        process.exit(ExitCode.GENERAL_ERROR);
      }
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs import failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_IMPORT_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    } finally {
      await accessor.close().catch(() => {
        /* never fail on close */
      });
    }
  },
});

// ── cleo docs schema ─────────────────────────────────────────────────────────

/**
 * Serializable wire shape for the doc-kind registry envelope.
 *
 * Regex patterns are serialized to their `.source` string so JSON
 * consumers (and downstream agents) can re-compile them deterministically.
 *
 * @task T9788
 */
interface DocKindMetadataWire {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly defaultOwnerKind: 'task' | 'session' | 'observation' | 'project';
  readonly publishDir: string;
  readonly requiresEntityId: boolean;
  readonly entityIdPattern?: string;
  readonly isExtension: boolean;
}

/**
 * Convert a {@link DocKindMetadata} entry to its wire-format twin.
 *
 * @internal
 * @task T9788
 */
function toWireKind(meta: DocKindMetadata): DocKindMetadataWire {
  return {
    kind: meta.kind,
    label: meta.label,
    description: meta.description,
    defaultOwnerKind: meta.defaultOwnerKind,
    publishDir: meta.publishDir,
    requiresEntityId: meta.requiresEntityId,
    ...(meta.entityIdPattern ? { entityIdPattern: meta.entityIdPattern.source } : {}),
    isExtension: meta.isExtension === true,
  };
}

/**
 * Load the canonical registry, mapping config errors into a CLI-friendly
 * envelope. Returns the built-in-only fallback on failure so commands stay
 * usable even when `.cleo/docs-config.json` is broken.
 *
 * @internal
 * @task T9788
 */
function loadCliRegistry(projectRoot: string): {
  registry: DocKindRegistry;
  configError?: { source: string; message: string };
} {
  try {
    return { registry: DocKindRegistry.load(projectRoot) };
  } catch (err) {
    if (err instanceof DocKindConfigError) {
      return {
        registry: DocKindRegistry.builtinOnly(),
        configError: { source: err.source, message: err.message },
      };
    }
    throw err;
  }
}

/**
 * `cleo docs schema` — emit the full doc-kind registry as a LAFS envelope.
 *
 * Built-in kinds appear first (declaration order), then any extensions
 * loaded from `.cleo/docs-config.json`. The envelope includes
 * `extensionsCount` so consumers can quickly tell whether project-level
 * extensions are in play.
 *
 * @task T9788
 */
const schemaCommand = defineCommand({
  meta: {
    name: 'schema',
    description:
      'Emit the canonical doc-kind taxonomy registry (built-ins + project extensions) ' +
      'as a LAFS envelope. The schema is the single source of truth for the ' +
      '--type values accepted by `cleo docs add` and the publish-dir layout used by ' +
      '`cleo docs publish-pr`. See `cleo docs list-types` for the human-readable form (T9788).',
  },
  args: {
    'include-counts': {
      type: 'boolean',
      description: 'Include per-kind attachment counts from the project SSoT',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const { registry, configError } = loadCliRegistry(projectRoot);
    const kinds = registry.list().map(toWireKind);
    const extensionsCount = kinds.filter((k) => k.isExtension).length;

    let counts: Record<string, number> | undefined;
    if (args['include-counts']) {
      counts = {};
      const { createAttachmentStore } = await import('@cleocode/core/internal');
      const store = createAttachmentStore();
      for (const k of kinds) counts[k.kind] = 0;
      try {
        const rows = await store.listAllInProject(projectRoot);
        for (const row of rows) {
          const key = row.type;
          if (key && key in counts) counts[key] = (counts[key] ?? 0) + 1;
        }
      } catch {
        // SSoT not initialised — leave the zero-filled counts in place.
      }
    }

    cliOutput(
      {
        version: 1,
        builtinsCount: kinds.length - extensionsCount,
        extensionsCount,
        kinds,
        ...(counts ? { counts } : {}),
        ...(configError ? { configError } : {}),
      },
      { command: 'docs schema', operation: 'docs.schema' },
    );
  },
});

// ── cleo docs list-types ─────────────────────────────────────────────────────

/**
 * `cleo docs list-types` — human-readable table of every registered kind.
 *
 * Columns: kind, label, count (when `--counts`), requiresEntityId, publishDir.
 * In JSON mode emits a LAFS envelope mirroring the table's rows.
 *
 * @task T9788
 */
const listTypesCommand = defineCommand({
  meta: {
    name: 'list-types',
    description:
      'List every registered doc kind with its label, publish directory, and ' +
      'slug-pattern requirement. Use --counts to include per-kind attachment counts ' +
      'from the project SSoT (T9788).',
  },
  args: {
    counts: {
      type: 'boolean',
      description: 'Include per-kind attachment counts from the project SSoT',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const { registry, configError } = loadCliRegistry(projectRoot);
    const kinds = registry.list().map(toWireKind);

    let counts: Record<string, number> | undefined;
    if (args.counts) {
      counts = {};
      const { createAttachmentStore } = await import('@cleocode/core/internal');
      const store = createAttachmentStore();
      for (const k of kinds) counts[k.kind] = 0;
      try {
        const rows = await store.listAllInProject(projectRoot);
        for (const row of rows) {
          const key = row.type;
          if (key && key in counts) counts[key] = (counts[key] ?? 0) + 1;
        }
      } catch {
        // SSoT not initialised — leave the zero-filled counts in place.
      }
    }

    const rows = kinds.map((k) => ({
      kind: k.kind,
      label: k.label,
      ...(counts ? { count: counts[k.kind] ?? 0 } : {}),
      requiresEntityId: k.requiresEntityId,
      publishDir: k.publishDir,
      isExtension: k.isExtension,
    }));

    cliOutput(
      {
        version: 1,
        total: rows.length,
        rows,
        ...(configError ? { configError } : {}),
      },
      {
        command: 'docs list-types',
        operation: 'docs.list-types',
        message: configError ? `loaded built-ins only — ${configError.message}` : undefined,
      },
    );
  },
});

/**
 * Root docs command group — attachment management, llmtxt primitives, drift detection,
 * and git⇄llmtxt round-trip (publish/sync/status) per Saga T9625 / Epic T9626.
 *
 * Subcommands: add, list, fetch, remove, generate, export,
 *              search, merge, graph, rank, versions, publish,
 *              sync, status, gap-check, import, schema, list-types.
 */
export const docsCommand = defineCommand({
  meta: {
    name: 'docs',
    description:
      'Documentation attachment management (add/list/fetch/remove), ' +
      'llmtxt primitives (search/merge/graph/rank/versions/publish), ' +
      'PR publishing (publish-pr), drift detection (sync/status/gap-check), ' +
      'legacy .md migration (import), ' +
      'and a local web viewer (serve/open/stop/viewer-status)',
  },
  subCommands: {
    add: addCommand,
    update: updateCommand,
    list: listCommand,
    fetch: fetchCommand,
    remove: removeCommand,
    generate: generateCommand,
    export: exportCommand,
    search: searchCommand,
    merge: mergeCommand,
    graph: graphCommand,
    rank: rankCommand,
    versions: versionsCommand,
    publish: publishCommand,
    'publish-pr': publishPrCommand,
    sync: syncCommand,
    status: statusCommand,
    'gap-check': gapCheckCommand,
    import: importCommand,
    // T9788 — canonical doc-kind taxonomy discovery surface.
    schema: schemaCommand,
    'list-types': listTypesCommand,
    ...docsViewerSubcommands,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
