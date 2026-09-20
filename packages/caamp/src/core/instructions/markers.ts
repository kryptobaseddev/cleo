/**
 * CAAMP marker engine — parsing, damage repair, and canonical block rendering.
 *
 * The grammar itself lives in `@cleocode/contracts/caamp-markers` (const data
 * in the leaf package, because `@cleocode/core` and `@cleocode/caamp` depend on
 * each other and cannot share a module directly). This file is the only place
 * that turns that grammar into behaviour.
 *
 * ## Why damage repair exists
 *
 * A CAAMP block is delimited by two HTML comments. Losing a single character
 * from an opening marker — `<!-- CAAMP:START -->` becoming `!-- CAAMP:START -->`
 * — used to be unrecoverable *and* self-amplifying:
 *
 * 1. The strict pattern no longer matched the block.
 * 2. `inject()` concluded the file had no CAAMP block at all and **prepended a
 *    fresh one**, rather than replacing the damaged one.
 * 3. The file now contained two blocks. The protocol text they reference was
 *    loaded into every agent's context twice.
 * 4. `cleo doctor` reported "markers unbalanced" and prescribed `cleo upgrade`
 *    — which ran `inject()` again and could only make it worse.
 *
 * That ratchet was observed in the wild on `~/.agents/AGENTS.md`, which had
 * accumulated three blocks from two separate single-byte losses.
 *
 * {@link normalizeMarkers} breaks the loop by healing near-miss markers back to
 * canonical form *before* any decision is made about the file, so a damaged
 * block is recognised and replaced instead of duplicated.
 *
 * @task T12051
 */

import {
  CAAMP_BLOCK_PATTERN_SOURCE,
  CAAMP_DAMAGED_END_PATTERN_SOURCE,
  CAAMP_DAMAGED_START_PATTERN_SOURCE,
  CAAMP_MARKER_END,
  CAAMP_MARKER_START,
} from '@cleocode/contracts/caamp-markers';

/**
 * A single parsed CAAMP block extracted from a file.
 *
 * @public
 */
export interface CaampBlock {
  /** Raw text of the entire block including markers. */
  raw: string;
  /** Trimmed content between the markers. */
  content: string;
  /** Zero-based character offset of the start of the block in the file. */
  startIndex: number;
  /** Zero-based character offset immediately after the block in the file. */
  endIndex: number;
}

/**
 * Result of healing damaged markers in a string.
 *
 * @public
 */
export interface NormalizeResult {
  /** Content with every recognised marker rewritten to canonical form. */
  content: string;
  /** How many marker lines were rewritten. `0` means the input was already canonical. */
  repaired: number;
}

/**
 * Build a fresh global pattern matching a complete canonical CAAMP block.
 *
 * A new `RegExp` is returned on every call deliberately. A shared module-level
 * `RegExp` carrying the `g` flag holds a mutable `lastIndex`, so reusing one
 * across `.test()` or `.exec()` calls silently skips matches — a defect that
 * previously existed in `removeInjection`.
 *
 * @returns A new `RegExp` with the `g` flag; capture group 1 is the block body
 *
 * @example
 * ```typescript
 * for (const m of content.matchAll(blockPattern())) {
 *   console.log(m[1]);
 * }
 * ```
 *
 * @public
 */
export function blockPattern(): RegExp {
  return new RegExp(CAAMP_BLOCK_PATTERN_SOURCE, 'g');
}

/**
 * Rewrite every damaged CAAMP marker line back to its canonical form.
 *
 * Only whole lines are considered, so prose that merely mentions a marker is
 * left alone. Lines that are already canonical are matched but rewritten to an
 * identical string, and therefore are not counted as repairs.
 *
 * @param content - Raw file contents
 * @returns The healed content and the number of marker lines actually changed
 *
 * @example
 * ```typescript
 * const { content, repaired } = normalizeMarkers(await readFile(p, "utf-8"));
 * if (repaired > 0) console.log(`healed ${repaired} damaged marker(s)`);
 * ```
 *
 * @public
 */
export function normalizeMarkers(content: string): NormalizeResult {
  let repaired = 0;

  const heal = (input: string, source: string, canonical: string): string =>
    input.replace(new RegExp(source, 'gmi'), (match) => {
      // Horizontal whitespace and CRLF bytes are not marker punctuation.
      const leading = /^[ \t\r]*/.exec(match)?.[0] ?? '';
      const trailing = /[ \t\r]*$/.exec(match)?.[0] ?? '';
      const replacement = leading + canonical + trailing;
      if (match === replacement) return match;
      repaired += 1;
      return replacement;
    });

  // Keep a UTF-8 BOM at the original file boundary while matching its first line.
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  let out = heal(content.slice(bom.length), CAAMP_DAMAGED_START_PATTERN_SOURCE, CAAMP_MARKER_START);
  out = heal(out, CAAMP_DAMAGED_END_PATTERN_SOURCE, CAAMP_MARKER_END);

  return { content: bom + out, repaired };
}

/**
 * Parse every canonical CAAMP block out of a file's contents.
 *
 * Blocks are returned in order of appearance. An opening marker with no
 * matching closing marker is skipped rather than throwing, so a corrupted file
 * can still be inspected.
 *
 * Call {@link normalizeMarkers} first if the input may contain damaged markers
 * — this function is deliberately strict.
 *
 * @param fileContent - Raw text content of the file
 * @returns Array of parsed CAAMP blocks
 *
 * @example
 * ```typescript
 * const blocks = parseBlocks(await readFile(agentsMd, "utf-8"));
 * console.log(`${blocks.length} block(s)`);
 * ```
 *
 * @public
 */
export function parseBlocks(fileContent: string): CaampBlock[] {
  const blocks: CaampBlock[] = [];
  const pattern = blockPattern();

  for (let match = pattern.exec(fileContent); match !== null; match = pattern.exec(fileContent)) {
    const raw = match[0];
    blocks.push({
      raw,
      content: (match[1] ?? '').trim(),
      startIndex: match.index,
      endIndex: match.index + raw.length,
    });
  }

  return blocks;
}

/**
 * Wrap content in canonical CAAMP markers.
 *
 * @param content - Body of the block
 * @returns The full block, markers included
 *
 * @example
 * ```typescript
 * buildBlock("@AGENTS.md");
 * // "<!-- CAAMP:START -->\n@AGENTS.md\n<!-- CAAMP:END -->"
 * ```
 *
 * @public
 */
export function buildBlock(content: string): string {
  return `${CAAMP_MARKER_START}\n${content}\n${CAAMP_MARKER_END}`;
}

/** Reject ambiguous ownership before a caller can write or discard text. */
function assertBalancedMarkers(content: string): void {
  let open = false;
  const markers = new RegExp(`${CAAMP_MARKER_START}|${CAAMP_MARKER_END}`, 'g');
  for (const match of content.matchAll(markers)) {
    const opening = match[0] === CAAMP_MARKER_START;
    if (opening === open) {
      throw new Error(
        'Ambiguous CAAMP markers: nested or unmatched delimiter; original content preserved.',
      );
    }
    open = opening;
  }
  if (open)
    throw new Error(
      'Ambiguous CAAMP markers: opening delimiter has no end; original content preserved.',
    );
}

/**
 * Where {@link reconcile} places the block when the file has none yet.
 *
 * Only applies to a file that has no CAAMP block at all — an existing block is
 * always replaced where it already is, never moved.
 *
 * @public
 */
export type BlockInsertPosition = 'prepend' | 'append';

/**
 * Outcome of reconciling a file's contents against the desired CAAMP block.
 *
 * @public
 */
export interface ReconcileResult {
  /** The file contents that should be on disk. */
  content: string;
  /** Number of blocks found before reconciliation. */
  blocksBefore: number;
  /** Number of damaged marker lines healed. */
  repaired: number;
}

/**
 * Reconcile a file's contents so it contains exactly one canonical CAAMP block
 * carrying `desiredContent`.
 *
 * The rules, in order:
 *
 * 1. Damaged markers are healed first, so a corrupted block is recognised as a
 *    block rather than treated as absent.
 * 2. If the file has no block, one is inserted — at the top by default, or at
 *    the bottom when `insert` is `'append'` (which is what the Pi harness has
 *    always done for its own `AGENTS.md`).
 * 3. If the file has one or more blocks, the **first** is replaced in place and
 *    any others are removed. Replacing in place matters: prepending instead
 *    would walk the block up the file on every run, and would separate it from
 *    any heading a user wrote above it.
 * 4. Every byte outside CAAMP blocks is preserved, including indentation,
 *    CRLF, BOM, blank lines and trailing whitespace. Only newly inserted block
 *    separators are added; existing user text is never trimmed or tidied.
 * 5. Nested or unmatched markers are ambiguous ownership and reject mutation.
 *    No guessed region is removed or expanded to consume user content.
 *
 * This function is pure — it performs no I/O, which is what makes the
 * behaviour straightforward to test exhaustively.
 *
 * @param existing - Current file contents
 * @param desiredContent - Body the single surviving block should carry
 * @param insert - Placement when the file has no block yet
 * @returns The reconciled content plus what was found on the way
 * @throws When existing or desired markers have ambiguous ownership.
 *
 * @example
 * ```typescript
 * const { content, blocksBefore, repaired } = reconcile(onDisk, "@AGENTS.md");
 * if (content !== onDisk) await writeFileAtomic(path, content);
 * ```
 *
 * @public
 */
export function reconcile(
  existing: string,
  desiredContent: string,
  insert: BlockInsertPosition = 'prepend',
): ReconcileResult {
  const { content: healed, repaired } = normalizeMarkers(existing);
  assertBalancedMarkers(healed);
  const blocks = parseBlocks(healed);
  // Trim the body so whitespace-only differences converge to one canonical
  // form instead of rewriting the file on every call.
  const desiredBlock = buildBlock(desiredContent.trim());
  assertBalancedMarkers(desiredBlock);

  if (blocks.length === 0) {
    if (healed.length === 0) return { content: `${desiredBlock}\n`, blocksBefore: 0, repaired };
    const bom = healed.startsWith('\uFEFF') ? '\uFEFF' : '';
    return {
      content:
        insert === 'append'
          ? `${healed}\n\n${desiredBlock}\n`
          : `${bom}${desiredBlock}\n\n${healed.slice(bom.length)}`,
      blocksBefore: 0,
      repaired,
    };
  }

  let out = '';
  let cursor = 0;

  for (const [index, block] of blocks.entries()) {
    out += healed.slice(cursor, block.startIndex);
    cursor = block.endIndex;
    // Keep the first block's position; every later block is dropped.
    if (index === 0) out += desiredBlock;
  }
  out += healed.slice(cursor);

  return { content: out, blocksBefore: blocks.length, repaired };
}

/**
 * Merge the bodies of several CAAMP blocks into one, preserving order and
 * dropping exact duplicate lines.
 *
 * Used by repair, which — unlike injection — does not know what the block
 * *should* contain. Keeping the union rather than picking a winner means no
 * reference is silently dropped when two blocks legitimately differ (a project
 * block carrying `@AGENTS.md` and a global one carrying
 * `@~/.agents/AGENTS.md`, for instance).
 *
 * @param blocks - Blocks to merge, in file order
 * @returns The merged body
 *
 * @example
 * ```typescript
 * mergeBlockBodies(parseBlocks(content));
 * // "@AGENTS.md\n@~/.agents/AGENTS.md"
 * ```
 *
 * @public
 */
export function mergeBlockBodies(blocks: readonly CaampBlock[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const block of blocks) {
    for (const line of block.content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }

  return lines.join('\n');
}

/**
 * Restore a file to exactly one well-formed CAAMP block without needing to
 * know what that block should contain.
 *
 * This is what `cleo caamp repair` and `cleo doctor` use. Injection knows the
 * desired body and calls {@link reconcile}; repair does not, so it derives the
 * surviving body from what is already there via {@link mergeBlockBodies}.
 *
 * Deriving rather than deduplicating matters: the previous repair removed only
 * blocks with *identical* bodies, so a file with two blocks carrying different
 * references was reported as "2 blocks (expected 1)" by the health check and
 * then left untouched by the repair the health check prescribed — an
 * unfixable warning loop.
 *
 * @param existing - Current file contents
 * @returns The repaired content plus what was found on the way
 * @throws When marker ownership is ambiguous; callers must preserve the original file.
 *
 * @example
 * ```typescript
 * const { content, blocksBefore, repaired } = repairContent(onDisk);
 * ```
 *
 * @public
 */
export function repairContent(existing: string): ReconcileResult {
  const { content: healed, repaired } = normalizeMarkers(existing);
  assertBalancedMarkers(healed);
  const blocks = parseBlocks(healed);

  if (blocks.length === 0) {
    return { content: healed, blocksBefore: 0, repaired };
  }

  const merged = reconcile(healed, mergeBlockBodies(blocks));
  return { content: merged.content, blocksBefore: blocks.length, repaired };
}
