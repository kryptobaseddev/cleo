#!/usr/bin/env node
/**
 * Check declared literal staging paths and npm-selected semantic CLI resources.
 * CAAMP owns pattern classification and content/budget policy (T12273).
 * Passing is a preview assessment, not installed-runtime certification.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPackageFilesEntry } from '@cleocode/caamp';
import { checkCleoTarball } from '../packages/cleo/scripts/check-cleo-tarball-size.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/cleo');

/**
 * Check promises made by literal manifest entries, then assess actual selected content.
 * @param {string} packageRoot - Package directory; defaults to the repository CLI package.
 * @returns {boolean} Whether staging and preview checks passed.
 */
export function assertCleoTarball(packageRoot = PKG_ROOT) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (
    !Array.isArray(pkg.files) ||
    !pkg.files.length ||
    pkg.files.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Package files[] must be a nonempty array of strings.');
  }
  let valid = true;
  for (const entry of pkg.files) {
    const classified = classifyPackageFilesEntry(entry);
    if (classified.kind === 'invalid') {
      console.error(`::error::files[] ${entry}: ${classified.reason}`);
      valid = false;
    } else if (
      classified.kind === 'literal' &&
      !existsSync(join(packageRoot, classified.pattern))
    ) {
      console.error(`::error::Declared literal staging path is missing: ${entry}`);
      valid = false;
    }
  }
  // Globs/exclusions are not existsSync paths. npm's selection is assessed below.
  const previewValid = checkCleoTarball(packageRoot);
  return valid && previewValid;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = assertCleoTarball() ? 0 : 1;
  } catch (error) {
    console.error(`::error::assert-cleo-tarball: ${error.message}`);
    process.exitCode = 1;
  }
}
