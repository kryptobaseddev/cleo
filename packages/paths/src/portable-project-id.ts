/**
 * The tracked, write-once portable project identity.
 *
 * Every other project identifier CLEO computes hashes the absolute path, and
 * the random `projectId` in `.cleo/project-info.json` is gitignored (ADR-013
 * §9), so a fresh clone used to mint a brand-new identity at `cleo init`. The
 * tracked identity travels with the repository instead. Two files carry it:
 *
 * - `.cleo/project.json` — canonical since T12716: `{schemaVersion, id, name}`.
 *   The id is write-once; the name is the project's committed display name and
 *   changes only through `cleo project rename`.
 * - `.cleo/project-id` — the ADR-094 id-only file (T12325). Kept as a legacy
 *   mirror so builds that know only this file keep resolving the same id.
 *
 * {@link readPortableProjectId} is the ONE resolver over both: `project.json`
 * wins, `project-id` is the fallback. Because nothing rewrites the id, git has
 * nothing to overwrite — the geometry that made ADR-013 untrack the mutable
 * state files does not apply (ADR-094, T12325; ADR-096, T12716).
 *
 * This module only READS. Writing (create-only), renaming and migration live
 * in `@cleocode/core` (`scaffold/project-identity.ts`, `project-manifest.ts`,
 * `doctor/project-identity.ts`).
 *
 * @packageDocumentation
 * @task T12325
 * @task T12716
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Basename of the legacy id-only identity file inside a project's `.cleo/`
 * (ADR-094). Superseded by {@link PROJECT_MANIFEST_FILE}; still read as a
 * fallback and kept as a mirror for older builds (T12716).
 */
export const PORTABLE_PROJECT_ID_FILE = 'project-id';

/** Basename of the canonical tracked identity manifest inside `.cleo/` (T12716). */
export const PROJECT_MANIFEST_FILE = 'project.json';

/** The only `schemaVersion` of `.cleo/project.json` this build understands. */
export const PROJECT_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Longest accepted display name. Matches the Cleo Nexus project-label limit so
 * a declared name can always be sent as a label unchanged.
 */
export const PROJECT_DISPLAY_NAME_MAX = 120;

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
  | {
      readonly status: 'valid';
      readonly projectId: string;
      /** File that supplied the id; set by the file readers, not by the parser. */
      readonly file?: TrackedIdentityFile;
      /** Declared display name; only `project.json` carries one. */
      readonly name?: string;
    }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      /** File that is unusable; set by the file readers, not by the parser. */
      readonly file?: TrackedIdentityFile;
    };

/** A tracked identity file: the canonical manifest or the legacy id-only file. */
export type TrackedIdentityFile = typeof PROJECT_MANIFEST_FILE | typeof PORTABLE_PROJECT_ID_FILE;

/**
 * The committed project manifest, `.cleo/project.json` (T12716).
 *
 * @public
 */
export interface ProjectManifest {
  /** Manifest format version; always {@link PROJECT_MANIFEST_SCHEMA_VERSION}. */
  readonly schemaVersion: typeof PROJECT_MANIFEST_SCHEMA_VERSION;
  /** Write-once portable project id. */
  readonly id: string;
  /** Display name; renamed only through `cleo project rename`. */
  readonly name: string;
}

/**
 * Outcome of reading `.cleo/project.json`. As with the id file, `invalid` is a
 * diagnostic to report, never a reason to mint or regenerate.
 *
 * @public
 */
export type ProjectManifestRead =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly manifest: ProjectManifest }
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
    '# Legacy mirror of the id in .cleo/project.json (T12716) for older CLEO builds.\n' +
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
 * Read ONLY the legacy `.cleo/project-id` file, synchronously.
 *
 * Callers that need the project's id use {@link readPortableProjectId}, which
 * prefers `project.json`. This is for code that manages the legacy file
 * itself (the doctor, the mirror writer, identity retirement).
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `absent`, `valid` with the id, or `invalid` with a reason.
 *
 * @example
 * ```ts
 * readProjectIdFile('/repo'); // { status: 'valid', projectId: 'c78d09c3a8ee', file: 'project-id' }
 * ```
 *
 * @public
 * @task T12716
 */
export function readProjectIdFile(projectRoot: string): PortableProjectIdRead {
  const content = readTextFile(portableProjectIdPath(projectRoot));
  if (content.status !== 'read') return withFile(content, PORTABLE_PROJECT_ID_FILE);
  return withFile(parsePortableProjectId(content.content), PORTABLE_PROJECT_ID_FILE);
}

/**
 * Whether a string is an acceptable display name: 1-{@link PROJECT_DISPLAY_NAME_MAX}
 * characters after trimming, no path separator, no leading `~`, no control
 * character. A name is a label, never a path.
 *
 * @param name - Candidate name.
 * @returns `true` when the name is acceptable as-is (already trimmed).
 *
 * @example
 * ```ts
 * isValidProjectDisplayName('cleocode'); // true
 * isValidProjectDisplayName('../x');     // false
 * ```
 *
 * @public
 * @task T12716
 */
export function isValidProjectDisplayName(name: string): boolean {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name.length <= PROJECT_DISPLAY_NAME_MAX &&
    !name.startsWith('~') &&
    !/[/\\\u0000-\u001f\u007f]/.test(name)
  );
}

/**
 * Absolute path of the canonical identity manifest for a project root.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `<projectRoot>/.cleo/project.json`.
 *
 * @public
 * @task T12716
 */
export function projectManifestPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', PROJECT_MANIFEST_FILE);
}

/**
 * Render the exact bytes CLEO writes for a manifest: stable key order, two-space
 * indent, trailing newline, so a rename diff touches one line.
 *
 * @param manifest - A manifest with a valid id and name.
 * @returns The file body.
 *
 * @public
 * @task T12716
 */
export function formatProjectManifest(manifest: ProjectManifest): string {
  const ordered: ProjectManifest = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parse the body of `.cleo/project.json`.
 *
 * Strict on the three fields: `schemaVersion` must be
 * {@link PROJECT_MANIFEST_SCHEMA_VERSION} (a newer format is `invalid`, so an
 * old build never guesses at it), `id` must pass
 * {@link isValidPortableProjectId}, and `name` must pass
 * {@link isValidProjectDisplayName}. Unknown extra keys are ignored.
 *
 * @param content - Raw file content.
 * @returns `valid` with the manifest, or `invalid` with a reason.
 *
 * @public
 * @task T12716
 */
export function parseProjectManifest(content: string): ProjectManifestRead {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return {
      status: 'invalid',
      reason: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'invalid', reason: 'expected a JSON object' };
  }
  const record = data as Record<string, unknown>;
  if (record['schemaVersion'] !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    return {
      status: 'invalid',
      reason: `unsupported schemaVersion ${JSON.stringify(record['schemaVersion'])} (this build reads ${PROJECT_MANIFEST_SCHEMA_VERSION})`,
    };
  }
  const id = record['id'];
  if (typeof id !== 'string' || !isValidPortableProjectId(id)) {
    return { status: 'invalid', reason: `malformed id ${JSON.stringify(id)?.slice(0, 64)}` };
  }
  const name = record['name'];
  if (typeof name !== 'string' || !isValidProjectDisplayName(name)) {
    return { status: 'invalid', reason: `malformed name ${JSON.stringify(name)?.slice(0, 64)}` };
  }
  return {
    status: 'valid',
    manifest: { schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION, id, name },
  };
}

/**
 * Read `.cleo/project.json`, synchronously.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `absent`, `valid` with the manifest, or `invalid` with a reason.
 *
 * @example
 * ```ts
 * const read = readProjectManifest('/repo');
 * if (read.status === 'valid') console.log(read.manifest.name);
 * ```
 *
 * @public
 * @task T12716
 */
export function readProjectManifest(projectRoot: string): ProjectManifestRead {
  const content = readTextFile(projectManifestPath(projectRoot));
  if (content.status !== 'read') return content;
  return parseProjectManifest(content.content);
}

/**
 * Read the tracked portable identity of a project, synchronously — the ONE
 * resolver over the tracked files (T12716).
 *
 * Precedence: `.cleo/project.json`, then the legacy `.cleo/project-id`. A
 * malformed `project.json` is `invalid` and does NOT fall through to
 * `project-id`: a broken canonical file is restored from version control,
 * never papered over. When both files are valid and disagree, `project.json`
 * wins here and `cleo doctor project-identity` reports the mirror conflict.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns `absent` when neither file exists, `valid` with the id (and the
 *   `file` it came from, plus the `name` when `project.json` supplied it), or
 *   `invalid` with a reason and the unusable `file`.
 *
 * @example
 * ```ts
 * const read = readPortableProjectId('/repo');
 * if (read.status === 'valid') console.log(read.projectId, read.file);
 * ```
 *
 * @public
 */
export function readPortableProjectId(projectRoot: string): PortableProjectIdRead {
  const manifest = readProjectManifest(projectRoot);
  if (manifest.status === 'valid') {
    return {
      status: 'valid',
      projectId: manifest.manifest.id,
      file: PROJECT_MANIFEST_FILE,
      name: manifest.manifest.name,
    };
  }
  if (manifest.status === 'invalid') {
    return { status: 'invalid', reason: manifest.reason, file: PROJECT_MANIFEST_FILE };
  }
  return readProjectIdFile(projectRoot);
}

/** Read a small text file; `absent` on ENOENT, `invalid` on any other error. */
function readTextFile(
  path: string,
):
  | { readonly status: 'read'; readonly content: string }
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string } {
  try {
    return { status: 'read', content: readFileSync(path, 'utf-8') };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { status: 'absent' };
    }
    return {
      status: 'invalid',
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Tag a read outcome with the file it came from (absent stays untagged). */
function withFile(
  read: PortableProjectIdRead | { readonly status: 'absent' },
  file: TrackedIdentityFile,
): PortableProjectIdRead {
  if (read.status === 'absent') return read;
  return { ...read, file };
}
