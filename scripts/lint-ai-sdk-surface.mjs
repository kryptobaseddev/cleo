#!/usr/bin/env node

/**
 * AI SDK Surface Inventory (T12169 · gh#1223)
 *
 * Every module that reaches the AI SDK directly is a module whose output can
 * land on stdout, because `ai@6`'s `logWarnings` emits its one-time banner with
 * `console.info` — which is stdout, and therefore breaks ADR-086's
 * one-envelope-per-call contract.
 *
 * ## Why an INVENTORY rather than a per-module rule
 *
 * The obvious gate — "every AI-SDK module must import the stdout guard" — is
 * wrong, and it took an experiment to be sure. The guard is deliberately
 * installed at the CLI's envelope funnel, ONE place every command passes
 * through, not per module. Requiring each module to install it would contradict
 * that design and produce a dozen redundant installs.
 *
 * What actually failed was different, and this gate matches it: a module began
 * reaching the SDK **and nobody noticed the coverage question**.
 * `memory/llm-backend-resolver.ts` builds its own client via
 * `await import('@ai-sdk/openai-compatible')`, imports `ai` only as
 * `import type { LanguageModel }` — type-only, erased at runtime — and never
 * loads the chokepoint the guard was originally installed at. The guard was
 * placed on a claim about where traffic goes; this module was a counter-example
 * nobody had enumerated.
 *
 * Measured 2026-09-12: with the funnel install removed, the banner still did
 * not reach stdout, because some unrelated module happens to import the
 * chokepoint on that path. **The safety was real and accidental.** A gate
 * cannot assert reachability statically — but it can ensure the set of modules
 * that could ever emit is a set somebody has looked at.
 *
 * So: a net-new entrant fails, and the fix is to confirm the entry point that
 * reaches it installs the guard, then baseline it deliberately.
 *
 * Modes:
 *   (default)           fail on any module not in the baseline
 *   --update-baseline   re-record after a reviewed addition
 *   --strict            fail if ANY module touches the SDK outside the chokepoint
 *
 * @task T12169
 * @see ADR-086 — one LAFS envelope per call
 * @see ADR-092 — "an invariant asserted in a comment, with nothing enforcing it"
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-ai-sdk-surface-baseline.json');

/** Where the stdout guard is installed; exempt by definition. */
const GUARD_MODULES = ['packages/core/src/llm/ai-sdk-warnings.ts'];

/** Human-readable scan boundary, printed with every result. */
const SCAN_SCOPE = 'packages/**/src/**/*.ts (excluding tests and dist/)';

/**
 * Patterns that mean "this module reaches the AI SDK at RUNTIME".
 *
 * `import type { … } from 'ai'` is deliberately NOT here: it is erased at
 * compile time and pulls in nothing. Treating it as a reach was the mistake
 * that made `llm-backend-resolver.ts` look covered.
 */
const RUNTIME_REACH = [
  /^\s*import\s+\{[^}]*\}\s+from\s+'ai'/m,
  /\bcreate(?:Anthropic|OpenAI|OpenAICompatible|GoogleGenerativeAI|Ollama)\s*\(/,
  /await\s+import\('@ai-sdk\//,
];

/** Strip comments so a docblock example is never read as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);
}

/** Every tracked source file that could reach the SDK. */
function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '*.ts'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => /^packages\/[^/]+\/src\//.test(f))
    .filter((f) => !/(^|\/)(__tests__|dist)\//.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));
}

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update-baseline');
const STRICT = args.has('--strict');

const found = [];
for (const file of sourceFiles()) {
  if (GUARD_MODULES.includes(file)) continue;
  const code = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));
  const reasons = RUNTIME_REACH.filter((re) => re.test(code)).length;
  if (reasons > 0) found.push(file);
}
found.sort();

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Modules that reach the AI SDK at runtime (gh#1223). A net-new entrant FAILS: confirm the ' +
          'entry point that reaches it installs the stdout guard, then re-record with --update-baseline.',
        modules: found,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log(`lint-ai-sdk-surface: baseline written — ${found.length} module(s).`);
  process.exit(0);
}

if (STRICT) {
  const outside = found.filter((f) => f !== 'packages/core/src/llm/model-runner.ts');
  if (outside.length === 0) {
    console.log('lint-ai-sdk-surface: STRICT OK — the SDK is reached only from the chokepoint.');
    process.exit(0);
  }
  console.error(
    `lint-ai-sdk-surface: STRICT FAIL — ${outside.length} module(s) outside the chokepoint:`,
  );
  for (const f of outside) console.error(`    ${f}`);
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
} catch {
  console.error(
    `lint-ai-sdk-surface: no baseline at ${relative(REPO_ROOT, BASELINE)}.\n` +
      '  Create it with: node scripts/lint-ai-sdk-surface.mjs --update-baseline',
  );
  process.exit(1);
}

const known = new Set(baseline.modules ?? []);
const added = found.filter((f) => !known.has(f));
const removed = [...known].filter((f) => !found.includes(f));

if (added.length === 0) {
  const suffix =
    removed.length > 0 ? ` (${removed.length} left the surface — consider --update-baseline)` : '';
  console.log(
    `lint-ai-sdk-surface: OK — ${found.length} module(s) reach the AI SDK, all reviewed${suffix}.\n` +
      `  scanned: ${SCAN_SCOPE}`,
  );
  process.exit(0);
}

console.error(`lint-ai-sdk-surface: FAIL — ${added.length} module(s) newly reach the AI SDK:\n`);
for (const f of added) console.error(`    ${f}`);
console.error(
  '\nEvery module that reaches the AI SDK can emit on STDOUT: `ai@6` logs its one-time\n' +
    'banner with `console.info`, which lands after the LAFS envelope and breaks ADR-086.\n\n' +
    '  CONFIRM: the entry point that reaches this module installs the stdout guard\n' +
    '           (`installAiSdkWarningHandler`). Do NOT assume the LLM chokepoint covers\n' +
    '           it — `memory/llm-backend-resolver.ts` reaches the SDK by dynamic import\n' +
    '           and never loads the chokepoint at all (gh#1223).\n\n' +
    '  THEN:    node scripts/lint-ai-sdk-surface.mjs --update-baseline\n\n' +
    `  scanned: ${SCAN_SCOPE}`,
);
process.exit(1);
