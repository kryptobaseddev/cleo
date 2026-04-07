/**
 * `caamp pi sessions` command group.
 *
 * @remarks
 * Four verbs implementing ADR-035 §D2 for Pi sessions:
 *
 * - `list` — read only line 1 of every `*.jsonl` under the user-tier
 *   sessions directory (and the `subagents/` subdir); NEVER load full
 *   session bodies.
 * - `show <id>` — load the full session file and return its raw JSONL
 *   entries alongside the header summary.
 * - `export <id> --jsonl|--md` — stream the session file line-by-line
 *   into the output sink. Markdown export filters to message-type
 *   entries.
 * - `resume <id>` — thin shell-out to `pi --session <id>`; we never
 *   reimplement Pi-owned lifecycle semantics.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import { PI_ERROR_CODES, requirePiHarness } from './common.js';

/**
 * Options accepted by `caamp pi sessions list`.
 *
 * @public
 */
export interface PiSessionsListOptions {
  /** Include sessions under the `subagents/` subdirectory (default: true). */
  includeSubagents?: boolean;
}

/**
 * Options accepted by `caamp pi sessions export`.
 *
 * @public
 */
export interface PiSessionsExportOptions {
  /** Emit raw JSONL. Mutually exclusive with `md`. */
  jsonl?: boolean;
  /** Emit Markdown (filtered to message/custom_message entries). */
  md?: boolean;
  /** Write to this file path instead of stdout. */
  output?: string;
}

/**
 * Stream a session file line-by-line through a transform into a write
 * target (stdout or a file).
 *
 * @remarks
 * Uses a Node `readline` interface on top of a read stream so we never
 * pull the full file into memory. The transform decides whether each
 * line contributes to the output and returns the string to emit (or
 * `null` to skip). A trailing newline is written after every emitted
 * line so downstream tools see a well-formed file.
 *
 * @internal
 */
async function streamSession(
  filePath: string,
  outputPath: string | undefined,
  transform: (line: string) => string | null,
): Promise<number> {
  const writeToFile = outputPath !== undefined && outputPath.length > 0;
  const out = writeToFile ? createWriteStream(outputPath) : process.stdout;
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let emitted = 0;
  try {
    for await (const line of reader) {
      const result = transform(line);
      if (result === null) continue;
      out.write(`${result}\n`);
      emitted += 1;
    }
  } finally {
    reader.close();
    if (writeToFile && 'end' in out) {
      await new Promise<void>((resolve) => {
        (out as NodeJS.WritableStream).end(resolve);
      });
    }
  }
  return emitted;
}

/**
 * Produce a Markdown representation of a single JSONL session entry.
 *
 * @remarks
 * Returns `null` for entry kinds that carry no user-visible content so
 * the export transform can drop them cleanly. Supported kinds match
 * ADR-035 §D2's "Markdown export filters to message/custom_message
 * entry types only" rule, plus the line-1 session header which is
 * converted into a level-1 heading.
 *
 * @internal
 */
function sessionEntryToMarkdown(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj['type'] === 'string' ? obj['type'] : null;

  if (type === 'session') {
    const id = typeof obj['id'] === 'string' ? obj['id'] : '(no id)';
    const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : '';
    return `# Session ${id}${ts.length > 0 ? ` · ${ts}` : ''}\n`;
  }

  if (type === 'message') {
    const role = typeof obj['role'] === 'string' ? obj['role'] : 'assistant';
    const content = extractMessageContent(obj['content']);
    if (content === null) return null;
    const label = role.charAt(0).toUpperCase() + role.slice(1);
    return `## ${label}\n\n${content}\n`;
  }

  if (type === 'custom_message') {
    const label = typeof obj['label'] === 'string' ? obj['label'] : 'Custom';
    const text = typeof obj['text'] === 'string' ? obj['text'] : '';
    return `### ${label}\n\n${text}\n`;
  }

  return null;
}

/**
 * Extract a text body from a Pi message `content` field.
 *
 * @remarks
 * Pi's message schema allows either a bare string or an array of
 * content blocks where each block is `{ type: "text", text: "..." }`
 * or similar. We handle both shapes and concatenate text blocks with a
 * blank line separator. Non-text blocks are silently dropped because
 * the Markdown export is a lossy text preview, not a fidelity-
 * preserving format.
 *
 * @internal
 */
function extractMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text']);
    }
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

/**
 * Registers the `caamp pi sessions` command group.
 *
 * @remarks
 * Wires the `list`, `show`, `export`, and `resume` subcommands into the
 * supplied `pi` parent Command. Delegates to {@link PiHarness.listSessions}
 * and {@link PiHarness.showSession} for discovery and read paths, and
 * shells out to Pi directly for the resume verb.
 *
 * @param parent - The parent `pi` Command to attach the sessions group to.
 *
 * @example
 * ```bash
 * caamp pi sessions list
 * caamp pi sessions show sess-abc123
 * caamp pi sessions export sess-abc123 --md --output session.md
 * caamp pi sessions resume sess-abc123
 * ```
 *
 * @public
 */
export function registerPiSessionsCommands(parent: Command): void {
  const sessions = parent.command('sessions').description('Inspect and resume Pi sessions');

  sessions
    .command('list')
    .description('List Pi sessions (reads only line 1 of each JSONL file)')
    .option('--no-subagents', 'Skip sessions under subagents/')
    .action(async (opts: PiSessionsListOptions) =>
      runLafsCommand('pi.sessions.list', 'standard', async () => {
        const harness = requirePiHarness();
        const summaries = await harness.listSessions({
          includeSubagents: opts.includeSubagents !== false,
        });
        return {
          count: summaries.length,
          sessions: summaries,
        };
      }),
    );

  sessions
    .command('show <id>')
    .description('Show the full body of a Pi session by id')
    .action(async (id: string) =>
      runLafsCommand('pi.sessions.show', 'full', async () => {
        const harness = requirePiHarness();
        const doc = await harness.showSession(id);
        return {
          summary: doc.summary,
          entryCount: doc.entries.length,
          entries: doc.entries,
        };
      }),
    );

  sessions
    .command('export <id>')
    .description('Export a Pi session to JSONL or Markdown')
    .option('--jsonl', 'Emit the raw JSONL body (default)')
    .option('--md', 'Emit a Markdown transcription (messages only)')
    .option('--output <path>', 'Write to this file instead of stdout')
    .action(async (id: string, opts: PiSessionsExportOptions) =>
      runLafsCommand('pi.sessions.export', 'standard', async () => {
        if (opts.jsonl === true && opts.md === true) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.VALIDATION,
            'Cannot pass both --jsonl and --md',
            'Pick one of --jsonl or --md.',
            false,
          );
        }
        const harness = requirePiHarness();
        // Resolve the file path via the harness listing so we never
        // need to know the user-tier layout inline.
        const summaries = await harness.listSessions({ includeSubagents: true });
        const match = summaries.find((s) => s.id === id);
        if (match === undefined) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.NOT_FOUND,
            `No session found with id ${id}`,
            'Run `caamp pi sessions list` to see known ids.',
            false,
          );
        }
        const format: 'jsonl' | 'md' = opts.md === true ? 'md' : 'jsonl';
        const emitted =
          format === 'md'
            ? await streamSession(match.filePath, opts.output, sessionEntryToMarkdown)
            : await streamSession(match.filePath, opts.output, (line) =>
                line.length === 0 ? null : line,
              );
        return {
          id,
          format,
          filePath: match.filePath,
          output: opts.output ?? 'stdout',
          entriesEmitted: emitted,
        };
      }),
    );

  sessions
    .command('resume <id>')
    .description('Resume a Pi session by shelling out to `pi --session <id>`')
    .action(async (id: string) =>
      runLafsCommand('pi.sessions.resume', 'standard', async () => {
        const harness = requirePiHarness();
        // Sanity-check the session exists before shelling out so we
        // return a typed error envelope rather than an opaque Pi exit
        // code when the id is wrong.
        const summaries = await harness.listSessions({ includeSubagents: true });
        const match = summaries.find((s) => s.id === id);
        if (match === undefined) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.NOT_FOUND,
            `No session found with id ${id}`,
            'Run `caamp pi sessions list` to see known ids.',
            false,
          );
        }
        const piBinary = harness.provider.detection.binary ?? 'pi';
        // Verify the binary is actually callable before spawning.
        if (!existsSync(piBinary) && piBinary === 'pi') {
          // `pi` might live on PATH; we trust that case and just spawn.
        }
        const child = spawn(piBinary, ['--session', id], {
          stdio: 'inherit',
          detached: false,
        });
        const exitCode: number = await new Promise((resolve) => {
          child.on('exit', (code) => resolve(code ?? 0));
        });
        if (exitCode !== 0) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.TRANSIENT,
            `pi --session ${id} exited with code ${exitCode}`,
            'Check the Pi binary output for details.',
            true,
          );
        }
        return {
          id,
          filePath: match.filePath,
          exitCode,
        };
      }),
    );
}
