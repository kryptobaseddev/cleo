/**
 * Marker-based instruction file injection
 *
 * Injects content blocks between CAAMP markers in instruction files
 * (CLAUDE.md, AGENTS.md, GEMINI.md) and agent-definition files
 * (cleo-subagent.md, seed agent profiles) per provider's native folder.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CaampInjectionAction } from '@cleocode/contracts/caamp-markers';
import { writeFileAtomic } from '@cleocode/core/tools/fs.js';
import type { InjectionCheckResult, InjectionStatus, Provider } from '../../types.js';
import { assertNotTornRead, withFileLock } from '../fs/atomic.js';
import { getAgentsHome } from '../paths/standard.js';
import { getProvider, getProviderInstructionReferences } from '../registry/providers.js';
import {
  blockPattern,
  buildBlock,
  type CaampBlock,
  normalizeMarkers,
  parseBlocks,
  reconcile,
  repairContent,
} from './markers.js';
import {
  buildInjectionContent,
  type InjectionTemplate,
  resolveInstructionDelivery,
} from './templates.js';

export type { CaampBlock } from './markers.js';

// ── Block parsing ──────────────────────────────────────────────────────────

/**
 * Parse all CAAMP blocks from a file's content string.
 *
 * Returns an array of {@link CaampBlock} objects in order of appearance.
 * Blocks with malformed markers (START without matching END) are silently
 * skipped to avoid crashing on corrupted files.
 *
 * @param fileContent - Raw text content of the file
 * @returns Array of parsed CAAMP blocks
 *
 * @remarks
 * Strict: a block whose marker has been damaged (for example a lost `<`) is
 * not seen. Run {@link normalizeMarkers} first when the input may be corrupt.
 *
 * @example
 * ```typescript
 * const blocks = parseCaampBlocks(await readFile(agentsMd, "utf-8"));
 * ```
 *
 * @public
 */
export function parseCaampBlocks(fileContent: string): CaampBlock[] {
  return parseBlocks(fileContent);
}

/**
 * Result of deduplicating CAAMP blocks in a single file.
 *
 * @public
 */
export interface DedupeResult {
  /** Absolute path to the file that was processed. */
  filePath: string;
  /** Number of duplicate blocks removed. */
  removed: number;
  /** Number of unique blocks kept. */
  kept: number;
  /** `true` if the file was modified on disk; `false` if it was already clean. */
  modified: boolean;
  /**
   * Number of damaged marker lines healed back to canonical form.
   *
   * Non-zero means the file had corruption that the strict block pattern could
   * not see — the condition that used to make duplicates accumulate invisibly.
   */
  repaired: number;
}

/**
 * Deduplicate CAAMP blocks in a file by content.
 *
 * Groups all `<!-- CAAMP:START -->...<!-- CAAMP:END -->` blocks by their
 * trimmed inner content. For each group that has more than one block, keeps
 * only the **last** occurrence (most recently written) and removes the earlier
 * duplicates. Blocks with distinct contents are preserved in their original
 * relative order.
 *
 * Idempotent: calling this on an already-clean file returns `modified: false`
 * and makes no filesystem writes.
 *
 * @param filePath - Absolute path to the file to deduplicate
 * @returns Dedup summary
 *
 * @remarks
 * "Last occurrence wins" matches the behaviour of CLEO's injection chain,
 * which writes the canonical `@~/.local/share/cleo/…` path on every session.
 * Stale temp-path blocks from earlier sessions therefore have earlier indices
 * and are removed, leaving the canonical block.
 *
 * @example
 * ```typescript
 * const result = await dedupeFile("/home/user/.agents/AGENTS.md");
 * console.log(`Removed ${result.removed} duplicate(s)`);
 * ```
 *
 * @public
 */
export async function dedupeFile(filePath: string): Promise<DedupeResult> {
  if (!existsSync(filePath)) {
    return { filePath, removed: 0, kept: 0, modified: false, repaired: 0 };
  }

  return withFileLock(filePath, async () => {
    const original = await readFile(filePath, 'utf-8');

    // Heal damaged markers FIRST. A block whose marker lost a character is
    // invisible to the strict pattern, so without this step the duplicates it
    // caused would be reported as "already clean" (T12051).
    const { content: healed, repaired } = normalizeMarkers(original);
    const blocks = parseBlocks(healed);

    if (blocks.length === 0) {
      if (repaired > 0 && healed !== original) {
        await writeFileAtomic({ path: filePath, content: healed });
        return { filePath, removed: 0, kept: 0, modified: true, repaired };
      }
      return { filePath, removed: 0, kept: 0, modified: false, repaired };
    }

    // Group by trimmed content — last occurrence wins
    const lastByContent = new Map<string, CaampBlock>();
    for (const block of blocks) {
      lastByContent.set(block.content, block);
    }

    const keepSet = new Set<CaampBlock>(lastByContent.values());
    const removed = blocks.length - keepSet.size;

    // Rebuild file content: walk through the healed text, emit blocks that are
    // in keepSet and skip duplicates. Non-block text between blocks is preserved.
    let result = '';
    let cursor = 0;

    for (const block of blocks) {
      // Emit any non-block text before this block
      result += healed.slice(cursor, block.startIndex);
      cursor = block.endIndex;

      if (keepSet.has(block)) {
        result += block.raw;
      }
      // Removed duplicates contribute nothing — surrounding whitespace is
      // normalized by the final collapse step below.
    }

    // Emit any trailing text after the last block
    result += healed.slice(cursor);

    // Normalize: collapse 3+ consecutive newlines → 2, trim trailing whitespace
    result = `${result.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

    // Only rewrite when there is real work to do. Cosmetic differences alone
    // (a missing trailing newline, say) must not cause a write — callers batch
    // this across files they do not own.
    if (removed === 0 && repaired === 0) {
      return { filePath, removed: 0, kept: blocks.length, modified: false, repaired };
    }

    if (result === original) {
      return { filePath, removed: 0, kept: blocks.length, modified: false, repaired };
    }

    await writeFileAtomic({ path: filePath, content: result });
    return { filePath, removed, kept: keepSet.size, modified: true, repaired };
  });
}

/**
 * Deduplicate CAAMP blocks across multiple files.
 *
 * Runs {@link dedupeFile} on each path in order and collects results.
 * Files that do not exist are skipped silently (their result has `removed: 0`).
 *
 * @param filePaths - Array of absolute file paths to process
 * @returns Array of results, one per input path
 *
 * @example
 * ```typescript
 * const results = await dedupeFiles([
 *   "/home/user/.agents/AGENTS.md",
 *   "/project/AGENTS.md",
 * ]);
 * const totalRemoved = results.reduce((n, r) => n + r.removed, 0);
 * console.log(`Removed ${totalRemoved} duplicate(s) across ${results.length} files`);
 * ```
 *
 * @public
 */
export async function dedupeFiles(filePaths: string[]): Promise<DedupeResult[]> {
  const results: DedupeResult[] = [];
  for (const filePath of filePaths) {
    results.push(await dedupeFile(filePath));
  }
  return results;
}

/**
 * Every instruction file CAAMP may have written to, for a given project.
 *
 * Covers three tiers, because corruption in any one of them affects every
 * agent session:
 *
 * 1. The **global hub** `~/.agents/AGENTS.md` — the highest-risk file in the
 *    system. Every `cleo init`, `cleo upgrade` and `cleo doctor` run rewrites
 *    it regardless of which project invoked them, and until T12051 no health
 *    check looked at it at all.
 * 2. The project's own `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`.
 * 3. Each detected provider's global instruction file.
 *
 * Paths are de-duplicated and returned whether or not they exist; callers skip
 * missing ones.
 *
 * @param projectDir - Absolute path to the project directory
 * @param providers - Detected providers whose global files should be included
 * @returns De-duplicated absolute paths, global hub first
 *
 * @example
 * ```typescript
 * const paths = instructionFileCascade("/project", getInstalledProviders());
 * const results = await dedupeFiles(paths);
 * ```
 *
 * @public
 */
export function instructionFileCascade(projectDir: string, providers: Provider[]): string[] {
  const paths: string[] = [
    join(getAgentsHome(), 'AGENTS.md'),
    join(projectDir, 'AGENTS.md'),
    join(projectDir, 'CLAUDE.md'),
    join(projectDir, 'GEMINI.md'),
  ];

  for (const provider of providers) {
    paths.push(join(provider.pathGlobal, provider.instructFile));
  }

  return [...new Set(paths)];
}

/**
 * Summary of a repair sweep across instruction files.
 *
 * @public
 */
export interface RepairResult {
  /** Per-file outcomes, in cascade order. Files that do not exist are omitted. */
  files: DedupeResult[];
  /** Total damaged marker lines healed across all files. */
  repaired: number;
  /** Total duplicate blocks removed across all files. */
  removed: number;
  /** How many files were actually rewritten. */
  filesModified: number;
}

/**
 * Heal damaged CAAMP markers and collapse duplicate blocks across a project's
 * whole instruction-file cascade.
 *
 * This is the repair that `cleo doctor` prescribes. It is deliberately
 * content-agnostic — it does not need to know what *should* be inside the
 * block, so it can restore a file to a well-formed single-block state without
 * a provider registry lookup or a template refresh.
 *
 * Safe to run repeatedly: a healthy cascade reports `repaired: 0`,
 * `removed: 0`, `filesModified: 0` and performs no writes.
 *
 * @param projectDir - Absolute path to the project directory
 * @param providers - Detected providers whose global files should be included
 * @returns Aggregate repair summary
 *
 * @example
 * ```typescript
 * const result = await repairInstructionFiles("/project", getInstalledProviders());
 * console.log(`healed ${result.repaired} marker(s), removed ${result.removed} duplicate(s)`);
 * ```
 *
 * @public
 */
export async function repairInstructionFiles(
  projectDir: string,
  providers: Provider[],
): Promise<RepairResult> {
  const paths = instructionFileCascade(projectDir, providers).filter((p) => existsSync(p));
  const files: DedupeResult[] = [];

  for (const filePath of paths) {
    files.push(
      await withFileLock(filePath, async (): Promise<DedupeResult> => {
        const original = await readFile(filePath, 'utf-8');
        const { content, blocksBefore, repaired } = repairContent(original);
        const removed = Math.max(0, blocksBefore - 1);

        if (removed === 0 && repaired === 0) {
          return { filePath, removed: 0, kept: blocksBefore, modified: false, repaired: 0 };
        }
        if (content === original) {
          return { filePath, removed: 0, kept: blocksBefore, modified: false, repaired };
        }

        await writeFileAtomic({ path: filePath, content: content });
        return {
          filePath,
          removed,
          kept: blocksBefore > 0 ? 1 : 0,
          modified: true,
          repaired,
        };
      }),
    );
  }

  return {
    files,
    repaired: files.reduce((n, r) => n + r.repaired, 0),
    removed: files.reduce((n, r) => n + r.removed, 0),
    filesModified: files.filter((r) => r.modified).length,
  };
}

/**
 * Check the status of a CAAMP injection block in an instruction file.
 *
 * Returns the injection status:
 * - `"missing"` - File does not exist
 * - `"none"` - File exists but has no CAAMP markers
 * - `"current"` - CAAMP block exists and matches expected content (or no expected content given)
 * - `"outdated"` - CAAMP block exists but differs from expected content
 *
 * @param filePath - Absolute path to the instruction file
 * @param expectedContent - Optional expected content to compare against
 * @returns The injection status
 *
 * @remarks
 * Does not modify the file. Safe to call repeatedly for status checks.
 *
 * @example
 * ```typescript
 * const status = await checkInjection("/project/CLAUDE.md", expectedContent);
 * if (status === "outdated") {
 *   console.log("CAAMP injection needs updating");
 * }
 * ```
 *
 * @public
 */
export async function checkInjection(
  filePath: string,
  expectedContent?: string,
): Promise<InjectionStatus> {
  if (!existsSync(filePath)) return 'missing';

  const raw = await readFile(filePath, 'utf-8');

  // Damaged markers are healed in memory before the check so a corrupted file
  // reports `outdated` (which the caller repairs) instead of `none` (which
  // used to make the caller prepend a second block). No write happens here.
  const { content, repaired } = normalizeMarkers(raw);
  const blocks = parseBlocks(content);

  if (blocks.length === 0) return 'none';

  // More than one block, or a marker that had to be healed, means the file is
  // not in its canonical state regardless of what the block body says.
  if (blocks.length > 1 || repaired > 0) return 'outdated';

  if (expectedContent) {
    return blocks[0]?.content === expectedContent.trim() ? 'current' : 'outdated';
  }

  return 'current';
}

/**
 * Inject content into an instruction file between CAAMP markers.
 *
 * Behavior depends on the file state:
 * - File does not exist: creates the file with the injection block → `"created"`
 * - File exists without markers: prepends the injection block → `"added"`
 * - File exists with a damaged marker: heals it and replaces in place → `"repaired"`
 * - File exists with multiple markers (duplicates): consolidates into a single block → `"consolidated"`
 * - File exists with markers, content differs: replaces the block → `"updated"`
 * - File exists with markers, content matches: no-op → `"intact"`
 *
 * This function is **idempotent** — calling it multiple times with the same
 * content will not modify the file after the first write.
 *
 * @param filePath - Absolute path to the instruction file
 * @param content - Content to inject between CAAMP markers
 * @returns The {@link CaampInjectionAction} describing what was done
 *
 * @remarks
 * Damaged markers are healed *before* the file is classified. This is what
 * stops a single lost character from ratcheting into duplicate blocks: prior
 * to T12051 a marker that lost its leading `<` was invisible to the block
 * pattern, so this function concluded the file had no block and prepended a
 * second one — permanently doubling the injected protocol text, and doubling
 * again on the next mishap.
 *
 * The whole read-modify-write cycle runs under a cross-process lock and the
 * write itself is atomic, because the busiest target — `~/.agents/AGENTS.md` —
 * is rewritten by every project on the machine.
 *
 * All text outside the CAAMP markers is preserved verbatim.
 *
 * @example
 * ```typescript
 * const action = await inject("/project/CLAUDE.md", "## My Config\nSome content");
 * console.log(`File ${action}`); // "created" on first call, "intact" on subsequent
 * ```
 *
 * @public
 */
export async function inject(filePath: string, content: string): Promise<CaampInjectionAction> {
  // Canonicalise the body once, at the entry, so the create path and the
  // reconcile path agree on what "the same content" means. Without this a
  // whitespace-only difference reported `updated` forever.
  const body = content.trim();

  if (!existsSync(filePath)) {
    // Create new file with injection block. Still atomic + locked so a
    // concurrent creator cannot interleave with us.
    return withFileLock<CaampInjectionAction>(filePath, async () => {
      await writeFileAtomic({ path: filePath, content: `${buildBlock(body)}\n` });
      return 'created';
    });
  }

  return withFileLock<CaampInjectionAction>(filePath, async () => {
    const existing = await readFile(filePath, 'utf-8');

    // Fail closed on a torn read. Our own writes are atomic, but callers
    // outside this package still rewrite instruction files with a plain
    // `writeFile` (truncate-then-write), and a read landing inside that window
    // returns empty for a file that is not empty on disk. Reconciling from
    // that would replace every byte of the user's content with a lone block.
    if (existing.length === 0) {
      assertNotTornRead(filePath, existing, (await stat(filePath)).size);
    }

    const { content: next, blocksBefore, repaired } = reconcile(existing, body);

    if (next === existing) return 'intact';

    await writeFileAtomic({ path: filePath, content: next });

    // Report the most significant thing that happened, most invasive first.
    if (blocksBefore === 0) return 'added';
    if (repaired > 0) return 'repaired';
    if (blocksBefore > 1) return 'consolidated';
    return 'updated';
  });
}

/**
 * Remove the CAAMP injection block from an instruction file.
 *
 * If removing the block would leave the file empty, the file is deleted entirely.
 *
 * @param filePath - Absolute path to the instruction file
 * @returns `true` if a CAAMP block was found and removed, `false` otherwise
 *
 * @remarks
 * Cleans up any leftover blank lines after removing the block. If the file
 * would be entirely empty after removal, the file itself is deleted.
 *
 * Blocks whose markers are damaged are healed first, so uninstall removes them
 * too rather than leaving orphaned fragments behind.
 *
 * @example
 * ```typescript
 * const removed = await removeInjection("/project/CLAUDE.md");
 * ```
 *
 * @public
 */
export async function removeInjection(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  return withFileLock(filePath, async () => {
    const original = await readFile(filePath, 'utf-8');
    const { content } = normalizeMarkers(original);

    // A fresh pattern per call: a shared /g RegExp carries `lastIndex`, so the
    // previous `MARKER_PATTERN.test()` here skipped matches on alternate calls.
    if (parseBlocks(content).length === 0) return false;

    const cleaned = content
      .replace(blockPattern(), '')
      .replace(/^\n{2,}/, '\n')
      .trim();

    if (!cleaned) {
      // File would be empty - remove it entirely
      const { rm } = await import('node:fs/promises');
      await rm(filePath);
    } else {
      await writeFileAtomic({ path: filePath, content: `${cleaned}\n` });
    }

    return true;
  });
}

/**
 * Check injection status across all providers' instruction files.
 *
 * Deduplicates by file path since multiple providers may share the same
 * instruction file (e.g. many providers use `AGENTS.md`).
 *
 * @param providers - Array of providers to check
 * @param projectDir - Absolute path to the project directory
 * @param scope - Whether to check project or global instruction files
 * @param expectedContent - Optional expected content to compare against
 * @returns Array of injection check results, one per unique instruction file
 *
 * @remarks
 * Multiple providers may share the same instruction file (e.g. many use
 * `AGENTS.md`). This function deduplicates to avoid redundant file reads.
 *
 * @example
 * ```typescript
 * const results = await checkAllInjections(providers, "/project", "project", expected);
 * const outdated = results.filter(r => r.status === "outdated");
 * ```
 *
 * @public
 */
export async function checkAllInjections(
  providers: Provider[],
  projectDir: string,
  scope: 'project' | 'global',
  expectedContent?: string,
): Promise<InjectionCheckResult[]> {
  const results: InjectionCheckResult[] = [];
  const checked = new Set<string>();

  for (const provider of providers) {
    const filePath =
      scope === 'global'
        ? join(provider.pathGlobal, provider.instructFile)
        : join(projectDir, provider.instructFile);

    // Skip duplicates (multiple providers share same instruction file)
    if (checked.has(filePath)) continue;
    checked.add(filePath);

    let status = await checkInjection(filePath, expectedContent);
    const delivery = await resolveInstructionDelivery(`@${filePath}`, dirname(filePath));
    if (expectedContent !== undefined && status === 'outdated') {
      delivery.findings.push({
        kind: 'stale',
        path: filePath,
        reason: 'Managed content differs from the expected version.',
      });
    }
    if (existsSync(filePath) && parseBlocks(await readFile(filePath, 'utf8')).length > 1) {
      delivery.findings.push({
        kind: 'duplicate',
        path: filePath,
        reason: 'Multiple managed blocks are delivered.',
      });
    }
    if (delivery.findings.length > 0 && status === 'current') status = 'outdated';

    results.push({
      deliveryFindings: delivery.findings,
      liveEvaluation: delivery.liveEvaluation,
      file: filePath,
      provider: provider.id,
      status,
      fileExists: existsSync(filePath),
    });
  }

  return results;
}

/**
 * Inject content into all providers' instruction files.
 *
 * Deduplicates by file path to avoid injecting the same file multiple times.
 *
 * @param providers - Array of providers to inject into
 * @param projectDir - Absolute path to the project directory
 * @param scope - Whether to target project or global instruction files
 * @param content - Content to inject between CAAMP markers
 * @returns Map of file path to action taken (`"created"`, `"added"`, `"consolidated"`, `"updated"`, or `"intact"`)
 *
 * @remarks
 * Providers sharing the same instruction file are only written once to avoid
 * conflicting concurrent writes.
 *
 * @example
 * ```typescript
 * const results = await injectAll(providers, "/project", "project", content);
 * for (const [file, action] of results) {
 *   console.log(`${file}: ${action}`);
 * }
 * ```
 *
 * @public
 */
export async function injectAll(
  providers: Provider[],
  projectDir: string,
  scope: 'project' | 'global',
  content: string,
): Promise<Map<string, CaampInjectionAction>> {
  const results = new Map<string, CaampInjectionAction>();
  const injected = new Set<string>();

  for (const provider of providers) {
    const filePath =
      scope === 'global'
        ? join(provider.pathGlobal, provider.instructFile)
        : join(projectDir, provider.instructFile);

    // Skip duplicates
    if (injected.has(filePath)) continue;
    injected.add(filePath);

    const action = await inject(filePath, content);
    results.set(filePath, action);
  }

  return results;
}

// ── Provider Instruction File API ─────────────────────────────────

/**
 * Options for ensuring a provider instruction file.
 *
 * @public
 */
export interface EnsureProviderInstructionFileOptions {
  /**
   * `@` references to inject (e.g. `["@AGENTS.md"]`).
   *
   * When omitted or `undefined`, the references declared in the CAAMP provider
   * registry (`provider.instructionReferences`) are used as the default. Callers
   * that supply an explicit array always take precedence over the registry default.
   *
   * @defaultValue Registry `instructionReferences` for the provider
   */
  references?: string[];
  /** Optional inline content blocks. @defaultValue `undefined` */
  content?: string[];
  /** Whether this is a global or project-level file. @defaultValue `"project"` */
  scope?: 'project' | 'global';
  /** Embed resolved sources; reference-only delivery requires an explicitly verified provider. */
  delivery?: 'self-contained' | 'verified-references';
}

/**
 * Result of ensuring a provider instruction file.
 *
 * @public
 */
export interface EnsureProviderInstructionFileResult {
  /** Absolute path to the instruction file. */
  filePath: string;
  /** Instruction file name from the provider registry. */
  instructFile: string;
  /** Action taken. */
  action: CaampInjectionAction;
  /** Provider ID. */
  providerId: string;
}

/**
 * Ensure a provider's instruction file exists with the correct CAAMP block.
 *
 * This is the canonical API for adapters and external packages to manage
 * provider instruction files. Instead of directly creating/modifying
 * CLAUDE.md, GEMINI.md, etc., callers should use this function to
 * delegate instruction file management to CAAMP.
 *
 * The instruction file name is resolved from CAAMP's provider registry
 * (single source of truth), not hardcoded by the caller.
 *
 * @remarks
 * The instruction file name is resolved from CAAMP's provider registry
 * (single source of truth), not hardcoded by the caller.
 *
 * @param providerId - Provider ID from the registry (e.g. `"claude-code"`, `"gemini-cli"`)
 * @param projectDir - Absolute path to the project directory
 * @param options - References, content, and scope configuration
 * @returns Result with file path, action taken, and provider metadata
 * @throws Error if the provider ID is not found in the registry
 *
 * @example
 * ```typescript
 * const result = await ensureProviderInstructionFile("claude-code", "/project", {
 *   references: ["\@AGENTS.md"],
 * });
 * ```
 *
 * @public
 */
export async function ensureProviderInstructionFile(
  providerId: string,
  projectDir: string,
  options: EnsureProviderInstructionFileOptions,
): Promise<EnsureProviderInstructionFileResult> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: "${providerId}". Check CAAMP provider registry.`);
  }

  const scope = options.scope ?? 'project';
  const filePath =
    scope === 'global'
      ? join(provider.pathGlobal, provider.instructFile)
      : join(projectDir, provider.instructFile);

  // Fall back to the registry default when the caller omits references.
  let references = options.references ?? getProviderInstructionReferences(providerId);
  let content = options.content;
  // This generated project artifact does not exist before the first memory
  // refresh. Its absence is a visible capability limit, not a broken user source.
  if (
    options.delivery !== 'verified-references' &&
    references.includes('@.cleo/memory-bridge.md') &&
    !existsSync(join(dirname(filePath), '.cleo', 'memory-bridge.md'))
  ) {
    references = references.filter((reference) => reference !== '@.cleo/memory-bridge.md');
    content = [
      ...(content ?? []),
      'Project memory bridge unavailable. Run `cleo memory digest` to inspect current evidence.',
    ];
  }

  const template: InjectionTemplate = {
    references,
    content,
  };

  let injectionContent = buildInjectionContent(template);
  // Provider registry entries declare references, not proof that the runtime loads them.
  // Resolve by default for every provider; preserve existing files if resolution fails.
  if (options.delivery !== 'verified-references') {
    const delivery = await resolveInstructionDelivery(injectionContent, dirname(filePath));
    const failures = delivery.findings.filter((finding) => finding.kind !== 'duplicate');
    if (failures.length > 0) {
      throw new Error(
        `Instruction delivery failed: ${failures.map((finding) => `${finding.kind}: ${finding.path}`).join('; ')}`,
      );
    }
    injectionContent = delivery.content;
  }
  const action = await inject(filePath, injectionContent);

  return {
    filePath,
    instructFile: provider.instructFile,
    action,
    providerId: provider.id,
  };
}

/**
 * Ensure instruction files for multiple providers at once.
 *
 * Deduplicates by file path — providers sharing the same instruction file
 * (e.g. many providers use AGENTS.md) are only written once.
 *
 * @remarks
 * Providers sharing the same instruction file (e.g. many use `AGENTS.md`)
 * are only written once, avoiding duplicate blocks.
 *
 * @param providerIds - Array of provider IDs from the registry
 * @param projectDir - Absolute path to the project directory
 * @param options - References, content, and scope configuration
 * @returns Array of results, one per unique instruction file
 * @throws Error if any provider ID is not found in the registry
 *
 * @example
 * ```typescript
 * const results = await ensureAllProviderInstructionFiles(
 *   ["claude-code", "cursor", "gemini-cli"],
 *   "/project",
 *   { references: ["\@AGENTS.md"] },
 * );
 * ```
 *
 * @public
 */
export async function ensureAllProviderInstructionFiles(
  providerIds: string[],
  projectDir: string,
  options: EnsureProviderInstructionFileOptions,
): Promise<EnsureProviderInstructionFileResult[]> {
  const results: EnsureProviderInstructionFileResult[] = [];
  const processed = new Set<string>();

  for (const providerId of providerIds) {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: "${providerId}". Check CAAMP provider registry.`);
    }

    const scope = options.scope ?? 'project';
    const filePath =
      scope === 'global'
        ? join(provider.pathGlobal, provider.instructFile)
        : join(projectDir, provider.instructFile);

    // Skip duplicates (multiple providers may share the same instruction file)
    if (processed.has(filePath)) continue;
    processed.add(filePath);

    // Fall back to the registry default when the caller omits references.
    const references = options.references ?? getProviderInstructionReferences(providerId);

    const template: InjectionTemplate = {
      references,
      content: options.content,
    };

    const injectionContent = buildInjectionContent(template);
    const action = await inject(filePath, injectionContent);

    results.push({
      filePath,
      instructFile: provider.instructFile,
      action,
      providerId: provider.id,
    });
  }

  return results;
}

// ── Per-Provider Agent Folder API ─────────────────────────────────

/**
 * Known provider IDs that have a defined agent folder path.
 *
 * @public
 */
export type KnownProviderAgentFolderId =
  | 'claude-code'
  | 'claude-sdk'
  | 'opencode'
  | 'codex'
  | 'cursor'
  | 'pi'
  | 'kimi'
  | 'gemini-cli'
  | 'openai-sdk';

/**
 * Resolve the native agent-definition folder path for a given provider.
 *
 * Each AI provider reads agent-definition files (e.g. `cleo-subagent.md`,
 * seed agent profiles) from its own platform-specific directory. This
 * function returns the correct path per provider so the CAAMP injector can
 * write agent files to the right location for every enabled provider.
 *
 * Follows XDG conventions (`~/.config/<provider>/agents/`) for providers
 * that do not have a pre-existing dotfolder convention. Claude Code and
 * Claude SDK both share `~/.claude/agents/` to match the Claude Code
 * native agent-loading path.
 *
 * Returns `null` for unknown provider IDs so callers can handle the gap
 * without throwing.
 *
 * @param providerId - Provider ID from the CAAMP registry (e.g. `"claude-code"`, `"opencode"`)
 * @returns Absolute path to the provider's agent folder, or `null` if the provider is unknown
 *
 * @example
 * ```typescript
 * const folder = getProviderAgentFolder("claude-code");
 * // => "/home/user/.claude/agents"
 *
 * const folder2 = getProviderAgentFolder("opencode");
 * // => "/home/user/.config/opencode/agents"
 *
 * const folder3 = getProviderAgentFolder("unknown-provider");
 * // => null
 * ```
 *
 * @public
 */
export function getProviderAgentFolder(providerId: string): string | null {
  const home = homedir();

  switch (providerId as KnownProviderAgentFolderId) {
    case 'claude-code':
    case 'claude-sdk':
      return join(home, '.claude', 'agents');
    case 'opencode':
      return join(home, '.config', 'opencode', 'agents');
    case 'codex':
      return join(home, '.config', 'codex', 'agents');
    case 'cursor':
      return join(home, '.cursor', 'agents');
    case 'pi':
      return join(home, '.config', 'pi', 'agents');
    case 'kimi':
      return join(home, '.config', 'kimi', 'agents');
    case 'gemini-cli':
      return join(home, '.config', 'gemini', 'agents');
    case 'openai-sdk':
      return join(home, '.config', 'openai', 'agents');
    default:
      return null;
  }
}

/**
 * Result of writing an agent-definition file to a single provider's agent folder.
 *
 * @public
 */
export interface WriteAgentFileResult {
  /** Provider ID the file was written for. */
  providerId: string;
  /** Absolute path to the written agent-definition file. */
  filePath: string;
  /** Action taken. */
  action: CaampInjectionAction;
}

/**
 * Options for writing agent-definition files to provider agent folders.
 *
 * @public
 */
export interface WriteAgentFileOptions {
  /**
   * File name for the agent-definition file (e.g. `"cleo-subagent.md"`).
   * This name is used as-is inside each provider's agent folder.
   */
  fileName: string;
  /** Content to inject between CAAMP markers in the agent-definition file. */
  content: string;
  /**
   * If `true`, skip writing to providers whose agent folder does not yet exist.
   * If `false` (default), the folder is created automatically.
   *
   * @defaultValue false
   */
  skipMissingFolders?: boolean;
}

/**
 * Write an agent-definition file to every enabled provider's native agent folder.
 *
 * For each provider ID supplied, the file is written to the provider's native
 * agent-definition directory (resolved via {@link getProviderAgentFolder}).
 * Writing is idempotent — if the file already exists with matching content the
 * action is `"intact"` and the file is not modified. This ensures that existing
 * `~/.claude/agents/cleo-subagent.md` installs from prior versions are preserved
 * without clobbering.
 *
 * Providers whose folder cannot be resolved (unknown provider IDs) are silently
 * skipped. Providers whose folder does not yet exist on disk are created
 * automatically unless `skipMissingFolders` is set to `true`.
 *
 * @param providerIds - Array of provider IDs to write agent files for
 * @param options - File name, content, and folder-creation behaviour
 * @returns Array of write results, one per provider that was successfully processed
 *
 * @example
 * ```typescript
 * const results = await writeAgentFileToAllProviders(
 *   ["claude-code", "opencode", "cursor"],
 *   {
 *     fileName: "cleo-subagent.md",
 *     content: "## CLEO Subagent\nYou are a CLEO subagent...",
 *   },
 * );
 * for (const r of results) {
 *   console.log(`${r.providerId}: ${r.action} → ${r.filePath}`);
 * }
 * ```
 *
 * @public
 */
export async function writeAgentFileToAllProviders(
  providerIds: string[],
  options: WriteAgentFileOptions,
): Promise<WriteAgentFileResult[]> {
  const results: WriteAgentFileResult[] = [];
  const processed = new Set<string>();

  for (const providerId of providerIds) {
    const folder = getProviderAgentFolder(providerId);
    if (folder === null) {
      // Unknown provider — skip silently; caller can detect by comparing
      // providerIds.length to results.length.
      continue;
    }

    const filePath = join(folder, options.fileName);

    // Deduplicate by resolved file path — claude-code and claude-sdk share
    // the same folder so we only write once.
    if (processed.has(filePath)) {
      // Still push a result so the caller sees all providers reflected.
      const existingResult = results.find((r) => r.filePath === filePath);
      if (existingResult) {
        results.push({ providerId, filePath, action: existingResult.action });
      }
      continue;
    }
    processed.add(filePath);

    if (options.skipMissingFolders === true && !existsSync(folder)) {
      // Folder does not exist and caller requested we skip rather than create.
      continue;
    }

    const action = await inject(filePath, options.content);
    results.push({ providerId, filePath, action });
  }

  return results;
}
