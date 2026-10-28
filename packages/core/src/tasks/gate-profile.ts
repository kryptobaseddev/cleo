/**
 * Gate profiles (T13474) and the document-path rules they rest on, as a leaf
 * module with no runtime imports: the task view reads them on every
 * `cleo show`, which must not load config (gate 39). Re-exported by
 * `verification-policy.ts`, their public home.
 *
 * @task T13474
 */

import type { Task } from '@cleocode/contracts';

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
