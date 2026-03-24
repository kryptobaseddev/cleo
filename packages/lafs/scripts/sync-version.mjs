#!/usr/bin/env node

/**
 * Syncs the version from package.json into markdown files.
 * Intended to run as an npm `version` lifecycle hook so that
 * `npm version patch/minor/major` keeps everything in sync.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const files = [
  {
    path: 'README.md',
    pattern: /(\*\*Current version:\*\*) \d+\.\d+\.\d+/,
    replacement: `$1 ${version}`,
  },
  {
    path: 'lafs.md',
    pattern: /(\*\*Version:\*\*) \d+\.\d+\.\d+/,
    replacement: `$1 ${version}`,
  },
  {
    path: 'docs/specification.md',
    pattern: /(\*\*Version:\*\*) \d+\.\d+\.\d+/,
    replacement: `$1 ${version}`,
  },
];

let changed = 0;

for (const { path: rel, pattern, replacement } of files) {
  const abs = resolve(root, rel);
  const before = readFileSync(abs, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after !== before) {
    writeFileSync(abs, after);
    console.log(`  updated ${rel} -> ${version}`);
    changed++;
  } else {
    console.log(`  ${rel} already at ${version}`);
  }
}

console.log(`\nsync-version: ${changed} file(s) updated to ${version}`);
