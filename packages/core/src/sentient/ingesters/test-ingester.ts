/**
 * Test Ingester — Tier-2 proposal candidate source.
 *
 * Reads two data sources:
 *
 *   Source A — `.cleo/audit/gates.jsonl`: CLEO evidence gate failure records.
 *     Each line is a JSONL record. Lines where `failCount > 0` produce a
 *     proposal suggesting a flaky-test guard be added for the failing task.
 *
 *   Source B — `.cleo/coverage-summary.json`: vitest coverage JSON summary.
 *     Written by `vitest --coverage --reporter json-summary`. Lines where
 *     `lines.pct < 80` produce a proposal suggesting coverage improvement.
 *     If the file is absent, Source B returns zero candidates (no error).
 *
 * Design principles:
 * - NO LLM calls. All data comes from structured file reads.
 * - Title is template-generated. Prompt-injection defence (T1008 §3.6).
 * - Failures are swallowed: returns empty array + logs warning.
 *
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProposalCandidate } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single line from gates.jsonl. */
interface GateRecord {
  taskId?: string;
  gate?: string;
  failCount?: number;
  [key: string]: unknown;
}

/** Coverage summary entry for a single file. */
interface CoverageEntry {
  lines?: { pct?: number };
  statements?: { pct?: number };
  functions?: { pct?: number };
  branches?: { pct?: number };
}

/** Shape of the JSON coverage summary file. */
type CoverageSummary = Record<string, CoverageEntry>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative path from project root to gates.jsonl. */
export const GATES_JSONL_PATH = '.cleo/audit/gates.jsonl' as const;

/** Relative path from project root to the coverage summary. */
export const COVERAGE_SUMMARY_PATH = '.cleo/coverage-summary.json' as const;

/** Coverage line percentage below which a proposal is emitted. */
export const MIN_LINE_COVERAGE_PCT = 80;

/** Base weight for all test ingester candidates. */
export const TEST_BASE_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Source A: gates.jsonl
// ---------------------------------------------------------------------------

/**
 * Parse gates.jsonl and return one candidate per task that has any gate
 * with `failCount > 0`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Proposal candidates (may be empty).
 */
function runGatesIngester(projectRoot: string): ProposalCandidate[] {
  const gatesPath = join(projectRoot, GATES_JSONL_PATH);

  let raw: string;
  try {
    raw = readFileSync(gatesPath, 'utf-8');
  } catch {
    // File absent or unreadable — not an error.
    return [];
  }

  const candidates: ProposalCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: GateRecord;
    try {
      record = JSON.parse(trimmed) as GateRecord;
    } catch {
      // Skip malformed lines.
      continue;
    }

    const taskId = record.taskId;
    const gate = record.gate ?? 'unknown';
    const failCount = record.failCount ?? 0;

    if (typeof taskId !== 'string' || failCount <= 0) continue;

    const key = `${taskId}.${gate}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    candidates.push({
      source: 'test' as const,
      sourceId: key,
      title: `[T2-TEST] Fix flaky gate: ${taskId}.${gate}`,
      rationale: `Gate '${gate}' on task ${taskId} has failed ${failCount} time(s)`,
      weight: TEST_BASE_WEIGHT,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Source B: coverage-summary.json
// ---------------------------------------------------------------------------

/**
 * Read the vitest coverage summary and return one candidate per file with
 * line coverage below {@link MIN_LINE_COVERAGE_PCT}.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Proposal candidates (may be empty; empty if file absent).
 */
function runCoverageIngester(projectRoot: string): ProposalCandidate[] {
  const coveragePath = join(projectRoot, COVERAGE_SUMMARY_PATH);

  let summary: CoverageSummary;
  try {
    const raw = readFileSync(coveragePath, 'utf-8');
    summary = JSON.parse(raw) as CoverageSummary;
  } catch {
    // File absent or malformed — not an error, return zero candidates.
    return [];
  }

  const candidates: ProposalCandidate[] = [];

  for (const [filePath, entry] of Object.entries(summary)) {
    // Skip the 'total' synthetic key if present.
    if (filePath === 'total') continue;

    const pct = entry?.lines?.pct;
    if (typeof pct !== 'number' || pct >= MIN_LINE_COVERAGE_PCT) continue;

    candidates.push({
      source: 'test' as const,
      sourceId: filePath,
      title: `[T2-TEST] Increase coverage: ${filePath} (${pct}% lines)`,
      rationale: `File ${filePath} has ${pct}% line coverage (target: ${MIN_LINE_COVERAGE_PCT}%)`,
      weight: TEST_BASE_WEIGHT,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the test ingester against both data sources.
 *
 * Merges Source A (gates.jsonl) and Source B (coverage-summary.json) without
 * duplication. Returns an empty array if both sources yield nothing or if
 * errors occur (errors are swallowed).
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Combined ProposalCandidate array (may be empty).
 */
export function runTestIngester(projectRoot: string): ProposalCandidate[] {
  try {
    const gatesCandidates = runGatesIngester(projectRoot);
    const coverageCandidates = runCoverageIngester(projectRoot);

    // Merge, deduplicate by sourceId.
    const seenSourceIds = new Set<string>();
    const merged: ProposalCandidate[] = [];

    for (const candidate of [...gatesCandidates, ...coverageCandidates]) {
      if (seenSourceIds.has(candidate.sourceId)) continue;
      seenSourceIds.add(candidate.sourceId);
      merged.push(candidate);
    }

    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/test-ingester] WARNING: ${message}\n`);
    return [];
  }
}
