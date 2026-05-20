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
import { ExitCode } from '@cleocode/contracts';
import {
  buildDocsGraph,
  CleoError,
  CounterMismatchError,
  createDocsAccessor,
  exportDocument,
  formatError,
  getAgentOutputsAbsolute,
  getProjectRoot,
  listDocVersions,
  mergeDocs,
  publishDocs,
  rankDocs,
  readJson,
  recordPublication,
  runDocsImport,
  searchDocs,
  statusDocs,
  syncFromGit,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

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
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Attach a local file or remote URL to a CLEO entity (task, session, observation). ' +
      'Owner type is inferred from the ID prefix: T### → task, ses_* → session, O-* → observation. ' +
      'Use --slug to set a human-friendly alias (unique per project) (T9636).',
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
        'Collision returns E_SLUG_TAKEN with 3 alternative suggestions.',
    },
    type: {
      type: 'string',
      description: 'Taxonomy classification: spec|adr|research|handoff|note|llm-readme (T9637)',
    },
  },
  async run({ args }) {
    const ownerId = args['owner-id'];
    const fileArg = args.file ?? undefined;
    const url = args.url ?? undefined;

    if (!fileArg && !url) {
      cliError('provide a file path (positional argument) or --url <url>', 6, {
        name: 'E_VALIDATION',
        fix: 'Example: cleo docs add T123 docs/rfc.md --desc "RFC draft" — or — cleo docs add T123 --url https://example.com/spec',
      });
      process.exit(6);
    }

    await dispatchFromCli(
      'mutate',
      'docs',
      'add',
      {
        ownerId,
        ...(fileArg ? { file: fileArg } : {}),
        ...(url ? { url } : {}),
        ...(args.desc ? { desc: args.desc } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
        ...(args['attached-by'] ? { attachedBy: args['attached-by'] } : {}),
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.type ? { type: args.type } : {}),
      },
      { command: 'docs add' },
    );
  },
});

// ── cleo docs list ───────────────────────────────────────────────────────────

/** cleo docs list [--task T###] [--session ses_*] [--observation O###] [--type TYPE] — list attachments. */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List attachments for a CLEO entity. Provide exactly one of --task, --session, or --observation. ' +
      '--type filters across any scope (T9637).',
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
    type: {
      type: 'string',
      description: 'Filter by classification: spec|adr|research|handoff|note|llm-readme (T9637)',
    },
  },
  async run({ args }) {
    const task = args.task ?? undefined;
    const session = args.session ?? undefined;
    const observation = args.observation ?? undefined;
    const type = args.type ?? undefined;

    if (!task && !session && !observation) {
      cliError('provide one of --task <id>, --session <id>, or --observation <id>', 6, {
        name: 'E_VALIDATION',
      });
      process.exit(6);
    }

    await dispatchFromCli(
      'query',
      'docs',
      'list',
      {
        ...(task ? { task } : {}),
        ...(session ? { session } : {}),
        ...(observation ? { observation } : {}),
        ...(type ? { type } : {}),
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
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs export failed: ${message}`)),
        { command: 'docs export', operation: 'docs.export' },
      );
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
      'Pass --owner to scope the search to a specific entity (T###, ses_*, O-*).',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Free-text search query',
      required: true,
    },
    owner: {
      type: 'string',
      description: 'Scope search to a specific owner entity ID',
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
    try {
      const result = await searchDocs(String(args.query), {
        ownerId: args.owner ?? undefined,
        limit: args.limit ? Number.parseInt(String(args.limit), 10) : 10,
        projectRoot,
      });

      cliOutput(result, { command: 'docs search', operation: 'docs.search' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs search failed: ${message}`)),
        { command: 'docs search', operation: 'docs.search' },
      );
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
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs merge failed: ${message}`)),
        { command: 'docs merge', operation: 'docs.merge' },
      );
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
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs graph failed: ${message}`)),
        { command: 'docs graph', operation: 'docs.graph' },
      );
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
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs rank failed: ${message}`)),
        { command: 'docs rank', operation: 'docs.rank' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
    }
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
      const message = err instanceof Error ? err.message : String(err);
      cliOutput(
        formatError(new CleoError(ExitCode.GENERAL_ERROR, `docs versions failed: ${message}`)),
        { command: 'docs versions', operation: 'docs.versions' },
      );
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
        cliError(formatError(err), err.code, { name: 'E_DOCS_FAILED' });
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
        cliError(formatError(err), err.code, { name: 'E_DOCS_FAILED' });
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

    const accessor = createDocsAccessor(projectRoot);
    try {
      const result = await runDocsImport({
        root: scanRoot,
        accessor,
        dryRun,
        force,
        manifestPath,
        auditDir: projectRoot,
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

/**
 * Root docs command group — attachment management, llmtxt primitives, drift detection,
 * and git⇄llmtxt round-trip (publish/sync/status) per Saga T9625 / Epic T9626.
 *
 * Subcommands: add, list, fetch, remove, generate, export,
 *              search, merge, graph, rank, versions, publish,
 *              sync, status, gap-check, import.
 */
export const docsCommand = defineCommand({
  meta: {
    name: 'docs',
    description:
      'Documentation attachment management (add/list/fetch/remove), ' +
      'llmtxt primitives (search/merge/graph/rank/versions/publish), ' +
      'drift detection (sync/status/gap-check), and legacy .md migration (import)',
  },
  subCommands: {
    add: addCommand,
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
    sync: syncCommand,
    status: statusCommand,
    'gap-check': gapCheckCommand,
    import: importCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
