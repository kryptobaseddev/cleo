/**
 * The tracked, write-once portable project identity (`.cleo/project-id`).
 *
 * Every other project identifier CLEO computes hashes the absolute path, and
 * the random `projectId` in `.cleo/project-info.json` is gitignored (ADR-013
 * §9), so a fresh clone used to mint a brand-new identity at `cleo init`. This
 * file is the one identifier that travels with the repository: CLEO writes it
 * once, commits nothing else beside it, and never rewrites it. Because nothing
 * ever writes it a second time, git has nothing to overwrite — the geometry
 * that made ADR-013 untrack the mutable state files does not apply
 * (ADR-094, T12325).
 *
 * This module only READS. Writing (create-only) and re-linking live in
 * `@cleocode/core` (`scaffold/project-identity.ts`).
 *
 * @packageDocumentation
 * @task T12325
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Basename of the tracked portable identity file inside a project's `.cleo/`. */
export const PORTABLE_PROJECT_ID_FILE = 'project-id';

/**
 * Accepted identity shape: every id CLEO has ever minted (UUIDv4, 12-hex,
 * the 29-char legacy form) fits, and nothing that could smuggle a path
 * separator, whitespace or a second line does.
 */
const PORTABLE_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Outcome of reading `.cleo/project-id`.
 *
 * `invalid` is distinct from `absent` on purpose: an unreadable or malformed
 * identity file is a diagnostic to report, never a reason to mint a new id.
 *
 * @public
 */
export type PortableProjectIdRead =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly projectId: string }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Whether a string is an acceptable portable project id.
 *
 * @param projectId - Candidate identifier.
 * @returns `true` when the id matches the accepted shape.
 *
 * @example
 * ```ts
 * isValidPortableProjectId('c78d09c3a8ee'); // true
 * isValidPortableProjectId('../etc');       // false
 * ```
 *
 * @public
 */
export function isValidPortableProjectId(projectId: string): boolean {
  return PORTABLE_PROJECT_ID_PATTERN.test(projectId);
}

/**
 * Absolute path of the portable identity file for a project root.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `<projectRoot>/.cleo/project-id`.
 *
 * @public
 */
export function portableProjectIdPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', PORTABLE_PROJECT_ID_FILE);
}

/**
 * Render the file body CLEO writes for a portable id.
 *
 * Comment lines (`#`) are ignored by {@link parsePortableProjectId}, so the
 * header can tell a human reader not to edit the file without being part of
 * the identity.
 *
 * @param projectId - A valid portable id.
 * @returns The exact bytes to write.
 *
 * @public
 */
export function formatPortableProjectId(projectId: string): string {
  return (
    '# CLEO portable project identity (write-once; ADR-094, T12325).\n' +
    '# Commit this file. Never edit or regenerate it: every checkout, clone and\n' +
    '# device of this project resolves to the id below.\n' +
    `${projectId}\n`
  );
}

/**
 * Parse the body of a portable identity file.
 *
 * Blank lines and `#` comment lines are ignored; exactly one remaining line
 * must hold a valid id.
 *
 * @param content - Raw file content.
 * @returns The parsed read outcome (`valid` or `invalid`).
 *
 * @public
 */
export function parsePortableProjectId(content: string): PortableProjectIdRead {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length !== 1) {
    return {
      status: 'invalid',
      reason: `expected exactly one identity line, found ${lines.length}`,
    };
  }
  const projectId = lines[0] ?? '';
  if (!isValidPortableProjectId(projectId)) {
    return { status: 'invalid', reason: `malformed identity '${projectId.slice(0, 64)}'` };
  }
  return { status: 'valid', projectId };
}

/**
 * Read the tracked portable identity of a project, synchronously.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `absent` when no file exists, `valid` with the id, or `invalid`
 *   with a reason when the file exists but cannot be used.
 *
 * @example
 * ```ts
 * const read = readPortableProjectId('/repo');
 * if (read.status === 'valid') console.log(read.projectId);
 * ```
 *
 * @public
 */
export function readPortableProjectId(projectRoot: string): PortableProjectIdRead {
  let content: string;
  try {
    content = readFileSync(portableProjectIdPath(projectRoot), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { status: 'absent' };
    }
    return {
      status: 'invalid',
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parsePortableProjectId(content);
}
