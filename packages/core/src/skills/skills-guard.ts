/**
 * Skills-guard — trust-aware static security scanner for externally-sourced
 * skills. TypeScript port of Hermes `tools/skills_guard.py`.
 *
 * Every skill downloaded from a federation peer or community URL passes
 * through {@link scanSkill} before any disk write. The scanner runs the
 * 120-pattern threat table (see {@link ./skills-guard-patterns}) on every
 * scannable file plus structural checks (file count, size, binary blobs,
 * symlink escapes, invisible unicode).
 *
 * Install gating then runs {@link shouldAllowInstall} against the Hermes
 * `INSTALL_POLICY` matrix:
 *
 * | trust level   | safe  | caution | dangerous |
 * |---------------|-------|---------|-----------|
 * | builtin       | allow | allow   | allow     |
 * | trusted       | allow | allow   | block     |
 * | community     | allow | block   | block     |
 * | agent-created | allow | allow   | ask       |
 *
 * Wire site: `packages/caamp/src/commands/skills/install.ts` calls
 * {@link scanSkill} BEFORE the canonical filesystem copy so a `block`
 * verdict has zero side-effects.
 *
 * @task T9730
 * @epic T9564
 * @saga T9560
 * @architecture docs/skills/federation.md
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  type FindingCategory,
  type FindingSeverity,
  INVISIBLE_CHARS,
  SCANNABLE_EXTENSIONS,
  STRUCTURAL_LIMITS,
  SUSPICIOUS_BINARY_EXTENSIONS,
  THREAT_PATTERNS,
} from './skills-guard-patterns.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Trust level of a skill source.
 *
 * Maps from a federation entry's `trust` field (verified → trusted) plus the
 * two special tiers `builtin` (ships with CLEO) and `agent-created` (produced
 * by `skill_manage` tool flows). Mirrors `INSTALL_POLICY` row labels in the
 * Hermes source.
 */
export type SkillTrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';

/**
 * Overall verdict assigned by {@link scanSkill} based on the worst finding.
 *
 * - `safe`      — zero findings.
 * - `caution`   — at least one `high` finding, no critical.
 * - `dangerous` — at least one `critical` finding.
 *
 * Identical rule to `_determine_verdict` in `skills_guard.py`.
 */
export type ScanVerdict = 'safe' | 'caution' | 'dangerous';

/**
 * Install policy decision produced by {@link shouldAllowInstall}.
 *
 * - `allow` — proceed with install.
 * - `block` — refuse install (operator can re-run with `--force`).
 * - `ask`   — prompt the operator (used by `agent-created` × dangerous).
 */
export type InstallDecision = 'allow' | 'block' | 'ask';

/**
 * One regex hit (or structural anomaly) discovered while scanning a skill.
 *
 * Field order matches the Hermes `Finding` dataclass so diffs between the
 * two implementations stay readable.
 */
export interface Finding {
  /** Stable identifier matching the pattern table or structural check. */
  readonly patternId: string;
  /** Severity assigned by the pattern (or `critical` for structural escapes). */
  readonly severity: FindingSeverity;
  /** Threat category. */
  readonly category: FindingCategory;
  /** Path relative to the scanned skill root. */
  readonly file: string;
  /** 1-based line number (`0` for directory-level findings). */
  readonly line: number;
  /** First ≤120 chars of the matching content (or summary for structural hits). */
  readonly match: string;
  /** Human-readable description (mirrors the pattern table). */
  readonly description: string;
}

/**
 * Result returned by {@link scanSkill}.
 *
 * `verdict` is derived from `findings` per the Hermes rules so callers can
 * trust the verdict-only fast path without inspecting every finding.
 */
export interface ScanResult {
  /** Skill identifier (basename of the scanned path). */
  readonly skillName: string;
  /** Caller-supplied source identifier (URL, repo, `agent-created`). */
  readonly source: string;
  /** Trust level resolved from `source` via {@link resolveTrustLevel}. */
  readonly trustLevel: SkillTrustLevel;
  /** Overall verdict — see {@link ScanVerdict}. */
  readonly verdict: ScanVerdict;
  /** All findings, in discovery order. */
  readonly findings: readonly Finding[];
  /** ISO-8601 timestamp marking when the scan ran. */
  readonly scannedAt: string;
  /** One-line human-readable summary. */
  readonly summary: string;
}

/**
 * Trusted repository allow-list — identical set to Hermes `TRUSTED_REPOS`.
 *
 * Sources matching one of these prefixes are auto-promoted to `trusted`,
 * allowing `caution` verdicts to install without operator prompts.
 */
export const TRUSTED_REPOS: ReadonlySet<string> = new Set([
  'openai/skills',
  'anthropics/skills',
  'huggingface/skills',
]);

/** Hermes-aligned `INSTALL_POLICY` table — never `undefined`-typed. */
const INSTALL_POLICY: Readonly<
  Record<SkillTrustLevel, Readonly<Record<ScanVerdict, InstallDecision>>>
> = {
  builtin: { safe: 'allow', caution: 'allow', dangerous: 'allow' },
  trusted: { safe: 'allow', caution: 'allow', dangerous: 'block' },
  community: { safe: 'allow', caution: 'block', dangerous: 'block' },
  'agent-created': { safe: 'allow', caution: 'allow', dangerous: 'ask' },
};

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Map a source identifier to a {@link SkillTrustLevel}.
 *
 * Resolution rules mirror Hermes `_resolve_trust_level`:
 *   1. `agent-created` → `agent-created`.
 *   2. `official/*` or `official` → `builtin`.
 *   3. Prefix-match against {@link TRUSTED_REPOS} → `trusted`.
 *   4. Strip `skills-sh/`/`skils-sh/`/etc. prefix aliases, retry rule 3.
 *   5. Fallback → `community`.
 *
 * @param source - Source identifier (URL, `owner/repo`, federation URL).
 * @returns The resolved trust level — never `undefined`.
 *
 * @task T9730
 */
export function resolveTrustLevel(source: string): SkillTrustLevel {
  const prefixAliases = ['skills-sh/', 'skills.sh/', 'skils-sh/', 'skils.sh/'];
  let normalised = source;
  for (const prefix of prefixAliases) {
    if (normalised.startsWith(prefix)) {
      normalised = normalised.slice(prefix.length);
      break;
    }
  }

  if (normalised === 'agent-created') return 'agent-created';
  if (normalised === 'official' || normalised.startsWith('official/')) return 'builtin';

  for (const trusted of TRUSTED_REPOS) {
    if (
      normalised === trusted ||
      normalised.startsWith(`${trusted}/`) ||
      normalised.startsWith(trusted)
    ) {
      return 'trusted';
    }
  }
  return 'community';
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Scan a single file for threat patterns and invisible unicode characters.
 *
 * Returns an empty array for files whose extension is not in
 * {@link SCANNABLE_EXTENSIONS} (unless the basename is `SKILL.md`), matching
 * the Hermes early-return in `scan_file`.
 *
 * @param filePath - Absolute path to the file.
 * @param relPath  - Path to render in findings; defaults to `basename(filePath)`.
 * @returns Deduplicated findings — one per `(patternId, line)` pair.
 *
 * @task T9730
 */
export function scanFile(filePath: string, relPath?: string): Finding[] {
  const displayPath = relPath ?? filePath.split('/').pop() ?? filePath;

  const extMatch = /\.[a-z0-9]+$/i.exec(filePath);
  const ext = (extMatch ? extMatch[0] : '').toLowerCase();
  const basename = filePath.split('/').pop() ?? '';
  if (!SCANNABLE_EXTENSIONS.has(ext) && basename !== 'SKILL.md') {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (const { regex, patternId, severity, category, description } of THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const key = `${patternId}|${lineNo}`;
      if (seen.has(key)) continue;
      const line = lines[i] ?? '';
      // Re-create per-line so RegExp lastIndex never carries between calls.
      const m = new RegExp(regex.source, regex.flags).test(line);
      if (m) {
        seen.add(key);
        const trimmed = line.trim();
        const matchText = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
        findings.push({
          patternId,
          severity,
          category,
          file: displayPath,
          line: lineNo,
          match: matchText,
          description,
        });
      }
    }
  }

  // Invisible unicode pass — one finding per line, first hit wins.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { char, name } of INVISIBLE_CHARS) {
      if (line.includes(char)) {
        findings.push({
          patternId: 'invisible_unicode',
          severity: 'high',
          category: 'injection',
          file: displayPath,
          line: i + 1,
          match: `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????'} (${name})`,
          description: `invisible unicode character ${name} (possible text hiding/injection)`,
        });
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

function* walkFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stat: ReturnType<typeof lstatSync> | undefined;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (!stat) continue;
      if (stat.isDirectory()) {
        stack.push(full);
      } else {
        yield full;
      }
    }
  }
}

function checkStructure(skillDir: string): Finding[] {
  const findings: Finding[] = [];
  let fileCount = 0;
  let totalSize = 0;
  const skillRootReal = (() => {
    try {
      return realpathSync(skillDir);
    } catch {
      return resolve(skillDir);
    }
  })();

  for (const filePath of walkFiles(skillDir)) {
    fileCount += 1;
    const rel = relative(skillDir, filePath) || filePath;

    let lstat: ReturnType<typeof lstatSync> | undefined;
    try {
      lstat = lstatSync(filePath);
    } catch {
      continue;
    }
    if (!lstat) continue;

    if (lstat.isSymbolicLink()) {
      try {
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(`${skillRootReal}/`) && resolved !== skillRootReal) {
          findings.push({
            patternId: 'symlink_escape',
            severity: 'critical',
            category: 'traversal',
            file: rel,
            line: 0,
            match: `symlink -> ${resolved}`,
            description: 'symlink points outside the skill directory',
          });
        }
      } catch {
        findings.push({
          patternId: 'broken_symlink',
          severity: 'medium',
          category: 'traversal',
          file: rel,
          line: 0,
          match: 'broken symlink',
          description: 'broken or circular symlink',
        });
      }
      continue;
    }

    let size = 0;
    try {
      size = statSync(filePath).size;
      totalSize += size;
    } catch {
      continue;
    }

    if (size > STRUCTURAL_LIMITS.maxSingleFileKb * 1024) {
      findings.push({
        patternId: 'oversized_file',
        severity: 'medium',
        category: 'structural',
        file: rel,
        line: 0,
        match: `${Math.floor(size / 1024)}KB`,
        description: `file is ${Math.floor(size / 1024)}KB (limit: ${STRUCTURAL_LIMITS.maxSingleFileKb}KB)`,
      });
    }

    const extMatch = /\.[a-z0-9]+$/i.exec(filePath);
    const ext = (extMatch ? extMatch[0] : '').toLowerCase();
    if (SUSPICIOUS_BINARY_EXTENSIONS.has(ext)) {
      findings.push({
        patternId: 'binary_file',
        severity: 'critical',
        category: 'structural',
        file: rel,
        line: 0,
        match: `binary: ${ext}`,
        description: `binary/executable file (${ext}) should not be in a skill`,
      });
    }

    // Executable bit on non-script files
    const scriptExts: ReadonlySet<string> = new Set(['.sh', '.bash', '.py', '.rb', '.pl']);
    if (!scriptExts.has(ext) && (lstat.mode & 0o111) !== 0) {
      findings.push({
        patternId: 'unexpected_executable',
        severity: 'medium',
        category: 'structural',
        file: rel,
        line: 0,
        match: 'executable bit set',
        description: 'file has executable permission but is not a recognized script type',
      });
    }
  }

  if (fileCount > STRUCTURAL_LIMITS.maxFileCount) {
    findings.push({
      patternId: 'too_many_files',
      severity: 'medium',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${fileCount} files`,
      description: `skill has ${fileCount} files (limit: ${STRUCTURAL_LIMITS.maxFileCount})`,
    });
  }

  if (totalSize > STRUCTURAL_LIMITS.maxTotalSizeKb * 1024) {
    findings.push({
      patternId: 'oversized_skill',
      severity: 'high',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${Math.floor(totalSize / 1024)}KB total`,
      description: `skill is ${Math.floor(totalSize / 1024)}KB total (limit: ${STRUCTURAL_LIMITS.maxTotalSizeKb}KB)`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Top-level scan + decision API
// ---------------------------------------------------------------------------

function determineVerdict(findings: readonly Finding[]): ScanVerdict {
  if (findings.length === 0) return 'safe';
  if (findings.some((f) => f.severity === 'critical')) return 'dangerous';
  if (findings.some((f) => f.severity === 'high')) return 'caution';
  return 'caution';
}

function buildSummary(name: string, verdict: ScanVerdict, findings: readonly Finding[]): string {
  if (findings.length === 0) return `${name}: clean scan, no threats detected`;
  const categories = Array.from(new Set(findings.map((f) => f.category))).sort();
  return `${name}: ${verdict} — ${findings.length} finding(s) in ${categories.join(', ')}`;
}

/**
 * Scan a skill directory (or single file) for threats.
 *
 * Runs structural checks then pattern matching, returning a fully-populated
 * {@link ScanResult}. Never throws on individual file I/O errors — bad files
 * are simply skipped so a single broken symlink can't crash the scanner.
 *
 * @param skillPath - Absolute path to the skill root directory or file.
 * @param source    - Source identifier — drives {@link resolveTrustLevel}.
 *                    Defaults to `'community'` (the most conservative tier).
 * @returns Populated scan result with verdict + findings.
 *
 * @task T9730
 */
export function scanSkill(skillPath: string, source: string = 'community'): ScanResult {
  const skillName = skillPath.split('/').filter(Boolean).pop() ?? skillPath;
  const trustLevel = resolveTrustLevel(source);

  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(skillPath);
  } catch {
    // Path doesn't exist — return an empty safe result rather than throwing
    // so install gating can decide whether to surface E_NOT_FOUND.
    const verdict: ScanVerdict = 'safe';
    return {
      skillName,
      source,
      trustLevel,
      verdict,
      findings: [],
      scannedAt: new Date().toISOString(),
      summary: `${skillName}: clean scan, no threats detected`,
    };
  }

  const findings: Finding[] = [];
  if (stat.isDirectory()) {
    findings.push(...checkStructure(skillPath));
    for (const file of walkFiles(skillPath)) {
      const rel = relative(skillPath, file) || file;
      findings.push(...scanFile(file, rel));
    }
  } else {
    findings.push(...scanFile(skillPath, skillName));
  }

  const verdict = determineVerdict(findings);

  return {
    skillName,
    source,
    trustLevel,
    verdict,
    findings,
    scannedAt: new Date().toISOString(),
    summary: buildSummary(skillName, verdict, findings),
  };
}

/**
 * Decision shape returned by {@link shouldAllowInstall}.
 *
 * `reason` is always populated with a human-readable explanation suitable for
 * CLI rendering. Callers MAY surface `reason` verbatim in error envelopes.
 */
export interface InstallGateDecision {
  /** Final action — see {@link InstallDecision}. */
  readonly decision: InstallDecision;
  /** Human-readable rationale. */
  readonly reason: string;
}

/**
 * Decide whether a scan result allows installation under the Hermes
 * {@link INSTALL_POLICY} matrix.
 *
 * `force=true` flips a `block` decision to `allow` (the caller MUST log a
 * bypass entry in `.cleo/audit/skill-trust-bypass.jsonl` — see
 * {@link recordTrustBypass}). `ask` decisions are NEVER auto-allowed by
 * force; the operator must answer the prompt explicitly.
 *
 * @param result - The scan result.
 * @param force  - Allow operator override of `block` decisions.
 * @returns Composite decision shape.
 *
 * @task T9730
 */
export function shouldAllowInstall(
  result: ScanResult,
  force: boolean = false,
): InstallGateDecision {
  const row = INSTALL_POLICY[result.trustLevel];
  const decision = row[result.verdict];

  if (decision === 'allow') {
    return {
      decision: 'allow',
      reason: `Allowed (${result.trustLevel} source, ${result.verdict} verdict)`,
    };
  }

  if (decision === 'ask') {
    return {
      decision: 'ask',
      reason: `Requires confirmation (${result.trustLevel} source + ${result.verdict} verdict, ${result.findings.length} findings)`,
    };
  }

  // block
  if (force) {
    return {
      decision: 'allow',
      reason: `Force-installed despite ${result.verdict} verdict (${result.findings.length} findings)`,
    };
  }
  return {
    decision: 'block',
    reason: `Blocked (${result.trustLevel} source + ${result.verdict} verdict, ${result.findings.length} findings). Use --force to override.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers — content hash + report formatting
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic short SHA-256 hash of every file in a skill
 * directory for integrity tracking. Mirrors Hermes `content_hash`.
 *
 * @param skillPath - Skill root directory or single file.
 * @returns Hash prefixed with `sha256:` and truncated to 16 hex chars.
 */
export function contentHash(skillPath: string): string {
  const hash = createHash('sha256');
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(skillPath);
  } catch {
    return `sha256:${hash.digest('hex').slice(0, 16)}`;
  }
  if (stat.isDirectory()) {
    const files = Array.from(walkFiles(skillPath)).sort();
    for (const file of files) {
      try {
        hash.update(readFileSync(file));
      } catch {
        // skip
      }
    }
  } else {
    try {
      hash.update(readFileSync(skillPath));
    } catch {
      // skip
    }
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

/**
 * Format a scan result as a compact human-readable report.
 *
 * Output mirrors the Hermes `format_scan_report` shape so identical fixtures
 * produce identical reports for parity testing.
 */
export function formatScanReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(
    `Scan: ${result.skillName} (${result.source}/${result.trustLevel})  Verdict: ${result.verdict.toUpperCase()}`,
  );

  if (result.findings.length > 0) {
    const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    for (const f of sorted) {
      const sev = f.severity.toUpperCase().padEnd(8);
      const cat = f.category.padEnd(14);
      const loc = `${f.file}:${f.line}`.padEnd(30);
      lines.push(`  ${sev} ${cat} ${loc} "${f.match.slice(0, 60)}"`);
    }
    lines.push('');
  }

  const { decision, reason } = shouldAllowInstall(result);
  const status =
    decision === 'allow' ? 'ALLOWED' : decision === 'ask' ? 'NEEDS CONFIRMATION' : 'BLOCKED';
  lines.push(`Decision: ${status} — ${reason}`);
  return lines.join('\n');
}
