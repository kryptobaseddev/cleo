/**
 * Canon-Lint — agent-accountability harness for raw markdown writes against
 * canonical doc types.
 *
 * Reads a Claude Code-style session transcript (`*.jsonl` under
 * `~/.claude/projects/.../*.jsonl` or `.cleo/sessions/*.jsonl`), walks every
 * recorded `Write` / `Edit` / `MultiEdit` tool call, and flags any
 * `file_path` argument whose target lands under a `rawMdPaths` entry whose
 * owning DocKind has `rawMdAllowed: false` in `.cleo/canon.yml`.
 *
 * This is the deferred-detection complement to the PR-time CI gate
 * (`cleo check canon docs`, T9796): the CI gate blocks at merge time, but
 * agent-accountability runs against historical transcripts so the team can
 * audit which agents (and which tool calls within them) bypassed SSoT.
 *
 * Design:
 *   - Pure function. Caller supplies a transcript path + canon registry.
 *   - Returns one violation per offending tool call (NOT per file) so the
 *     same `file_path` overwritten three times in a session yields three
 *     violations — useful for sequencing analysis.
 *   - Treats missing transcript as `[]` (not an error) so callers can
 *     batch-lint across many session ids without try/catch.
 *   - Uses the same `CanonRegistry` shape exported by the CLI dispatch
 *     layer's check.canon-docs module — that's the single source of
 *     routing truth.
 *
 * @epic T9787 — SG-DOCS-CANON-CLOSURE
 * @task T9797 — E-DOCS-REAL-WORLD-VALIDATION
 * @see ADR-076 — Canonical Docs SSoT
 * @see packages/cleo/src/dispatch/domains/check/canon-docs.ts — CI gate sibling
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One DocKind entry from `.cleo/canon.yml` — duplicated here (rather than
 * imported from `packages/cleo/`) because the SDK MUST NOT depend on the
 * CLI dispatch layer (Package-Boundary Check, AGENTS.md). The shape is
 * pinned by `.cleo/canon.schema.json`.
 */
export interface CanonKindEntry {
  /** `'ssot'` — blob-store-only; `'ssot-first'` — dual-write via cleo verb. */
  readonly canonicalHome: 'ssot' | 'ssot-first';
  /** Relative path to the human-reviewable mirror (e.g. `docs/adr/`). */
  readonly publishMirror: string;
  /** When `false`, raw fs writes to listed paths are violations. */
  readonly rawMdAllowed: boolean;
  /** Directories the lint scans. Optional when `rawMdAllowed: false`. */
  readonly rawMdPaths?: ReadonlyArray<string>;
}

/** Parsed shape of `.cleo/canon.yml`. */
export interface CanonRegistry {
  /** Schema version. Currently always `1`. */
  readonly version: number;
  /** Map of DocKind id (e.g. `'adr'`, `'changeset'`) to its routing entry. */
  readonly kinds: Readonly<Record<string, CanonKindEntry>>;
}

/**
 * Categorical reason a tool call was flagged.
 *
 * Currently only `raw-md-canonical` exists. Future expansion (per the
 * task spec): `bypass-attempt` for renames into canonical paths,
 * `delete-bypass` for `rm` calls under SSoT mirrors, etc.
 */
export type CanonLintViolationKind = 'raw-md-canonical';

/** One violation flagged by the canon-lint scan. */
export interface CanonLintViolation {
  /** Session id this transcript belongs to. Derived from the file name. */
  readonly sessionId: string;
  /** Anthropic `tool_use.id` (e.g. `toolu_01ABC...`). Empty when missing. */
  readonly toolUseId: string;
  /** Tool name (`Write` | `Edit` | `MultiEdit`). */
  readonly tool: string;
  /** Repo-relative file path the agent attempted to write. */
  readonly path: string;
  /** Owning DocKind id (`'adr'`, `'note'`, …). */
  readonly docKind: string;
  /** The `rawMdPaths` entry that matched (e.g. `'.cleo/adrs/'`). */
  readonly matchedPath: string;
  /** Categorical reason. */
  readonly kind: CanonLintViolationKind;
  /**
   * Short evidence snippet — first 200 chars of either the violating
   * `content` (Write) or `new_string` (Edit). Truncated so a transcript
   * with 50 violations stays under a few KB total.
   */
  readonly evidence: string;
  /** Suggested fix-command text. */
  readonly fix: string;
}

/** Aggregate result returned by `lintSessionForCanonViolations`. */
export interface CanonLintResult {
  /** Absolute path of the transcript that was scanned. */
  readonly transcriptPath: string;
  /** Session id derived from the transcript filename. */
  readonly sessionId: string;
  /** True when no violations were found. */
  readonly passed: boolean;
  /** Number of `Write` / `Edit` / `MultiEdit` tool calls inspected. */
  readonly scanned: number;
  /** Violations in transcript order. Empty when `passed === true`. */
  readonly violations: ReadonlyArray<CanonLintViolation>;
  /**
   * Non-fatal warnings (e.g. transcript JSON parse failures on isolated
   * lines). Lint does NOT abort on a single bad line — it skips and
   * surfaces here so callers can spot data quality issues.
   */
  readonly warnings: ReadonlyArray<string>;
  /**
   * `'enforced'` when the canon registry was supplied; `'no-canon'` when
   * caller passed `undefined` (lint becomes a no-op success).
   */
  readonly mode: 'enforced' | 'no-canon';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a configured directory path so it always:
 *   1. Uses forward slashes (matches Claude tool_use `file_path` output).
 *   2. Ends with a trailing `/` so `startsWith` cannot accidentally
 *      match e.g. `.cleo/adrs-archive/` against `.cleo/adrs/`.
 *
 * @internal
 */
function normaliseDir(dir: string): string {
  const slashed = dir.split(sep).join('/');
  return slashed.endsWith('/') ? slashed : `${slashed}/`;
}

/**
 * Derive the session id from a transcript filename.
 *
 * Claude Code names files `<uuid>.jsonl` (e.g.
 * `00355a61-178f-471e-95fe-edad13d83f52.jsonl`). The session id is the
 * filename minus extension. CLEO sessions follow the same convention
 * under `.cleo/sessions/`.
 *
 * @internal
 */
function deriveSessionId(transcriptPath: string): string {
  const base = transcriptPath.split(sep).pop() ?? transcriptPath;
  return base.replace(/\.jsonl$/, '');
}

/**
 * Truncate a snippet for evidence display. 200 chars max, trailing
 * ellipsis on truncation. Newlines collapsed to spaces so the evidence
 * stays single-line in CLI rendering.
 *
 * @internal
 */
function truncateEvidence(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/**
 * Type-narrowing predicate for the JSONL message shape we care about.
 * Returns true ONLY when `entry.message.content` is an array of items.
 *
 * @internal
 */
function hasToolUseContent(
  entry: unknown,
): entry is { message: { content: ReadonlyArray<Record<string, unknown>> } } {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  const msg = obj['message'];
  if (msg === null || typeof msg !== 'object') return false;
  const content = (msg as Record<string, unknown>)['content'];
  return Array.isArray(content);
}

/**
 * Extract the candidate set of `(toolName, toolUseId, filePath, snippet)`
 * tuples from a single transcript line. Returns `[]` when the line carries
 * no relevant tool call.
 *
 * @internal
 */
function extractToolCalls(
  entry: unknown,
): Array<{ tool: string; toolUseId: string; filePath: string; snippet: string }> {
  if (!hasToolUseContent(entry)) return [];
  const out: Array<{ tool: string; toolUseId: string; filePath: string; snippet: string }> = [];
  for (const item of entry.message.content) {
    if (item['type'] !== 'tool_use') continue;
    const name = item['name'];
    if (name !== 'Write' && name !== 'Edit' && name !== 'MultiEdit') continue;
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const input = item['input'];
    if (input === null || typeof input !== 'object') continue;
    const inputObj = input as Record<string, unknown>;
    if (name === 'MultiEdit') {
      // MultiEdit: { file_path, edits: [{ old_string, new_string }, ...] }
      const filePath = inputObj['file_path'];
      const edits = inputObj['edits'];
      if (typeof filePath !== 'string' || !Array.isArray(edits)) continue;
      // One violation per edit (matches the per-tool-call resolution).
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue;
        const newStr = (edit as Record<string, unknown>)['new_string'];
        out.push({
          tool: 'MultiEdit',
          toolUseId: id,
          filePath,
          snippet: typeof newStr === 'string' ? newStr : '',
        });
      }
      continue;
    }
    const filePath = inputObj['file_path'];
    if (typeof filePath !== 'string') continue;
    let snippet = '';
    if (name === 'Write') {
      const content = inputObj['content'];
      snippet = typeof content === 'string' ? content : '';
    } else {
      // Edit
      const newStr = inputObj['new_string'];
      snippet = typeof newStr === 'string' ? newStr : '';
    }
    out.push({ tool: name, toolUseId: id, filePath, snippet });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load `.cleo/canon.yml` from `projectRoot`. Returns `undefined` when the
 * file is missing — the lint becomes a no-op success in that case. Throws
 * on malformed YAML so callers can surface a clear error envelope.
 *
 * Mirrors `loadCanonRegistry` in
 * `packages/cleo/src/dispatch/domains/check/canon-docs.ts` so SDK callers
 * (e.g. external session-audit tools) do NOT need to depend on the CLI
 * package.
 *
 * @param projectRoot - Absolute path to the repo root.
 */
export function loadCanonRegistry(projectRoot: string): CanonRegistry | undefined {
  const path = join(projectRoot, '.cleo', 'canon.yml');
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readFileSync(path, 'utf8');
  const parsed = parseYaml(text) as unknown;
  return validateCanonRegistry(parsed, path);
}

/** @internal */
function validateCanonRegistry(raw: unknown, source: string): CanonRegistry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: top-level value must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['version'];
  if (typeof version !== 'number' || version !== 1) {
    throw new Error(`${source}: 'version' must be the integer 1 (got ${String(version)})`);
  }
  const kindsRaw = obj['kinds'];
  if (kindsRaw === null || typeof kindsRaw !== 'object' || Array.isArray(kindsRaw)) {
    throw new Error(`${source}: 'kinds' must be an object`);
  }
  const kinds: Record<string, CanonKindEntry> = {};
  for (const [kindId, entryRaw] of Object.entries(kindsRaw as Record<string, unknown>)) {
    kinds[kindId] = validateKindEntry(kindId, entryRaw, source);
  }
  return { version, kinds };
}

/** @internal */
function validateKindEntry(kindId: string, raw: unknown, source: string): CanonKindEntry {
  const where = `${source} kinds.${kindId}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const canonicalHome = obj['canonicalHome'];
  if (canonicalHome !== 'ssot' && canonicalHome !== 'ssot-first') {
    throw new Error(
      `${where}: 'canonicalHome' must be 'ssot' or 'ssot-first' (got ${String(canonicalHome)})`,
    );
  }
  const publishMirror = obj['publishMirror'];
  if (typeof publishMirror !== 'string' || publishMirror.length === 0) {
    throw new Error(`${where}: 'publishMirror' must be a non-empty string`);
  }
  const rawMdAllowed = obj['rawMdAllowed'];
  if (typeof rawMdAllowed !== 'boolean') {
    throw new Error(`${where}: 'rawMdAllowed' must be a boolean`);
  }
  const rawMdPathsRaw = obj['rawMdPaths'];
  let rawMdPaths: ReadonlyArray<string> | undefined;
  if (rawMdPathsRaw !== undefined) {
    if (!Array.isArray(rawMdPathsRaw)) {
      throw new Error(`${where}: 'rawMdPaths' must be an array`);
    }
    for (const p of rawMdPathsRaw) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`${where}: 'rawMdPaths' entries must be non-empty strings`);
      }
    }
    rawMdPaths = rawMdPathsRaw as ReadonlyArray<string>;
  }
  return {
    canonicalHome,
    publishMirror,
    rawMdAllowed,
    ...(rawMdPaths !== undefined ? { rawMdPaths } : {}),
  };
}

/** Parameters accepted by {@link lintSessionForCanonViolations}. */
export interface LintSessionParams {
  /** Absolute path to the `.jsonl` transcript to scan. */
  readonly transcriptPath: string;
  /**
   * Project root used to locate `.cleo/canon.yml`. Required because the
   * transcript may live anywhere (e.g. under `~/.claude/projects/`).
   */
  readonly projectRoot: string;
  /**
   * Pre-loaded registry override — when supplied, skips the on-disk read.
   * Tests pass a synthetic registry so they don't need a real project.
   */
  readonly registry?: CanonRegistry;
}

/**
 * Lint a single session transcript for raw-markdown writes that bypass
 * the docs SSoT.
 *
 * Walks the JSONL line-by-line. For each `tool_use` whose `name` is
 * `Write` / `Edit` / `MultiEdit`, normalises the `file_path` to forward
 * slashes and checks it against every `rawMdPaths` entry whose owning
 * kind has `rawMdAllowed: false`. Matches yield one
 * {@link CanonLintViolation} each (per-call resolution).
 *
 * The lint is forgiving: a malformed line surfaces as a warning, not a
 * fatal error, so a partial transcript still yields actionable output.
 *
 * @param params - Transcript path, project root, optional registry override.
 * @returns Structured result with the violation list and any warnings.
 */
export function lintSessionForCanonViolations(params: LintSessionParams): CanonLintResult {
  const { transcriptPath, projectRoot } = params;
  const sessionId = deriveSessionId(transcriptPath);

  // 1. Resolve registry. `undefined` → no-op success.
  const registry = params.registry ?? loadCanonRegistry(projectRoot);
  if (!registry) {
    return {
      transcriptPath,
      sessionId,
      passed: true,
      scanned: 0,
      violations: [],
      warnings: [],
      mode: 'no-canon',
    };
  }

  // 2. Build the [dir, kindId] block-list from kinds with rawMdAllowed:false.
  const blockingPaths: Array<{ dir: string; kind: string }> = [];
  for (const [kind, entry] of Object.entries(registry.kinds)) {
    if (entry.rawMdAllowed) continue;
    if (!entry.rawMdPaths || entry.rawMdPaths.length === 0) continue;
    for (const p of entry.rawMdPaths) {
      blockingPaths.push({ dir: normaliseDir(p), kind });
    }
  }

  // 3. Read the transcript. Missing file → empty success (see docstring).
  if (!existsSync(transcriptPath)) {
    return {
      transcriptPath,
      sessionId,
      passed: true,
      scanned: 0,
      violations: [],
      warnings: [],
      mode: 'enforced',
    };
  }
  const text = readFileSync(transcriptPath, 'utf8');
  const lines = text.split('\n');
  const violations: CanonLintViolation[] = [];
  const warnings: string[] = [];
  let scanned = 0;

  // 4. Walk every line.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      warnings.push(
        `line ${i + 1}: malformed JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const calls = extractToolCalls(entry);
    for (const call of calls) {
      scanned += 1;
      const normalisedPath = call.filePath.split(sep).join('/');
      // Match against absolute OR relative paths (Claude tool_use uses absolute).
      // We strip the projectRoot prefix when present so blocking-paths starting
      // with `.cleo/` match `<projectRoot>/.cleo/...` too.
      const projectRootSlashed = projectRoot.split(sep).join('/');
      const relative = normalisedPath.startsWith(`${projectRootSlashed}/`)
        ? normalisedPath.slice(projectRootSlashed.length + 1)
        : normalisedPath;
      for (const { dir, kind } of blockingPaths) {
        if (relative.startsWith(dir)) {
          violations.push({
            sessionId,
            toolUseId: call.toolUseId,
            tool: call.tool,
            path: relative,
            docKind: kind,
            matchedPath: dir,
            kind: 'raw-md-canonical',
            evidence: truncateEvidence(call.snippet),
            fix: `cleo docs add <taskId> ${relative} --type ${kind}`,
          });
          break;
        }
      }
    }
  }

  return {
    transcriptPath,
    sessionId,
    passed: violations.length === 0,
    scanned,
    violations,
    warnings,
    mode: 'enforced',
  };
}
