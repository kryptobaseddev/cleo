/**
 * Ambiguity-aware alias resolution for the project registry (T12589).
 *
 * The legacy project id is `base64url(path).slice(0, 32)`: it encodes only
 * the first 24 bytes of the path, so every project under a long shared prefix
 * (`/Users/<name>/projects/…`) derives the same key. The first project to
 * record that key used to own it, so it resolved to the wrong project for
 * everyone else, and each later project's encounter warned about the
 * collision on every command.
 *
 * A key claimed by more than one registered project is ambiguous: it is never
 * recorded for a second project and never resolves to any project. The rule
 * itself is {@link legacyAliasClaimants} in `@cleocode/paths`, so the raw-SQL
 * resolver there and these registry readers agree.
 *
 * @task T12589
 * @epic T12468
 */

import { legacyAliasClaimants } from '@cleocode/paths';
import { eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { projectIdAliases, projectRegistry } from '../store/schema/nexus-schema.js';

/** Read access to the global registry — a database or an open transaction. */
export type RegistryReader = Pick<NodeSQLiteDatabase, 'select'>;

/** Outcome of resolving an alias key through `nexus_project_id_aliases`. */
export type ProjectAliasResolution =
  | { readonly status: 'none' }
  | { readonly status: 'resolved'; readonly canonicalId: string }
  | { readonly status: 'ambiguous'; readonly claimants: readonly string[] };

/**
 * Every registered project that claims `alias`: the alias row's owner plus
 * each project whose registered path derives it as its legacy id.
 *
 * @param db - Registry database or transaction.
 * @param alias - Alias key.
 * @param owner - The alias row's `canonical_id`, when one exists.
 * @returns Distinct claimant ids, sorted; ambiguous when longer than one.
 * @example
 * ```ts
 * if (registryAliasClaimants(tx, alias).some((id) => id !== projectId)) continue;
 * ```
 */
export function registryAliasClaimants(
  db: RegistryReader,
  alias: string,
  owner?: string | null,
): string[] {
  const recorded = db
    .select({ projectId: projectRegistry.projectId, path: projectRegistry.projectPath })
    .from(projectRegistry)
    .all();
  return legacyAliasClaimants(alias, owner, recorded);
}

/**
 * Resolve an alias key to the one project it names, refusing an ambiguous key.
 *
 * @param db - Registry database or transaction.
 * @param alias - Alias key (legacy base64url id, path fingerprint, old UUID).
 * @returns `resolved` with the canonical id, `ambiguous` with every claimant,
 *   or `none` when no alias row exists.
 * @example
 * ```ts
 * const alias = resolveProjectAlias(db, projectId);
 * if (alias.status === 'resolved') return lookup(alias.canonicalId);
 * ```
 */
export function resolveProjectAlias(db: RegistryReader, alias: string): ProjectAliasResolution {
  const row = db
    .select({ canonicalId: projectIdAliases.canonicalId })
    .from(projectIdAliases)
    .where(eq(projectIdAliases.legacyId, alias))
    .get();
  if (!row) return { status: 'none' };
  const claimants = registryAliasClaimants(db, alias, row.canonicalId);
  return claimants.length > 1
    ? { status: 'ambiguous', claimants }
    : { status: 'resolved', canonicalId: row.canonicalId };
}
