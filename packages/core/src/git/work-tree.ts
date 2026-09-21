/**
 * Whether a directory can host a `git`/`gh` evidence invocation, which tree to
 * run in when the CLEO root is not itself a checkout, and what to say when no
 * tree can be found (gh#1462).
 *
 * `pr:` and `commit:` atoms shell out to `gh` / `git` from a working directory.
 * `gh` does its OWN repo discovery: it walks up from its cwd and, finding no
 * repository before the filesystem boundary, fails with
 *
 *   fatal: not a git repository (or any parent up to mount point /mnt)
 *
 * That message arrives as `E_EVIDENCE_TOOL_FAILED` — the same code a tool that
 * genuinely ran and failed produces — so a CLEO root that is a PARENT of the
 * checkout is indistinguishable from a broken `gh` or an atom this project
 * cannot satisfy. The layout is the cause; the error has to say so.
 *
 * Both atoms ask the same question and need the same remediation, so it lives
 * here rather than being spelled out twice.
 *
 * @task gh#1462
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Error code for "no git work tree at or above the evidence execution root".
 *
 * Deliberately distinct from `E_EVIDENCE_TOOL_FAILED` (the tool ran and failed)
 * and from `E_EVIDENCE_INVALID` (the atom itself cannot hold here). The reader
 * of this code is being told to fix the directory, not to stop trusting the
 * evidence route.
 *
 * @task gh#1462
 */
export const E_EVIDENCE_GIT_ROOT = 'E_EVIDENCE_GIT_ROOT' as const;

/**
 * Environment variable naming the checkout that evidence tools must run in.
 *
 * The CLEO-specific override, and the one the failure message points at. It
 * beats every other signal because it is the only one that can only have been
 * set on purpose for this invocation.
 *
 * @task gh#1466
 */
export const EVIDENCE_GIT_ROOT_ENV = 'CLEO_EVIDENCE_GIT_ROOT';

/**
 * Git's own repo-pointing variables, removed before any DISCOVERY probe.
 *
 * `git rev-parse --is-inside-work-tree` answers about the *ambient* repository
 * when `GIT_DIR`/`GIT_WORK_TREE` are set, not about `dir`. That is precisely
 * what made the remediation this module used to print unusable: from a parent
 * of the checkout, `GIT_DIR=<repo>/.git GIT_WORK_TREE=<repo> git rev-parse
 * --is-inside-work-tree` prints `false` (cwd is outside the declared tree) and
 * exits 0, so the guard rejected the very layout the advice was meant to fix.
 *
 * Probes therefore ask the unambiguous question — "is THIS directory in a
 * checkout of its own" — and the declared roots are honoured explicitly, by
 * {@link resolveDeclaredEvidenceGitRoot}, rather than by hoping git's ambient
 * state happens to agree.
 *
 * @task gh#1466
 */
const GIT_AMBIENT_REPO_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
] as const;

/**
 * A copy of `env` with git's ambient repo-pointing variables removed.
 *
 * @param env - Source environment. Defaults to the current process env.
 * @returns Environment safe for directory-discovery probes.
 * @task gh#1466
 */
function discoveryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of GIT_AMBIENT_REPO_VARS) delete copy[key];
  return copy;
}

/** Run a `git` probe in `dir`, returning trimmed stdout or `null` on any failure. */
function gitProbe(dir: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', [...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Resolve symlinks where possible, falling back to a plain absolute path. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `dir` is inside a git work tree of its own — its own checkout or a
 * descendant of one, since git walks up. False when the directory is missing,
 * is not a work tree, or `git` itself cannot be spawned.
 *
 * Ambient `GIT_DIR`/`GIT_WORK_TREE` are ignored on purpose; see
 * {@link GIT_AMBIENT_REPO_VARS}.
 *
 * @param dir - Directory the tools would run in.
 * @task gh#1462
 */
export function isGitWorkTree(dir: string): boolean {
  return gitProbe(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * Absolute toplevel of the checkout containing `dir`, or `null` when there is
 * none.
 *
 * @param dir - Directory to resolve from.
 * @task gh#1466
 */
export function gitToplevel(dir: string): string | null {
  const top = gitProbe(dir, ['rev-parse', '--show-toplevel']);
  return top === null || top.length === 0 ? null : canonical(top);
}

/**
 * Every git work tree directly below `dir`, in stable sorted order.
 *
 * One level only, on purpose. A CLEO root that parents its checkouts — the
 * layout gh#1462 reports — has the repositories as direct children, while a
 * recursive search would descend into `node_modules` and vendored trees.
 * Dot-directories are skipped so `.cleo/`, `.git/` and editor state are never
 * candidates.
 *
 * @param dir - Candidate parent directory (the CLEO store root).
 * @returns Canonical absolute paths; empty when there are none.
 * @task gh#1466
 */
export function findNestedGitWorkTrees(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules') continue;
    const child = join(dir, entry);
    if (!existsSync(join(child, '.git'))) continue;
    found.push(canonical(child));
  }
  return found.sort();
}

/**
 * The single git work tree directly below `dir`, or `null` when there is none
 * or more than one.
 *
 * Ambiguity returns `null` so the caller can report it — or disambiguate with
 * {@link findWorkTreeContainingCommit} — instead of picking one.
 *
 * @param dir - Candidate parent directory (the CLEO store root).
 * @task gh#1462
 */
export function findNestedGitWorkTree(dir: string): string | null {
  const found = findNestedGitWorkTrees(dir);
  return found.length === 1 ? found[0]! : null;
}

/**
 * The one candidate checkout that contains `sha`, or `null` when none or
 * several do.
 *
 * This is what makes a multi-repo CLEO root resolvable WITHOUT configuration:
 * a `commit:` atom is a statement about exactly one repository, and "which of
 * these checkouts has this object" has a single correct answer almost always.
 * Several matches (shared history) or none stay unresolved rather than being
 * guessed, so the caller reports the ambiguity.
 *
 * @param candidates - Checkouts to search, e.g. from {@link findNestedGitWorkTrees}.
 * @param sha - Commit SHA the evidence is about.
 * @task gh#1466
 */
export function findWorkTreeContainingCommit(
  candidates: readonly string[],
  sha: string,
): string | null {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (gitProbe(candidate, ['cat-file', '-e', `${sha}^{commit}`]) !== null)
      matches.push(candidate);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** An evidence git root the operator declared, and where the declaration came from. */
export interface DeclaredEvidenceGitRoot {
  /** Absolute path exactly as declared (resolved against the store root when relative). */
  path: string;
  /** Human-readable provenance, used verbatim in failure text. */
  source: string;
}

/**
 * Read `evidence.gitRoot` out of `.cleo/project-context.json`.
 *
 * Parsed here with a bare `readFileSync` rather than through
 * `loadProjectContext` so this module stays a leaf: the evidence resolver is
 * synchronous and sits below the agents layer, and a static import back into
 * it would close a cycle. A malformed or absent file simply yields `null` —
 * this tier has always been optional.
 *
 * @param storeRoot - CLEO store root holding `.cleo/`.
 * @task gh#1466
 */
function readConfiguredGitRoot(storeRoot: string): string | null {
  try {
    const raw = readFileSync(join(storeRoot, '.cleo', 'project-context.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const evidence = (parsed as { evidence?: unknown }).evidence;
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
    const gitRoot = (evidence as { gitRoot?: unknown }).gitRoot;
    return typeof gitRoot === 'string' && gitRoot.trim().length > 0 ? gitRoot.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The checkout the operator declared for evidence execution, if any.
 *
 * Precedence, most to least specific:
 *
 *  1. `CLEO_EVIDENCE_GIT_ROOT` — set for this invocation, for this purpose.
 *  2. `GIT_WORK_TREE` — git's own override, and the one the old failure text
 *     advertised. It is honoured by RUNNING in that tree, which is the part
 *     that was missing: setting it alone never helped, because every tool
 *     still ran with its cwd at the CLEO root.
 *  3. `.cleo/project-context.json` → `evidence.gitRoot` — the durable,
 *     committed answer for a root that parents several repositories.
 *
 * The result is NOT validated here. A declared path that is not a work tree
 * must fail loudly and by name rather than falling back to a different tree
 * and attesting against it, so validation belongs to the caller's guard.
 *
 * @param storeRoot - CLEO store root; relative declarations resolve against it.
 * @param env - Environment to read. Defaults to the current process env.
 * @task gh#1466
 */
export function resolveDeclaredEvidenceGitRoot(
  storeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DeclaredEvidenceGitRoot | null {
  const fromEnv = (key: string): DeclaredEvidenceGitRoot | null => {
    const value = env[key]?.trim();
    if (value === undefined || value.length === 0) return null;
    return {
      path: isAbsolute(value) ? value : resolve(storeRoot, value),
      source: `${key}=${value}`,
    };
  };

  const explicit = fromEnv(EVIDENCE_GIT_ROOT_ENV) ?? fromEnv('GIT_WORK_TREE');
  if (explicit !== null) return explicit;

  const configured = readConfiguredGitRoot(storeRoot);
  if (configured === null) return null;
  return {
    path: isAbsolute(configured) ? configured : resolve(storeRoot, configured),
    source: `.cleo/project-context.json evidence.gitRoot="${configured}"`,
  };
}

/** Context that makes {@link describeMissingGitWorkTree} name the actual fix. */
export interface MissingGitWorkTreeContext {
  /** CLEO store root, when it differs from the directory that was tried. */
  storeRoot?: string;
  /** Checkouts found directly below the store root. */
  candidates?: readonly string[];
  /** Provenance of a declared root that turned out not to be a work tree. */
  declaredFrom?: string;
}

/**
 * Reason text for {@link E_EVIDENCE_GIT_ROOT}.
 *
 * The previous text offered `GIT_DIR`/`GIT_WORK_TREE` as the remedy. That
 * advice could not work: the guard asks whether the *current directory* is
 * inside a work tree, and the CLEO root never is, so following it produced the
 * identical error and left the reader with nothing to try. Every branch here
 * therefore names a remedy that has a test proving it resolves the layout.
 *
 * @param dir - Directory the tools would have run in.
 * @param context - What else is known about the layout.
 * @task gh#1462
 * @task gh#1466
 */
export function describeMissingGitWorkTree(
  dir: string,
  context: MissingGitWorkTreeContext = {},
): string {
  const { storeRoot, candidates = [], declaredFrom } = context;

  if (declaredFrom !== undefined) {
    return (
      `Declared evidence git root ${dir} (from ${declaredFrom}) is not a git work tree, ` +
      `so git and gh cannot run there. CLEO honours the declaration rather than ` +
      `silently measuring a different checkout. Point it at a directory that is ` +
      `inside a git repository, or unset it to let CLEO resolve one.`
    );
  }

  const head =
    `No git work tree at or above ${dir}, so git and gh cannot run there. ` +
    `This is a directory/layout problem — not a failing PR, a missing commit, ` +
    `or a broken gh.`;

  if (candidates.length > 1) {
    const root = storeRoot ?? dir;
    return (
      `${head} The CLEO root ${root} parents ${candidates.length} checkouts ` +
      `(${candidates.join(', ')}), and this atom does not say which one it is about, ` +
      `so CLEO will not guess. Declare it once, durably, by adding to ` +
      `${join(root, '.cleo', 'project-context.json')}: ` +
      `"evidence": { "gitRoot": "<subdirectory>" } — or, for a single invocation, ` +
      `${EVIDENCE_GIT_ROOT_ENV}=<repo> cleo verify ... . ` +
      `(A commit: atom naming a SHA that exists in exactly one of these checkouts ` +
      `resolves automatically and needs no configuration.)`
    );
  }

  if (candidates.length === 1) {
    return (
      `${head} The one checkout below the CLEO root, ${candidates[0]}, could not be used. ` +
      `Run the command from inside it, or declare it with ` +
      `${EVIDENCE_GIT_ROOT_ENV}=${candidates[0]}.`
    );
  }

  return (
    `${head} No checkout was found below the CLEO root either. If the repository ` +
    `lives elsewhere, declare it: ${EVIDENCE_GIT_ROOT_ENV}=<repo> cleo verify ... , ` +
    `or add "evidence": { "gitRoot": "<path>" } to ` +
    `${join(storeRoot ?? dir, '.cleo', 'project-context.json')} ` +
    `(or run the command from inside the checkout).`
  );
}

/**
 * The complete {@link E_EVIDENCE_GIT_ROOT} reason for a store root whose
 * resolved execution root turned out not to be a checkout.
 *
 * Composed here, beside the resolution inputs it reports on, so the message
 * and the resolution order cannot drift apart: a declaration that was honoured
 * is named, otherwise the sibling checkouts that made the choice ambiguous are.
 *
 * @param storeRoot - Absolute CLEO store root.
 * @param executionRoot - Root the tools would have run in.
 * @task gh#1466
 */
export function describeUnusableEvidenceGitRoot(storeRoot: string, executionRoot: string): string {
  const declared = resolveDeclaredEvidenceGitRoot(storeRoot);
  return describeMissingGitWorkTree(executionRoot, {
    storeRoot,
    candidates: findNestedGitWorkTrees(storeRoot),
    ...(declared === null ? {} : { declaredFrom: declared.source }),
  });
}
