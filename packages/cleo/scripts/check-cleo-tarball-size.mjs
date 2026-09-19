#!/usr/bin/env node
/**
 * Check npm-selected CLI content and upper installation-cost budgets (T12273).
 * Required resources replace the former size/count floors. This preview does
 * not certify a retained tarball, installed runtime, or npm publication latency.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCleoShippedBuildShape,
  CLEO_ARTIFACT_BUDGETS,
  CLEO_ARTIFACT_REQUIREMENTS,
  validatePackageArtifact,
} from '@cleocode/caamp';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Retained unpacked installation-cost ceiling in MiB. */
export const MAX_CLEO_UNPACKED_MB = CLEO_ARTIFACT_BUDGETS.unpackedBytes / (1024 * 1024);
/** Retained selected-file count ceiling. */
export const MAX_CLEO_FILES = CLEO_ARTIFACT_BUDGETS.fileCount;
/** Retained compressed installation-cost ceiling in MiB. */
export const MAX_CLEO_PACKED_MB = CLEO_ARTIFACT_BUDGETS.packedBytes / (1024 * 1024);
/** Compatibility export; canonical packaging logic belongs to CAAMP. */
export const assertShippedBuildShape = assertCleoShippedBuildShape;

/**
 * Preview the actual npm-selected inventory and report semantic/budget findings.
 * @param {string} packageRoot - Package directory; defaults to this CLI package.
 * @returns {boolean} Whether the preview checks passed; runtime remains unassessed.
 */
export function checkCleoTarball(packageRoot = PKG_ROOT) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (
    !Array.isArray(pkg.files) ||
    !pkg.files.length ||
    pkg.files.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Package files[] must be a nonempty array of strings.');
  }
  const raw = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new Error('Expected one npm package report.');
  const report = parsed[0];
  if (
    !report ||
    typeof report.name !== 'string' ||
    typeof report.version !== 'string' ||
    typeof report.size !== 'number' ||
    typeof report.unpackedSize !== 'number' ||
    !Array.isArray(report.files) ||
    report.files.some(
      (file) => !file || typeof file.path !== 'string' || typeof file.size !== 'number',
    )
  ) {
    throw new Error('npm pack returned malformed identity, bytes or file inventory.');
  }
  if (report.name !== pkg.name || report.version !== pkg.version)
    throw new Error('Packer and manifest identity differ.');
  const result = validatePackageArtifact(
    {
      packageName: report.name,
      version: report.version,
      source: 'npm-pack-dry-run',
      packedBytes: report.size,
      files: report.files.map(({ path, size }) => ({ path, size })),
    },
    {
      requirements: CLEO_ARTIFACT_REQUIREMENTS,
      budgets: CLEO_ARTIFACT_BUDGETS,
      filesEntries: pkg.files,
      forbiddenPatterns: ['**/*.map'],
    },
  );
  const shapeProblems = assertCleoShippedBuildShape(result.inventory.files);
  const totalsMatch =
    Number.isSafeInteger(report.unpackedSize) && report.unpackedSize === result.unpackedBytes;
  console.log(JSON.stringify(result, null, 2));
  for (const issue of result.issues)
    console.error(`::error::${issue.code}: ${issue.subject}: ${issue.message}`);
  for (const problem of shapeProblems) console.error(`::error::E_DEV_TREE: ${problem}`);
  if (!totalsMatch)
    console.error('::error::Packer unpacked bytes differ from the independently summed inventory.');
  return result.valid && !shapeProblems.length && totalsMatch;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = checkCleoTarball() ? 0 : 1;
  } catch (error) {
    console.error(`::error::check-cleo-tarball: ${error.message}`);
    process.exitCode = 1;
  }
}
