/**
 * Shared transcript-reading utility for provider hook adapters.
 *
 * Several providers (Gemini CLI, Codex CLI) store session data in a
 * flat directory of JSON/JSONL files using the same role/content schema.
 * This module centralises the "find most-recent file, parse turns"
 * logic to avoid duplicating it in each hook provider.
 *
 * Usage:
 * ```ts
 * import { readLatestTranscript } from '../shared/transcript-reader.js';
 *
 * async getTranscript(_sessionId: string, _projectDir: string) {
 *   return readLatestTranscript(join(homedir(), '.gemini'));
 * }
 * ```
 *
 * @task T161
 * @epic T134
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed conversation turn from a provider session file. */
interface TranscriptTurn {
  role: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSONL or JSON session file into an array of transcript turns.
 *
 * Lines that are not valid JSON, or that lack a string `role` and string
 * `content`, are silently skipped.
 *
 * @param raw - Raw file contents (UTF-8 string).
 * @returns Array of `{ role, content }` pairs, in file order.
 */
function parseTranscriptLines(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = raw.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const role = entry.role;
      const content = entry.content;
      if (typeof role === 'string' && typeof content === 'string') {
        turns.push({ role, content });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the most recent JSON or JSONL session file from `providerDir` and
 * return its contents as a flat transcript string.
 *
 * Files are sorted in descending order by filename — this works naturally
 * for providers that embed timestamps in filenames. The most recently named
 * file is read first.
 *
 * Returns `null` when:
 * - `providerDir` does not exist or cannot be read
 * - No JSON/JSONL files are present
 * - The most recent file contains no parseable turns
 *
 * @param providerDir - Absolute path to the provider's session directory
 *   (e.g. `~/.gemini` or `~/.codex`).
 * @returns A plain-text transcript with lines of the form `role: content`,
 *   or `null` if no transcript could be extracted.
 *
 * @task T161
 * @epic T134
 */
export async function readLatestTranscript(providerDir: string): Promise<string | null> {
  let allFiles: string[] = [];

  try {
    const entries = await readdir(providerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.endsWith('.json') || name.endsWith('.jsonl')) {
        allFiles.push(join(providerDir, name));
      }
    }
  } catch {
    return null;
  }

  if (allFiles.length === 0) return null;

  // Sort descending — timestamps in filenames sort naturally
  allFiles = allFiles.sort((a, b) => b.localeCompare(a));
  const mostRecent = allFiles[0];
  if (!mostRecent) return null;

  try {
    const raw = await readFile(mostRecent, 'utf-8');
    const turns = parseTranscriptLines(raw);
    return turns.length > 0 ? turns.map((t) => `${t.role}: ${t.content}`).join('\n') : null;
  } catch {
    return null;
  }
}
