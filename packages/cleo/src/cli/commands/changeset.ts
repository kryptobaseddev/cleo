/**
 * CLI `cleo changeset` command — the canonical author + reader surface for
 * task-anchored changeset entries. Every write goes through the dual-write
 * pipeline so the bytes always land in BOTH `.changeset/<slug>.md` (the
 * human-reviewable file mirror) AND the docs SSoT blob store.
 *
 * Subcommands:
 *   - `cleo changeset add` — author and dual-write a new entry (T9793)
 *   - `cleo changeset list` — list entries via the same parser the aggregator
 *     consumes; LAFS envelope on JSON, aligned table on `--human` (T9785)
 *
 * The aggregator (`changesets-aggregator.ts`) reads SSoT-first and falls back
 * to `.changeset/*.md` for slugs that have not yet been mirrored, so the
 * file surface remains the source of truth for review while the SSoT
 * unlocks search, dedup, and provenance.
 *
 * @epic T9785 (Saga T9782 — single canonical changesets system)
 * @task T9785
 * @see ADR-068 — DB Charter: changeset bytes live in manifest.db blob store
 * @see packages/core/src/changesets/writer.ts — dual-write transaction
 * @see packages/core/src/release/changesets-aggregator.ts — SSoT-first reader
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANGESET_KINDS,
  type ChangesetEntry,
  type ChangesetKind,
  ExitCode,
} from '@cleocode/contracts';
import { changesets, getProjectRoot } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dataTable } from '../renderers/format-helpers.js';
import { cliError, cliOutput, humanInfo, humanLine, isHumanOutput } from '../renderers/index.js';

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
    const outcome = await changesets.writeChangesetEntry(entry, {
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

// ─── cleo changeset list ─────────────────────────────────────────────────────

/**
 * `cleo changeset list`
 *
 * Read-only verb that lists every entry under `.changeset/*.md` by routing
 * through the SAME {@link changesets.parseChangesetDir} the release-plan
 * aggregator uses — no duplicate parsing logic, no separate code path.
 *
 * Output surfaces:
 * - JSON (default — agent mode): emits a LAFS envelope whose `data.entries`
 *   array carries the full parsed records (`id`, `tasks`, `kind`, `summary`,
 *   `prs`, `notes`, `breaking`).
 * - Human (`--human`): renders an aligned `dataTable` (SLUG · KIND · TASKS ·
 *   PR · SUMMARY) ordered by filename (alphabetical, matching the parser's
 *   deterministic sort).
 *
 * The lookup is project-local: `getProjectRoot()` + `.changeset/`. When the
 * directory is missing (fresh repo, no entries yet), the verb returns an
 * empty `entries` array with a `note` rather than erroring — operators and
 * agents alike can rely on it for idempotent "is there anything queued?"
 * checks.
 *
 * @task T9785
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List every changeset entry under .changeset/*.md using the same parser ' +
      'the release-plan aggregator consumes. JSON envelope by default, ' +
      'aligned table on --human.',
  },
  args: {},
  async run() {
    const projectRoot = getProjectRoot();
    const dir = join(projectRoot, '.changeset');

    // Empty-state path: missing directory is a perfectly valid "nothing
    // queued" answer — return an envelope rather than erroring so scripts
    // can poll without try/catch noise.
    if (!existsSync(dir)) {
      const empty = { entries: [] as ChangesetEntry[], count: 0, dir, note: 'no .changeset/ dir' };
      if (isHumanOutput()) {
        humanLine('No changeset entries found (.changeset/ directory absent).');
      }
      cliOutput(empty, { command: 'changeset list', operation: 'changeset.list' });
      return;
    }

    // Re-use the canonical parser the aggregator/lint script share — keeps
    // this verb and CI lockstep, so a `list` that succeeds implies the lint
    // gate would also pass.
    let entries: ChangesetEntry[];
    try {
      entries = changesets.parseChangesetDir(dir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      cliError(`Failed to parse .changeset directory: ${msg}`, ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
        fix: 'run `node scripts/lint-changesets.mjs` to surface every offending entry',
      });
      process.exit(ExitCode.VALIDATION_ERROR);
    }

    // Human surface: aligned table. Empty list still emits a friendly line.
    if (isHumanOutput()) {
      if (entries.length === 0) {
        humanLine('No changeset entries found (.changeset/ has no *.md files).');
      } else {
        const rendered = dataTable<ChangesetEntry>(entries, [
          { header: 'SLUG', get: (e) => e.id, maxWidth: 40 },
          { header: 'KIND', get: (e) => e.kind, maxWidth: 10 },
          { header: 'TASKS', get: (e) => e.tasks.join(','), maxWidth: 22 },
          {
            header: 'PR',
            get: (e) => (e.prs && e.prs.length > 0 ? `#${e.prs.join(',#')}` : '-'),
            maxWidth: 10,
          },
          { header: 'SUMMARY', get: (e) => e.summary },
        ]);
        humanLine(rendered);
      }
    }

    cliOutput(
      { entries, count: entries.length, dir },
      { command: 'changeset list', operation: 'changeset.list' },
    );
  },
});

// ─── Root command group ──────────────────────────────────────────────────────

/**
 * Root `cleo changeset` command group — the canonical surface for the
 * task-anchored changesets DSL.
 *
 * Subcommands:
 *   - `add`  — author + dual-write (file + SSoT) per T9793
 *   - `list` — read-only listing via the shared aggregator parser (T9785)
 *
 * Future read verbs (fetch, lint) can land on the same foundation without
 * forking the dual-write transaction or duplicating the parser path.
 */
export const changesetCommand = defineCommand({
  meta: {
    name: 'changeset',
    description:
      'Author + list task-anchored changeset entries — dual-writes go to ' +
      '.changeset/*.md AND the docs SSoT blob store (Saga T9782).',
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
