/**
 * Global provider instruction delivery — the ONE regenerator and its cheap
 * staleness check.
 *
 * Every global provider instruction file (`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.pi/agent/AGENTS.md`, …)
 * carries a CAAMP block that EMBEDS the global hub `~/.agents/AGENTS.md` and
 * everything it references, stamped with one `CAAMP:SOURCE` line per source.
 *
 * Before T12377 there were two regenerators. `cleo install-global` resolved the
 * hub into an embedded delivery; `caamp instructions update --global` wrote a
 * generic "CAAMP Managed Configuration" stub, and only to the default target
 * provider (Pi when installed), so it destroyed Pi's embedded protocol and never
 * touched the stale Claude/Codex/Gemini files. Both now call
 * {@link syncGlobalInstructions}.
 *
 * Code placed in `packages/caamp/` per Package-Boundary Check — verified against
 * AGENTS.md: `@cleocode/core` already reaches CAAMP through
 * `await import('@cleocode/caamp')`, and CAAMP cannot import core's bootstrap.
 *
 * @task T12377
 * @task T12378
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  CAAMP_SOURCE_STAMP_PATTERN_SOURCE,
  GLOBAL_INSTRUCTION_HUB_REFERENCE,
  type GlobalInstructionFileStatus,
  type GlobalInstructionStalenessReport,
  type GlobalInstructionSyncFile,
  type GlobalInstructionSyncResult,
} from '@cleocode/contracts/caamp-markers';
import { writeFileAtomic } from '@cleocode/core/tools/fs.js';
import type { Provider } from '../../types.js';
import { withFileLock } from '../fs/atomic.js';
import { getInstalledProviders } from '../registry/detection.js';
import { inject, resolveGlobalInstructionPath } from './injector.js';
import { blockPattern, parseBlocks } from './markers.js';
import { resolveInstructionDelivery } from './templates.js';

/** Legacy pre-CAAMP block, bare or versioned (`<!-- CLEO:START v0.53.4 -->`). */
const LEGACY_CLEO_BLOCK = /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g;

/** Minimum trimmed length for a line to count as managed-content evidence. */
const DUPLICATE_LINE_MIN_LENGTH = 24;

/** Matching outside lines needed before a hand-appended copy is reported. */
const DUPLICATE_LINE_THRESHOLD = 2;

/**
 * Options for {@link syncGlobalInstructions} and {@link checkGlobalInstructionStaleness}.
 *
 * @public
 */
export interface GlobalInstructionOptions {
  /** Providers to target. @defaultValue every installed provider */
  providers?: Provider[];
  /** Managed reference resolved into the delivery. @defaultValue `@~/.agents/AGENTS.md` */
  hubReference?: string;
  /** Directory relative references resolve against. @defaultValue the user's home */
  baseDir?: string;
}

/**
 * Options for {@link syncGlobalInstructions}.
 *
 * @public
 */
export interface SyncGlobalInstructionsOptions extends GlobalInstructionOptions {
  /** Plan the targets without writing. @defaultValue false */
  dryRun?: boolean;
}

/**
 * Group providers by their global instruction file.
 *
 * @returns Absolute path → provider ids, plus the providers with no global file.
 */
function groupGlobalTargets(providers: Provider[]): {
  targets: Map<string, string[]>;
  skipped: string[];
} {
  const targets = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const provider of providers) {
    const path = resolveGlobalInstructionPath(provider);
    if (path === null) {
      skipped.push(provider.id);
      continue;
    }
    targets.set(path, [...(targets.get(path) ?? []), provider.id]);
  }
  return { targets, skipped };
}

/** Remove a legacy `CLEO:START` block, under the same lock and atomic write as `inject()`. */
async function stripLegacyCleoBlock(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return withFileLock(path, async () => {
    const content = await readFile(path, 'utf8');
    const stripped = content.replace(LEGACY_CLEO_BLOCK, '');
    if (stripped === content) return false;
    await writeFileAtomic({ path, content: stripped });
    return true;
  });
}

/**
 * Regenerate every global provider instruction file from its sources.
 *
 * @remarks
 * The single global regenerator (T12377), shared by `cleo install-global`, the
 * npm postinstall, `caamp instructions update --global`, and the automatic
 * refresh at `cleo session start` / `cleo briefing`.
 *
 * 1. Resolves {@link GLOBAL_INSTRUCTION_HUB_REFERENCE} into a self-contained,
 *    source-stamped delivery. Any defect other than a benign duplicate stops
 *    the run before a byte is written — a partial delivery must never replace
 *    a usable one.
 * 2. Strips legacy `CLEO:START` blocks.
 * 3. Injects the delivery into each distinct global file. `inject()` is
 *    idempotent (`intact` when unchanged) and preserves all text outside the
 *    managed block.
 *
 * Providers without an absolute global path are skipped and reported (T12379).
 * One failing file does not stop the others; it is reported as `failed`.
 *
 * @param options - Targets, hub reference and dry-run switch.
 * @returns What was written, or why nothing was.
 *
 * @example
 * ```typescript
 * const result = await syncGlobalInstructions();
 * if (result.status === 'unresolved') console.error(result.findings);
 * ```
 *
 * @public
 */
export async function syncGlobalInstructions(
  options: SyncGlobalInstructionsOptions = {},
): Promise<GlobalInstructionSyncResult> {
  const providers = options.providers ?? getInstalledProviders();
  const { targets, skipped } = groupGlobalTargets(providers);
  const result: GlobalInstructionSyncResult = {
    status: 'synced',
    files: [],
    findings: [],
    legacyStripped: [],
    skippedProviders: skipped,
  };

  if (targets.size === 0) {
    result.status = 'no-providers';
    return result;
  }

  if (options.dryRun) {
    result.status = 'dry-run';
    for (const [path, ids] of targets) {
      result.files.push({ path, providers: ids, action: 'planned' });
    }
    return result;
  }

  const delivery = await resolveInstructionDelivery(
    options.hubReference ?? GLOBAL_INSTRUCTION_HUB_REFERENCE,
    options.baseDir ?? homedir(),
  );
  const blocking = delivery.findings.filter((finding) => finding.kind !== 'duplicate');
  if (blocking.length > 0) {
    result.status = 'unresolved';
    result.findings = blocking;
    return result;
  }

  for (const [path, ids] of targets) {
    const entry: GlobalInstructionSyncFile = { path, providers: ids, action: 'intact' };
    try {
      if (await stripLegacyCleoBlock(path)) result.legacyStripped.push(path);
      entry.action = await inject(path, delivery.content);
    } catch (err) {
      entry.action = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
    }
    result.files.push(entry);
  }

  return result;
}

/** Hash of a source file, or `null` when it cannot be read. Text kept for duplicate matching. */
interface SourceSnapshot {
  digest: string | null;
  lines: string[];
}

async function snapshotSource(path: string): Promise<SourceSnapshot> {
  try {
    const bytes = await readFile(path);
    return {
      digest: createHash('sha256').update(bytes).digest('hex'),
      lines: bytes.toString('utf8').split('\n'),
    };
  } catch {
    return { digest: null, lines: [] };
  }
}

/** Normalise a line for duplicate matching; `null` when it is too weak to count. */
function evidenceLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < DUPLICATE_LINE_MIN_LENGTH) return null;
  if (trimmed.startsWith('@') || trimmed.startsWith('<!--')) return null;
  if (/^(`{3,}|~{3,}|[-|: ]+)$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Cheap staleness scan over every global provider instruction file.
 *
 * @remarks
 * Reads each distinct provider file once and hashes each distinct stamped
 * source once — no reference expansion, no writes. A file is:
 *
 * - `stale` when a `CAAMP:SOURCE` stamp's sha256 no longer matches its source
 *   (or the source is gone);
 * - `unembedded` when its managed block carries no stamp at all (a
 *   reference-only block or the generic stub written before T12377).
 *
 * It also reports a hand-appended copy of managed content OUTSIDE the managed
 * block as a duplicate: at least two substantial lines outside the block that
 * also occur in a stamped source. Duplicates are reported only — user text is
 * never deleted automatically.
 *
 * @param options - Targets to scan.
 * @returns Per-file verdicts plus the files a sync would repair.
 *
 * @example
 * ```typescript
 * const report = await checkGlobalInstructionStaleness();
 * if (report.needsSync.length > 0) await syncGlobalInstructions();
 * ```
 *
 * @public
 */
export async function checkGlobalInstructionStaleness(
  options: GlobalInstructionOptions = {},
): Promise<GlobalInstructionStalenessReport> {
  const providers = options.providers ?? getInstalledProviders();
  const { targets } = groupGlobalTargets(providers);
  const sources = new Map<string, SourceSnapshot>();
  const outsideByFile = new Map<string, string>();
  const files: GlobalInstructionFileStatus[] = [];

  for (const [path, ids] of targets) {
    const status: GlobalInstructionFileStatus = {
      path,
      providers: ids,
      state: 'current',
      staleSources: [],
      duplicateLines: 0,
    };
    files.push(status);

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      status.state = 'absent';
      continue;
    }

    const blocks = parseBlocks(content);
    if (blocks.length === 0) {
      status.state = 'no-block';
      continue;
    }
    outsideByFile.set(path, content.replace(blockPattern(), ''));

    const stamps = blocks.flatMap((block) => [
      ...block.content.matchAll(new RegExp(CAAMP_SOURCE_STAMP_PATTERN_SOURCE, 'gm')),
    ]);
    if (stamps.length === 0) {
      status.state = 'unembedded';
      continue;
    }

    for (const stamp of stamps) {
      const encoded = stamp[1];
      const expected = stamp[2];
      if (!encoded || !expected) continue;
      let source: string;
      try {
        source = decodeURIComponent(encoded);
      } catch {
        source = encoded;
      }
      let snapshot = sources.get(source);
      if (!snapshot) {
        snapshot = await snapshotSource(source);
        sources.set(source, snapshot);
      }
      if (snapshot.digest !== expected && !status.staleSources.includes(source)) {
        status.staleSources.push(source);
      }
    }
    if (status.staleSources.length > 0) status.state = 'stale';
  }

  // Duplicate detection runs after every source is known, so a file whose own
  // block is unembedded is still checked against the sources other files embed.
  const managedLines = new Set<string>();
  for (const snapshot of sources.values()) {
    for (const line of snapshot.lines) {
      const evidence = evidenceLine(line);
      if (evidence !== null) managedLines.add(evidence);
    }
  }
  for (const status of files) {
    const outside = outsideByFile.get(status.path);
    if (outside === undefined) continue;
    let matched = 0;
    for (const line of outside.split('\n')) {
      const evidence = evidenceLine(line);
      if (evidence !== null && managedLines.has(evidence)) matched++;
    }
    status.duplicateLines = matched >= DUPLICATE_LINE_THRESHOLD ? matched : 0;
  }

  return {
    files,
    needsSync: files
      .filter((file) => file.state === 'stale' || file.state === 'unembedded')
      .map((file) => file.path),
    duplicates: files.filter((file) => file.duplicateLines > 0).map((file) => file.path),
  };
}
