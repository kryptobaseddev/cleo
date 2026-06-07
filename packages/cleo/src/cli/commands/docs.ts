/**
 * CLI docs command — canonical seven-verb path: add, update, fetch, list, remove, publish, check.
 *
 * Publish: consolidated `publish` verb (--target file|pr, --dry-run) (T11177).
 *   publish-pr retained as deprecated migration alias.
 * Query: query (consolidates search, find, rank) (T11133/T11176).
 * Advanced: supersede, generate, export, merge, graph, versions.
 * Legacy/migration: sync, status, gap-check, import, search, find, rank, publish-pr.
 * Utilities: schema (doc-kind taxonomy discovery), serve, open, stop, viewer-status.
 * Migration alias: list-types to schema (T11142).
 *
 * @task T11046, T11133/T11176 (query), T11177 (publish), T11142 (unify schema/list-types)
 * @saga T10516
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DocKindConfigError,
  type DocKindMetadata,
  DocKindRegistry,
  ExitCode,
} from '@cleocode/contracts';
import { pushWarning } from '@cleocode/core';
import { createDocsReadModel } from '@cleocode/core/docs/docs-read-model';
import {
  CleoError,
  CounterMismatchError,
  checkSlugSimilarity,
  DEFAULT_SIMILARITY_MODE,
  DEFAULT_SIMILARITY_THRESHOLD,
  detectStrayCleoDb,
  getAgentOutputsAbsolute,
  getProjectRoot,
  readJson,
  resolveWorktreeFilePath,
  resolveWorktreeRouting,
} from '@cleocode/core/internal';
import { describeOperation } from '@cleocode/lafs';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { loadCanonRegistry } from '../../dispatch/domains/check/canon-docs.js';
import { resolve as resolveOperation } from '../../dispatch/registry.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
import { assertKnownFlags, UnknownFlagError } from '../lib/strict-args.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';
import { auditCommand } from './docs/audit.js';
// T10164 — DocProvenanceResponse-typed graph verb (`--root <slug>|<taskId>`).
import { graphCommand as provenanceGraphCommand } from './docs/graph.js';
// T11875 — display-alias assignment verb (`set-alias <slug> <number>`).
import { setAliasCommand } from './docs/set-alias.js';
import { docsViewerSubcommands } from './docs-viewer.js';

const docsOutputFlagHelp =
  '  --json                 Emit the canonical LAFS JSON envelope (also accepted as a global flag)\n' +
  '  --output <mode>        Re-render the result as envelope|id|table|count|silent (also accepted as a global flag)';

const docsOutputArgs = {
  json: {
    type: 'boolean',
    description:
      'Emit the canonical LAFS JSON envelope (global output flag; accepted here for docs-command consistency).',
  },
  output: {
    type: 'string',
    description:
      'Output mode: envelope|id|table|count|silent (global output flag; accepted here for docs-command consistency).',
  },
} as const;

async function dispatchDocsRaw(
  gateway: 'query' | 'mutate',
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await dispatchRaw(gateway, 'docs', operation, params);
  handleRawError(response, { command: 'docs', operation: `docs.${operation}` });
  return response.data;
}

/**
 * Read a document body from stdin for `cleo docs add --content -` (T10965).
 *
 * Drains piped stdin fully and strips a single trailing newline (the shell
 * convention for here-docs / `echo`), preserving all internal whitespace so
 * the stored blob byte-matches the piped source. When stdin is a TTY (no
 * pipe) the caller would block forever; we short-circuit to an empty string
 * so the downstream "no source" validation produces an actionable error.
 */
async function readDocBodyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  return buf.replace(/\r?\n$/, '');
}

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
      '  [file]                 Local file path to attach — optional when --url/--content is set\n\n' +
      'Named arguments:\n' +
      '  --url <url>            Remote URL to attach (instead of a local file)\n' +
      "  --content <text>       Inline document body — author without a file (T10965); '-' reads stdin\n" +
      '  --desc <text>          Free-text description of this attachment\n' +
      '  --labels <csv>         Comma-separated labels (e.g. rfc,spec)\n' +
      '  --attached-by <name>   Agent identity that created the attachment (default: "human")\n' +
      '  --slug <kebab>         Human-friendly alias, unique per project (T9636)\n' +
      '  --title <text>         Human-readable title — REQUIRED for --type adr when --slug is omitted (T10360)\n' +
      '  --type <kind>          Taxonomy classification — run `cleo docs schema` for kinds\n' +
      '  --allow-similar        Bypass the slug-similarity warn — every bypass is audited\n' +
      '                         to .cleo/audit/similar-bypass.jsonl (T10361)\n' +
      '  --strict               Enforce body-schema (requiredSections) — fail with\n' +
      '                         E_DOC_SCHEMA_MISMATCH instead of warning (T10160)\n' +
      docsOutputFlagHelp +
      '\n\n' +
      'Validation behaviors:\n' +
      '  • Unknown flags → E_UNKNOWN_FLAG with did-you-mean suggestions (T10359)\n' +
      '  • Slug collision → E_SLUG_RESERVED + 3 alternative slugs (T10386)\n' +
      '  • Near-duplicate slug → W_SLUG_SIMILAR warning unless --allow-similar (T10361)\n' +
      '  • For --type adr without --slug, slug auto-allocates as `adr-NNN-<kebab-title>` via the\n' +
      '    central allocator (T10360 — closes T10153). --title is required in this case.',
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
    content: {
      type: 'string',
      description:
        'Inline document body — author a doc without a pre-existing file (T10965). ' +
        "Pass '-' to read the body from stdin. Mutually exclusive with the file positional and --url.",
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
    title: {
      type: 'string',
      description:
        'Human-readable title used to derive the kebab-slug tail when auto-allocating an ' +
        'ADR slug. REQUIRED when --type adr is set AND --slug is omitted. Slugified via the ' +
        'shared kebabize helper (lowercase, hyphen-separated, diacritics stripped) (T10360).',
    },
    type: {
      type: 'string',
      description:
        'Taxonomy classification — run `cleo docs schema` to enumerate registered kinds (T9637 / T9788 / T11142)',
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
    ...docsOutputArgs,
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
    const contentArg = typeof args.content === 'string' ? args.content : undefined;
    const allowSimilar = args['allow-similar'] === true;

    // T10965 — inline authoring. Exactly one source must be supplied; the
    // three write distinct attachment kinds so they cannot be combined.
    const sourceCount = (fileArg ? 1 : 0) + (url ? 1 : 0) + (contentArg !== undefined ? 1 : 0);
    if (sourceCount === 0) {
      cliError('provide a file path (positional), --url <url>, or --content <text>', 6, {
        name: 'E_VALIDATION',
        fix: 'Example: cleo docs add T123 docs/rfc.md --desc "RFC draft" — or — cleo docs add T123 --content "# Note" --slug my-note',
      });
      process.exit(6);
    }
    if (sourceCount > 1) {
      cliError('the file positional, --url, and --content are mutually exclusive', 6, {
        name: 'E_VALIDATION',
        fix: 'Pass exactly one source: a file path, --url <url>, or --content <text>.',
      });
      process.exit(6);
    }

    // T10965 — `--content -` reads the document body from stdin so large or
    // multi-line bodies can be piped in (e.g. `cat draft.md | cleo docs add
    // T1 --content - --slug draft`).
    let content = contentArg;
    if (content === '-') {
      content = await readDocBodyFromStdin();
    }

    // T10360 — `--type adr` without `--slug` requires `--title` for the
    // auto-allocator's kebab-title tail. Surfacing this at the CLI layer
    // keeps the error close to the operator's input so the fix hint is
    // copy-pasteable.
    if (args.type === 'adr' && !args.slug && !args.title) {
      cliError(
        '--title <text> is required when --type adr is used without --slug — ' +
          'the allocator needs a title to assemble adr-NNN-<kebab-title>',
        6,
        {
          name: 'E_VALIDATION',
          fix: 'Re-run with --title "Adopt Drizzle v1 beta" (or pass --slug adr-042-explicit-name to bypass auto-allocation).',
        },
      );
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
        ...(content !== undefined ? { content } : {}),
        ...(args.desc ? { desc: args.desc } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
        ...(args['attached-by'] ? { attachedBy: args['attached-by'] } : {}),
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.title ? { title: args.title } : {}),
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
      'control the browsing window (T9792). ' +
      'Output flags: --json and --output envelope|id|table|count|silent are accepted consistently.',
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
    // T9922 — MVI record projection opt-out flags (surfaced for --help).
    verbose: {
      type: 'boolean',
      description:
        'Return full attachment records instead of the MVI projection (id + slug + type + kind + sha + size + createdAt). T9922.',
    },
    full: {
      type: 'boolean',
      description: 'Alias for --verbose. T9922.',
    },
    ...docsOutputArgs,
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
      'Retrieve attachment metadata and bytes by slug, attachment ID (att_*), or SHA-256 hex. ' +
      'Files <= 1 MB are returned base64-encoded inline; larger files report the storage path only. ' +
      'Pass --content (alias --decoded) to emit the decoded UTF-8 document body to stdout instead ' +
      'of the LAFS envelope — the agent-friendly shortcut over piping bytesBase64 through base64 -d (T10970). ' +
      'Output flags: --json and --output envelope|id|table|count|silent are accepted consistently.',
  },
  args: {
    'attachment-ref': {
      type: 'positional',
      description: 'Slug, attachment ID (att_*), or SHA-256 hex',
      required: true,
    },
    // T10970 — decoded-text content mode. An explicit opt-out from the
    // default envelope contract (ADR-086) that streams the raw UTF-8 body
    // to stdout, mirroring the other text-payload commands (export,
    // llm-output, view --render markdown).
    content: {
      type: 'boolean',
      description:
        'Emit the decoded UTF-8 document body to stdout instead of the LAFS envelope (text docs only). ' +
        'Replaces the `--field /data/bytesBase64 | base64 -d` two-step (T10970).',
    },
    decoded: {
      type: 'boolean',
      description: 'Alias for --content (T10970).',
    },
    // T9922 — MVI record projection opt-out flags (surfaced for --help).
    verbose: {
      type: 'boolean',
      description:
        'Return the full attachment metadata block instead of the MVI projection. The byte payload is always returned. T9922.',
    },
    full: {
      type: 'boolean',
      description: 'Alias for --verbose. T9922.',
    },
    ...docsOutputArgs,
  },
  async run({ args }) {
    const ref = String(args['attachment-ref']);

    // T10970 — decoded-text content mode. Resolve through the canonical
    // DocsReadModel (same surface the envelope path uses) and write the raw
    // UTF-8 body to stdout. This is an explicit opt-out from the one-envelope
    // ADR-086 contract, treated like the other raw-payload text modes
    // (`docs export`, `docs llm-output`, `docs view --render markdown`).
    if (args.content === true || args.decoded === true) {
      const model = createDocsReadModel();
      const result = await model.fetchDecoded(ref);
      if (!result.ok) {
        if (result.reason === 'not-found') {
          cliError(`Doc not found: ${ref}`, ExitCode.NOT_FOUND, {
            name: 'E_NOT_FOUND',
            fix: 'List available docs with: cleo docs list',
          });
        } else {
          cliError(`Content not retrievable: ${ref}`, ExitCode.NOT_FOUND, {
            name: 'E_NOT_FOUND',
            fix: 'The doc metadata exists but its blob may be missing. Try: cleo docs publish <slug>',
          });
        }
        process.exit(ExitCode.NOT_FOUND);
      }

      // Raw document body is the user-requested output of this mode —
      // emitted to stdout for piping. Not chrome.
      process.stdout.write(result.content); // stdout-discipline-allowed: decoded-text fetch payload (T10970) // stdout-write-allowed: decoded-text fetch payload (T10970)
      if (!result.content.endsWith('\n')) {
        process.stdout.write('\n'); // stdout-discipline-allowed: trailing newline for decoded payload (T10970) // stdout-write-allowed: trailing newline for decoded payload (T10970)
      }
      return;
    }

    await dispatchFromCli(
      'query',
      'docs',
      'fetch',
      { attachmentRef: ref },
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
      'When refCount reaches zero the blob file is purged from disk. ' +
      'Output flags: --json and --output envelope|id|table|count|silent are accepted consistently.',
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
    ...docsOutputArgs,
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

// ── cleo docs supersede ──────────────────────────────────────────────────────

/**
 * `cleo docs supersede <oldSlug> <newSlug> [--reason "..."]`
 *
 * Atomically supersedes one doc with another. Flips
 * `attachments.lifecycle_status` on the older row to `'superseded'`, sets the
 * `superseded_by` FK pointer to the new row, and sets `supersedes` on the new
 * row back to the old. All three writes commit inside a single
 * `BEGIN IMMEDIATE` transaction via the `openCleoDb` chokepoint.
 *
 * The supersession edge surfaced by `cleo docs provenance` (T10166) is
 * reconstructed at read time from these FK pointers — no dedicated edges
 * table exists. The deterministic `edgeId` returned on the envelope
 * (`supersedes:<newId>-><oldId>`) is the same handle future provenance reads
 * will quote.
 *
 * @task T10162 (Saga T9855 · Epic T10157 · ADR-078)
 */
const supersedeCommandArgs = {
  oldSlug: {
    type: 'positional',
    description: 'Slug of the doc being replaced',
    required: true,
  },
  newSlug: {
    type: 'positional',
    description: 'Slug of the doc that replaces oldSlug',
    required: true,
  },
  reason: {
    type: 'string',
    description: 'Optional human-readable reason carried back on the response envelope',
  },
} as const;

const supersedeCommand = defineCommand({
  meta: {
    name: 'supersede',
    description:
      'Atomically supersede an older doc with a newer one: flips lifecycle_status to ' +
      "'superseded' on the old row and links both rows via the supersedes/superseded_by " +
      'FK pointers. All writes commit in a single SQLite transaction.',
  },
  args: supersedeCommandArgs,
  async run({ args, rawArgs }) {
    // T11179: supersede is deprecated.
    pushWarning({
      code: 'W_DEPRECATED_COMMAND',
      message: 'cleo docs supersede is deprecated - use `cleo docs update` for new work (T11179)',
      deprecated: 'docs supersede',
      replacement: 'docs update',
    });
    try {
      assertKnownFlags(rawArgs, supersedeCommandArgs, 'docs supersede');
    } catch (err) {
      if (err instanceof UnknownFlagError) {
        cliError(err.message, ExitCode.VALIDATION_ERROR, { name: 'E_VALIDATION' });
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      throw err;
    }

    const oldSlug = args.oldSlug;
    const newSlug = args.newSlug;
    const reason =
      typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : undefined;

    await dispatchFromCli(
      'mutate',
      'docs',
      'supersede',
      {
        oldSlug,
        newSlug,
        ...(reason !== undefined ? { reason } : {}),
      },
      { command: 'docs supersede' },
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
    // T11179/T11137: generate is deprecated — use unified llm-output.
    humanInfo(
      `cleo: docs generate is deprecated — use \`cleo docs llm-output --for ${args.for} --mode attachment-bundle\` (T11137)`,
    );
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
      const result = (await dispatchDocsRaw('query', 'llm-output', {
        mode: 'task-export',
        taskId,
        includeAttachments,
        includeMemoryRefs,
      })) as { content: string; sectionCount: number };

      let writtenPath: string | undefined;
      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.content, 'utf8');
        writtenPath = outPath;
      }

      if (args.json) {
        cliOutput(
          { markdown: result.content, pages: result.sectionCount, path: writtenPath ?? null },
          { command: 'docs export', operation: 'docs.export' },
        );
      } else {
        // Human mode: print markdown to stdout, report path to stderr
        if (writtenPath) {
          humanInfo(`Wrote ${result.sectionCount} page(s) to ${writtenPath}`);
        } else {
          // Markdown payload is the user-requested output of this command —
          // emitted to stdout for piping. Not chrome.
          process.stdout.write(result.content); // stdout-write-allowed: markdown piping (T10164) // stdout-discipline-allowed: same (T10163)
          if (!result.content.endsWith('\n')) process.stdout.write('\n'); // stdout-write-allowed: trailing newline (T10164) // stdout-discipline-allowed: same (T10163)
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

// ── cleo docs llm-output (T11137) — unified LLM output surface ──────────────

/**
 * cleo docs llm-output — unified LLM output: task export + attachment bundle.
 *
 * Replaces `docs export` and `docs generate` with a single --mode flag.
 * @task T11137 @saga T10516 @epic T10517
 */
export const _llmOutputCommand = defineCommand({
  meta: {
    name: 'llm-output',
    description:
      'Unified LLM output: task export (rich Markdown with frontmatter + body + attachments + memory refs) ' +
      'or attachment-bundle (llms.txt summarising all attachments). Replaces `docs export` and `docs generate`.',
  },
  args: {
    for: {
      type: 'string',
      description: 'Target entity ID (T###, ses_*, O-*, D-*, L-*, P-*)',
      required: true,
    },
    mode: {
      type: 'string',
      description: "Output mode: 'task-export' or 'attachment-bundle' (auto-detected)",
    },
    out: { type: 'string', description: 'Output file path. Omit for stdout.' },
    'include-attachments': {
      type: 'boolean',
      default: true,
      description: 'Append attachment manifest (task-export, default: true)',
    },
    'include-memory-refs': {
      type: 'boolean',
      default: false,
      description: 'Append BRAIN memory refs (task-export, default: false)',
    },
    attach: {
      type: 'boolean',
      description: 'Save as llms-txt attachment on target (attachment-bundle)',
    },
    ...docsOutputArgs,
  },
  async run({ args }) {
    const forId = String(args.for);
    const projectRoot = getProjectRoot();
    try {
      const result = (await dispatchDocsRaw('query', 'llm-output', {
        for: forId,
        ...(typeof args.mode === 'string' ? { mode: args.mode } : {}),
        includeAttachments: args['include-attachments'] !== false,
        includeMemoryRefs: args['include-memory-refs'] === true,
        ...(args.attach ? { attach: true } : {}),
      })) as {
        forId: string;
        mode: string;
        content: string;
        sectionCount: number;
        usedLlmtxtPackage: boolean;
        attached?: boolean;
        attachmentId?: string;
        attachmentSha256?: string;
      };

      let writtenPath: string | undefined;
      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.content, 'utf8');
        writtenPath = outPath;
      }
      if (args.json) {
        cliOutput(
          {
            forId: result.forId,
            mode: result.mode,
            content: result.content,
            sectionCount: result.sectionCount,
            usedLlmtxtPackage: result.usedLlmtxtPackage,
            attached: result.attached,
            attachmentId: result.attachmentId,
            attachmentSha256: result.attachmentSha256,
            path: writtenPath ?? null,
          },
          { command: 'docs llm-output', operation: 'docs.llm-output' },
        );
      } else {
        if (writtenPath) {
          humanInfo(
            `Wrote ${result.sectionCount} ${result.mode === 'task-export' ? 'page(s)' : 'section(s)'} to ${writtenPath}`,
          );
        } else {
          process.stdout.write(result.content); // stdout-discipline-allowed: raw markdown payload passthrough // stdout-write-allowed: raw markdown payload passthrough
          if (!result.content.endsWith('\n')) process.stdout.write('\n'); // stdout-discipline-allowed: preserve trailing newline for raw payload // stdout-write-allowed: preserve trailing newline for raw payload
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs llm-output failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_LLM_OUTPUT_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs llm-output (T11137) — unified LLM output surface ──────────────

/** cleo docs llm-output — unified LLM output: task export + attachment bundle. @task T11137 */
const llmOutputCommand = defineCommand({
  meta: {
    name: 'llm-output',
    description:
      'Unified LLM output: task export (rich Markdown) or attachment-bundle (llms.txt). Replaces `docs export` and `docs generate`.',
  },
  args: {
    for: { type: 'string', description: 'Target entity ID', required: true },
    mode: {
      type: 'string',
      description: 'Output mode: task-export|attachment-bundle (auto-detected)',
    },
    out: { type: 'string', description: 'Output file path' },
    'include-attachments': {
      type: 'boolean',
      default: true,
      description: 'Include attachment manifest (task-export)',
    },
    'include-memory-refs': {
      type: 'boolean',
      default: false,
      description: 'Include memory refs (task-export)',
    },
    attach: { type: 'boolean', description: 'Save as llms-txt attachment (attachment-bundle)' },
    ...docsOutputArgs,
  },
  async run({ args }) {
    const forId = String(args.for);
    const projectRoot = getProjectRoot();
    try {
      const result = (await dispatchDocsRaw('query', 'llm-output', {
        for: forId,
        ...(typeof args.mode === 'string' ? { mode: args.mode } : {}),
        includeAttachments: args['include-attachments'] !== false,
        includeMemoryRefs: args['include-memory-refs'] === true,
        ...(args.attach ? { attach: true } : {}),
      })) as {
        forId: string;
        mode: string;
        content: string;
        sectionCount: number;
        usedLlmtxtPackage: boolean;
        attached?: boolean;
        attachmentId?: string;
        attachmentSha256?: string;
      };
      let writtenPath: string | undefined;
      if (typeof args.out === 'string' && args.out.length > 0) {
        const outPath = isAbsolute(args.out) ? args.out : resolve(projectRoot, args.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.content, 'utf8');
        writtenPath = outPath;
      }
      if (args.json) {
        cliOutput(
          {
            forId: result.forId,
            mode: result.mode,
            content: result.content,
            sectionCount: result.sectionCount,
            usedLlmtxtPackage: result.usedLlmtxtPackage,
            attached: result.attached,
            attachmentId: result.attachmentId,
            attachmentSha256: result.attachmentSha256,
            path: writtenPath ?? null,
          },
          { command: 'docs llm-output', operation: 'docs.llm-output' },
        );
      } else {
        if (writtenPath) {
          humanInfo(
            `Wrote ${result.sectionCount} ${result.mode === 'task-export' ? 'page(s)' : 'section(s)'} to ${writtenPath}`,
          );
        } else {
          process.stdout.write(result.content); // stdout-discipline-allowed: raw markdown payload passthrough // stdout-write-allowed: raw markdown payload passthrough
          if (!result.content.endsWith('\n')) process.stdout.write('\n'); // stdout-discipline-allowed: preserve trailing newline for raw payload // stdout-write-allowed: preserve trailing newline for raw payload
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs llm-output failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_LLM_OUTPUT_FAILED',
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
    const limit = args.limit ? Number.parseInt(String(args.limit), 10) : 10;
    try {
      const result = await dispatchDocsRaw('query', 'search', {
        query: String(args.query),
        ...(args.owner ? { ownerId: String(args.owner) } : {}),
        limit,
        ...(args.type ? { type: String(args.type) } : {}),
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

// ── cleo docs find ────────────────────────────────────────────────────────────

/**
 * `cleo docs find --similar <slug>` — surface llmtxt/similarity.rankBySimilarity
 * over an existing seed doc.
 *
 * Useful for agents asking "what's already been written about X?" before
 * drafting a new doc. Ranks every other published doc against the seed's
 * content, filtered (by default) to the same DocKind. Pass `--all-kinds`
 * to disable the kind filter and rank cross-kind.
 *
 * The JSON envelope mirrors the AC contract:
 * `{ seedSlug, seedKind, totalCandidates, hits: [{ slug, kind, score, summary, lifecycle_status }] }`.
 *
 * @task T10163 (Epic T10157 · Saga T9855 · E12.C6)
 */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description:
      'Find docs similar to a seed slug via llmtxt/similarity.rankBySimilarity. ' +
      'Pass --similar <slug>; results default to the same DocKind as the seed. ' +
      'Use --all-kinds to rank cross-kind, --threshold to set the minimum cosine ' +
      'score, and --limit to cap the number of returned hits.\n\n' +
      'Named arguments:\n' +
      '  --similar <slug>       Slug of the seed doc to anchor similarity against (required for now)\n' +
      '  --limit <n>            Maximum number of hits to return (default 10)\n' +
      '  --threshold <0..1>     Minimum cosine score, hits below are dropped (default 0.5)\n' +
      '  --all-kinds            Disable the same-kind filter and rank cross-kind\n' +
      '  --json                 Emit LAFS JSON envelope (default for non-TTY)',
  },
  args: {
    similar: {
      type: 'string',
      description: 'Slug of the seed doc to anchor similarity against',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of hits to return (default: 10)',
    },
    threshold: {
      type: 'string',
      description: 'Minimum cosine similarity score in [0, 1] (default: 0.5)',
    },
    'all-kinds': {
      type: 'boolean',
      description: 'Disable the same-kind filter and rank across every DocKind',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope instead of human-readable output',
    },
  },
  async run({ args, rawArgs }) {
    try {
      assertKnownFlags(rawArgs, findCommand.args, 'docs find');
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

    const similarSlug = typeof args.similar === 'string' ? args.similar.trim() : '';
    if (similarSlug.length === 0) {
      cliError('--similar <slug> is required', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
        fix: 'Example: `cleo docs find --similar adr-073-above-epic-naming --limit 5`.',
      });
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    // Parse numeric flags with explicit validation so we emit structured
    // errors instead of forwarding NaN into the core helper.
    let limit: number | undefined;
    if (typeof args.limit === 'string') {
      const parsed = Number.parseInt(args.limit, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        cliError(
          `--limit must be a positive integer (got "${args.limit}")`,
          ExitCode.VALIDATION_ERROR,
          {
            name: 'E_VALIDATION',
          },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      limit = parsed;
    }

    let threshold: number | undefined;
    if (typeof args.threshold === 'string') {
      const parsed = Number.parseFloat(args.threshold);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        cliError(
          `--threshold must be a number in [0, 1] (got "${args.threshold}")`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      threshold = parsed;
    }

    const allKinds = args['all-kinds'] === true;

    try {
      const result = await dispatchDocsRaw('query', 'find', {
        similarSlug,
        ...(limit !== undefined ? { limit } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        allKinds,
      });
      cliOutput(result, { command: 'docs find', operation: 'docs.find' });
    } catch (err) {
      const code =
        err instanceof Error && typeof (err as Error & { code?: string }).code === 'string'
          ? (err as Error & { code: string }).code
          : 'E_DOCS_FIND_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs find failed: ${message}`, ExitCode.GENERAL_ERROR, { name: code });
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
      const result = (await dispatchDocsRaw('query', 'merge', {
        attA: String(args.attA),
        attB: String(args.attB),
        strategy,
        base: args.base ?? undefined,
      })) as { merged: string };

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

// ── cleo docs query ──────────────────────────────────────────────────────────
//
// Unified search/find/rank surface — single entry point that routes to the
// appropriate llmtxt/similarity primitive based on the provided flags.
//
// @task T11176 (T10516-F1 — consolidate search/find/rank)
// @saga T10516

const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description:
      'Unified docs query surface: semantic search, similar-doc discovery, and entity ranking. ' +
      'Subsumes the legacy search, find, and rank subcommands into one consistent surface.\n\n' +
      'Modes (mutually exclusive):\n' +
      '  cleo docs query "<text>"       Free-text search\n' +
      '  cleo docs query --similar <slug>  Find similar to a slug\n' +
      '  cleo docs query --for <id>     Rank for an entity\n\n' +
      'Common flags: --limit <n>, --type <kind>, --json\n' +
      'Free-text search flags: --owner <id>\n' +
      'Similar-to-slug flags: --threshold <0..1>, --all-kinds\n' +
      'Entity-ranking flags: --text "<query>"\n\n' +
      docsOutputFlagHelp,
  },
  args: {
    query: {
      type: 'positional',
      description: 'Free-text query for semantic search',
      required: false,
    },
    similar: {
      type: 'string',
      description: 'Slug of seed doc to find similar docs against (find mode)',
    },
    for: {
      type: 'string',
      description: 'Owner entity ID to rank attachments for (rank mode)',
    },
    text: {
      type: 'string',
      description: 'Custom query string for the rank mode (default: owner ID)',
    },
    type: {
      type: 'string',
      description: 'Filter by taxonomy type: spec|adr|research|handoff|note|llm-readme',
    },
    owner: {
      type: 'string',
      description: 'Scope free-text search to a specific owner entity ID',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results to return (default: 10)',
    },
    threshold: {
      type: 'string',
      description: 'Minimum cosine similarity score in [0, 1] (for --similar mode, default: 0.5)',
    },
    'all-kinds': {
      type: 'boolean',
      description:
        'Disable the same-kind filter and rank across every DocKind (for --similar mode)',
    },
    ...docsOutputArgs,
  },
  async run({ args, rawArgs }) {
    try {
      assertKnownFlags(rawArgs, queryCommand.args, 'docs query');
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

    const similarSlug = typeof args.similar === 'string' ? args.similar.trim() : '';
    const forId = typeof args.for === 'string' ? args.for.trim() : '';
    const textQuery = typeof args.query === 'string' ? String(args.query) : '';
    const customQuery = typeof args.text === 'string' ? String(args.text) : undefined;
    const typeFilter = typeof args.type === 'string' ? String(args.type) : undefined;
    const ownerScope = typeof args.owner === 'string' ? String(args.owner) : undefined;

    const modes = [];
    if (similarSlug.length > 0) modes.push('--similar');
    if (forId.length > 0) modes.push('--for');
    if (textQuery.length > 0) modes.push('<query>');

    if (modes.length === 0) {
      cliError(
        'docs query requires a query mode: pass a free-text <query>, --similar <slug>, or --for <id>',
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION',
          fix: 'Examples: cleo docs query "authentication flow" | cleo docs query --similar adr-073 | cleo docs query --for T123',
        },
      );
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    if (modes.length > 1) {
      cliError(
        `docs query modes are mutually exclusive — got ${modes.join(', ')}. Choose one.`,
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION',
          fix: 'Pass exactly one of: free-text <query>, --similar <slug>, or --for <id>',
        },
      );
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    let limit: number | undefined;
    if (typeof args.limit === 'string') {
      const parsed = Number.parseInt(args.limit, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        cliError(
          `--limit must be a positive integer (got "${args.limit}")`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      limit = parsed;
    }

    let threshold: number | undefined;
    if (typeof args.threshold === 'string') {
      const parsed = Number.parseFloat(args.threshold);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        cliError(
          `--threshold must be a number in [0, 1] (got "${args.threshold}")`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      threshold = parsed;
    }

    const allKinds = args['all-kinds'] === true;

    try {
      if (similarSlug.length > 0) {
        const result = await dispatchDocsRaw('query', 'find', {
          similarSlug,
          ...(limit !== undefined ? { limit } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          allKinds,
        });
        cliOutput(result, { command: 'docs query', operation: 'docs.find' });
      } else if (forId.length > 0) {
        const result = await dispatchDocsRaw('query', 'rank', {
          ownerId: forId,
          query: customQuery ?? undefined,
        });
        cliOutput(result, { command: 'docs query', operation: 'docs.rank' });
      } else {
        const result = await dispatchDocsRaw('query', 'search', {
          query: textQuery,
          ...(ownerScope ? { ownerId: ownerScope } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
        });
        cliOutput(result, { command: 'docs query', operation: 'docs.search' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof Error && typeof (err as Error & { code?: string }).code === 'string'
          ? (err as Error & { code: string }).code
          : 'E_DOCS_QUERY_FAILED';
      cliError(`docs query failed: ${message}`, ExitCode.GENERAL_ERROR, { name: code });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ── cleo docs graph (moved to ./docs/graph.ts in T10164) ─────────────────────
//
// The legacy `--for <id>` llmtxt-backed graph was replaced by the T10166
// DocProvenanceResponse contract per ADR-078 §4. The new `--root <slug>|<taskId>`
// implementation lives in ./docs/graph.ts and is wired below via
// `provenanceGraphCommand` so the `subCommands.graph` slot stays unchanged for
// existing callers.

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
    try {
      const result = await dispatchDocsRaw('query', 'rank', {
        ownerId: String(args.for),
        query: args.query ?? undefined,
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

const docsUpdateOperation = resolveOperation('mutate', 'docs', 'update')?.def;
if (docsUpdateOperation === undefined) {
  throw new Error('docs.update operation is missing from the registry');
}
const docsUpdateSchema = describeOperation(docsUpdateOperation, {
  includeGates: false,
  includeExamples: true,
});
const docsUpdateArgs = paramsToCittyArgs(getOperationParams('mutate', 'docs', 'update'));
const docsUpdateCliArgs = {
  ...docsUpdateArgs,
  ...docsOutputArgs,
} as const;

function toKebabFlag(name: string): string {
  return name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function formatDocsUpdateContractHelp(): string {
  const positional = docsUpdateSchema.params.filter((param) => param.cli?.positional === true);
  const named = docsUpdateSchema.params.filter((param) => param.cli?.positional !== true);
  const lines: string[] = [
    docsUpdateSchema.description,
    '',
    'Positional arguments:',
    ...positional.map((param) => `  <${param.name}>                 ${param.description}`),
    '',
    'Named arguments:',
    ...named.map((param) => {
      const flag = param.cli?.flag ?? toKebabFlag(param.name);
      const enumSuffix = param.enum !== undefined ? ` (${param.enum.join('|')})` : '';
      return `  --${flag} <${param.type}>          ${param.description}${enumSuffix}`;
    }),
  ];
  if ((docsUpdateSchema.examples ?? []).length > 0) {
    lines.push('', 'Examples:');
    for (const example of docsUpdateSchema.examples ?? []) {
      lines.push(`  ${example.command}`, `    ${example.description}`);
    }
  }
  lines.push(
    '',
    'Output flags:',
    docsOutputFlagHelp,
    '',
    'Renderer support: this command shares the registry schema surfaced by `cleo schema docs.update --format human --include-examples`.',
  );
  return lines.join('\n');
}

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
    description: formatDocsUpdateContractHelp(),
  },
  args: docsUpdateCliArgs,
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
        ...(args['allow-external'] === true ? { allowExternal: true } : {}),
        ...(inlineContent !== undefined ? { content: inlineContent } : {}),
        ...(typeof args.message === 'string' ? { message: args.message } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        ...(args['dry-run'] === true ? { dryRun: true } : {}),
        ...(args.strict === true ? { strict: true } : {}),
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
    try {
      const result = await dispatchDocsRaw('query', 'versions', {
        ownerId: String(args.for),
        name: args.name ?? undefined,
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

// ── cleo docs publish (unified — T11177) ─────────────────────────────────────

/**
 * cleo docs publish — unified publish surface with --target flag.
 *
 * Two targets:
 *   --target file (default): `--for <id> --to <path>` — atomic publish to git path.
 *   --target pr:            `<slug-or-id>` — open or update a GitHub PR.
 *
 * Common flags:
 *   --dry-run               Preview without side effects.
 *
 * @task T11177 (publish verb consolidation)
 * @saga T10516
 */
const publishCommand = defineCommand({
  meta: {
    name: 'publish',
    description:
      'Publish a doc to a local file (--target file) or a GitHub PR (--target pr). ' +
      'Default target is file. Use --target pr with a slug-or-id to open/update a PR. ' +
      'Use --dry-run to preview without side effects.',
  },
  args: {
    'slug-or-id': {
      type: 'positional',
      description:
        'Slug, attachment id, or full sha256 hex of the doc to publish. Required for --target pr.',
    },
    target: {
      type: 'string',
      description:
        'Publish target: file (local git-tracked path) or pr (GitHub PR). Default: file.',
      default: 'file',
    },
    for: {
      type: 'string',
      description:
        'Owner entity ID whose attachment to publish (T###, ses_*, O-*). Required for --target file.',
    },
    to: {
      type: 'string',
      description:
        'Destination file path (absolute or relative to project root). Required for --target file.',
    },
    attachment: {
      type: 'string',
      description: 'Specific attachment ID or SHA-256 to publish (default: latest)',
    },
    slug: {
      type: 'string',
      description:
        'Override the slug used for the branch + filename. Required when <slug-or-id> is an attachment id or sha256 with no stored slug.',
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
    'dry-run': {
      type: 'boolean',
      description:
        'Preview what would happen without side effects. Reports resolved target, mode, and parameters. No files are written and no git/gh commands are invoked.',
    },
    json: { type: 'boolean', description: 'Emit LAFS JSON envelope' },
  },
  async run({ args }) {
    const target = String(args.target ?? 'file');
    const dryRun = args['dry-run'] === true;
    if (dryRun) {
      const details: Record<string, unknown> = { target, dryRun: true };
      if (target === 'pr') {
        details.slugOrId = String(args['slug-or-id'] ?? '');
        if (args.slug) details.slug = String(args.slug);
        if (args.type) details.type = String(args.type);
        if (args.title) details.title = String(args.title);
      } else {
        details.for = args.for ? String(args.for) : null;
        details.to = args.to ? String(args.to) : null;
        if (args.attachment) details.attachment = String(args.attachment);
      }
      cliOutput(details, { command: 'docs publish', operation: 'docs.publish' });
      return;
    }
    if (target === 'pr') {
      const slugOrId = String(args['slug-or-id'] ?? '');
      if (!slugOrId) {
        cliError(
          'docs publish --target pr requires a slug-or-id argument',
          ExitCode.GENERAL_ERROR,
          { name: 'E_MISSING_ARG' },
        );
        process.exit(ExitCode.GENERAL_ERROR);
      }
      const result = (await dispatchDocsRaw('mutate', 'publish', {
        slugOrId,
        target: 'pr',
        ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
        ...(typeof args.type === 'string' ? { type: args.type } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.body === 'string' ? { body: args.body } : {}),
        ...(typeof args.base === 'string' ? { base: args.base } : {}),
      })) as
        | { success: true; data: unknown }
        | {
            success: false;
            error: {
              message: string;
              codeName: string;
              fix?: string;
              alternatives?: string[];
              details?: Record<string, unknown>;
            };
          };
      if (result.success) {
        cliOutput(result.data, { command: 'docs publish', operation: 'docs.publish' });
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
            ? { alternatives: e.alternatives.map((alt: string) => ({ action: alt, command: alt })) }
            : {}),
          ...(e.details ? { details: e.details } : {}),
        },
        { operation: 'docs.publish' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
    }
    if (!args.for || !args.to) {
      cliError(
        'docs publish --target file requires --for <ownerId> and --to <path>',
        ExitCode.GENERAL_ERROR,
        { name: 'E_MISSING_ARG' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
    }
    try {
      const result = await dispatchDocsRaw('mutate', 'publish', {
        ownerId: String(args.for),
        toPath: String(args.to),
        attachmentId: args.attachment ?? undefined,
        target: 'file',
      });
      cliOutput(result, { command: 'docs publish', operation: 'docs.publish' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs publish failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_PUBLISH_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});
// ── cleo docs publish-pr (backward-compatible alias — T11177) ─────────────────

/**
 * cleo docs publish-pr <slug-or-id> — backward-compatible alias.
 * Delegates to `docs publish --target pr`. Prefer `cleo docs publish --target pr <slug-or-id>` for new usage.
 * @deprecated Use `cleo docs publish --target pr` instead.
 */
const publishPrCommand = defineCommand({
  meta: {
    name: 'publish-pr',
    description:
      '[DEPRECATED] Use `docs publish --target pr` instead. Publish an attachment to a GitHub PR. Opens a new PR on branch `docs/<slug>` with frontmatter, or atomically updates the existing open PR for the same slug. Use --dry-run to preview without side effects.',
  },
  args: {
    'slug-or-id': {
      type: 'positional',
      description: 'Slug, attachment id, or full sha256 hex of the doc to publish',
      required: true,
    },
    slug: { type: 'string', description: 'Override the slug used for the branch + filename.' },
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
    base: { type: 'string', description: 'Base branch for the PR. Default: main.' },
    'dry-run': { type: 'boolean', description: 'Preview what would happen without side effects.' },
  },
  async run({ args }) {
    humanInfo(
      '[deprecated] `docs publish-pr` is deprecated. Use `docs publish --target pr <slug-or-id>` instead.',
    );
    const slugOrId = String(args['slug-or-id']);
    if (args['dry-run'] === true) {
      const details: Record<string, unknown> = { slugOrId, target: 'pr', dryRun: true };
      if (args.slug) details.slug = String(args.slug);
      if (args.type) details.type = String(args.type);
      if (args.title) details.title = String(args.title);
      cliOutput(details, { command: 'docs publish-pr', operation: 'docs.publish' });
      return;
    }
    const result = (await dispatchDocsRaw('mutate', 'publish', {
      slugOrId,
      target: 'pr',
      ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
      ...(typeof args.type === 'string' ? { type: args.type } : {}),
      ...(typeof args.title === 'string' ? { title: args.title } : {}),
      ...(typeof args.body === 'string' ? { body: args.body } : {}),
      ...(typeof args.base === 'string' ? { base: args.base } : {}),
    })) as
      | { success: true; data: unknown }
      | {
          success: false;
          error: {
            message: string;
            codeName: string;
            fix?: string;
            alternatives?: string[];
            details?: Record<string, unknown>;
          };
        };
    if (result.success) {
      cliOutput(result.data, { command: 'docs publish-pr', operation: 'docs.publish' });
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
          ? { alternatives: e.alternatives.map((alt: string) => ({ action: alt, command: alt })) }
          : {}),
        ...(e.details ? { details: e.details } : {}),
      },
      { operation: 'docs.publish' },
    );
    process.exit(ExitCode.GENERAL_ERROR);
  },
});
// ── cleo docs check ───────────────────────────────────────────────────────────

/** Combined results from all check modes. */
interface CheckResults {
  drift?: DriftResult;
  status?: { allInSync: boolean };
  gaps?: GapEntry[];
}

/**
 * cleo docs check — unified drift management surface (T11136).
 *
 * Consolidates sync drift mode, status, and gap-check into a single check subcommand.
 * Running without flags runs all three checks. Use --drift, --status, --gaps for specific checks.
 *
 * @saga T10516
 * @task T11136
 */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description:
      'Unified drift management: check documentation for drift, status, and gaps. ' +
      'Use --drift, --status, --gaps for specific checks; runs all by default.',
  },
  args: {
    drift: {
      type: 'boolean',
      description: 'Run legacy drift check (scripts/ vs COMMANDS-INDEX.json)',
    },
    status: {
      type: 'boolean',
      description: 'Run git⇄llmtxt drift check (published files vs docs SSoT)',
    },
    gaps: { type: 'boolean', description: 'Run knowledge transfer gap check (review docs)' },
    all: {
      type: 'boolean',
      description: 'Run all three checks (default when no mode flag is set)',
    },
    quick: { type: 'boolean', description: 'Drift check only: quick mode (commands only)' },
    strict: { type: 'boolean', description: 'Exit with non-zero code on any drift detection' },
    epic: { type: 'string', description: 'Gap check only: filter by epic ID' },
    task: { type: 'string', description: 'Gap check only: filter by task ID' },
    json: { type: 'boolean', description: 'Emit LAFS JSON envelope' },
  },
  async run({ args }) {
    const hasExplicit = args.drift === true || args.status === true || args.gaps === true;
    const runDrift = args.drift === true || args.all === true || !hasExplicit;
    const runStatus = args.status === true || args.all === true || !hasExplicit;
    const runGaps = args.gaps === true || args.all === true || !hasExplicit;
    const projectRoot = process.cwd();
    const results: CheckResults = {};
    let anyDrift = false;
    try {
      if (runDrift) {
        const r = await detectDrift(projectRoot);
        results.drift = r;
        if (r.status !== 'clean') anyDrift = true;
      }
      if (runStatus) {
        const r = (await dispatchDocsRaw('query', 'status', {})) as { allInSync: boolean };
        results.status = r;
        if (!r.allInSync) anyDrift = true;
      }
      if (runGaps) {
        const r = await runGapCheck(projectRoot, args.epic ?? args.task ?? undefined);
        results.gaps = r;
        if (r.length > 0) anyDrift = true;
      }
      cliOutput(results, {
        command: 'docs check',
        message: anyDrift
          ? 'Drift detected — see results for details'
          : 'All checks passed — no drift detected',
      });
      if (args.strict && anyDrift) process.exit(2);
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'E_DOCS_CHECK_FAILED' });
        process.exit(err.code);
      }
      throw err;
    }
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
        const result = await dispatchDocsRaw('mutate', 'sync', {
          ownerId: String(ownerId),
          fromPath: String(args.from),
          blobName: args.name ?? undefined,
          contentType: args['content-type'] ?? undefined,
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
    try {
      const result = (await dispatchDocsRaw('query', 'status', {})) as { allInSync: boolean };
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

    try {
      const result = await dispatchDocsRaw('mutate', 'import', {
        scanRoot,
        dryRun,
        force,
        manifestPath,
      });

      cliOutput(result, { command: 'docs import', operation: 'docs.import' });
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
      '`cleo docs publish-pr`. (T11142).',
  },
  args: {
    counts: {
      type: 'boolean',
      description: 'Include per-kind attachment counts from the project SSoT',
    },
    'include-counts': {
      type: 'boolean',
      description:
        'DEPRECATED -- use --counts instead. Accepted for backward compatibility but will be removed in a future release.',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const { registry, configError } = loadCliRegistry(projectRoot);
    const kinds = registry.list().map(toWireKind);
    const extensionsCount = kinds.filter((k) => k.isExtension).length;

    // --counts replaces --include-counts (T11142)
    const wantCounts = args.counts === true || args['include-counts'] === true;

    let counts: Record<string, number> | undefined;
    if (wantCounts) {
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
}); // ── cleo docs list-types (migration alias to schema) ────────────────────────────────────────

/**
 * `cleo docs list-types` -- migration alias for `cleo docs schema` (T11142).
 *
 * Redirects to the unified `schema` surface. Emits a deprecation notice so
 * callers learn the canonical verb. All flags (--counts, --include-counts)
 * forward to the schema handler.
 *
 * @task T11142
 */
const listTypesCommand = defineCommand({
  meta: {
    name: 'list-types',
    description:
      'DEPRECATED -- use `cleo docs schema` instead. ' +
      'Lists every registered doc kind (T11142).',
  },
  args: {
    counts: {
      type: 'boolean',
      description: 'Include per-kind attachment counts from the project SSoT',
    },
    'include-counts': {
      type: 'boolean',
      description: 'DEPRECATED -- use --counts instead.',
    },
  },
  async run({ args }) {
    pushWarning({
      code: 'W_DEPRECATED_COMMAND',
      message: 'cleo docs list-types is deprecated -- use `cleo docs schema` instead (T11142)',
      deprecated: 'docs list-types',
      replacement: 'docs schema',
    });
    const projectRoot = getProjectRoot();
    const { registry, configError } = loadCliRegistry(projectRoot);
    const kinds = registry.list().map(toWireKind);
    const extensionsCount = kinds.filter((k) => k.isExtension).length;

    const wantCounts = args.counts === true || args['include-counts'] === true;

    let counts: Record<string, number> | undefined;
    if (wantCounts) {
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
        // SSoT not initialised -- leave the zero-filled counts in place.
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
      {
        command: 'docs list-types',
        operation: 'docs.list-types',
      },
    );
  },
});

/**
 * Root docs command group.
 *
 * Canonical six-verb path: add, update, fetch, list, remove, publish.
 * Publish: consolidated `publish` verb (--target file|pr, --dry-run) (T11177).
 *   publish-pr retained as deprecated migration alias.
 * Query: query (consolidates search, find, rank) (T11133/T11176).
 * Advanced: supersede, generate, export, merge, graph, versions.
 * Legacy/migration: sync, status, gap-check, import, search, find, rank, publish-pr.
 * Viewer: viewer (start/stop/open/status) — legacy serve, open, stop, viewer-status.
 * Utilities: schema (list-types → schema).
 *
 * @task T11046 — simplify docs help around canonical six-verb path
 * @task T11177 — publish verb consolidation across doc CLI
 * @task T11135 — flatten viewer surface into single managed lifecycle
 * @saga T10516
 */
export const docsCommand = defineCommand({
  meta: {
    name: 'docs',
    description:
      'Canonical six-verb docs path: add, update, fetch, list, remove, publish. ' +
      'Unified query: query (subsumes search/find/rank). ' +
      'LLM output: llm-output (replaces generate + export). ' +
      'Advanced: supersede, merge, graph, versions. ' +
      'Audit: audit (query the immutable docs audit trail). ' +
      'Legacy/migration: search, find, rank, sync, status, gap-check, import (use query for new work). ' +
      'Viewer: viewer (start/stop/open/status). Utilities: schema (list-types → schema).',
  },
  subCommands: {
    // T11136 — Unified drift management (consolidates sync/status/gap-check)
    check: checkCommand as ReturnType<typeof defineCommand>, // Canonical six-verb path (add, update, fetch, list, remove, publish)
    add: addCommand,
    update: updateCommand,
    fetch: fetchCommand,
    list: listCommand,
    remove: removeCommand,
    publish: publishCommand,
    // T11176 — unified search/find/rank surface (preferred entry point)
    query: queryCommand,
    // Advanced primitives
    supersede: supersedeCommand,
    generate: generateCommand,
    export: exportCommand,
    'llm-output': llmOutputCommand,
    merge: mergeCommand,
    // T10164 — DocProvenanceResponse-typed graph (`--root <slug>|<taskId>`).
    graph: provenanceGraphCommand,
    // T11875 — display-alias assignment (`set-alias <slug> <number>`), decoupled from slug.
    'set-alias': setAliasCommand,
    // Legacy aliases (use `query` for new work — retained for backward compatibility)
    search: searchCommand,
    find: findCommand,
    rank: rankCommand,
    versions: versionsCommand,
    'publish-pr': publishPrCommand,
    // T11182 — unified docs audit trail
    audit: auditCommand,
    // Legacy/migration (use canonical verbs for new work)
    sync: syncCommand,
    status: statusCommand,
    'gap-check': gapCheckCommand,
    import: importCommand,
    // Utilities
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
