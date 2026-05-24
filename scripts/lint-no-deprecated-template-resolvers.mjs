#!/usr/bin/env node

/**
 * Advisory lint: warns on new uses of the deprecated template / config
 * directory-resolver wrappers.
 *
 * The wrappers (`getCleoTemplatesDir`, `getWorkflowTemplatesDir`,
 * `resolveAgentTemplates`) remain in place as @deprecated thin shims that
 * delegate to the SSoT template registry (T9877). The registry is the
 * preferred surface for any NEW code — this lint nudges authors to use
 * `getTemplatesByKind` / `getTemplateById` / `resolveSourcePathAbsolute`
 * instead.
 *
 * Exit code is ALWAYS 0 (advisory). The shipped CI gate (added later by
 * T9795 cleanup) will tighten this once the wrappers are removed.
 *
 * Skipped automatically:
 *   - Files inside `dist/` or `node_modules/` (build artefacts).
 *   - Test files (`__tests__/`, `.test.ts`, `.spec.ts`).
 *   - The wrapper source files themselves (where the wrapper is defined).
 *   - Barrel re-exports (`packages/core/src/index.ts`,
 *     `packages/core/src/internal.ts`,
 *     `packages/core/src/agents/index.ts`).
 *
 * @task T9879
 * @saga T9855
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const DEPRECATED_SYMBOLS = [
  'getCleoTemplatesDir',
  'getWorkflowTemplatesDir',
  'resolveAgentTemplates',
];

/**
 * Files where the deprecated symbol is *defined* OR re-exported by name —
 * these are not violations.
 */
const ALLOWED_FILES = new Set([
  // Symbol definitions.
  'packages/core/src/paths.ts',
  'packages/core/src/init/scaffold-workflows.ts',
  'packages/core/src/agents/resolveAgentTemplates.ts',
  // Barrel re-exports.
  'packages/core/src/index.ts',
  'packages/core/src/internal.ts',
  'packages/core/src/agents/index.ts',
  // Back-compat shims that internally re-export.
  'packages/cleo/src/cli/commands/init.ts',
  'packages/cleo/src/cli/commands/upgrade.ts',
  'packages/cleo/src/dispatch/domains/upgrade.ts',
  // SSoT registry itself (mentions symbols in TSDoc).
  'packages/core/src/templates/registry.ts',
  'packages/core/src/templates/index.ts',
  // Init module barrel that documents the wrapper.
  'packages/core/src/init/index.ts',
  // Cross-reference TSDoc only.
  'packages/core/src/scaffold/ensure-templates.ts',
  'packages/core/src/scaffold/telemetry.ts',
  'packages/core/src/store/agent-resolver.ts',
  'packages/core/src/agents/invoke-meta-agent.ts',
  'packages/core/src/agents/seed-install.ts',
  'packages/core/src/init.ts',
  'packages/core/src/playbooks/agent-dispatcher.ts',
  'packages/core/src/validation/doctor/checks.ts',
]);

/**
 * Walk a directory recursively returning every `*.ts` file path
 * (relative to REPO_ROOT). Skips `node_modules`, `dist`, and test files.
 *
 * @param {string} dir Absolute directory.
 * @returns {string[]} Relative TypeScript file paths.
 */
function walkTs(dir) {
  /** @type {string[]} */
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try {
      const { readdirSync } = require('node:fs');
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Use dynamic import fallback when require is unavailable in ESM ctx.
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        if (full.endsWith('.test.ts') || full.endsWith('.spec.ts')) continue;
        out.push(relative(REPO_ROOT, full));
      }
    }
  }
  return out;
}

// ESM does not expose `require` by default; create one for the walker above.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PACKAGES_DIR = join(REPO_ROOT, 'packages');
let tsFiles;
try {
  statSync(PACKAGES_DIR);
  tsFiles = walkTs(PACKAGES_DIR);
} catch {
  console.warn('[lint-no-deprecated-template-resolvers] packages/ not found; nothing to scan.');
  process.exit(0);
}

/** @type {Array<{ file: string, line: number, symbol: string, snippet: string }>} */
const findings = [];

for (const relPath of tsFiles) {
  if (ALLOWED_FILES.has(relPath)) continue;
  const abs = join(REPO_ROOT, relPath);
  let contents;
  try {
    contents = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const symbol of DEPRECATED_SYMBOLS) {
      // Match the symbol followed by `(` (a call) — avoids matching string
      // literals or comments that merely reference it by name.
      const re = new RegExp(`\\b${symbol}\\s*\\(`);
      if (re.test(line)) {
        findings.push({ file: relPath, line: i + 1, symbol, snippet: line.trim() });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(
    '[lint-no-deprecated-template-resolvers] no new uses of deprecated wrappers detected.',
  );
  process.exit(0);
}

console.warn(
  `[lint-no-deprecated-template-resolvers] WARN: ${findings.length} call(s) to deprecated wrapper(s):`,
);
for (const f of findings) {
  console.warn(`  - ${f.file}:${f.line} ${f.symbol}()  // ${f.snippet}`);
}
console.warn(
  '\n[lint-no-deprecated-template-resolvers] These wrappers delegate to the SSoT registry today,',
);
console.warn('but new code SHOULD use `getTemplatesByKind` / `getTemplateById` /');
console.warn('`resolveSourcePathAbsolute` from `@cleocode/core/templates/registry` directly.');
console.warn('See ADR-076, Saga T9855, .cleo/deprecations.yml for the removal schedule.');

// Advisory — always exit 0. CI will tighten when the wrappers are removed.
process.exit(0);
