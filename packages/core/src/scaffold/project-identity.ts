/**
 * Write-once portable project identity: decide, re-link, adopt (T12325 · T12716).
 *
 * The tracked identity — `.cleo/project.json` `{schemaVersion, id, name}`,
 * with the ADR-094 `.cleo/project-id` kept as a legacy mirror (both read by
 * `@cleocode/paths` `readPortableProjectId`) — is the one project identifier
 * that survives a fresh clone, a move, and a new device. This module owns the
 * write-side rules:
 *
 * 1. **Write once.** The id is created with `O_EXCL` and never rewritten. A
 *    conflicting or malformed file is reported, not repaired. Only the
 *    manifest's `name` may change, through {@link renameProjectManifest}.
 * 2. **Never silently re-mint.** When no tracked or local id exists, the
 *    global registry is searched for the project's previous identity (same
 *    path, its canonical-fingerprint alias, or a live checkout of the same remote). A
 *    unique candidate is re-linked; several candidates refuse to guess; a new
 *    id is minted only when nothing can be re-linked or when the caller asks
 *    for one explicitly.
 * 3. **Never migrate on open.** Tracked files are created here only for a
 *    project that has NONE yet. Turning a legacy `project-id` into
 *    `project.json` is `cleo doctor project-identity --resolve` alone.
 *
 * Precedence when the tracked id and the `project-info.json` cache disagree
 * (T12716, reversing the T12325 rule): the TRACKED id wins, as it already did
 * for every reader. The disagreement is reported. The cache is not rewritten
 * here: local state (registry row, aliases) keyed by the old id is re-keyed,
 * with the old id kept as an alias, only by `cleo doctor project-identity
 * --resolve`. Two ids for one repository means two lineages (typically two
 * devices that each ran `cleo init` before the id was tracked).
 *
 * @task T12325
 * @task T12716
 * @see ADR-096 — one committed `.cleo/project.json` (amends ADR-094)
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import {
  canonicalizePath,
  computePathFingerprintId,
  formatPortableProjectId,
  formatProjectManifest,
  getCleoHome,
  isValidPortableProjectId,
  isValidProjectDisplayName,
  PORTABLE_PROJECT_ID_FILE,
  PROJECT_DISPLAY_NAME_MAX,
  PROJECT_MANIFEST_FILE,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  portableProjectIdPath,
  projectManifestPath,
  readPortableProjectId,
  readProjectIdFile,
  readProjectManifest,
} from '@cleocode/paths';
import { CleoError } from '../errors.js';
import { normalizeRemoteUrl } from '../nexus/identity.js';

/**
 * Where the identity a scaffold step settled on came from.
 *
 * - `tracked` — the committed `.cleo/project.json` (or legacy `.cleo/project-id`);
 *   it wins over the `project-info.json` cache (T12716).
 * - `project-info` — the `project-info.json` cache, used only when no tracked
 *   file exists yet (a project from before ADR-094).
 * - `registry-path` / `registry-alias` / `registry-remote` — re-linked from the
 *   global registry because neither file was present.
 * - `minted` — a new random id; only when nothing could be re-linked or the
 *   caller explicitly asked for a new identity.
 */
export type ProjectIdentitySource =
  | 'project-info'
  | 'tracked'
  | 'registry-path'
  | 'registry-alias'
  | 'registry-remote'
  | 'minted';

/** How a registry row was matched as a re-link candidate. */
export type RelinkVia = 'registry-path' | 'registry-alias' | 'registry-remote';

/** One previous identity the global registry offers for a project root. */
export interface RelinkCandidate {
  /** The registered immutable project id. */
  projectId: string;
  /** The registry's recorded path for that id (may no longer exist). */
  projectPath: string;
  /** Which evidence matched it. */
  via: RelinkVia;
}

/** The identity a scaffold step should use, and why. */
export interface ProjectIdentityDecision {
  /** The id to write into `project-info.json`. */
  projectId: string;
  /** Provenance of {@link ProjectIdentityDecision.projectId}. */
  source: ProjectIdentitySource;
  /** Human-readable facts to surface (conflicts, re-links, coverage gaps). */
  diagnostics: string[];
}

/** Outcome of making sure the tracked files record the project's id. */
export type PortableIdFileOutcome =
  /** `project.json` already records the same id. */
  | 'present'
  /**
   * Only the legacy `project-id` records the same id. Reported, not migrated:
   * `cleo doctor project-identity --resolve` writes `project.json` (T12716).
   */
  | 'legacy'
  /** Created now (first adoption): `project.json` plus the `project-id` mirror. */
  | 'written'
  /** Present with a DIFFERENT id — reported, not rewritten. */
  | 'conflict'
  /** Present but unreadable/malformed — reported, not rewritten. */
  | 'invalid'
  /** No `<projectRoot>/.cleo/` directory to write into. */
  | 'no-cleo-dir';

/** Options for {@link decideProjectIdentity}. */
export interface DecideProjectIdentityOptions {
  /**
   * Explicitly request a new identity instead of re-linking. The only way to
   * mint while the registry offers candidates.
   */
  mintNewIdentity?: boolean;
  /** Global CLEO home whose registry is searched (defaults to the current one). */
  cleoHome?: string;
}

/** Re-exported from its home in `nexus/identity` (moved there by T12470). */
export { normalizeRemoteUrl } from '../nexus/identity.js';

/** Read `remoteUrl` from a checkout's `project-info.json`; null when absent or unusable. */
function readInfoRemote(projectPath: string): string | null {
  try {
    const data = JSON.parse(
      readFileSync(join(projectPath, '.cleo', 'project-info.json'), 'utf-8'),
    ) as Record<string, unknown>;
    return typeof data['remoteUrl'] === 'string' ? data['remoteUrl'] : null;
  } catch {
    return null;
  }
}

/**
 * Search the global registry for identities this project root previously had.
 *
 * Tiers, strongest first: a row registered at this exact path; an alias row
 * for this path's derived ids; a row whose LIVE checkout declares the same
 * git remote. Stranded rows (path gone) cannot be matched by remote because
 * the registry stores no remote — their checkout is the only record of it.
 *
 * @param projectRoot - Absolute project root.
 * @param cleoHome - Global CLEO home whose registry to read.
 * @returns Candidates plus diagnostics; an unreadable registry yields no
 *   candidates and a diagnostic saying coverage is missing.
 */
export async function findRelinkCandidates(
  projectRoot: string,
  cleoHome: string = getCleoHome(),
): Promise<{ candidates: RelinkCandidate[]; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const candidates: RelinkCandidate[] = [];
  const lexicalRoot = resolve(projectRoot);
  const realRoot = canonicalizePath(projectRoot);
  const rootForms = new Set([lexicalRoot, realRoot]);
  try {
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { projectIdAliases, projectRegistry } = await import('../store/schema/nexus-schema.js');
    const { inArray } = await import('drizzle-orm');
    const db = await getNexusRegistryDb(cleoHome);
    const rows = db
      .select({ projectId: projectRegistry.projectId, projectPath: projectRegistry.projectPath })
      .from(projectRegistry)
      .all();

    for (const row of rows) {
      if (rootForms.has(row.projectPath)) candidates.push({ ...row, via: 'registry-path' });
    }

    // Only the full canonical fingerprint is a re-link key. The legacy
    // base64url alias is truncated to 32 chars (24 path bytes), so every
    // checkout under a shared prefix collides on it — measured: two sibling
    // temp dirs re-linked to each other through it.
    const derived = [computePathFingerprintId(realRoot)];
    const aliasRows = db
      .select()
      .from(projectIdAliases)
      .where(inArray(projectIdAliases.legacyId, derived))
      .all();
    for (const alias of aliasRows) {
      const owner = rows.find((row) => row.projectId === alias.canonicalId);
      candidates.push({
        projectId: alias.canonicalId,
        projectPath: owner?.projectPath ?? '',
        via: 'registry-alias',
      });
    }

    const { findGitRemoteUrl } = await import('../nexus/identity.js');
    const remote = normalizeRemoteUrl(await findGitRemoteUrl(realRoot));
    if (remote) {
      for (const row of rows) {
        if (rootForms.has(row.projectPath) || !existsSync(row.projectPath)) continue;
        if (normalizeRemoteUrl(readInfoRemote(row.projectPath)) === remote)
          candidates.push({ ...row, via: 'registry-remote' });
      }
    }
  } catch (error) {
    diagnostics.push(
      `registry unavailable, re-link coverage missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { candidates, diagnostics };
}

/**
 * Decide the identity a scaffold step writes into `project-info.json`.
 *
 * @param projectRoot - Absolute project root.
 * @param localInfoId - The id already in `project-info.json`, if any.
 * @param options - Explicit-mint request and registry home.
 * @returns The decision with provenance and diagnostics.
 * @throws {CleoError} `CONFIG_ERROR` when the tracked file is malformed, or
 *   when the registry offers several candidates and no explicit mint was asked.
 *
 * @example
 * ```ts
 * const { projectId, source } = await decideProjectIdentity(root, undefined);
 * ```
 */
export async function decideProjectIdentity(
  projectRoot: string,
  localInfoId: string | undefined,
  options: DecideProjectIdentityOptions = {},
): Promise<ProjectIdentityDecision> {
  const tracked = readPortableProjectId(projectRoot);
  const diagnostics: string[] = [];
  const trackedFile = `.cleo/${tracked.status !== 'absent' ? (tracked.file ?? PORTABLE_PROJECT_ID_FILE) : PROJECT_MANIFEST_FILE}`;

  // T12716: the tracked id wins — the ONE place this rule lives. Readers
  // (`readDeclaredProjectIdentity`, `decodeProjectInfo`) apply the same order.
  if (tracked.status === 'valid') {
    if (localInfoId && localInfoId !== tracked.projectId) {
      diagnostics.push(
        `identity conflict: ${trackedFile} is '${tracked.projectId}' but the project-info.json cache is '${localInfoId}'; the tracked id wins. Re-key local state with \`cleo doctor project-identity --resolve\` (the old id stays resolvable as an alias)`,
      );
    }
    return { projectId: tracked.projectId, source: 'tracked', diagnostics };
  }
  if (tracked.status === 'invalid') {
    if (localInfoId) {
      // Never block a working checkout on a damaged tracked file, and never
      // regenerate it: keep the cached id and report the file.
      diagnostics.push(
        `${trackedFile} is unusable (${tracked.reason}); keeping the project-info.json id '${localInfoId}'. Restore it: \`git checkout -- ${trackedFile}\``,
      );
      return { projectId: localInfoId, source: 'project-info', diagnostics };
    }
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Tracked project identity ${join(projectRoot, trackedFile)} is unusable (${tracked.reason}); refusing to mint a replacement`,
      { fix: `Restore it from version control: \`git checkout -- ${trackedFile}\`` },
    );
  }
  if (localInfoId) {
    return { projectId: localInfoId, source: 'project-info', diagnostics };
  }

  if (options.mintNewIdentity) {
    diagnostics.push('minted a new identity on explicit request');
    return { projectId: randomUUID(), source: 'minted', diagnostics };
  }

  const found = await findRelinkCandidates(projectRoot, options.cleoHome);
  diagnostics.push(...found.diagnostics);
  for (const via of ['registry-path', 'registry-alias', 'registry-remote'] as const) {
    const tier = found.candidates.filter((candidate) => candidate.via === via);
    const ids = [...new Set(tier.map((candidate) => candidate.projectId))].filter(
      isValidPortableProjectId,
    );
    if (ids.length === 1) {
      const [projectId] = ids as [string];
      diagnostics.push(
        `re-linked identity '${projectId}' from ${via} (${tier[0]?.projectPath || 'alias'})`,
      );
      return { projectId, source: via, diagnostics };
    }
    if (ids.length > 1) {
      throw new CleoError(
        ExitCode.CONFIG_ERROR,
        `Cannot re-link project identity for ${projectRoot}: ${ids.length} registered identities match by ${via} (${tier
          .map((candidate) => `${candidate.projectId} @ ${candidate.projectPath}`)
          .join(', ')})`,
        {
          fix: 'Restore .cleo/project.json (or the legacy .cleo/project-id) with the intended id from version control, or mint explicitly with `cleo init --new-identity`',
        },
      );
    }
  }

  diagnostics.push('minted a new identity: no local, tracked or registered identity to re-link');
  return { projectId: randomUUID(), source: 'minted', diagnostics };
}

/**
 * Default display name for a project root: its directory basename, made a
 * valid name (control characters and separators replaced, a leading `~`
 * dropped, capped at {@link PROJECT_DISPLAY_NAME_MAX}). `project` when nothing
 * usable is left.
 *
 * @param projectRoot - Project root.
 * @returns A name that passes `isValidProjectDisplayName`.
 *
 * @example
 * ```ts
 * defaultProjectDisplayName('/work/cleocode'); // 'cleocode'
 * ```
 * @task T12716
 */
export function defaultProjectDisplayName(projectRoot: string): string {
  const cleaned = basename(resolve(projectRoot))
    .replace(/[/\\\u0000-\u001f\u007f]/g, '-')
    .replace(/^~+/, '')
    .slice(0, PROJECT_DISPLAY_NAME_MAX)
    .trim();
  return isValidProjectDisplayName(cleaned) ? cleaned : 'project';
}

/** Create a file with `O_EXCL`; `false` when it already exists. */
async function writeExclusive(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Create `.cleo/project.json` for `projectId` — create-only (`O_EXCL`).
 *
 * @param projectRoot - Absolute project root.
 * @param projectId - The identity to record; never changed afterwards.
 * @param name - Display name; must pass `isValidProjectDisplayName`.
 * @returns `written`, or — for a file that already exists — `present` (same
 *   id), `conflict` (different id) or `invalid` (unparseable). Never rewrites.
 *
 * @example
 * ```ts
 * await createProjectManifest(root, 'c78d09c3a8ee', 'cleocode'); // 'written'
 * ```
 * @task T12716
 */
export async function createProjectManifest(
  projectRoot: string,
  projectId: string,
  name: string,
): Promise<'written' | 'present' | 'conflict' | 'invalid' | 'no-cleo-dir'> {
  if (!isValidPortableProjectId(projectId) || !isValidProjectDisplayName(name)) return 'invalid';
  if (!existsSync(join(projectRoot, '.cleo'))) return 'no-cleo-dir';
  const body = formatProjectManifest({
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: projectId,
    name,
  });
  if (await writeExclusive(projectManifestPath(projectRoot), body)) return 'written';
  // Present (or lost a race): judge what is there, never overwrite it.
  const current = readProjectManifest(projectRoot);
  if (current.status !== 'valid') return 'invalid';
  return current.manifest.id === projectId ? 'present' : 'conflict';
}

/**
 * Create the legacy `.cleo/project-id` mirror for `projectId` — create-only.
 * Older builds read only this file, so it is kept beside `project.json`
 * until a later removal (T12716).
 *
 * @param projectRoot - Absolute project root.
 * @param projectId - The identity to mirror.
 * @returns `written`, or for an existing file `present` / `conflict` / `invalid`.
 *
 * @example
 * ```ts
 * await createProjectIdMirror(root, 'c78d09c3a8ee');
 * ```
 * @task T12716
 */
export async function createProjectIdMirror(
  projectRoot: string,
  projectId: string,
): Promise<'written' | 'present' | 'conflict' | 'invalid' | 'no-cleo-dir'> {
  if (!isValidPortableProjectId(projectId)) return 'invalid';
  if (!existsSync(join(projectRoot, '.cleo'))) return 'no-cleo-dir';
  if (await writeExclusive(portableProjectIdPath(projectRoot), formatPortableProjectId(projectId)))
    return 'written';
  const current = readProjectIdFile(projectRoot);
  if (current.status !== 'valid') return 'invalid';
  return current.projectId === projectId ? 'present' : 'conflict';
}

/**
 * Make sure the tracked files record `projectId` — write-once.
 *
 * Only a project with NO tracked identity gets files: `project.json` and the
 * legacy `project-id` mirror, both created with `O_EXCL`. A present file is
 * compared, never rewritten, and a legacy-only project is reported as
 * `legacy` rather than migrated (migration is `cleo doctor project-identity
 * --resolve`, T12716).
 *
 * @param projectRoot - Absolute project root.
 * @param projectId - The identity to adopt.
 * @param name - Display name for a new `project.json`; defaults to
 *   {@link defaultProjectDisplayName}. Ignored when a file already exists.
 * @returns What happened; `legacy`/`conflict`/`invalid` are for the caller to report.
 *
 * @example
 * ```ts
 * const outcome = await ensurePortableProjectId(root, info.projectId);
 * ```
 */
export async function ensurePortableProjectId(
  projectRoot: string,
  projectId: string,
  name?: string,
): Promise<PortableIdFileOutcome> {
  const current = readPortableProjectId(projectRoot);
  if (current.status === 'valid') {
    if (current.projectId !== projectId) return 'conflict';
    return current.file === PORTABLE_PROJECT_ID_FILE ? 'legacy' : 'present';
  }
  if (current.status === 'invalid') return 'invalid';
  if (!isValidPortableProjectId(projectId)) return 'invalid';
  if (!existsSync(join(projectRoot, '.cleo'))) return 'no-cleo-dir';
  const displayName =
    name !== undefined && isValidProjectDisplayName(name)
      ? name
      : defaultProjectDisplayName(projectRoot);
  const manifest = await createProjectManifest(projectRoot, projectId, displayName);
  if (manifest !== 'written' && manifest !== 'present') return manifest;
  const mirror = await createProjectIdMirror(projectRoot, projectId);
  if (mirror === 'conflict' || mirror === 'invalid') return mirror;
  return manifest;
}

/**
 * Rename a project in its committed `.cleo/project.json`: only `name` changes;
 * the id is carried over byte-identical and keys this build does not know are
 * kept (`writeProjectManifestName`: a tmp file unique to the call, renamed
 * into place, so a crash never leaves a half-written identity file).
 *
 * @param projectRoot - Absolute project root.
 * @param name - New display name (trimmed; must pass `isValidProjectDisplayName`).
 * @returns The previous and new manifest names.
 * @throws {CleoError} `VALIDATION_ERROR` for an invalid name; `CONFIG_ERROR`
 *   when `project.json` is absent (migrate first) or unusable.
 *
 * @example
 * ```ts
 * await renameProjectManifest(root, 'cleo-platform');
 * ```
 * @task T12716
 */
export async function renameProjectManifest(
  projectRoot: string,
  name: string,
): Promise<{ oldName: string; newName: string; projectId: string }> {
  const newName = name.trim();
  if (!isValidProjectDisplayName(newName)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid project name '${newName}': use 1-${PROJECT_DISPLAY_NAME_MAX} characters with no "/", "\\", control characters or leading "~"`,
    );
  }
  const current = readProjectManifest(projectRoot);
  if (current.status !== 'valid') {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      current.status === 'absent'
        ? `${projectManifestPath(projectRoot)} does not exist yet`
        : `${projectManifestPath(projectRoot)} is unusable (${current.reason})`,
      {
        fix:
          current.status === 'absent'
            ? 'Run `cleo doctor project-identity --resolve` to record the identity in .cleo/project.json'
            : `Restore it from version control: \`git checkout -- .cleo/${PROJECT_MANIFEST_FILE}\``,
      },
    );
  }
  // Only `name` changes; unknown keys survive; a per-call tmp file (T12716).
  const { writeProjectManifestName } = await import('../project-info.js');
  return writeProjectManifestName(projectRoot, newName);
}
