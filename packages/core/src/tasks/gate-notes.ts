/**
 * Human-readable notes on passed verification gates (T12961).
 *
 * A flaky pass — a `tool` run whose first attempt failed and whose one full
 * rerun passed — counts toward its gate, but must stay visible rather than
 * read as a clean pass. `cleo verify` and the `cleo show --full` view render
 * such a gate as `passed (flaky: <files>)` from these notes.
 *
 * It also holds the gate-profile rules (T13474) and the document-path rules
 * they rest on, with no runtime imports: the task view reads them on every
 * `cleo show`, whose module budget (gate 39) has no room for another module.
 * `verification-policy.ts`, their public home, re-exports them.
 *
 * @task T12961
 * @task T13474
 */

import type { Task, TaskVerification, VerificationGate } from '@cleocode/contracts';
import type { GateProfileName } from '@cleocode/contracts/evidence-atom-schema.js';

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
 * A source directory: a path under one is code whatever its extension
 * (T14065). Shared by the acceptance-prose rule and the data-receipt rule.
 */
export const SOURCE_DIR_PATH =
  /^(?:\.\/)?(?:packages|src|scripts|crates|tests?|apps|lib|bin|\.github)\//;

/** A data file extension: what a run, census or HTTP readback records (T14557). */
const DATA_FILE_EXTENSION = /\.(?:json|jsonl|ndjson|csv|tsv|xml|log|parquet)$/i;

/** Data-format names a toolchain reads as its configuration, so they are code (T14557). */
const CONFIG_DATA_NAME =
  /(?:^|\/)(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?|jsconfig|biome|deno|composer|[\w.-]+\.config|\.[\w.-]*rc)\.json$/i;

/**
 * Whether a path looks like a data receipt (T14557): a data file (`.json`,
 * `.csv`, `.ndjson`, …) outside every source directory that is not a
 * toolchain configuration name. Such a file is still not a document, so
 * citing it in `files:` keeps the task code; the refusal instead names the
 * supported route ({@link dataReceiptRoute}). Classification never relies on
 * this guess.
 *
 * @param path - Repo-relative path.
 * @returns True for a likely data receipt.
 * @example
 * ```ts
 * isDataReceiptPath('.capture/run-12/manifest.private.json'); // true
 * isDataReceiptPath('packages/core/package.json'); // false
 * ```
 * @task T14557
 */
export function isDataReceiptPath(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return DATA_FILE_EXTENSION.test(p) && !SOURCE_DIR_PATH.test(p) && !CONFIG_DATA_NAME.test(p);
}

/**
 * The supported route for a data receipt cited as a `files:` path (T14557),
 * or `null` when the atom is not a `files:` data receipt. A data file is not
 * a document, so it reclassifies a gate-profiled or documentation task as
 * code; attached through `cleo docs add`, its bytes are stored under
 * `.cleo/attachments/`, a hash-checked document path that `cleo done --plan`
 * cites in `implemented` for the task.
 *
 * @param taskId - The task the receipt proves.
 * @param codeAtom - The code atom as {@link implementedCodeEvidence} names it.
 * @returns The route, as a sentence, or `null`.
 * @task T14557
 */
export function dataReceiptRoute(taskId: string, codeAtom: string): string | null {
  const path = codeAtom.startsWith('files:') ? codeAtom.slice('files:'.length) : null;
  if (path === null || !isDataReceiptPath(path)) return null;
  return (
    `If ${path} is a read-only data receipt, not code: attach it ` +
    `(cleo docs add ${taskId} ${path} --type note), then record implemented again without it ` +
    `from cleo done ${taskId} --plan, which cites its stored .cleo/attachments/ copy, ` +
    'hash-checked evidence that keeps the task non-code'
  );
}

/**
 * Gate profiles a task with no code change may declare, as a `profile:<name>`
 * label (T13474): operations work, a decision, a census or an audit. A
 * profiled task owes the non-code gates of a research task (`implemented`,
 * proven by `decision:` with a `note:` or an artifact); `testsPassed` and
 * `qaPassed` are not applicable to it. The set is closed: any other
 * `profile:` label is refused, and a profiled task whose work touches code
 * owes the code gates whatever its label says (`taskEvidenceKindReport`).
 *
 * @task T13474
 */
export const GATE_PROFILES = ['ops', 'decision', 'census', 'audit'] as const;

/** One of {@link GATE_PROFILES}. */
export type GateProfile = (typeof GATE_PROFILES)[number];

/** Resolves only when `T` is `true`; a compile-time assertion that emits no code. */
type Assert<T extends true> = T;

/**
 * Compile-time proof that {@link GATE_PROFILES} and `GATE_PROFILE_NAMES` in
 * contracts (the key set of `PROFILE_GATE_EVIDENCE`, T14187) name the same
 * profiles: it fails to type-check when they drift. The list is a literal
 * here, imported only as a type from contracts, so `cleo show` (which reads
 * profile notes) does not load the evidence schema module (gate 39), and the
 * check is a type, so this module still does nothing at load.
 *
 * @task T14187
 */
export type GateProfilesMatchContracts = Assert<
  [GateProfile] extends [GateProfileName]
    ? [GateProfileName] extends [GateProfile]
      ? true
      : false
    : false
>;

/** The label prefix that declares a gate profile. */
export const GATE_PROFILE_LABEL_PREFIX = 'profile:';

function isGateProfile(value: string): value is GateProfile {
  return GATE_PROFILES.some((p) => p === value);
}

/**
 * The gate profile a task declares (`profile:<name>` label), or `null`.
 *
 * @param task - The task's labels.
 * @returns The profile, or `null` when it declares none (or only an unknown one).
 * @example
 * ```ts
 * gateProfileOf({ labels: ['profile:ops'] }); // 'ops'
 * ```
 * @task T13474
 */
export function gateProfileOf(task: Partial<Pick<Task, 'labels'>>): GateProfile | null {
  for (const label of task.labels ?? []) {
    const name = label.trim().startsWith(GATE_PROFILE_LABEL_PREFIX)
      ? label.trim().slice(GATE_PROFILE_LABEL_PREFIX.length)
      : null;
    if (name !== null && isGateProfile(name)) return name;
  }
  return null;
}

/**
 * Why a label set's gate profile labels are refused, or `null` (T13474): an
 * unknown `profile:<name>`, or more than one profile.
 *
 * @param labels - The task's labels after the change.
 * @returns The refusal, or `null`.
 * @example
 * ```ts
 * gateProfileLabelProblem(['profile:deploy']); // "Unknown gate profile label 'profile:deploy' …"
 * ```
 * @task T13474
 */
export function gateProfileLabelProblem(labels: readonly string[]): string | null {
  const profiles = [
    ...new Set(labels.map((l) => l.trim()).filter((l) => l.startsWith(GATE_PROFILE_LABEL_PREFIX))),
  ];
  const known = GATE_PROFILES.map((p) => `${GATE_PROFILE_LABEL_PREFIX}${p}`).join(', ');
  const unknown = profiles.find((l) => !isGateProfile(l.slice(GATE_PROFILE_LABEL_PREFIX.length)));
  if (unknown !== undefined)
    return `Unknown gate profile label '${unknown}': the profiles are ${known}`;
  if (profiles.length > 1) return `A task takes one gate profile, got ${profiles.join(', ')}`;
  return null;
}

/**
 * The code evidence a task's recorded `implemented` gate carries, as its atom
 * (`commit:<sha>`, `pr:<n>`, `files:<code path>`), or `null` (T13474). A gate
 * profile never applies to such a task: a code change always owes its tests.
 *
 * @param task - The task (its recorded `implemented` evidence is read).
 * @returns The first code atom, or `null`.
 * @task T13474
 */
export function implementedCodeEvidence(task: Partial<Pick<Task, 'verification'>>): string | null {
  for (const atom of task.verification?.evidence?.implemented?.atoms ?? []) {
    if (atom.kind === 'commit') return `commit:${atom.sha}`;
    if (atom.kind === 'pr') return `pr:${atom.prNumber}`;
    if (atom.kind === 'files') {
      const code = atom.files.find((f) => !isDocumentEvidencePath(f.path));
      if (code !== undefined) return `files:${code.path}`;
    }
  }
  return null;
}

/** The gates a gate profile (T13474) makes not applicable: those that test or lint code. */
export const PROFILE_WAIVED_GATES: readonly VerificationGate[] = ['testsPassed', 'qaPassed'];

/**
 * Notes for the gates a task's gate profile (T13474) makes not applicable:
 * `{ testsPassed: 'not applicable (profile:ops)', … }` for each such gate that
 * is not passed, so a reader never takes it for a pass. Empty when the task
 * declares no profile, or when its implemented evidence carries code (the
 * profile does not apply to it).
 *
 * @param task - The task (labels and recorded evidence are read).
 * @returns The notes, keyed by gate.
 * @task T13474
 */
export function profileGateNotes(
  task: Pick<Task, 'labels' | 'verification'>,
): Partial<Record<VerificationGate, string>> {
  const profile = gateProfileOf(task);
  if (profile === null || implementedCodeEvidence(task) !== null) return {};
  const notes: Partial<Record<VerificationGate, string>> = {};
  for (const gate of PROFILE_WAIVED_GATES) {
    if (task.verification?.gates?.[gate] !== true)
      notes[gate] = `not applicable (profile:${profile})`;
  }
  return notes;
}

/**
 * Notes for every PASSED gate whose evidence carries a flaky `tool` run.
 *
 * @param verification - The task's verification record, if any.
 * @returns e.g. `{ testsPassed: 'passed (flaky: src/a.test.ts)' }`; `{}` when
 *   nothing is flaky.
 *
 * @task T12961
 */
export function describeGateNotes(
  verification: TaskVerification | null | undefined,
): Partial<Record<VerificationGate, string>> {
  const notes: Partial<Record<VerificationGate, string>> = {};
  if (!verification?.evidence) return notes;
  for (const [gate, evidence] of Object.entries(verification.evidence) as Array<
    [VerificationGate, NonNullable<TaskVerification['evidence']>[VerificationGate]]
  >) {
    if (verification.gates[gate] !== true || !evidence) continue;
    const flaky = evidence.atoms.flatMap((a) => (a.kind === 'tool' && a.flaky ? a.flaky : []));
    if (flaky.length > 0) notes[gate] = `passed (flaky: ${[...new Set(flaky)].join(', ')})`;
  }
  return notes;
}
