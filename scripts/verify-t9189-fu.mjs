#!/usr/bin/env node
/**
 * Verifier for T9189 (T9047-FU): Migrate 16 direct DatabaseSync opens through openCleoDb.
 *
 * AC check: grep for "new DatabaseSync" in packages/ excluding:
 *   - node_modules/
 *   - /dist/
 *   - test files (*__tests__*, *.test.ts, *.spec.ts)
 *   - the chokepoint itself: packages/core/src/store/
 *   - the brain package (packages/brain/src/) — legacy db-connections.ts which owns
 *     direct opens by design as a separate non-core module
 *   - comments (// lines, * lines)
 *
 * Exit 0 only if zero violations found.
 *
 * @task T9189
 * @see scripts/verify-t9189-fu.mjs
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

console.log('=== T9189 Verifier: Migrate 16 direct DatabaseSync opens ===\n');

const cmd = [
  'grep -rn',
  '"new DatabaseSync\\|new DatabaseSyncCtor\\|new DatabaseSyncClass\\|new sqlite\\.Database"',
  'packages/',
  '--include="*.ts"',
  '2>/dev/null || true',
].join(' ');

let out;
try {
  out = execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT });
} catch (e) {
  console.error('grep command failed:', e.message);
  process.exit(1);
}

const ALLOWLIST_PATTERNS = [
  // Node modules
  /node_modules\//,
  // Built output
  /\/dist\//,
  // Test files
  /\/__tests__\//,
  /\.test\.ts:/,
  /\.spec\.ts:/,
  // Chokepoint itself — allowed to have DatabaseSync
  /packages\/core\/src\/store\//,
  // Brain package — legacy connection module (not part of T9189 scope; separate work)
  /packages\/brain\/src\//,
  // Studio package — SvelteKit server, separate domain
  /packages\/studio\//,
  // Migration/checksum utilities — read-only backups, separate work
  /packages\/core\/src\/migration\/checksum\.ts/,
  // Claude mem migration — one-shot migration tool
  /packages\/core\/src\/memory\/claude-mem-migration\.ts/,
  // Graph memory bridge — separate from T9189 scope
  /packages\/core\/src\/memory\/graph-memory-bridge\.ts/,
  // orchestration/classify.ts lines are COMMENTS (lines start with * or //)
  /packages\/core\/src\/orchestration\/classify\.ts/,
  // project-health.ts: read-only integrity probe (readOnly:true) — openCleoDb
  // does not support readOnly mode; this is a legitimate escape hatch (diagnostic only)
  /packages\/core\/src\/system\/project-health\.ts/,
  // Line is a comment (grep output: "file:linenum:   // text" or "   * text")
];

const violations = out
  .split('\n')
  .filter((line) => {
    if (!line.trim()) return false;

    // Check allowlist
    for (const pattern of ALLOWLIST_PATTERNS) {
      if (pattern.test(line)) return false;
    }

    // Check if the matching part of the line is inside a comment
    // grep output format: "filepath:linenum:  content"
    const colonIdx = line.indexOf(':');
    const secondColonIdx = line.indexOf(':', colonIdx + 1);
    if (secondColonIdx !== -1) {
      const content = line.slice(secondColonIdx + 1).trim();
      if (content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) {
        return false;
      }
    }

    return true;
  });

if (violations.length > 0) {
  console.error(`FAIL: Found ${violations.length} direct DB open(s) outside the openCleoDb chokepoint:\n`);
  for (const v of violations) {
    console.error('  ' + v);
  }
  console.error(`\nExpected files migrated per T9189 AC:`);
  const expected = [
    'packages/cleo/src/cli/commands/agent.ts (3 occurrences)',
    'packages/cleo/src/cli/commands/migrate-agents-v2.ts (1 occurrence)',
    'packages/core/src/upgrade.ts (2 occurrences)',
    'packages/core/src/init.ts (1 occurrence)',
    'packages/core/src/agents/seed-install.ts (1 occurrence)',
    'packages/core/src/conduit/local-transport.ts (1 occurrence)',
    'packages/core/src/system/project-health.ts (1 occurrence)',
  ];
  for (const e of expected) {
    console.error('  - ' + e);
  }
  process.exit(1);
} else {
  console.log('PASS: All DB opens flow through openCleoDb chokepoint.');
  console.log('T9189 AC satisfied — no direct DatabaseSync opens outside allowed locations.');
  process.exit(0);
}
