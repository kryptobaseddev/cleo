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
// ADR-079-r2: satisfies atom — cross-task AC binding
// ---------------------------------------------------------------------------

/**
 * Strict AC UUID regex (lowercase, hyphenated 8-4-4-4-12 with v4/v5 major
 * version nibble and `[89ab]` variant nibble). T10586 keeps legacy random
 * UUIDv4 AC ids valid while allowing deterministic UUIDv5-shaped ids derived
 * from task id + source key.
 *
 * Validators MUST reject mixed-case to prevent silent dedupe failures — the
 * canonical column casing is lowercase per ADR-079-r1 §2.1.
 *
 * @task T10506
 * @adr ADR-079-r2 §2.1
 */
export const AC_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Positional-alias regex for `satisfies:` atom target-AC identifiers per
 * ADR-079-r2 §2.1 ABNF (`ac-alias` production). Format: `AC<1-4 digits>`
 * (capped at AC9999 — three orders of magnitude above realistic per-task AC
 * counts).
 *
 * @task T10506
 * @adr ADR-079-r2 §2.1
 */
export const AC_ALIAS_REGEX = /^AC[0-9]{1,4}$/;

/**
 * Task-id regex for `satisfies:` atom target-task identifiers per ADR-079-r2
 * §2.1 ABNF (`task-id` production). Format: `T<1-7 digits>` (capped at
 * T9999999 — three orders of magnitude above current CLEO task IDs as of
 * 2026-05-24).
 *
 * @task T10506
 * @adr ADR-079-r2 §2.1
 */
export const SATISFIES_TASK_ID_REGEX = /^T[0-9]{1,7}$/;

/**
 * Version-pin regex for `satisfies:` atom optional `@<ts>` suffix per
 * ADR-079-r2 §2.1 ABNF (`version-pin` production). Format: `YYYYMMDDhhmmss`
 * (ISO-8601-basic timestamp, 14 digits).
 *
 * @task T10506
 * @adr ADR-079-r2 §2.1
 */
export const SATISFIES_VERSION_PIN_REGEX = /^[0-9]{14}$/;

/**
 * `satisfies:<task-id>#<ac-id>[@<version-pin>]` atom — cross-task AC binding
 * per ADR-079-r2 §2.1 (full grammar) and ADR-079-r1 §2.4 (basic shape).
 *
 * Format:
 *
 *   - `satisfies:T1234#a1b2c3d4-5e6f-4890-abcd-ef1234567890`   — canonical
 *     UUID form (preferred for long-lived specs).
 *   - `satisfies:T1234#AC2`                                    — positional
 *     alias form (preferred in fresh PRs where the target task's AC list
 *     is stable).
 *   - `satisfies:T1234#AC2@20260524223045`                     — alias +
 *     optional version-pin (Validator emissions where pin-on-mint is
 *     required by ADR-079-r2 §3.4).
 *
 * Exactly ONE of `targetAcId` (UUID form) or `targetAcAlias` (alias form)
 * is populated per parsed atom. `versionPin` is always optional.
 *
 * ## Scope
 *
 * This Zod schema covers PARSING ONLY. The runtime validator semantics —
 * the 5-check accept/reject pipeline (target exists, target not terminal,
 * AC exists, same-saga scope rule) — ship in T10507 alongside the
 * `evidence_satisfies_bindings` side-effect table.
 *
 * Per ADR-079-r2 §2.2 the maximum atom length is 120 chars; the schema does
 * NOT enforce length here because the per-field regexes already cap the
 * surface (`satisfies:` + 8-char T+digits + `#` + 36-char UUID + `@` +
 * 14-char pin = 78 chars max — well under 120).
 *
 * @task T10506
 * @adr ADR-079-r2 §2.1
 * @adr ADR-079-r1 §2.4
 */
export const satisfiesAtomSchema = z.object({
  kind: z.literal('satisfies'),
  /** Target task ID — `T<1-7 digits>` per ADR-079-r2 §2.1. */
  targetTaskId: z
    .string()
    .regex(SATISFIES_TASK_ID_REGEX, 'satisfies atom targetTaskId must match /^T[0-9]{1,7}$/'),
  /** Lowercase UUIDv4/v5 — populated for the canonical form; undefined for alias form. */
  targetAcId: z
    .string()
    .regex(AC_UUID_REGEX, 'satisfies atom targetAcId must be a lowercase UUIDv4/v5')
    .optional(),
  /** Positional alias `AC<1-4 digits>` — populated for alias form; undefined for UUID form. */
  targetAcAlias: z
    .string()
    .regex(AC_ALIAS_REGEX, 'satisfies atom targetAcAlias must match /^AC[0-9]{1,4}$/')
    .optional(),
  /** Optional `@<14-digit YYYYMMDDhhmmss>` pin captured at mint time. */
  versionPin: z
    .string()
    .regex(
      SATISFIES_VERSION_PIN_REGEX,
      'satisfies atom versionPin must be 14 digits (YYYYMMDDhhmmss)',
    )
    .optional(),
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
 *   - `satisfies`          — cross-task AC binding (T10506 / ADR-079-r2;
 *                            validator semantics ship in T10507)
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
  satisfiesAtomSchema,
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
 * Failure carries:
 *   - {@link EvidenceValidationFailure.message} — the legacy single-line
 *     `Gate '<gate>' requires evidence: [<combo>] OR [<combo>]` format,
 *     preserved byte-for-byte for backward-compat with surfaces and tests
 *     that match against it.
 *   - {@link EvidenceValidationFailure.hint} — a richer, multi-line,
 *     example-bearing remediation hint suitable for CLI `fix:` surfaces.
 *     Added by T9949 so `E_EVIDENCE_INSUFFICIENT` errors point clearly at
 *     the alternative atom the caller needs (e.g. "this gate requires
 *     real proof — note: alone is not accepted; use commit+files,
 *     commit+note, or pr instead").
 */
export interface EvidenceValidationFailure {
  readonly ok: false;
  readonly message: string;
  readonly hint: string;
}

export type EvidenceValidationResult = { readonly ok: true } | EvidenceValidationFailure;

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
 * Example `--evidence` strings for each atom kind. Used by
 * {@link formatGateRequirementHint} to render copy-pasteable remediation
 * commands in CLI error surfaces.
 *
 * @task T9949
 */
const ATOM_EXAMPLES: Readonly<Record<EvidenceAtomKind, string>> = Object.freeze({
  commit: 'commit:<sha>',
  files: 'files:path/a.ts,path/b.ts',
  'test-run': 'test-run:/tmp/vitest-out.json',
  tool: 'tool:test',
  url: 'url:https://example.com/docs',
  note: 'note:<short description>',
  decision: 'decision:D-arch-001',
  pr: 'pr:357',
  'loc-drop': 'loc-drop:<fromLines>:<toLines>',
  'callsite-coverage': 'callsite-coverage:<symbolName>:<relativeSourcePath>',
  satisfies: 'satisfies:T1234#AC2',
});

/**
 * Render a satisfying atom combination as a copy-pasteable `--evidence`
 * string fragment, e.g. `['commit', 'files']` → `commit:<sha>;files:path/a.ts,path/b.ts`.
 *
 * @internal
 */
function renderCombinationAsEvidence(combination: ReadonlyArray<EvidenceAtomKind>): string {
  return combination.map((kind) => ATOM_EXAMPLES[kind]).join(';');
}

/**
 * Produce a multi-line, example-bearing remediation hint for a gate.
 *
 * Designed for CLI `fix:` surfaces so `E_EVIDENCE_INSUFFICIENT` errors point
 * the caller at the specific alternative atom shape they need. The hint lists
 * every satisfying combination as a copy-pasteable `cleo verify` invocation
 * plus a note-specific clarification when the gate does NOT accept `note:`
 * alone.
 *
 * The motivating bug (T9949) was that note-only deliverables (decision-only
 * tasks, deletion-only refactors) hit `E_EVIDENCE_INSUFFICIENT` with the
 * legacy single-line error and had to consult ADR-051 to figure out which
 * additional atom kind the gate required. The richer hint inlines the answer.
 *
 * @param gate - Verification gate the hint is for.
 * @returns Multi-line remediation hint suitable for an `engineError({fix:})`
 *   surface. Always ends in a clarifying sentence about whether `note:` alone
 *   is accepted for the gate.
 *
 * @example
 * ```ts
 * formatGateRequirementHint('implemented');
 * // "Gate 'implemented' requires programmatic evidence. Use ONE of:
 * //   - cleo verify T#### --gate implemented --evidence 'commit:<sha>;files:path/a.ts,path/b.ts'
 * //   - cleo verify T#### --gate implemented --evidence 'commit:<sha>;note:<short description>'
 * //   - cleo verify T#### --gate implemented --evidence 'decision:D-arch-001;files:path/a.ts,path/b.ts'
 * //   - cleo verify T#### --gate implemented --evidence 'decision:D-arch-001;note:<short description>'
 * //   - cleo verify T#### --gate implemented --evidence 'pr:357'
 * // Note: 'note:' alone is NOT accepted for this gate — pair it with 'commit:' or 'decision:'."
 * ```
 *
 * @task T9949
 * @adr ADR-051 §2.3
 */
export function formatGateRequirementHint(gate: VerificationGate): string {
  const requirement = GATE_EVIDENCE_REQUIREMENTS[gate];
  if (!requirement) {
    // Unknown gate — match validateEvidenceForGate's defensive default.
    return `Gate '${gate}' has no documented evidence requirements.`;
  }

  const lines: string[] = [
    `Gate '${gate}' requires programmatic evidence. Use ONE of:`,
    ...requirement.oneOf.map(
      (combo) =>
        `  - cleo verify T#### --gate ${gate} --evidence '${renderCombinationAsEvidence(combo)}'`,
    ),
  ];

  // Note-specific clarification — T9949's headline pain point.
  // The gate accepts note: alone IFF some single-element combination is ['note'].
  const noteAloneAccepted = requirement.oneOf.some(
    (combo) => combo.length === 1 && combo[0] === 'note',
  );
  if (noteAloneAccepted) {
    lines.push(`Note: 'note:' alone IS accepted for this gate (waiver-style evidence).`);
  } else {
    // Surface every alternative pairing involving note for at-a-glance routing.
    const notePairings = requirement.oneOf.filter(
      (combo) => combo.length > 1 && combo.includes('note'),
    );
    if (notePairings.length > 0) {
      const partners = Array.from(
        new Set(notePairings.flatMap((combo) => combo.filter((k) => k !== 'note'))),
      ).map((k) => `'${k}:'`);
      lines.push(
        `Note: 'note:' alone is NOT accepted for this gate — pair it with ${partners.join(' or ')}.`,
      );
    } else {
      lines.push(
        `Note: 'note:' is NOT accepted for this gate (even when paired). See ADR-051 for the full grammar.`,
      );
    }
  }

  return lines.join('\n');
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
    // T9949: rich, example-bearing remediation hint suitable for CLI `fix:`.
    // Always populated alongside `message` so consumers can choose between
    // the legacy single-line surface and the multi-line hint without re-
    // computing the spec.
    hint: formatGateRequirementHint(gate),
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
      case 'satisfies': {
        // ADR-079-r2 §2.1 ABNF:
        //   satisfies-atom = "satisfies:" task-id "#" ac-id [ "@" version-pin ]
        // Payload shape: <task-id>#<ac-id>[@<version-pin>]
        //
        // PARSING ONLY per T10506 — runtime validator semantics (5-check
        // accept pipeline + same-saga scope rule) ship in T10507.
        const hashIdx = payload.indexOf('#');
        if (hashIdx < 1 || hashIdx === payload.length - 1) {
          throw new EvidenceParseError(
            `Malformed satisfies atom: "${chunk}" (expected satisfies:<task-id>#<ac-id>[@<version-pin>])`,
            'Use format: satisfies:T1234#AC2 or satisfies:T1234#<uuid> e.g. satisfies:T10506#AC1',
          );
        }
        const targetTaskId = payload.slice(0, hashIdx).trim();
        const acAndPin = payload.slice(hashIdx + 1).trim();

        // task-id must match strict ABNF /^T[0-9]{1,7}$/
        if (!SATISFIES_TASK_ID_REGEX.test(targetTaskId)) {
          throw new EvidenceParseError(
            `satisfies atom targetTaskId "${targetTaskId}" must match /^T[0-9]{1,7}$/ in "${chunk}"`,
            'Use format: satisfies:T<digits>#<ac-id> e.g. satisfies:T1234#AC2',
          );
        }

        // Split optional version-pin (after `@`)
        const atIdx = acAndPin.indexOf('@');
        let acIdRaw: string;
        let versionPin: string | undefined;
        if (atIdx === -1) {
          acIdRaw = acAndPin;
          versionPin = undefined;
        } else {
          if (atIdx < 1 || atIdx === acAndPin.length - 1) {
            throw new EvidenceParseError(
              `Malformed satisfies atom version-pin in "${chunk}" (expected <ac-id>@<14-digit YYYYMMDDhhmmss>)`,
              'Use format: satisfies:T1234#AC2@20260524223045',
            );
          }
          acIdRaw = acAndPin.slice(0, atIdx).trim();
          versionPin = acAndPin.slice(atIdx + 1).trim();
          if (!SATISFIES_VERSION_PIN_REGEX.test(versionPin)) {
            throw new EvidenceParseError(
              `satisfies atom versionPin "${versionPin}" must be 14 digits (YYYYMMDDhhmmss) in "${chunk}"`,
              'Use format: satisfies:T1234#AC2@<YYYYMMDDhhmmss> e.g. satisfies:T1234#AC2@20260524223045',
            );
          }
        }

        // ac-id is EITHER a strict UUIDv4/v5 OR an AC<digits> alias — exactly one.
        let targetAcId: string | undefined;
        let targetAcAlias: string | undefined;
        if (AC_UUID_REGEX.test(acIdRaw)) {
          targetAcId = acIdRaw;
        } else if (AC_ALIAS_REGEX.test(acIdRaw)) {
          targetAcAlias = acIdRaw;
        } else {
          throw new EvidenceParseError(
            `satisfies atom ac-id "${acIdRaw}" must be either a lowercase UUIDv4/v5 or AC<1-4 digits> in "${chunk}"`,
            'Use format: satisfies:T1234#AC2 (alias) or satisfies:T1234#<lowercase-uuidv4-or-v5> (canonical)',
          );
        }

        atoms.push({
          kind: 'satisfies',
          targetTaskId,
          ...(targetAcId !== undefined ? { targetAcId } : {}),
          ...(targetAcAlias !== undefined ? { targetAcAlias } : {}),
          ...(versionPin !== undefined ? { versionPin } : {}),
        });
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
          'Valid kinds: commit, files, test-run, tool, url, note, loc-drop, callsite-coverage, decision, pr, satisfies, state',
        );
    }
  }

  return atoms;
}
