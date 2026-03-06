#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const JUSTIFICATION_TOKEN = 'underscore-import:';
const importPattern = /\bas\s+(_[A-Za-z0-9_]+)/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTrackedTsFiles() {
  const output = execSync("git ls-files -- 'src/**/*.ts' 'tests/**/*.ts'", {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (!output) {
    return [];
  }

  return output.split('\n').filter(Boolean);
}

function findUnderscoreImports(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const findings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes('import') || !line.includes(' as _')) {
      continue;
    }

    const match = line.match(importPattern);
    if (!match) {
      continue;
    }

    const alias = match[1];
    if (!alias) {
      continue;
    }

    const aliasRegex = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'g');
    const aliasMatches = source.match(aliasRegex) ?? [];
    const isWired = aliasMatches.length > 1;

    const contextStart = Math.max(0, index - 3);
    const context = lines.slice(contextStart, index + 1).join('\n').toLowerCase();
    const hasJustification = context.includes(JUSTIFICATION_TOKEN);

    findings.push({
      filePath,
      lineNumber: index + 1,
      alias,
      isWired,
      hasJustification,
    });
  }

  return findings;
}

const files = getTrackedTsFiles();
const findings = files.flatMap(findUnderscoreImports);

if (findings.length === 0) {
  console.log('Underscore import hygiene: no underscore-prefixed imports found in src/tests TypeScript scope.');
  process.exit(0);
}

console.log('Underscore import hygiene report:');
for (const finding of findings) {
  console.log(
    `- ${finding.filePath}:${finding.lineNumber} ${finding.alias} ` +
    `(wired=${finding.isWired ? 'yes' : 'no'}, justified=${finding.hasJustification ? 'yes' : 'no'})`,
  );
}

const violations = findings.filter((finding) => !finding.isWired || !finding.hasJustification);

if (violations.length > 0) {
  console.error('');
  console.error('Underscore import hygiene check failed.');
  console.error('Each underscore-prefixed import must be wired (used) and justified.');
  console.error(`Use a nearby comment token \`${JUSTIFICATION_TOKEN}\` to document intent.`);
  process.exit(1);
}

console.log('Underscore import hygiene check passed.');
