/**
 * dedup — SHA-based skip-gate for `cleo docs import`.
 *
 * Bytes that already live in the docs SSoT under the same content sha
 * MUST not be re-imported — the second import would just add a duplicate
 * blob version with zero new information. The dedup gate looks up the
 * (kind, contentSha) tuple against an existing-shas set the caller
 * supplies (sourced from a one-shot `DocsAccessor.listDocs()` snapshot)
 * and returns a `noop` decision when the bytes are already known.
 *
 * `--force` bypasses dedup. The CLI handler is responsible for writing
 * the audit line to `.cleo/audit/import-force-bypass.jsonl` per
 * the team-lead's spec.
 *
 * @epic T9628 (Saga T9625)
 * @task T9711 (ST-MIG-1c)
 */

/** A decision returned by {@link decideDedupAction}. */
export type DedupDecision =
  | { readonly action: 'create'; readonly contentSha: string }
  | { readonly action: 'noop'; readonly contentSha: string; readonly reason: 'sha-already-stored' };

/** Options for {@link decideDedupAction}. */
export interface DedupOptions {
  /** Hex-encoded SHA-256 of the file content. */
  readonly contentSha: string;
  /**
   * Set of `contentSha` values already known to the docs SSoT for the
   * current scope (typically scoped per docs `kind`). When the incoming
   * sha is a member, the action is `noop`.
   */
  readonly existingShas: ReadonlySet<string>;
  /** When true, bypass dedup and force a fresh import. Default: false. */
  readonly force?: boolean;
}

/**
 * Decide whether the bytes identified by `contentSha` need a fresh write
 * or can be skipped because they already exist.
 *
 * Pure function — no I/O — so the import orchestrator can call it inside
 * the per-file loop with a single up-front lookup of `existingShas`.
 *
 * @param options - The content sha + existing-sha set.
 * @returns A {@link DedupDecision}.
 */
export function decideDedupAction(options: DedupOptions): DedupDecision {
  if (options.force) {
    return { action: 'create', contentSha: options.contentSha };
  }
  if (options.existingShas.has(options.contentSha)) {
    return {
      action: 'noop',
      contentSha: options.contentSha,
      reason: 'sha-already-stored',
    };
  }
  return { action: 'create', contentSha: options.contentSha };
}
