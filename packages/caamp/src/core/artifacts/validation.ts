/**
 * Pure semantic validation of npm-produced package inventories.
 *
 * Code placed in `packages/caamp/` per Package-Boundary Check — verified
 * against AGENTS.md. No filesystem, process, model, or runtime-store access.
 */

import { posix } from 'node:path';
import type {
  PackageArtifactBudgets,
  PackageArtifactFile,
  PackageArtifactInventory,
  PackageArtifactIssue,
  PackageArtifactPolicy,
  PackageArtifactRequirement,
  PackageArtifactValidation,
  PackageFilesEntry,
} from '@cleocode/contracts/package-artifact';

/** Existing CLI upper budgets: 20 MiB packed, 36 MiB unpacked, and 800 files. */
export const CLEO_ARTIFACT_BUDGETS: Readonly<PackageArtifactBudgets> = Object.freeze({
  packedBytes: 20 * 1024 * 1024,
  unpackedBytes: 36 * 1024 * 1024,
  fileCount: 800,
});

/** Required CLI and adapter-node resources, independent of historical byte/file-count floors. */
export const CLEO_ARTIFACT_REQUIREMENTS: readonly PackageArtifactRequirement[] = Object.freeze([
  { id: 'cli-entry', path: 'dist/cli/index.js', match: 'exact' },
  { id: 'studio-server-entry', path: 'studio-dist/index.js', match: 'exact' },
  { id: 'studio-handler', path: 'studio-dist/handler.js', match: 'exact' },
  { id: 'studio-server', path: 'studio-dist/server/index.js', match: 'exact' },
  { id: 'studio-manifest', path: 'studio-dist/server/manifest.js', match: 'exact' },
  {
    id: 'studio-client-start',
    path: 'studio-dist/client/_app/immutable/entry/start.*.js',
    match: 'glob',
  },
  {
    id: 'studio-client-app',
    path: 'studio-dist/client/_app/immutable/entry/app.*.js',
    match: 'glob',
  },
]);

const SHA256 = /^[a-f0-9]{64}$/;
const GLOB = /[*?{}[\]]|[+@!]\(/;

function pathProblem(path: string): string | null {
  if (!path || path.trim() !== path) return 'Path is empty or has surrounding whitespace.';
  if (path.includes('\\') || /[\x00-\x1f\x7f]/.test(path))
    return 'Path is not a portable POSIX package path.';
  if (posix.isAbsolute(path) || /^[A-Za-z]:/.test(path))
    return 'Path must be relative to the package.';
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) {
    return 'Path must not contain empty, current-directory, or parent-directory segments.';
  }
  return null;
}

/**
 * Classify a manifest files entry without evaluating exclusions as disk paths.
 *
 * @param entry - Original npm manifest entry.
 * @returns Classification only; actual selected content must come from the packer.
 * @example
 * ```ts
 * classifyPackageFilesEntry('!dist/index.js.map').kind; // 'exclusion'
 * ```
 */
export function classifyPackageFilesEntry(entry: string): PackageFilesEntry {
  const exclusion = entry.startsWith('!');
  const pattern = (exclusion ? entry.slice(1) : entry).replace(/^\.\//, '').replace(/\/$/, '');
  const reason = pattern.startsWith('!')
    ? 'Repeated exclusion markers are not assessed.'
    : pathProblem(pattern);
  return {
    entry,
    pattern,
    kind: reason ? 'invalid' : exclusion ? 'exclusion' : GLOB.test(pattern) ? 'glob' : 'literal',
    reason,
  };
}

function fileProblems(file: PackageArtifactFile): string[] {
  const problems: string[] = [];
  const pathError = pathProblem(file.path);
  if (pathError) problems.push(pathError);
  if (!Number.isSafeInteger(file.size) || file.size < 0)
    problems.push('File size must be a nonnegative safe integer.');
  if (file.sha256 !== undefined && !SHA256.test(file.sha256))
    problems.push('File SHA-256 must be 64 lowercase hexadecimal characters.');
  return problems;
}

/**
 * Validate nonempty semantic resources, inventory identity, expected hashes and upper budgets.
 *
 * @param inventory - Packer-produced evidence or an explicitly identified fixture.
 * @param policy - Independently specified resources, expected files and cost ceilings.
 * @returns A copied evidence receipt; valid means only the supplied checks passed.
 * @example
 * ```ts
 * const result = validatePackageArtifact(inventory, {
 *   requirements: CLEO_ARTIFACT_REQUIREMENTS,
 *   budgets: CLEO_ARTIFACT_BUDGETS,
 * });
 * // result.runtime remains 'not-assessed', even when result.valid is true.
 * ```
 */
export function validatePackageArtifact(
  inventory: PackageArtifactInventory,
  policy: PackageArtifactPolicy,
): PackageArtifactValidation {
  const issues: PackageArtifactIssue[] = [];
  const add = (code: PackageArtifactIssue['code'], subject: string, message: string): void => {
    issues.push({ code, subject, message });
  };
  if (!inventory.packageName.trim() || !inventory.version.trim()) {
    add('invalid-inventory', 'identity', 'Package name and version must be recorded.');
  }
  if (!['npm-pack', 'npm-pack-dry-run', 'fixture'].includes(inventory.source)) {
    add('invalid-inventory', 'source', 'Inventory provenance is not recognized.');
  }
  if (!Number.isSafeInteger(inventory.packedBytes) || inventory.packedBytes < 0) {
    add('invalid-inventory', 'packedBytes', 'Packed bytes must be a nonnegative safe integer.');
  }
  if (inventory.tarballSha256 !== undefined && !SHA256.test(inventory.tarballSha256)) {
    add(
      'invalid-inventory',
      'tarballSha256',
      'Tarball SHA-256 must be 64 lowercase hexadecimal characters.',
    );
  }
  if (inventory.source === 'npm-pack-dry-run' && inventory.tarballSha256 !== undefined) {
    add(
      'invalid-inventory',
      'tarballSha256',
      'A dry run cannot establish a retained tarball hash.',
    );
  }
  const files = new Map<string, PackageArtifactFile>();
  let unpackedBytes: number | null = 0;
  for (const file of inventory.files) {
    for (const problem of fileProblems(file)) add('invalid-inventory', file.path, problem);
    if (files.has(file.path)) add('invalid-inventory', file.path, 'Duplicate inventory path.');
    files.set(file.path, file);
    if (unpackedBytes !== null) {
      const total: number = unpackedBytes + file.size;
      unpackedBytes = Number.isSafeInteger(total) && file.size >= 0 ? total : null;
    }
  }
  if (unpackedBytes === null)
    add('invalid-inventory', 'unpackedBytes', 'File bytes cannot be safely totaled.');
  const entries = (policy.filesEntries ?? []).map(classifyPackageFilesEntry);
  for (const entry of entries) {
    if (entry.reason) add('invalid-policy', entry.entry, entry.reason);
  }
  if (!policy.requirements.length)
    add('invalid-policy', 'requirements', 'At least one semantic content requirement is required.');
  const ids = new Set<string>();
  const requirements = policy.requirements.map((requirement) => {
    const invalid = pathProblem(requirement.path);
    const duplicate = ids.has(requirement.id);
    ids.add(requirement.id);
    if (
      !requirement.id.trim() ||
      duplicate ||
      invalid ||
      !['exact', 'glob'].includes(requirement.match)
    ) {
      add(
        'invalid-policy',
        requirement.id,
        invalid ?? 'Requirement identity or match mode is invalid or duplicated.',
      );
      return { id: requirement.id, matchedPaths: [], satisfied: false };
    }
    const matches = inventory.files.filter((file) =>
      requirement.match === 'exact'
        ? file.path === requirement.path
        : posix.matchesGlob(file.path, requirement.path),
    );
    if (!matches.length)
      add(
        'missing',
        requirement.id,
        `Required resource ${requirement.path} is absent from the selected inventory.`,
      );
    for (const file of matches) {
      if (file.size === 0) add('empty', file.path, `Required resource ${requirement.id} is empty.`);
    }
    return {
      id: requirement.id,
      matchedPaths: matches.map((file) => file.path),
      satisfied: matches.length > 0 && matches.every((file) => file.size > 0),
    };
  });
  for (const pattern of policy.forbiddenPatterns ?? []) {
    const invalid = pathProblem(pattern);
    if (invalid) {
      add('invalid-policy', pattern, invalid);
      continue;
    }
    for (const file of inventory.files) {
      if (posix.matchesGlob(file.path, pattern))
        add('forbidden', file.path, `Selected file matches forbidden pattern ${pattern}.`);
    }
  }
  let hashComparison: PackageArtifactValidation['hashComparison'] = 'not-requested';
  for (const expected of policy.expectedFiles ?? []) {
    const problems = fileProblems(expected);
    for (const problem of problems) add('invalid-policy', expected.path, problem);
    const actual = files.get(expected.path);
    if (!actual) add('missing', expected.path, 'An independently expected file is missing.');
    else if (actual.size !== expected.size)
      add('mismatch', expected.path, 'File bytes differ from independently expected inventory.');
    if (expected.sha256 !== undefined) {
      if (hashComparison !== 'failed') hashComparison = 'matched';
      if (problems.length || actual?.sha256 !== expected.sha256) {
        hashComparison = 'failed';
        add(
          'mismatch',
          expected.path,
          'Actual hash is missing or differs from the independently expected SHA-256.',
        );
      }
    }
  }
  for (const [field, limit] of Object.entries(policy.budgets)) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      add('invalid-policy', field, 'Budget must be a nonnegative safe integer.');
  }
  if (inventory.packedBytes > policy.budgets.packedBytes)
    add('budget', 'packedBytes', 'Packed bytes exceed the configured upper budget.');
  if (unpackedBytes !== null && unpackedBytes > policy.budgets.unpackedBytes)
    add('budget', 'unpackedBytes', 'Unpacked bytes exceed the configured upper budget.');
  if (inventory.files.length > policy.budgets.fileCount)
    add('budget', 'fileCount', 'Selected file count exceeds the configured upper budget.');
  return {
    valid: issues.length === 0,
    inventory: { ...inventory, files: inventory.files.map((file) => ({ ...file })) },
    unpackedBytes,
    issues,
    filesEntries: entries,
    requirements,
    hashComparison,
    runtime: 'not-assessed',
    limitations: [
      'Manifest entries are classified only; the supplied packer inventory is the content authority.',
      'Hashes are recorded and compared to supplied expected evidence; this validator does not read or authenticate tarball bytes.',
      'Installability, module/dependency resolution, local-reference closure and native/dynamic runtime behavior are not assessed.',
    ],
  };
}

/**
 * Reject declaration and stray JavaScript output absent from the published CLI bundle.
 *
 * @param files - Actual selected package files, not a development directory listing.
 * @returns Concrete build-shape failures; this does not load the bundle.
 * @example
 * ```ts
 * assertCleoShippedBuildShape([{ path: 'dist/cli/index.js', size: 1 }]); // []
 * ```
 */
export function assertCleoShippedBuildShape(files: readonly PackageArtifactFile[]): string[] {
  const reasons: string[] = [];
  const dist = files.filter((file) => file.path.startsWith('dist/'));
  const declarations = dist.filter(
    (file) => file.path.endsWith('.d.ts') || file.path.endsWith('.d.ts.map'),
  );
  if (declarations.length)
    reasons.push(
      `${declarations.length} declaration file(s) under dist/ — the esbuild bundle emits none`,
    );
  const stray = dist.filter(
    (file) => file.path.endsWith('.js') && file.path !== 'dist/cli/index.js',
  );
  if (stray.length)
    reasons.push(
      `${stray.length} .js file(s) under dist/ outside the declared entry dist/cli/index.js, e.g. ${stray[0]?.path}`,
    );
  return reasons;
}
