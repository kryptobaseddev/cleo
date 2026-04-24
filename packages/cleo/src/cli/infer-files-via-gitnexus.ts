/**
 * File inference via GitNexus query.
 *
 * When `--files-infer` is passed to `cleo add` and `--files` is not provided,
 * this module invokes GitNexus to suggest files that might be touched based on
 * the task title and description.
 *
 * Falls back gracefully if GitNexus is unavailable or returns no results.
 *
 * @task T1330
 */

import { execFileSync } from 'node:child_process';

/**
 * Infer touched files from a task's title and description using GitNexus.
 *
 * Constructs a query from title + description, invokes `gitnexus query --json`,
 * and extracts file paths from the result.
 *
 * Fallback: if GitNexus is unavailable or returns empty results, returns an
 * empty array (the atomicity check at spawn time still fires).
 *
 * @param title Task title
 * @param description Task description
 * @returns Array of inferred file paths (may be empty)
 *
 * @task T1330
 */
export function inferFilesViaGitNexus(title: string, description?: string): string[] {
  // Build query text — concatenate title and description for better ranking
  const queryText = description ? `${title} ${description}` : title;

  try {
    // Invoke `gitnexus query --json --limit 5` to get top processes
    const output = execFileSync('gitnexus', ['query', '--json', '--limit', '5', queryText], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr
    });

    const result = JSON.parse(output);

    // Extract files from processes
    // GitNexus returns an array of processes, each with symbol paths or file lists
    const files = new Set<string>();

    if (Array.isArray(result)) {
      for (const process of result) {
        // Each process object may have a 'symbols' array or 'files' array
        if (Array.isArray(process.symbols)) {
          for (const symbol of process.symbols) {
            // Symbols have a 'location' field that includes the file path
            if (symbol.location && typeof symbol.location === 'string') {
              // Extract the file path (format: "path/to/file.ts:line:col")
              const match = symbol.location.match(/^([^:]+):/);
              if (match?.[1]) {
                files.add(match[1]);
              }
            }
          }
        }
        if (Array.isArray(process.files)) {
          for (const file of process.files) {
            if (typeof file === 'string') {
              files.add(file);
            }
          }
        }
      }
    }

    return Array.from(files);
  } catch {
    // GitNexus unavailable, query failed, or output not valid JSON
    // Return empty array; caller will warn the user
    return [];
  }
}
