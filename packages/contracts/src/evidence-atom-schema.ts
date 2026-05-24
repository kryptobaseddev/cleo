/**
 * Zod schema + gate-to-atom mapping for the ADR-051 evidence atom grammar.
 *
 * `cleo verify <task-id> --evidence "<atoms>"` accepts a semicolon-delimited
 * list of evidence atoms. Each atom carries a kind prefix and a payload. The
 * grammar lives in three places today:
 *
 *   1. {@link EvidenceAtomSchema} — Zod discriminated union covering every
 *      parseable atom shape (this file).
 *   2. {@link GATE_EVIDENCE_REQUIREMENTS} — gate → satisfying atom-combination
 *      map (this file).
 *   3. `packages/core/src/tasks/evidence.ts` — runtime parser + filesystem /
 *      git / tool validators. The runtime parser delegates to
 *      {@link parseEvidenceString} below for the syntactic split.
 *
 * The schema is exposed for LLM agents and IDE tooling that want to validate
 * an evidence string client-side BEFORE invoking `cleo verify`. The CLI
 * runtime continues to perform the full filesystem-aware validation pass
 * because Zod cannot check that a commit SHA is reachable or that a file
 * exists on disk.
 *
 * The atom shapes here mirror the `ParsedAtom` union in
 * `packages/core/src/tasks/evidence.ts` exactly. Behavior parity with the
 * pre-T10337 ad-hoc parser is required — see the T10337 test suite for the
 * full parity matrix.
 *
 * @task T10337
 * @saga T10326
 * @adr ADR-051
 */

import { z } from 'zod';

import type { VerificationGate } from './task.js';

// ---------------------------------------------------------------------------
// Per-atom Zod schemas
// ---------------------------------------------------------------------------

/**
 * `commit:<sha>` atom — references a git commit by full or short SHA.
 *
 * Format: `commit:<7-40 hex chars>`. The schema accepts any 7-40-character
 * lowercase hex SHA; the runtime validator additionally checks reachability
 * from the task branch and the AC-file content-intersect rule (T9245).
 *
 * @task T832
 */
export const commitAtomSchema = z.object({
  kind: z.literal('commit'),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/i, 'commit sha must be 7-40 hex characters'),
});

/**
 * `files:<p1,p2,...>` atom — list of file paths that the task touched.
 *
 * Format: `files:<comma-separated paths>`. The runtime validator additionally
 * stats each path and records its sha256.
 *
 * @task T832
 */
export const filesAtomSchema = z.object({
  kind: z.literal('files'),
  paths: z.array(z.string().min(1)).min(1, 'files atom requires at least one path'),
});

/**
 * `test-run:<path>` atom — path to a structured test runner JSON output
 * (vitest, jest, pytest, cargo-nextest, etc.).
 *
 * Format: `test-run:<absolute or project-relative path>`. The runtime validator
 * loads the file, parses the JSON, and rejects when failedTests > 0 or
 * totalTests === 0.
 *
 * @task T832
 */
export const testRunAtomSchema = z.object({
  kind: z.literal('test-run'),
  path: z.string().min(1, 'test-run atom requires a non-empty path'),
});

/**
 * `tool:<name>` atom — runs a project-resolved canonical tool and accepts
 * exit-code 0.
 *
 * Format: `tool:<canonical name or legacy alias>`. Canonical names: `test`,
 * `build`, `lint`, `typecheck`, `audit`, `security-scan`. Legacy aliases
 * (`pnpm-test`, `tsc`, `biome`, `cargo-test`, `pytest`, …) still resolve via
 * the runtime resolver (ADR-061 / T1534).
 *
 * @task T832
 * @task T1534
 */
export const toolAtomSchema = z.object({
  kind: z.literal('tool'),
  tool: z.string().min(1, 'tool atom requires a non-empty tool name'),
});

/**
 * `url:<href>` atom — soft evidence pointing to an external artifact (docs,
 * dashboard, etc.).
 *
 * Format: `url:<http(s)://...>`. The runtime validator requires the
 * `http://` or `https://` scheme.
 *
 * @task T832
 */
export const urlAtomSchema = z.object({
  kind: z.literal('url'),
  url: z
    .string()
    .min(1)
    .regex(/^https?:\/\//, 'url atom must start with http:// or https://'),
});

/**
 * `note:<text>` atom — free-form note used for soft evidence and waivers.
 *
 * Format: `note:<1-512 chars>`. The runtime validator caps the note at 512
 * characters to keep the gate-evidence record bounded.
 *
 * @task T832
 */
export const noteAtomSchema = z.object({
  kind: z.literal('note'),
  note: z
    .string()
    .min(1, 'note atom must be non-empty')
    .max(512, 'note atom is too long (max 512 chars)'),
});

/**
 * `decision:<id>` atom — references a `brain_decisions` row that IS the
 * canonical artifact for a decision-only task. Satisfies the `implemented`
 * gate when combined with `files:` pointing to a research note or with
 * `note:` (T1875).
 *
 * Format: `decision:<id>` (e.g. `decision:D-arch-001`). The runtime validator
 * looks up the row and requires `confirmation_state` ∈ {`accepted`,
 * `proposed`}.
 *
 * @task T1875
 */
export const decisionAtomSchema = z.object({
  kind: z.literal('decision'),
  decisionId: z.string().min(1, 'decision atom requires a non-empty decision ID'),
});

/**
 * `pr:<number>` atom — references a GitHub PR by number. Satisfies BOTH
 * `testsPassed` and `qaPassed` simultaneously when the PR is MERGED and every
 * required-workflow check is green (T9764). Extended in T9838 to satisfy
 * `implemented` because the merge commit IS the landing artifact.
 *
 * Format: `pr:<positive integer>` (e.g. `pr:357`).
 *
 * @task T9764
 * @task T9838
 */
export const prAtomSchema = z.object({
  kind: z.literal('pr'),
  prNumber: z.number().int().positive('pr atom requires a positive integer PR number'),
});

/**
 * `loc-drop:<fromLines>:<toLines>` atom — proves that a migrated engine shed
 * lines. Required for the `implemented` gate when the task carries the
 * `engine-migration` label (T1604).
 *
 * Format: `loc-drop:<non-negative integer>:<non-negative integer>`.
 * The schema admits any non-negative pair; the runtime validator additionally
 * requires `fromLines > 0` and `toLines <= fromLines`.
 *
 * @task T1604
 */
export const locDropAtomSchema = z.object({
  kind: z.literal('loc-drop'),
  fromLines: z.number().int().nonnegative('loc-drop fromLines must be ≥ 0'),
  toLines: z.number().int().nonnegative('loc-drop toLines must be ≥ 0'),
});

/**
 * `callsite-coverage:<symbol>:<sourcePath>` atom — proves that an exported
 * symbol has ≥1 production callsite outside its own source file, test files,
 * and dist directories. Required for the `implemented` gate when the task
 * carries the `callsite-coverage` label (T1605).
 *
 * @task T1605
 */
export const callsiteCoverageAtomSchema = z.object({
  kind: z.literal('callsite-coverage'),
  symbolName: z.string().min(1, 'callsite-coverage atom requires a non-empty symbolName'),
  relativeSourcePath: z
    .string()
    .min(1, 'callsite-coverage atom requires a non-empty relativeSourcePath'),
});

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Zod discriminated union covering every parseable evidence atom prefix.
 *
 * Use `EvidenceAtomSchema.safeParse(atom)` to validate a single atom client-
 * side BEFORE invoking `cleo verify`. The runtime parser in
 * `packages/core/src/tasks/evidence.ts` performs filesystem/git/tool checks
 * on top of this syntactic schema.
 *
 * Atom kinds:
 *   - `commit`             — git commit SHA (T832)
 *   - `files`              — touched file paths (T832)
 *   - `test-run`           — structured test runner JSON (T832)
 *   - `tool`               — project-resolved tool exit code (T832 / T1534)
 *   - `url`                — soft external pointer (T832)
 *   - `note`               — free-form note (T832)
 *   - `decision`           — brain_decisions row reference (T1875)
 *   - `pr`                 — merged-PR retroactive proof (T9764 / T9838)
 *   - `loc-drop`           — engine-migration LOC reduction (T1604)
 *   - `callsite-coverage`  — exported-symbol production callsite (T1605)
 *
 * @task T10337
 * @adr ADR-051
 */
export const EvidenceAtomSchema = z.discriminatedUnion('kind', [
  commitAtomSchema,
  filesAtomSchema,
  testRunAtomSchema,
  toolAtomSchema,
  urlAtomSchema,
  noteAtomSchema,
  decisionAtomSchema,
  prAtomSchema,
  locDropAtomSchema,
  callsiteCoverageAtomSchema,
]);

/**
 * Inferred TypeScript type for a parsed evidence atom.
 *
 * This is the pre-validation shape emitted by {@link parseEvidenceString}
 * — distinct from the post-validation `EvidenceAtom` in `./task.ts` which
 * carries fields populated by the runtime validator (sha256, exitCode, etc.).
 *
 * @task T10337
 */
export type EvidenceAtom = z.infer<typeof EvidenceAtomSchema>;

/** Discriminant union of every atom kind accepted by {@link EvidenceAtomSchema}. */
export type EvidenceAtomKind = EvidenceAtom['kind'];

// ---------------------------------------------------------------------------
// Gate-to-atom requirements map
// ---------------------------------------------------------------------------

/**
 * Per-gate evidence requirement spec.
 *
 * Each entry of `oneOf` is a satisfying atom-combination — the gate is
 * satisfied IFF EVERY kind listed in at least ONE of the combinations is
 * present among the supplied atoms.
 *
 * A single-element combination `['pr']` means "one `pr:` atom alone
 * satisfies the gate". A two-element combination `['commit', 'files']` means
 * "both a `commit:` atom AND a `files:` atom must be present".
 *
 * @task T10337
 * @adr ADR-051 §2.3
 */
export interface GateEvidenceRequirement {
  /** Alternative satisfying combinations — ANY one is sufficient. */
  oneOf: ReadonlyArray<ReadonlyArray<EvidenceAtomKind>>;
}

/**
 * Mapping from each {@link VerificationGate} to its satisfying atom
 * combinations. Mirrors the legacy `GATE_EVIDENCE_MINIMUMS` table in
 * `packages/core/src/tasks/evidence.ts` exactly — behavior parity required
 * by T10337.
 *
 * ## Why two alternatives for `implemented`?
 *
 * The `implemented` gate accepts six different evidence shapes:
 *
 *   - `[commit, files]`   — standard: commit SHA + touched file list.
 *   - `[commit, note]`    — deletion-safe: commit SHA + descriptive note
 *                           (when the implementation deleted files there
 *                           are none left to anchor `files:`).
 *   - `[decision, files]` — decision-only task: brain_decisions row +
 *                           research-note file (T1875).
 *   - `[decision, note]`  — decision-only task without research note.
 *   - `[pr]`              — merged-PR retroactive proof (T9838 extension
 *                           of T9764).
 *
 * ## Why is `qaPassed` listed as `['tool']` not `['tool', 'tool']`?
 *
 * The pre-T10337 runtime enforced "at least one atom of kind `tool` is
 * present" — it did NOT count distinct tool names. The convention `tool:lint`
 * + `tool:typecheck` is documented in AGENTS.md as best-practice but the
 * gate is satisfied by a single tool atom (e.g. `tool:test` when test
 * already runs lint + typecheck pre-flight). Behavior parity requires that
 * single-tool atoms continue to pass.
 *
 * @task T10337
 * @adr ADR-051 §2.3
 */
export const GATE_EVIDENCE_REQUIREMENTS: Readonly<
  Record<VerificationGate, GateEvidenceRequirement>
> = Object.freeze({
  implemented: {
    oneOf: [
      ['commit', 'files'],
      ['commit', 'note'],
      ['decision', 'files'],
      ['decision', 'note'],
      ['pr'],
    ],
  },
  testsPassed: { oneOf: [['test-run'], ['tool'], ['pr']] },
  qaPassed: { oneOf: [['tool'], ['pr']] },
  documented: { oneOf: [['files'], ['url']] },
  securityPassed: { oneOf: [['tool'], ['note']] },
  cleanupDone: { oneOf: [['note']] },
  nexusImpact: { oneOf: [['tool'], ['note']] },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Result of {@link validateEvidenceForGate}.
 *
 * Success carries no extra payload (the caller already holds the atom list).
 * Failure carries a human-readable message in the legacy
 * `Gate '<gate>' requires evidence: [<combo>] OR [<combo>]` format so error
 * surfaces (E_EVIDENCE_INSUFFICIENT) read identically across the CLI and any
 * client-side validator built on top of this schema.
 */
export type EvidenceValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Format the satisfying-combinations spec for a gate as the legacy
 * `[commit AND files] OR [pr]` string used in CLI error messages.
 *
 * Exposed so consumers can render the same hint text without re-computing it.
 *
 * @task T10337
 */
export function formatGateRequirement(gate: VerificationGate): string {
  const requirement = GATE_EVIDENCE_REQUIREMENTS[gate];
  return requirement.oneOf.map((set) => `[${set.join(' AND ')}]`).join(' OR ');
}

/**
 * Check whether a set of parsed atoms satisfies the requirement spec for
 * `gate`.
 *
 * Returns `{ ok: true }` when ANY combination in `GATE_EVIDENCE_REQUIREMENTS[gate].oneOf`
 * is fully present in `atoms` (matched by kind). Returns
 * `{ ok: false, message }` otherwise — the message matches the legacy
 * `checkGateEvidenceMinimum()` format byte-for-byte so error surfaces do not
 * regress.
 *
 * Atoms must already be parsed (via {@link parseEvidenceString} or
 * {@link EvidenceAtomSchema}); the helper does NOT re-validate the atom
 * payload. Use {@link EvidenceAtomSchema.safeParse} first if the input came
 * from an untrusted source.
 *
 * @param gate - Verification gate being checked.
 * @param atoms - Already-parsed evidence atoms.
 * @returns Pass / fail with a human-readable failure message.
 *
 * @example
 * ```ts
 * const atoms = parseEvidenceString('commit:abc1234;files:src/foo.ts');
 * validateEvidenceForGate('implemented', atoms); // { ok: true }
 * validateEvidenceForGate('testsPassed', atoms);
 * // { ok: false, message: "Gate 'testsPassed' requires evidence: [test-run] OR [tool] OR [pr]" }
 * ```
 *
 * @task T10337
 * @adr ADR-051 §2.3
 */
export function validateEvidenceForGate(
  gate: VerificationGate,
  atoms: ReadonlyArray<{ kind: EvidenceAtomKind }>,
): EvidenceValidationResult {
  const requirement = GATE_EVIDENCE_REQUIREMENTS[gate];
  if (!requirement) {
    // Unknown gate — defensive default: accept (preserves legacy "no minimum"
    // behavior from checkGateEvidenceMinimum when the gate had no entry).
    return { ok: true };
  }
  for (const combination of requirement.oneOf) {
    const satisfied = combination.every((kind) => atoms.some((a) => a.kind === kind));
    if (satisfied) return { ok: true };
  }
  return {
    ok: false,
    message: `Gate '${gate}' requires evidence: ${formatGateRequirement(gate)}`,
  };
}

/**
 * Error class thrown by {@link parseEvidenceString} when the input is
 * malformed. Carries a {@link reason} suitable for the CLI `fix:` hint.
 *
 * Pure data — no dependency on `@cleocode/contracts/errors` (which would
 * pull the CleoError import surface into every consumer that just wants
 * syntactic validation).
 *
 * @task T10337
 */
export class EvidenceParseError extends Error {
  /** Hint text suitable for an `fix:` message in the CLI surface. */
  public readonly fix: string;

  constructor(message: string, fix: string) {
    super(message);
    this.name = 'EvidenceParseError';
    this.fix = fix;
  }
}

/**
 * Parse the raw CLI `--evidence` string into structured atoms.
 *
 * Syntax:
 * ```
 * evidence-list := atom (';' atom)*
 * atom          := kind ':' payload
 * ```
 *
 * The payload format depends on `kind`:
 *
 *   - `files`             — comma-separated paths
 *   - `loc-drop`          — `<fromLines>:<toLines>` (two integers)
 *   - `callsite-coverage` — `<symbolName>:<relativeSourcePath>`
 *   - `pr`                — positive integer
 *   - everything else     — opaque payload string until the next `;`
 *
 * A `state:MERGED` modifier may follow a `pr:<num>` atom and is consumed
 * in-place (no separate atom is emitted) — see T9838. Any other usage of
 * `state:` is rejected.
 *
 * Whitespace surrounding the `;` separators and around `kind`/`payload` is
 * trimmed. Empty chunks are skipped (consecutive `;;` is tolerated).
 *
 * @param raw - Raw `--evidence` string.
 * @returns Parsed atoms ready for {@link validateEvidenceForGate} or for
 *   the runtime validator in `packages/core/src/tasks/evidence.ts`.
 * @throws {@link EvidenceParseError} when the input is malformed.
 *
 * @example
 * ```ts
 * parseEvidenceString('commit:abc1234;files:src/foo.ts,src/bar.ts;tool:lint');
 * // [
 * //   { kind: 'commit', sha: 'abc1234' },
 * //   { kind: 'files', paths: ['src/foo.ts', 'src/bar.ts'] },
 * //   { kind: 'tool', tool: 'lint' },
 * // ]
 * ```
 *
 * @task T10337
 * @adr ADR-051
 */
export function parseEvidenceString(raw: string): EvidenceAtom[] {
  if (!raw || typeof raw !== 'string') {
    throw new EvidenceParseError(
      'Evidence string is empty',
      "Pass evidence like '--evidence commit:<sha>;files:<path>;...'",
    );
  }
  const chunks = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    throw new EvidenceParseError(
      'Evidence string contained no atoms',
      "Pass evidence like '--evidence commit:<sha>;files:<path>;...'",
    );
  }

  const atoms: EvidenceAtom[] = [];
  for (const chunk of chunks) {
    const colon = chunk.indexOf(':');
    if (colon < 1 || colon === chunk.length - 1) {
      throw new EvidenceParseError(
        `Malformed evidence atom: "${chunk}" (expected <kind>:<payload>)`,
        'Each atom must be of form "<kind>:<payload>" separated by ";".',
      );
    }
    const kind = chunk.slice(0, colon).trim();
    const payload = chunk.slice(colon + 1).trim();
    switch (kind) {
      case 'commit':
        atoms.push({ kind: 'commit', sha: payload });
        break;
      case 'files':
        atoms.push({
          kind: 'files',
          paths: payload
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
        });
        break;
      case 'test-run':
        atoms.push({ kind: 'test-run', path: payload });
        break;
      case 'tool':
        atoms.push({ kind: 'tool', tool: payload });
        break;
      case 'url':
        atoms.push({ kind: 'url', url: payload });
        break;
      case 'note':
        atoms.push({ kind: 'note', note: payload });
        break;
      case 'decision': {
        if (!payload) {
          throw new EvidenceParseError(
            `decision atom requires a non-empty decision ID in "${chunk}"`,
            'Use format: decision:<decisionId> e.g. decision:D-arch-001',
          );
        }
        atoms.push({ kind: 'decision', decisionId: payload });
        break;
      }
      case 'pr': {
        const prNumber = Number(payload);
        if (!Number.isInteger(prNumber) || prNumber <= 0) {
          throw new EvidenceParseError(
            `pr atom requires a positive integer PR number, got "${payload}" in "${chunk}"`,
            'Use format: pr:<number> e.g. pr:357',
          );
        }
        atoms.push({ kind: 'pr', prNumber });
        break;
      }
      case 'loc-drop': {
        const firstColon = payload.indexOf(':');
        if (firstColon < 1 || firstColon === payload.length - 1) {
          throw new EvidenceParseError(
            `Malformed loc-drop atom: "${chunk}" (expected loc-drop:<fromLines>:<toLines>)`,
            'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800',
          );
        }
        const fromRaw = payload.slice(0, firstColon).trim();
        const toRaw = payload.slice(firstColon + 1).trim();
        const fromLines = Number(fromRaw);
        const toLines = Number(toRaw);
        if (!Number.isInteger(fromLines) || fromLines < 0) {
          throw new EvidenceParseError(
            `loc-drop: fromLines must be a non-negative integer, got "${fromRaw}"`,
            'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800',
          );
        }
        if (!Number.isInteger(toLines) || toLines < 0) {
          throw new EvidenceParseError(
            `loc-drop: toLines must be a non-negative integer, got "${toRaw}"`,
            'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800',
          );
        }
        atoms.push({ kind: 'loc-drop', fromLines, toLines });
        break;
      }
      case 'callsite-coverage': {
        const colonIdx = payload.indexOf(':');
        if (colonIdx < 1 || colonIdx === payload.length - 1) {
          throw new EvidenceParseError(
            `Malformed callsite-coverage atom: "${chunk}" (expected callsite-coverage:<symbolName>:<relativeSourcePath>)`,
            'Use format: callsite-coverage:<symbolName>:<relativeSourcePath> e.g. callsite-coverage:myFn:packages/core/src/myFn.ts',
          );
        }
        const symbolName = payload.slice(0, colonIdx).trim();
        const relativeSourcePath = payload.slice(colonIdx + 1).trim();
        if (!symbolName) {
          throw new EvidenceParseError(
            `callsite-coverage: symbolName must not be empty in "${chunk}"`,
            'Use format: callsite-coverage:<symbolName>:<relativeSourcePath>',
          );
        }
        if (!relativeSourcePath) {
          throw new EvidenceParseError(
            `callsite-coverage: relativeSourcePath must not be empty in "${chunk}"`,
            'Use format: callsite-coverage:<symbolName>:<relativeSourcePath>',
          );
        }
        atoms.push({ kind: 'callsite-coverage', symbolName, relativeSourcePath });
        break;
      }
      case 'state': {
        // T9838: explicit-form modifier for the preceding pr: atom.
        // Format: pr:<num>;state:MERGED. The resolver always requires
        // state === 'MERGED' so the modifier is intent-documenting — it
        // asserts the caller knows the contract.
        if (payload !== 'MERGED') {
          throw new EvidenceParseError(
            `state atom only accepts "MERGED", got "${payload}" in "${chunk}"`,
            'Use format: pr:<num>;state:MERGED (state is only meaningful paired with a pr: atom)',
          );
        }
        const lastAtom = atoms[atoms.length - 1];
        if (!lastAtom || lastAtom.kind !== 'pr') {
          throw new EvidenceParseError(
            `state:MERGED must immediately follow a pr:<num> atom in the same evidence string ` +
              `(got "${chunk}" with no preceding pr: atom)`,
            'Use format: --evidence "pr:357;state:MERGED" (state modifier requires a pr: predecessor)',
          );
        }
        // Modifier consumed — no new atom emitted.
        break;
      }
      default:
        throw new EvidenceParseError(
          `Unknown evidence kind: "${kind}" in atom "${chunk}"`,
          'Valid kinds: commit, files, test-run, tool, url, note, loc-drop, callsite-coverage, decision, pr, state',
        );
    }
  }

  return atoms;
}
