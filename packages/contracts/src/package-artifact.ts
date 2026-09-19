/**
 * Shared contracts for semantic validation of a package inventory.
 *
 * Code placed in `packages/contracts/` per Package-Boundary Check — verified
 * against AGENTS.md. Inventory validation does not certify runtime behavior.
 */

/** A file reported by the packer; hashes describe supplied evidence, not inferred bytes. */
export interface PackageArtifactFile {
  /** Canonical POSIX path relative to the package root. */
  path: string;
  /** Uncompressed file length in bytes. */
  size: number;
  /** SHA-256 computed by the inventory producer, when bytes were inspected. */
  sha256?: string;
}

/** Identity and file evidence supplied by a pack operation or an explicit test fixture. */
export interface PackageArtifactInventory {
  /** Package name from the packed manifest. */
  packageName: string;
  /** Package version from the packed manifest. */
  version: string;
  /** Distinguishes a real packed artifact from a preview or synthetic fixture. */
  source: 'npm-pack' | 'npm-pack-dry-run' | 'fixture';
  /** Compressed artifact length reported by the packer. */
  packedBytes: number;
  /** SHA-256 of the retained tarball, absent for previews. */
  tarballSha256?: string;
  /** Actual selected file inventory, including files npm includes implicitly. */
  files: readonly PackageArtifactFile[];
}

/** Classification of a manifest entry; classification does not reproduce npm's selection rules. */
export interface PackageFilesEntry {
  /** Original manifest string, preserved for diagnostics. */
  entry: string;
  /** Exclusions are patterns, never filesystem paths that must exist. */
  kind: 'literal' | 'glob' | 'exclusion' | 'invalid';
  /** Relative path or pattern without a leading exclusion marker. */
  pattern: string;
  /** Why an entry cannot be assessed, or null for a supported classification. */
  reason: string | null;
}

/** One independently stated content requirement against a packer's inventory. */
export interface PackageArtifactRequirement {
  /** Stable semantic role, such as studio-server-entry. */
  id: string;
  /** Exact path or POSIX glob evaluated against already selected files. */
  path: string;
  /** Exact files and deliberately variable build filenames remain distinct. */
  match: 'exact' | 'glob';
}

/** Upper installation-cost budgets; there is deliberately no mass-based presence floor. */
export interface PackageArtifactBudgets {
  /** Maximum compressed bytes. */
  packedBytes: number;
  /** Maximum sum of uncompressed file bytes. */
  unpackedBytes: number;
  /** Maximum number of selected files. */
  fileCount: number;
}

/** Explicit content and comparison policy, independent of historical package size. */
export interface PackageArtifactPolicy {
  /** Required nonempty resources; an empty policy is rejected. */
  requirements: readonly PackageArtifactRequirement[];
  /** Existing upper budgets to enforce without increasing their values. */
  budgets: PackageArtifactBudgets;
  /** Manifest entries to classify only; the packer's inventory remains authoritative. */
  filesEntries?: readonly string[];
  /** Paths/globs that must be absent from the selected inventory. */
  forbiddenPatterns?: readonly string[];
  /** Independently captured expected files; supplied hashes must match actual hashes. */
  expectedFiles?: readonly PackageArtifactFile[];
}

/** A concrete invalid inventory, policy, required resource, comparison, or budget finding. */
export interface PackageArtifactIssue {
  /** Machine-readable finding class. */
  code:
    | 'invalid-inventory'
    | 'invalid-policy'
    | 'missing'
    | 'empty'
    | 'mismatch'
    | 'forbidden'
    | 'budget';
  /** File path, semantic role, or policy field identifying the affected evidence. */
  subject: string;
  /** Independently understandable failure explanation. */
  message: string;
}

/** One semantic resource assessment, preserving its actual matched file identities. */
export interface PackageArtifactRequirementResult {
  /** Original requirement identity. */
  id: string;
  /** Actual paths selected from the supplied inventory. */
  matchedPaths: readonly string[];
  /** Whether at least one matching nonempty file exists and no match is empty. */
  satisfied: boolean;
}

/** Result of validating supplied package evidence, with explicit limits on the claim. */
export interface PackageArtifactValidation {
  /** True only when the supplied inventory and policy have no findings. */
  valid: boolean;
  /** Original inventory identity and file/hash evidence, copied into the receipt. */
  inventory: PackageArtifactInventory;
  /** Computed byte total, or null if malformed/overflowing evidence prevents accounting. */
  unpackedBytes: number | null;
  /** Every detected failure; a failed diagnostic never becomes empty success. */
  issues: readonly PackageArtifactIssue[];
  /** Classified manifest entries without pretending to reproduce npm packlist. */
  filesEntries: readonly PackageFilesEntry[];
  /** Required resource assessments. */
  requirements: readonly PackageArtifactRequirementResult[];
  /** Hash comparisons establish equality with supplied expected evidence only. */
  hashComparison: 'not-requested' | 'matched' | 'failed';
  /** No runtime loading, install, dependency resolution, or dynamic-reference discovery occurs here. */
  runtime: 'not-assessed';
  /** Follow-up verification needed before claiming a usable installed artifact. */
  limitations: readonly string[];
}
