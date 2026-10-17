/**
 * Argument-shape diagnostics for `cleo docs add <OWNER-ID> [<file>]` (T13726).
 *
 * citty binds positionals by order, so `cleo docs add notes.md` binds
 * `notes.md` to OWNER-ID and leaves the file empty. The generic "provide a
 * file path" error then claims no file was given, and agents retried four
 * times before finding the owner-first shape. These helpers name which
 * positional each value landed in and print the exact corrected command.
 *
 * @task T13726
 */

/** A diagnosed `docs add` argument mistake: what went wrong and the exact fix. */
export interface DocsAddArgError {
  /** Human/agent-readable message naming the positional each value bound to. */
  readonly message: string;
  /** Copy-pasteable corrected invocation. */
  readonly fix: string;
}

/** Owner id prefixes `docs.add` infers an owner type from (mirrors dispatch `inferOwnerType`). */
const OWNER_ID_SHAPE = /^(?:[TD]\d+$|ses_|O-|D-|dec_|L-|lrn_|P-|pat_)/i;

/**
 * Whether `value` has the shape of a `docs add` owner id (T###, D###, ses_*, O-*, ...).
 *
 * @param value - The raw positional value.
 * @returns `true` when the value looks like an owner id rather than a path.
 */
export function looksLikeDocsOwnerId(value: string): boolean {
  return OWNER_ID_SHAPE.test(value);
}

/**
 * Diagnose the positional/source shape of a `docs add` invocation.
 *
 * @param input - The bound OWNER-ID and file positionals plus the source flags.
 * @returns The error to report, or `null` when the shape is valid.
 */
export function diagnoseDocsAddSources(input: {
  ownerId: string;
  file?: string;
  url?: string;
  content?: string;
}): DocsAddArgError | null {
  const { ownerId, file } = input;
  const sourceCount = (file ? 1 : 0) + (input.url ? 1 : 0) + (input.content !== undefined ? 1 : 0);
  if (file && !looksLikeDocsOwnerId(ownerId) && looksLikeDocsOwnerId(file)) {
    return {
      message: `docs add arguments are reversed: '${ownerId}' was read as OWNER-ID and '${file}' as the file — OWNER-ID comes first`,
      fix: `cleo docs add ${file} ${ownerId}`,
    };
  }
  if (sourceCount === 0) {
    if (!looksLikeDocsOwnerId(ownerId)) {
      return {
        message: `'${ownerId}' was read as OWNER-ID (the first positional) and no file, --url or --content was given — docs add takes the owner id first, then the file`,
        fix: `cleo docs add <T###|ses_*|O-*> ${ownerId}`,
      };
    }
    return {
      message: `no document source for owner ${ownerId}: pass a file path as the second positional, --content <text>, or --url <url>`,
      fix: `cleo docs add ${ownerId} ./path/to/doc.md   (or: cleo docs add ${ownerId} --content "# Title" --slug my-doc)`,
    };
  }
  if (sourceCount > 1) {
    return {
      message: 'the file positional, --url, and --content are mutually exclusive',
      fix: 'Pass exactly one source: a file path, --url <url>, or --content <text>.',
    };
  }
  return null;
}

/**
 * Error for a file positional that does not resolve to a readable path.
 *
 * @param ownerId - The bound OWNER-ID positional.
 * @param file - The raw file positional as typed.
 * @param resolvedPath - The absolute path the file positional resolved to.
 * @returns The error naming the file positional and the corrected command.
 */
export function docsAddMissingFileError(
  ownerId: string,
  file: string,
  resolvedPath: string,
): DocsAddArgError {
  return {
    message: `file '${file}' (the second positional, after OWNER-ID ${ownerId}) does not exist at ${resolvedPath}`,
    fix: `Check the path, then: cleo docs add ${ownerId} <existing-file>   (or author inline: cleo docs add ${ownerId} --content "..." --slug <slug>)`,
  };
}
