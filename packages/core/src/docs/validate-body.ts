/**
 * Body-schema validation for canonical doc kinds (T10160).
 *
 * Scans a Markdown body for H2 (`## ...`) section headers and checks them
 * against the {@link DocKindMetadata.requiredSections} list declared in the
 * canonical doc-kind taxonomy. Comparison is:
 *
 * - case-insensitive (`## decision` matches `Decision`)
 * - tolerant of hyphen vs space (`## Next Steps` matches `Next-Steps`)
 * - tolerant of trailing punctuation in the header (`## Decision:` matches)
 *
 * Unknown kinds (not in the registry) and kinds with no `requiredSections`
 * or an empty array always pass — this keeps the validator additive: a
 * project that never opts a kind into a schema sees no behaviour change.
 *
 * The function is pure and synchronous — no filesystem, no DB. The CLI
 * wires it into `cleo docs add` / `cleo docs publish` in advisory mode by
 * default; `--strict` makes a body-schema mismatch fatal with
 * `E_DOC_BODY_INVALID`.
 *
 * @task T10160 (E12.C3 · absorbs T10154)
 * @epic T10157
 * @saga T9855
 */

import { BUILTIN_DOC_KINDS, type DocKindMetadata, type DocKindRegistry } from '@cleocode/contracts';

/**
 * Result of {@link validateDocBody}.
 */
export interface ValidateDocBodyResult {
  /** True when every required H2 section is present (or the kind has none). */
  readonly ok: boolean;
  /** Missing required-section titles, in declaration order. Empty when ok. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Internal — extract H2 titles (`## Title`) from a Markdown body.
 *
 * Strips ATX-style trailing `#` markers, trailing punctuation (`:`, `.`),
 * and surrounding whitespace. The returned strings retain their original
 * casing; normalisation for comparison happens in {@link normaliseSection}.
 */
function extractH2Sections(body: string): string[] {
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const title = match[1]!.replace(/[:.]+$/, '').trim();
    if (title.length > 0) out.push(title);
  }
  return out;
}

/**
 * Internal — fold a section title into a canonical comparison form:
 * lowercased, hyphens collapsed to single spaces, whitespace trimmed +
 * collapsed.
 */
function normaliseSection(title: string): string {
  return title.toLowerCase().replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate a Markdown body against the required-sections schema for `kind`.
 *
 * Behaviour:
 * - Unknown kind → `{ ok: true, missing: [] }` (advisory — no schema rules).
 * - Kind declared with no `requiredSections` (or `[]`) → always ok.
 * - Otherwise → reports any required H2 section title not found in `body`.
 *
 * Matching ignores case and treats hyphens as spaces — `## next-steps`
 * satisfies a requirement of `Next Steps` and vice versa.
 *
 * Built-ins-only fast path: the function pulls metadata from
 * {@link BUILTIN_DOC_KINDS} so callers with no project root in scope
 * (e.g. dispatch handlers operating on a worktree-routed file) can still
 * validate. Extension-only kinds are reached through the optional
 * {@link DocKindRegistry} parameter.
 *
 * @param kind - Canonical doc kind id (e.g. `'adr'`, `'spec'`).
 * @param body - Markdown body to scan. Frontmatter is irrelevant — we
 *               only look at `## ...` headers.
 * @param registry - Optional registry (built-ins + project extensions).
 *                   When omitted, only built-in kinds are considered.
 */
export function validateDocBody(
  kind: string,
  body: string,
  registry?: DocKindRegistry,
): ValidateDocBodyResult {
  const meta = lookupMetadata(kind, registry);
  if (!meta?.requiredSections || meta.requiredSections.length === 0) {
    return { ok: true, missing: [] };
  }

  const presentRaw = extractH2Sections(body);
  const presentNorm = new Set(presentRaw.map(normaliseSection));

  const missing: string[] = [];
  for (const required of meta.requiredSections) {
    if (!presentNorm.has(normaliseSection(required))) {
      missing.push(required);
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Internal — look up metadata for `kind`, preferring the supplied registry
 * when present and falling back to the built-in list otherwise.
 */
function lookupMetadata(
  kind: string,
  registry: DocKindRegistry | undefined,
): DocKindMetadata | undefined {
  if (registry) {
    return registry.get(kind);
  }
  return BUILTIN_DOC_KINDS.find((m) => m.kind === kind);
}
