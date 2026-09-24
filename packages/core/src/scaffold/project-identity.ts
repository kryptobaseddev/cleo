/**
 * Write-once portable project identity: decide, re-link, adopt (T12325).
 *
 * The tracked `.cleo/project-id` file (read by `@cleocode/paths`) is the one
 * project identifier that survives a fresh clone, a move, and a new device.
 * This module owns the two write-side rules ADR-094 (amending ADR-013 §9) depends on:
 *
 * 1. **Write once.** The file is created with `O_EXCL` and never rewritten. A
 *    conflicting or malformed file is reported, not repaired.
 * 2. **Never silently re-mint.** When no local or tracked id exists, the
 *    global registry is searched for the project's previous identity (same
 *    path, its canonical-fingerprint alias, or a live checkout of the same remote). A
 *    unique candidate is re-linked; several candidates refuse to guess; a new
 *    id is minted only when nothing can be re-linked or when the caller asks
 *    for one explicitly.
 *
 * Precedence when both files exist and disagree: the local
 * `project-info.json` id wins and the conflict is reported. Local state
 * (registry row, aliases, brain) is keyed by that id, so switching silently
 * would re-key it — the data-loss geometry this whole design avoids. Two ids
 * for one repository means two lineages (typically two devices that each ran
 * `cleo init` before this file existed); reconciling them is an explicit act.
 *
 * @task T12325
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import {
  canonicalizePath,
  computeCanonicalProjectId,
  formatPortableProjectId,
  getCleoHome,
  isValidPortableProjectId,
  portableProjectIdPath,
  readPortableProjectId,
} from '@cleocode/paths';
import { CleoError } from '../errors.js';

/**
 * Where the identity a scaffold step settled on came from.
 *
 * - `project-info` — the existing local `project-info.json` id (adopted as-is).
 * - `tracked` — the committed `.cleo/project-id` (fresh clone).
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

/** Outcome of making sure `.cleo/project-id` records the project's id. */
export type PortableIdFileOutcome =
  /** Already present with the same id. */
  | 'present'
  /** Created now (first adoption). */
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

/**
 * Normalise a git remote URL so `git@host:o/r.git` and `https://host/o/r`
 * compare equal. Returns `null` for empty input.
 *
 * @param url - Raw `git remote get-url` output or a stored `remoteUrl`.
 * @returns A `host/owner/repo` style key, or `null`.
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let key = url.trim();
  if (!key) return null;
  key = key.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  key = key.replace(/^[^@/]+@/, '');
  key = key.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
  key = key.replace(/\/+$/, '').replace(/\.git$/i, '');
  return key.toLowerCase() || null;
}

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
    const derived = [computeCanonicalProjectId(realRoot)];
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

  if (localInfoId) {
    if (tracked.status === 'valid' && tracked.projectId !== localInfoId) {
      diagnostics.push(
        `identity conflict: .cleo/project-id is '${tracked.projectId}' but project-info.json is '${localInfoId}'; keeping the local id — reconcile explicitly`,
      );
    }
    return { projectId: localInfoId, source: 'project-info', diagnostics };
  }

  if (tracked.status === 'valid') {
    return { projectId: tracked.projectId, source: 'tracked', diagnostics };
  }
  if (tracked.status === 'invalid') {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Tracked project identity ${portableProjectIdPath(projectRoot)} is unusable (${tracked.reason}); refusing to mint a replacement`,
      { fix: 'Restore it from version control: `git checkout -- .cleo/project-id`' },
    );
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
          fix: 'Write the intended id to .cleo/project-id, or mint explicitly with `cleo init --new-identity`',
        },
      );
    }
  }

  diagnostics.push('minted a new identity: no local, tracked or registered identity to re-link');
  return { projectId: randomUUID(), source: 'minted', diagnostics };
}

/**
 * Make sure `<projectRoot>/.cleo/project-id` records `projectId` — write-once.
 *
 * Creates the file only when absent (`O_EXCL`); a present file is compared,
 * never rewritten.
 *
 * @param projectRoot - Absolute project root.
 * @param projectId - The identity to adopt.
 * @returns What happened; `conflict`/`invalid` are for the caller to report.
 *
 * @example
 * ```ts
 * const outcome = await ensurePortableProjectId(root, info.projectId);
 * ```
 */
export async function ensurePortableProjectId(
  projectRoot: string,
  projectId: string,
): Promise<PortableIdFileOutcome> {
  const current = readPortableProjectId(projectRoot);
  if (current.status === 'valid') return current.projectId === projectId ? 'present' : 'conflict';
  if (current.status === 'invalid') return 'invalid';
  if (!isValidPortableProjectId(projectId)) return 'invalid';
  if (!existsSync(join(projectRoot, '.cleo'))) return 'no-cleo-dir';
  try {
    await writeFile(portableProjectIdPath(projectRoot), formatPortableProjectId(projectId), {
      flag: 'wx',
    });
    return 'written';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      // Lost a race with another writer: judge what they wrote, never overwrite it.
      const raced = readPortableProjectId(projectRoot);
      if (raced.status === 'valid') return raced.projectId === projectId ? 'present' : 'conflict';
      return 'invalid';
    }
    throw error;
  }
}
