/**
 * CAAMP instruction-block marker grammar — the single source of truth.
 *
 * CAAMP delimits the region it owns inside an agent instruction file
 * (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, …) with a pair of HTML comments:
 *
 * ```markdown
 * <!-- CAAMP:START -->
 * @~/.cleo/templates/CLEO-INJECTION.md
 * <!-- CAAMP:END -->
 * ```
 *
 * Before T12051 this grammar was re-declared as inline string and regex
 * literals in at least five places — `caamp/core/instructions/injector.ts`,
 * `caamp/core/harness/pi.ts`, `core/injection.ts`, `core/bootstrap.ts` and
 * `core/validation/doctor/checks.ts`. Each copy recognised a slightly
 * different dialect, so a file that one module considered healthy another
 * considered corrupt.
 *
 * The grammar lives here, in the leaf package, because `@cleocode/core` and
 * `@cleocode/caamp` depend on each other and therefore cannot import the
 * grammar from one another without a cycle.
 *
 * This module is **const data only** — no runtime helpers — so it satisfies
 * the contracts-purity gate (`scripts/lint-no-runtime-in-contracts.mjs`).
 * The engine that consumes these patterns lives in
 * `packages/caamp/src/core/instructions/markers.ts`.
 *
 * @task T12051
 * @see {@link https://github.com/kryptobaseddev/cleo} ADR-064 (CAAMP↔Adapters boundary)
 */

/** Canonical opening marker of a CAAMP-managed block. */
export const CAAMP_MARKER_START = '<!-- CAAMP:START -->';

/** Canonical closing marker of a CAAMP-managed block. */
export const CAAMP_MARKER_END = '<!-- CAAMP:END -->';

/**
 * Source of the strict, canonical block pattern.
 *
 * Capture group 1 is the block's inner content. Build a fresh `RegExp` from
 * this string at every use site — a module-level `RegExp` carrying the `g`
 * flag keeps a mutable `lastIndex`, which silently skips matches when the
 * same object is reused across `.test()` / `.exec()` calls.
 *
 * @example
 * ```typescript
 * const pattern = new RegExp(CAAMP_BLOCK_PATTERN_SOURCE, 'g');
 * ```
 */
export const CAAMP_BLOCK_PATTERN_SOURCE = '<!-- CAAMP:START -->([\\s\\S]*?)<!-- CAAMP:END -->';

/**
 * Horizontal-whitespace class used by the damage-tolerant marker patterns.
 *
 * Deliberately excludes `\n` so the patterns stay anchored to a single line
 * and cannot swallow surrounding content.
 */
const H = '[ \\t\\r]';

/**
 * Build the source of a damage-tolerant, whole-line marker pattern.
 *
 * Recognises the canonical marker plus the near-miss forms produced when a
 * delimiter character is lost or mangled — a truncated write, an editor that
 * reflows HTML comments, a shell heredoc, a careless hand edit.
 *
 * Two constraints keep this from over-matching, both learned from an
 * adversarial review that demonstrated content loss with a looser pattern:
 *
 * 1. The `CAAMP:<KEYWORD>` token must be the *entire* line, modulo comment
 *    punctuation and horizontal whitespace. Prose such as "the CAAMP:START
 *    marker is written by …" is therefore never matched.
 * 2. Comment punctuation must be present on **both** sides — at least one of
 *    `< ! -` before the token and at least one of `- >` after it. A bare
 *    `CAAMP:START` line is deliberately NOT treated as a damaged marker: it is
 *    not a plausible outcome of losing one delimiter character, and accepting
 *    it caused a documentation fence that merely *mentioned* CAAMP to be
 *    rewritten into a real marker, silently swallowing the fenced body.
 */
const damagedMarkerSource = (keyword: 'START' | 'END'): string =>
  `^${H}*[<!-]{1,4}${H}*CAAMP${H}*:${H}*${keyword}${H}*[->]{1,3}${H}*$`;

/**
 * Source of the damage-tolerant pattern matching an opening marker line.
 *
 * Use with the `gmi` flags. Matches all of:
 *
 * | Form                     | Damage                     |
 * | ------------------------ | -------------------------- |
 * | `<!-- CAAMP:START -->`   | none (canonical)           |
 * | `!-- CAAMP:START -->`    | leading `<` lost           |
 * | `<!-- CAAMP:START --`    | trailing `>` lost          |
 * | `<!--CAAMP:START-->`     | spaces collapsed           |
 * | `<!-- caamp:start -->`   | case folded                |
 *
 * A bare `CAAMP:START` with no comment punctuation at all is deliberately NOT
 * matched — see {@link damagedMarkerSource}.
 *
 * @example
 * ```typescript
 * const damaged = new RegExp(CAAMP_DAMAGED_START_PATTERN_SOURCE, 'gmi');
 * const healed = content.replace(damaged, CAAMP_MARKER_START);
 * ```
 */
export const CAAMP_DAMAGED_START_PATTERN_SOURCE = damagedMarkerSource('START');

/**
 * Source of the damage-tolerant pattern matching a closing marker line.
 *
 * Mirrors {@link CAAMP_DAMAGED_START_PATTERN_SOURCE} for `CAAMP:END`. Use
 * with the `gmi` flags.
 */
export const CAAMP_DAMAGED_END_PATTERN_SOURCE = damagedMarkerSource('END');

/**
 * The outcome of writing a CAAMP block into an instruction file.
 *
 * Previously re-declared as an inline union in eight separate locations.
 *
 * - `created` — the file did not exist and was written from scratch.
 * - `added` — the file existed with no CAAMP block; one was prepended.
 * - `repaired` — at least one damaged marker was healed back to canonical form.
 * - `consolidated` — several blocks were merged down to exactly one.
 * - `updated` — a single block existed and its content changed.
 * - `intact` — the file already had exactly the desired content; no write.
 */
export type CaampInjectionAction =
  | 'created'
  | 'added'
  | 'repaired'
  | 'consolidated'
  | 'updated'
  | 'intact';

/**
 * Every {@link CaampInjectionAction} value, ordered from most to least
 * invasive. Useful for reporting the single most significant action taken
 * across a batch of files.
 */
export const CAAMP_INJECTION_ACTIONS = [
  'created',
  'added',
  'repaired',
  'consolidated',
  'updated',
  'intact',
] as const;

/** A delivery defect that must remain visible rather than pretending instructions loaded. */
export interface InstructionDeliveryFinding {
  /** Defect found during deterministic reference expansion. */
  kind: 'missing-reference' | 'cycle' | 'duplicate' | 'limit' | 'stale';
  /** Referenced source path or managed destination. */
  path: string;
  /** Human-readable evidence for the finding. */
  reason: string;
}

/** Self-contained instruction delivery with explicit static verification limits. */
export interface InstructionDelivery {
  /** Resolved content with no reliance on provider reference expansion. */
  content: string;
  /** Sources actually read during expansion. */
  sources: string[];
  /** Defects preventing trustworthy delivery. */
  findings: InstructionDeliveryFinding[];
  /** Static expansion is not a live provider behavior evaluation. */
  liveEvaluation: 'unverified';
}

/**
 * Pattern source for one embedded-source stamp line inside a managed block:
 * `<!-- CAAMP:SOURCE <url-encoded absolute path> <sha256 hex> -->`.
 *
 * A block carrying at least one stamp is an EMBEDDED delivery: it holds the
 * resolved text of its sources rather than `@` references a provider may never
 * expand. Compile with the `m` flag to scan a whole file line by line.
 *
 * @task T12377
 */
export const CAAMP_SOURCE_STAMP_PATTERN_SOURCE = '^<!-- CAAMP:SOURCE (\\S+) ([a-f0-9]{64}) -->$';

/**
 * The managed reference every global provider instruction file is generated
 * from. It is resolved into an embedded delivery before it is written.
 *
 * @task T12377
 */
export const GLOBAL_INSTRUCTION_HUB_REFERENCE = '@~/.agents/AGENTS.md';

/**
 * Delivery state of one global provider instruction file.
 *
 * - `current` — an embedded block whose every stamped source still hashes the same.
 * - `stale` — at least one stamped source changed or disappeared since delivery.
 * - `unembedded` — a managed block exists but carries no source stamp (reference-only
 *   or a generic stub), so the provider may never see the protocol.
 * - `no-block` — the file exists without a managed block.
 * - `absent` — the file does not exist.
 *
 * @task T12378
 */
export type GlobalInstructionFileState = 'current' | 'stale' | 'unembedded' | 'no-block' | 'absent';

/**
 * Staleness verdict for one global provider instruction file.
 *
 * @task T12378
 */
export interface GlobalInstructionFileStatus {
  /** Absolute path of the provider instruction file. */
  path: string;
  /** Provider ids that share this file. */
  providers: string[];
  /** Delivery state of the file. */
  state: GlobalInstructionFileState;
  /** Stamped sources whose content changed or that no longer exist. */
  staleSources: string[];
  /**
   * Lines of managed source content found OUTSIDE the managed block: a hand-appended
   * copy. Reported only; user content is never removed automatically.
   */
  duplicateLines: number;
}

/**
 * Result of the cheap staleness scan over every global provider instruction file.
 *
 * @task T12378
 */
export interface GlobalInstructionStalenessReport {
  /** One entry per distinct provider instruction file. */
  files: GlobalInstructionFileStatus[];
  /** Files whose state is `stale` or `unembedded`: the ones a sync repairs. */
  needsSync: string[];
  /** Files holding a hand-appended copy of managed content outside the block. */
  duplicates: string[];
}

/**
 * Outcome of one global instruction regeneration.
 *
 * - `synced` — every provider file was written (or was already intact).
 * - `unresolved` — the hub could not be resolved into a complete delivery; nothing was written.
 * - `no-providers` — no provider installation was detected.
 * - `dry-run` — the planned targets were computed without writing.
 *
 * @task T12377
 */
export type GlobalInstructionSyncStatus = 'synced' | 'unresolved' | 'no-providers' | 'dry-run';

/**
 * One provider instruction file targeted by a global regeneration.
 *
 * @task T12377
 */
export interface GlobalInstructionSyncFile {
  /** Absolute path of the provider instruction file. */
  path: string;
  /** Provider ids sharing this file. */
  providers: string[];
  /** Action taken, `planned` in a dry run, or `failed` when the write threw. */
  action: CaampInjectionAction | 'planned' | 'failed';
  /** Error message when `action` is `failed`. */
  error?: string;
}

/**
 * Result of regenerating the global provider instruction files from their sources.
 *
 * @task T12377
 */
export interface GlobalInstructionSyncResult {
  /** Overall outcome. */
  status: GlobalInstructionSyncStatus;
  /** One entry per distinct targeted file. */
  files: GlobalInstructionSyncFile[];
  /** Delivery defects that blocked the write (non-empty only when `status` is `unresolved`). */
  findings: InstructionDeliveryFinding[];
  /** Files from which a legacy `CLEO:START` block was stripped. */
  legacyStripped: string[];
  /** Providers skipped because their global instruction path is not absolute. */
  skippedProviders: string[];
}

/**
 * Report of an automatic global-instruction refresh run at session start or briefing.
 *
 * @task T12378
 */
export interface GlobalInstructionRefreshReport {
  /**
   * `current` when nothing needed a refresh, `refreshed` when a sync ran, `skipped`
   * when the refresh did not run, `failed` when it ran and could not complete.
   */
  status: 'current' | 'refreshed' | 'skipped' | 'failed';
  /** Files that were stale or unembedded before the refresh. */
  stale: string[];
  /** Files holding a hand-appended copy of managed content outside the block. */
  duplicates: string[];
  /** Files written by the refresh. */
  updated: string[];
  /** Why the refresh was skipped or failed, when it was. */
  reason?: string;
  /** Exact command that repairs what the refresh could not. */
  remedy?: string;
}
