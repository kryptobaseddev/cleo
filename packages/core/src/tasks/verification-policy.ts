/**
 * Verification-gate policy — the single resolver for WHICH verification gates
 * a task must have set to `true`, and whether that requirement is enforced.
 *
 * `cleo complete` and `cleo release plan` both consume this so the two can
 * never disagree about what "verified" means. Before T12359 the release plan
 * checked only that evidence atoms were PRESENT, and shipped fifteen tasks
 * whose `implemented` gate was `false`.
 *
 * @task T12359
 */

import type { Task, VerificationGate } from '@cleocode/contracts';
import { getRawConfigValue, loadConfig } from '../config.js';

/**
 * Fallback gate list used only when the resolved config names no valid gate.
 * The normal cascade supplies `verification.requiredGates` from config
 * defaults, so this is reached only when a project config sets an empty or
 * wholly-invalid list.
 */
const DEFAULT_VERIFICATION_REQUIRED_GATES: readonly VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'securityPassed',
  'documented',
];

const VERIFICATION_GATES: ReadonlySet<string> = new Set<VerificationGate>([
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
]);

/**
 * Type guard: `true` when `value` names a canonical {@link VerificationGate}.
 *
 * @param value - Candidate gate name (typically from project config).
 * @returns Whether `value` is a known verification gate.
 */
export function isVerificationGate(value: string): value is VerificationGate {
  return VERIFICATION_GATES.has(value);
}

/**
 * Resolved verification-gate policy for a project.
 *
 * @task T12359
 */
export interface VerificationGatePolicy {
  /**
   * Whether verification gates are enforced. Mirrors `verification.enabled`
   * from the project config; under VITEST it defaults to `false` when the
   * project config does not set it explicitly.
   */
  enabled: boolean;
  /** Gates that must be `true` before a task counts as verified, in config order. */
  requiredGates: VerificationGate[];
  /**
   * Gates required per evidence kind (T14001); read through
   * {@link requiredGatesFor} with the kind `taskEvidenceKind` gives (code
   * whenever the work touched code). `code` is `requiredGates` and the
   * non-code kinds `requiredGates` without `testsPassed`/`qaPassed`, unless
   * the project overrides them.
   */
  requiredGatesByKind: Readonly<Record<EvidenceTaskKind, VerificationGate[]>>;
}

/** The evidence kinds `classifyEvidenceTask` sorts tasks into. */
export type EvidenceTaskKind = 'code' | 'documentation' | 'research';

/** The gates that test or lint code: never owed by a change with no code (T14001). */
const CODE_ONLY_GATES: ReadonlySet<VerificationGate> = new Set(['testsPassed', 'qaPassed']);

/**
 * The default gates of a non-code kind (T14001, design doc §C item 2): the
 * project's own `requiredGates` without `testsPassed` and `qaPassed`, so a
 * project that requires `securityPassed` or `documented` keeps them; a
 * research task is then proven by its document or decision, a documentation
 * task by its document. Never empty: `implemented` stands in.
 *
 * @param requiredGates - The project's resolved `requiredGates`.
 */
function nonCodeGates(requiredGates: readonly VerificationGate[]): VerificationGate[] {
  const kept = requiredGates.filter((g) => !CODE_ONLY_GATES.has(g));
  return kept.length > 0 ? kept : ['implemented'];
}

/**
 * Whether a path is a document for evidence-kind purposes (T14001): a
 * documentation artifact, or a CLEO-managed document (an attachment or a
 * content-addressed blob, whose stored name carries no extension).
 *
 * @param path - Repo-relative path.
 */
export function isDocumentEvidencePath(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return (
    isDocumentArtifact(p) || p.startsWith('.cleo/attachments/') || p.startsWith('.cleo/blobs/')
  );
}

/**
 * The gates a task of `kind` must have set before it counts as verified: the
 * one rule `cleo verify`, `cleo done --plan`, `cleo complete` and
 * `cleo release plan` share (T14001).
 *
 * @param policy - The resolved policy.
 * @param kind - The task's evidence kind (`classifyEvidenceTask`).
 * @returns The required gates, in config order.
 */
export function requiredGatesFor(
  policy: Pick<VerificationGatePolicy, 'requiredGatesByKind'>,
  kind: EvidenceTaskKind,
): VerificationGate[] {
  return [...policy.requiredGatesByKind[kind]];
}

/**
 * Resolve the project's verification-gate policy — the same policy
 * `cleo complete` enforces.
 *
 * @param cwd - Project root (defaults to the resolved project root).
 * @returns The enforcement flag and the required gate list.
 *
 * @task T12359
 */
export async function loadVerificationGatePolicy(cwd?: string): Promise<VerificationGatePolicy> {
  const isTest = !!process.env.VITEST;
  const config = await loadConfig(cwd);
  // Read only the project-level value (no DEFAULTS cascade) so the isTest
  // fallback activates when `verification.enabled` is not explicitly set.
  const rawEnabled = await getRawConfigValue('verification.enabled', cwd);
  const enabled = rawEnabled !== undefined ? Boolean(rawEnabled) : !isTest;
  const configured = (config.verification?.requiredGates ?? []).filter(isVerificationGate);
  const requiredGates =
    configured.length > 0 ? configured : [...DEFAULT_VERIFICATION_REQUIRED_GATES];
  const byKind = config.verification?.requiredGatesByKind ?? {};
  const kindGates = (kind: EvidenceTaskKind, fallback: readonly VerificationGate[]) => {
    const declared = (byKind[kind] ?? []).filter(isVerificationGate);
    return declared.length > 0 ? declared : [...fallback];
  };
  return {
    enabled,
    requiredGates,
    requiredGatesByKind: {
      code: kindGates('code', requiredGates),
      documentation: kindGates('documentation', nonCodeGates(requiredGates)),
      research: kindGates('research', nonCodeGates(requiredGates)),
    },
  };
}

/**
 * Return the required gates that are not `true` on a verification record.
 *
 * @param gates - The task's `verification.gates` map (may be absent).
 * @param requiredGates - Gates the policy requires.
 * @returns Required gates whose value is anything other than `true`.
 *
 * @task T12359
 */
export function missingRequiredGates(
  gates: Partial<Record<VerificationGate, boolean | null>> | null | undefined,
  requiredGates: readonly VerificationGate[],
): VerificationGate[] {
  return requiredGates.filter((gate) => gates?.[gate] !== true);
}

/**
 * Whether a path is a documentation artifact (`.md`/`.mdx`/`.rst`/`.adoc`, or
 * README, LICENSE, CHANGELOG bare or with one of those extensions or `.txt`) —
 * the rule `pr:` uses to refuse a docs-only PR as implementation of a code task.
 *
 * A bare `.txt` is not a document (`requirements.txt`, `CMakeLists.txt`), nor
 * is a README/LICENSE/CHANGELOG name with a code extension (`src/README.ts`):
 * both decide what code builds or runs (T14001, review of #2413).
 *
 * @param path - Repo-relative path.
 * @returns True for a documentation artifact.
 */
export function isDocumentArtifact(path: string): boolean {
  return (
    /\.(md|mdx|rst|adoc)$/i.test(path) ||
    /(?:^|\/)(README|LICENSE|CHANGELOG)(?:\.(md|mdx|rst|adoc|txt))?$/i.test(path)
  );
}

/** A code file extension in acceptance prose: a token ending in one keeps the task code (T14065). */
const AC_CODE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json[c5]?|toml|ya?ml|sql|sh|rs|py|go|rb|java|kt|swift|c|h|cc|cpp|css|scss|html|svelte|vue|txt|lock|node|wasm)$/i;

/** A source directory: a path under one is code whatever its extension (T14065). */
const AC_CODE_DIR = /^(?:\.\/)?(?:packages|src|scripts|crates|tests?|apps|lib|bin|\.github)\//;

/**
 * The path-like tokens of a task's acceptance criteria, sorted into documents
 * and code (T14065). A token is a whitespace-separated word stripped of
 * surrounding quotes, backticks, brackets and punctuation; URLs are skipped.
 * A document is {@link isDocumentArtifact}; code is a known code extension
 * (a bare `.txt` included, as there) or any path under a source directory.
 * Anything else (prose, versions, hostnames) names neither.
 *
 * @param acceptance - The task's acceptance items; structured gates are skipped.
 */
function acceptancePathKinds(acceptance: Task['acceptance']): { docs: number; code: number } {
  const kinds = { docs: 0, code: 0 };
  for (const item of acceptance ?? []) {
    if (typeof item !== 'string') continue;
    for (const word of item.split(/\s+/)) {
      const token = word.replace(/^[("'`[{<]+|[)"'`\]}>,.;:!?]+$/g, '');
      if (!token || token.includes('://')) continue;
      if (isDocumentArtifact(token)) kinds.docs++;
      else if (AC_CODE_EXTENSION.test(token) || AC_CODE_DIR.test(token)) kinds.code++;
    }
  }
  return kinds;
}

/**
 * The evidence kind a task's own record decides before any change set is
 * read, or `null` when its change set decides (T14048, T14065): research and
 * spike kinds are research; declared files decide next (all documents:
 * documentation, any code file: code); a bug, or acceptance criteria naming
 * a code path, is code. A task with none of these is undecided.
 *
 * @param task - The task's kind, declared files and acceptance criteria.
 * @returns The decided kind, or `null`.
 * @task T14048
 */
export function declaredEvidenceKind(
  task: Pick<Task, 'kind' | 'files' | 'acceptance'>,
): EvidenceTaskKind | null {
  if (task.kind === 'research' || task.kind === 'spike') return 'research';
  if (task.files?.length && task.files.every(isDocumentArtifact)) return 'documentation';
  if (task.kind === 'bug') return 'code';
  // T14001 (review of #2413): a docs label never hides declared code files.
  if (task.files?.length) return 'code';
  // T14065: nor a code path its acceptance criteria name.
  if (acceptancePathKinds(task.acceptance).code > 0) return 'code';
  return null;
}

/**
 * Classify a task for evidence purposes: `research` (research/spike kind),
 * `documentation` or `code`.
 *
 * {@link declaredEvidenceKind} decides first. An undecided task is read from
 * what it changed (T14048): an inspected change set (`changedPaths`, a
 * `pr:`/`commit:` atom's diff) of documents only makes it documentation, one
 * with any code path keeps it code. Failing a change set, acceptance criteria
 * that name documents (and, being undecided, no code) or a docs label make it
 * documentation (T14065). A docs label therefore never hides code.
 *
 * Exported so the read-only `cleo done --plan` planner chooses the same
 * documentary path the validators accept — one classification, not two. It
 * also picks the gates a task needs ({@link requiredGatesFor}, T14001).
 *
 * @param context - Task context; only `task` and `changedPaths` are read.
 * @returns The evidence classification.
 * @task T12624
 * @task T14048
 * @task T14065
 */
export function classifyEvidenceTask(context: {
  readonly task: Pick<Task, 'kind' | 'files' | 'labels' | 'acceptance'>;
  /** The change set inspected for this evidence, when there is one (T14048). */
  readonly changedPaths?: readonly string[];
}): EvidenceTaskKind {
  const { task, changedPaths } = context;
  const declared = declaredEvidenceKind(task);
  if (declared !== null) return declared;
  if (changedPaths?.length)
    return changedPaths.every(isDocumentEvidencePath) ? 'documentation' : 'code';
  if (acceptancePathKinds(task.acceptance).docs > 0) return 'documentation';
  if (task.labels?.some((label) => label === 'docs' || label === 'documentation'))
    return 'documentation';
  return 'code';
}
