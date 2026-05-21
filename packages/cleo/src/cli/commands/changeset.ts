/**
 * CLI `cleo changeset` command — author task-anchored changeset entries that
 * dual-write to both `.changeset/<slug>.md` (file surface, preserved for git
 * PR review) AND the canonical docs SSoT blob store.
 *
 * Today CLEO ships 12 hand-authored `.changeset/*.md` files. This command
 * elevates the directory from "parallel system" to "first-class DocKind"
 * backed by the SSoT, while keeping the file surface for backward compat.
 *
 * Subcommands:
 *   - `cleo changeset add` — author and dual-write a new entry
 *
 * The aggregator (`changesets-aggregator.ts`) reads SSoT-first and falls back
 * to `.changeset/*.md` for slugs that have not yet been mirrored, so the
 * existing workflow (hand-author a `.md` file) continues to work unchanged.
 *
 * Future Wave 6 (T9791) will batch-import the 12 existing files into SSoT.
 *
 * @epic T9793 (E-DOCS-CHANGESET-INTEGRATION)
 * @task T9793
 * @see ADR-068 — DB Charter: changeset bytes live in manifest.db blob store
 * @see packages/core/src/changesets/writer.ts — dual-write transaction
 * @see packages/core/src/release/changesets-aggregator.ts — SSoT-first reader
 */

import {
  CHANGESET_KINDS,
  type ChangesetEntry,
  type ChangesetKind,
  ExitCode,
} from '@cleocode/contracts';
import { getProjectRoot, writeChangesetEntry } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that a raw `--kind` value matches one of {@link CHANGESET_KINDS}.
 *
 * Type-narrows from `string | undefined` to {@link ChangesetKind} so the
 * downstream {@link ChangesetEntry} construction does not need an `as` cast.
 *
 * @internal
 */
function isValidKind(raw: unknown): raw is ChangesetKind {
  return typeof raw === 'string' && (CHANGESET_KINDS as readonly string[]).includes(raw);
}

/**
 * Parse the `--tasks` CLI flag into a clean string array.
 *
 * Accepts comma-separated input (`T9793,T9788`) or single-task strings.
 * Strips whitespace and drops empty segments. Returns `undefined` when the
 * flag was not provided so the caller can apply its own required-field check.
 *
 * @internal
 */
function parseTasksFlag(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const tasks = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tasks.length > 0 ? tasks : undefined;
}

/**
 * Parse the `--prs` CLI flag into a clean number array.
 *
 * Accepts comma-separated input (`349,357`). Drops any segment that does not
 * parse to a positive integer (downstream Zod check will catch the rest).
 *
 * @internal
 */
function parsePrsFlag(raw: unknown): number[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const numbers: number[] = [];
  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0) numbers.push(n);
  }
  return numbers.length > 0 ? numbers : undefined;
}

// ─── cleo changeset add ──────────────────────────────────────────────────────

/**
 * `cleo changeset add --slug <slug> --tasks <T...> --kind <kind> --summary <text>`
 *
 * Authors a new changeset entry by dual-writing to `.changeset/<slug>.md` AND
 * the canonical docs SSoT. Slug MUST match the `changeset` kind's registry
 * pattern (`^t\d+-[a-z0-9-]+$`) — e.g. `t9793-changeset-ssot`.
 *
 * Either both writes succeed and a LAFS envelope is emitted with the new
 * `attachmentId` + `filePath`, or NEITHER persists and an `E_*` envelope is
 * returned describing which surface rejected the write.
 *
 * @task T9793
 */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Author a task-anchored changeset entry. Dual-writes to .changeset/<slug>.md ' +
      'AND the docs SSoT blob store. Slug must match /^t\\d+-[a-z0-9-]+$/ ' +
      '(e.g. t9793-changeset-ssot-integration).',
  },
  args: {
    slug: {
      type: 'string',
      description:
        'Filename slug (sans .md). Must match /^t\\d+-[a-z0-9-]+$/. ' +
        'Example: t9793-changeset-ssot-integration',
      required: true,
    },
    tasks: {
      type: 'string',
      description: 'Comma-separated CLEO task IDs (T####). Example: T9793,T9788',
      required: true,
    },
    kind: {
      type: 'string',
      description: `Type of change: ${CHANGESET_KINDS.join(' | ')}`,
      required: true,
    },
    summary: {
      type: 'string',
      description: 'One-line user-facing description of the change',
      required: true,
    },
    prs: {
      type: 'string',
      description: 'Comma-separated PR numbers, when known. Example: 349,357',
    },
    notes: {
      type: 'string',
      description: 'Optional longer-form markdown body (becomes the file body)',
    },
    breaking: {
      type: 'string',
      description: 'Migration note. REQUIRED when --kind is `breaking`.',
    },
    'attached-by': {
      type: 'string',
      description: 'Agent identity recorded on the SSoT row (default: cleo-changeset)',
    },
  },
  async run({ args }) {
    // ── 1. Narrow & validate the discriminated --kind flag. ────────────────
    if (!isValidKind(args.kind)) {
      cliError(`--kind must be one of: ${CHANGESET_KINDS.join(' | ')} — got '${args.kind}'`, 6, {
        name: 'E_VALIDATION',
        fix: `cleo changeset add --kind feat ... (or one of: ${CHANGESET_KINDS.join(', ')})`,
      });
      process.exit(6);
    }
    const kind: ChangesetKind = args.kind;

    // ── 2. Parse multi-value flags. ─────────────────────────────────────────
    const tasks = parseTasksFlag(args.tasks);
    if (!tasks) {
      cliError('--tasks must contain at least one task ID', 6, { name: 'E_VALIDATION' });
      process.exit(6);
    }
    const prs = parsePrsFlag(args.prs);

    // ── 3. Construct the entry. The schema is re-validated inside the writer. ──
    const entry: ChangesetEntry = {
      id: String(args.slug),
      tasks,
      kind,
      summary: String(args.summary),
      ...(prs !== undefined ? { prs } : {}),
      ...(typeof args.notes === 'string' && args.notes.length > 0 ? { notes: args.notes } : {}),
      ...(typeof args.breaking === 'string' && args.breaking.length > 0
        ? { breaking: args.breaking }
        : {}),
    };

    // ── 4. Dispatch to the dual-write transaction. ──────────────────────────
    const projectRoot = getProjectRoot();
    const outcome = await writeChangesetEntry(entry, {
      projectRoot,
      ...(typeof args['attached-by'] === 'string' && args['attached-by'].length > 0
        ? { attachedBy: args['attached-by'] }
        : {}),
    });

    // ── 5. Render the LAFS envelope. ────────────────────────────────────────
    if (!outcome.ok) {
      const err = outcome.error;
      const hint =
        err.code === 'E_SLUG_PATTERN_MISMATCH' && err.example
          ? `example slug: ${err.example}`
          : undefined;
      cliError(err.message, ExitCode.VALIDATION_ERROR, {
        name: err.code,
        ...(hint ? { fix: hint } : {}),
      });
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    const result = outcome.result;
    humanInfo(`Wrote ${result.filePath}`);
    humanInfo(`Wrote SSoT blob ${result.attachmentId} (sha=${result.sha256.slice(0, 12)}…)`);
    cliOutput(result, { command: 'changeset add', operation: 'changeset.add' });
  },
});

// ─── Root command group ──────────────────────────────────────────────────────

/**
 * Root `cleo changeset` command group.
 *
 * Currently exposes only `add` — future subcommands (list, fetch, lint) will
 * land on top of the same dual-write foundation introduced by T9793.
 */
export const changesetCommand = defineCommand({
  meta: {
    name: 'changeset',
    description:
      'Author task-anchored changeset entries that dual-write to ' +
      '.changeset/*.md AND the docs SSoT blob store (T9793).',
  },
  subCommands: {
    add: addCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
