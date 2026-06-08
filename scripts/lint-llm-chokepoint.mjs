#!/usr/bin/env node
/**
 * Lint rule (Gate 13 — LLM Chokepoint Guard): forbid LLM resolution + client /
 * transport construction outside the single SSoT chokepoint.
 *
 * Why this matters (E9 · T11745 · T11783)
 * ---------------------------------------
 * PR #954 collapsed CLEO's four near-duplicate transport factories
 * (`session-factory`, `api.ts`, `tool-loop.ts`, the inline codex block in
 * `role-executor.ts`) onto ONE place — {@link ModelRunner} in
 * `packages/core/src/llm/model-runner.ts` — fed by ONE resolution chokepoint:
 * `resolveLLMForSystem` → `resolveLLMForRole`. The whole point of the
 * {@link ResolvedLLMDescriptor} (carrying `apiMode`/`baseUrl`/`authType`) is that
 * a runner can build ANY provider's transport from descriptor data alone, with
 * NO inline per-call-site branching.
 *
 * Resolver divergence is a STRUCTURAL bug class: every time a new call-site
 * constructs its own transport / SDK client, reads `process.env.*_API_KEY`
 * directly, or hardcodes a model literal, it re-introduces a parallel resolution
 * path that drifts from the chokepoint (wrong base URL, missing OAuth headers,
 * stale model). This gate makes that drift fail CI.
 *
 * Forbidden classes (each is a separate rule with its own baseline count)
 * ----------------------------------------------------------------------
 *   1. `llm-transport-construction` — `new {Anthropic,ChatCompletions,Gemini,
 *      Ollama,Bedrock,CodexResponses,OpenAI}Transport(` outside the chokepoint.
 *   2. `ai-sdk-provider-factory`   — `createAnthropic(` / `createOpenAI(` /
 *      `createOpenAICompatible(` / `createGoogleGenerativeAI(` (Vercel AI SDK
 *      `LanguageModel` construction) outside the chokepoint.
 *   3. `raw-sdk-client`            — `new Anthropic(` / `new OpenAI(` outside the
 *      chokepoint (the raw provider SDK clients).
 *   4. `env-api-key-read`         — direct `process.env.*_API_KEY` reads outside
 *      the credential layer (credentials MUST flow through CredentialPool).
 *   5. `hardcoded-model-literal`  — a model-id string literal (`'claude-…'`,
 *      `'gpt-…'`, `'gemini-…'`, …) in resolver/consumer code. Models ALWAYS come
 *      from the registry / role-config, never a literal (scoped scan; the catalog
 *      / registry / metadata SSoT files are exempt — they ARE the model data).
 *   6. `direct-resolve-credentials` — `resolveCredentials(` called for inline
 *      client construction outside the resolver layer.
 *   7. `divergent-resolver-definition` — a NEW exported `resolveLLMFor*`
 *      resolution function DEFINED outside the two canonical chokepoint files
 *      (`role-resolver.ts` = the SSoT core impl, `system-resolver.ts` = the
 *      public E9 chokepoint). The whole point of E9 is ONE resolution chokepoint
 *      (T11751 · AC3): a second `resolveLLMForX` is a divergent resolver by
 *      definition. Refactor it to DELEGATE to `resolveLLMForSystem` instead.
 *
 * Allowlist = the chokepoint
 * --------------------------
 *   - `packages/core/src/llm/model-runner.ts`     — the single SSoT runner.
 *   - `packages/core/src/llm/transports/**`        — the transport class
 *     definitions (where `new Anthropic(...)` etc. legitimately live).
 *   - `packages/core/src/llm/role-resolver.ts`     — owns the legacy Anthropic
 *     `client` construction (D-ph4-01 grep-guard invariant).
 *   - `packages/core/src/llm/system-resolver.ts`   — the resolution chokepoint.
 *   - `packages/core/src/llm/api-mode.ts`          — the SSoT wire-derivation.
 *
 * Test files (`__tests__/`, `.test.ts`, `.spec.ts`) are exempt (they construct
 * transports / read env directly to seed fixtures).
 *
 * Per-line opt-out: append `// llm-resolve-allowed` on the same source line with
 * a brief justification.
 *
 * Modes
 * -----
 * --strict          Require zero violations — fail even if count matches baseline.
 * --baseline        Default mode — fail only if a rule's count INCREASES vs baseline.
 * --update-baseline Overwrite the baseline file with the current counts and exit 0.
 *
 * @task T11783
 * @task T11745
 * @epic T11745
 * @saga T9831 SG-ARCH-SOLID
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const SCAN_DIRS = ['packages'];

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svelte-kit',
  '__snapshots__',
  '__mocks__',
  'coverage',
  '.next',
  'fixtures',
  '__fixtures__',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.tsx']);

/** Test file suffixes — exempt even outside __tests__ directories. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/** Inline opt-out marker (must appear on the same source line). */
const ALLOW_INLINE = '// llm-resolve-allowed';

/**
 * The chokepoint allowlist shared by the transport/client-construction rules.
 * These are the ONLY places transport / SDK-client construction may appear.
 */
const CHOKEPOINT_ALLOW = [
  'packages/core/src/llm/model-runner.ts',
  'packages/core/src/llm/transports/',
  'packages/core/src/llm/role-resolver.ts',
  'packages/core/src/llm/system-resolver.ts',
  'packages/core/src/llm/api-mode.ts',
];

/**
 * The credential layer — exempt from the `env-api-key-read` rule (these modules
 * legitimately read provider env-var fallbacks while resolving credentials).
 */
const CREDENTIAL_LAYER_ALLOW = [
  'packages/core/src/llm/transports/',
  'packages/core/src/llm/credentials.ts',
  'packages/core/src/llm/credentials-store.ts',
  'packages/core/src/llm/credential-pool.ts',
  'packages/core/src/llm/credential-seeders/',
  'packages/core/src/llm/oauth/',
];

/**
 * Model-data SSoT files — exempt from the `hardcoded-model-literal` rule. These
 * files ARE the canonical model catalog / registry / metadata, so they MUST
 * carry model-id literals.
 */
const MODEL_DATA_ALLOW = [
  'packages/core/src/llm/model-metadata.ts',
  'packages/core/src/llm/fallback-model.ts',
  'packages/core/src/llm/catalog-cache.ts',
  'packages/core/src/llm/catalog-model-resolver.ts',
  'packages/core/src/llm/registry.ts',
  'packages/core/src/llm/provider-registry/',
  'packages/core/src/llm/generated/',
  'packages/core/src/llm/model-runner.ts',
  'packages/core/src/llm/api-mode.ts',
  'packages/core/src/llm/transports/',
  // The model→price data table is a model-keyed SSoT (same category as metadata).
  'packages/core/src/llm/usage-pricing.ts',
  // role-resolver IS the resolution chokepoint; it owns the IMPLICIT_FALLBACK
  // model constant (which system-resolver then upgrades to the catalog default).
  'packages/core/src/llm/role-resolver.ts',
];

/** The resolver layer — exempt from the `direct-resolve-credentials` rule. */
const RESOLVER_LAYER_ALLOW = [
  'packages/core/src/llm/role-resolver.ts',
  'packages/core/src/llm/system-resolver.ts',
  'packages/core/src/llm/model-runner.ts',
  'packages/core/src/llm/credentials.ts',
  'packages/core/src/llm/credential-pool.ts',
  'packages/core/src/llm/auxiliary-fallback.ts',
];

/**
 * The TWO canonical files allowed to DEFINE a `resolveLLMFor*` resolver (the
 * `divergent-resolver-definition` rule). `role-resolver.ts` is the SSoT core
 * implementation; `system-resolver.ts` is the public E9 chokepoint that
 * delegates to it. Any OTHER `export …resolveLLMForX` is a divergent resolver
 * (T11751 · AC3) — refactor it to delegate to `resolveLLMForSystem`.
 */
const RESOLVER_DEFINITION_ALLOW = [
  'packages/core/src/llm/role-resolver.ts',
  'packages/core/src/llm/system-resolver.ts',
];

/**
 * Scan-scope for the value-smell rules (`hardcoded-model-literal`,
 * `direct-resolve-credentials`). The transport/client-construction rules (1-3)
 * scan ALL of `packages`; these two scan only LLM-adjacent code, where a model
 * literal or a raw `resolveCredentials` call is a genuine divergence smell
 * (keeps the baseline meaningful instead of flagging unrelated prose/data).
 */
const LLM_ADJACENT_SCOPE = [
  'packages/core/src/llm/',
  'packages/core/src/memory/',
  'packages/core/src/sentient/',
  'packages/adapters/src/',
];

/**
 * Scan-scope for the `hardcoded-model-literal` rule. Narrower than
 * {@link LLM_ADJACENT_SCOPE}: CLEO's OWN resolution / consumer code in core,
 * where a model-id literal is a genuine "model not from registry/role-config"
 * smell. The harness provider adapters (`packages/adapters/**`) are intentionally
 * EXCLUDED — they wrap external CLIs (claude-code, gemini-cli, …) and legitimately
 * carry that tool's own default-model id as integration config, not as a CLEO
 * resolution decision. Transport/client construction in adapters is still covered
 * by the `*-construction` / `*-factory` rules above.
 */
const MODEL_LITERAL_SCOPE = [
  'packages/core/src/llm/',
  'packages/core/src/memory/',
  'packages/core/src/sentient/',
];

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string[]} allow      Path prefixes exempt from this rule.
 * @property {string[]} [scope]    When set, ONLY scan files under these prefixes.
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: 'llm-transport-construction',
    pattern:
      /new\s+(?:Anthropic|ChatCompletions|Gemini|Ollama|Bedrock|CodexResponses|OpenAI)Transport\s*\(/,
    allow: CHOKEPOINT_ALLOW,
  },
  {
    id: 'ai-sdk-provider-factory',
    pattern:
      /\b(?:createAnthropic|createOpenAICompatible|createOpenAI|createGoogleGenerativeAI)\s*\(/,
    allow: CHOKEPOINT_ALLOW,
  },
  {
    id: 'raw-sdk-client',
    pattern: /new\s+(?:Anthropic|OpenAI)\s*\(/,
    allow: CHOKEPOINT_ALLOW,
  },
  {
    id: 'env-api-key-read',
    pattern: /process\.env(?:\.[A-Za-z_]*_API_KEY\b|\[\s*['"][A-Za-z_]*_API_KEY['"])/,
    allow: CREDENTIAL_LAYER_ALLOW,
  },
  {
    id: 'hardcoded-model-literal',
    pattern:
      /['"](?:claude-[\w.:-]+|gpt-[\w.:-]+|gemini-[\w.:-]+|o[1-4]-[\w.:-]+|deepseek-[\w.:-]+|grok-[\w.:-]+)['"]/,
    allow: MODEL_DATA_ALLOW,
    scope: MODEL_LITERAL_SCOPE,
  },
  {
    id: 'direct-resolve-credentials',
    pattern: /\bresolveCredentials\s*\(/,
    allow: RESOLVER_LAYER_ALLOW,
    scope: LLM_ADJACENT_SCOPE,
  },
  {
    // A NEW exported `resolveLLMFor*` resolver DEFINITION outside the two
    // canonical chokepoint files (T11751 · AC3) — `export [async] function
    // resolveLLMForX(` or `export const resolveLLMForX =`. Exactly ONE
    // resolution chokepoint: `resolveLLMForSystem` → `resolveLLMForRole`.
    id: 'divergent-resolver-definition',
    pattern:
      /export\s+(?:async\s+)?(?:function\s+resolveLLMFor\w+\s*\(|const\s+resolveLLMFor\w+\s*=)/,
    allow: RESOLVER_DEFINITION_ALLOW,
  },
];

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-llm-chokepoint-baseline.json';

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/** @param {string} relPath @param {string[]} prefixes */
function underAny(relPath, prefixes) {
  return prefixes.some((p) => relPath.startsWith(p));
}

/** @param {string} filePath */
function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Strip block + line comments from a source line so patterns never match inside
 * TSDoc/JSDoc prose (the whole template documents these patterns in comments).
 *
 * @param {string} line
 */
function stripComments(line) {
  if (/^\s*\*/.test(line)) return '';
  const s = line.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = s.indexOf('//');
  return idx !== -1 ? s.slice(0, idx) : s;
}

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, ruleId: string, snippet: string}>} */
const violations = [];

/** @param {string} absPath */
function scanFile(absPath) {
  const relPath = toPosixRel(absPath);
  if (isTestFile(relPath)) return;

  // Rules applicable to this file (respect per-rule scope + allowlist).
  const applicable = RULES.filter((r) => {
    if (r.scope && !underAny(relPath, r.scope)) return false;
    if (underAny(relPath, r.allow)) return false;
    return true;
  });
  if (applicable.length === 0) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.includes(ALLOW_INLINE)) continue;
    const code = stripComments(rawLine);
    if (!code.trim()) continue;

    for (const rule of applicable) {
      if (rule.pattern.test(code)) {
        violations.push({
          file: relPath,
          line: i + 1,
          ruleId: rule.id,
          snippet: rawLine.trim(),
        });
      }
    }
  }
}

/** @param {string} dir */
function walkDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full);
    }
  }
}

for (const dir of SCAN_DIRS) {
  walkDir(join(process.cwd(), dir));
}

// ============================================================================
// Count violations per rule
// ============================================================================

const RULE_IDS = RULES.map((r) => r.id);

/** @type {Record<string, number>} */
const currentCounts = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
for (const v of violations) {
  currentCounts[v.ruleId] = (currentCounts[v.ruleId] ?? 0) + 1;
}
const totalViolations = violations.length;

/** Render the violation list grouped, for error output. @param {Set<string>} [onlyRules] */
function printViolations(onlyRules) {
  for (const v of violations) {
    if (onlyRules && !onlyRules.has(v.ruleId)) continue;
    console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
}

const FIX_HINT =
  '\nFix:\n' +
  '  • Resolve the LLM via resolveLLMForSystem()/resolveLLMForRole() and build the\n' +
  '    transport/model via the single ModelRunner (packages/core/src/llm/model-runner.ts).\n' +
  '  • Never read process.env.*_API_KEY directly — credentials flow through CredentialPool.\n' +
  '  • Never hardcode a model literal — models come from the registry / role-config.\n' +
  '  • Per-line opt-out: append `// llm-resolve-allowed: <reason>` for a justified exception.\n';

// ============================================================================
// Strict mode — require zero violations
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-llm-chokepoint: STRICT OK — zero violations.');
    process.exit(0);
  }
  console.error(`lint-llm-chokepoint: STRICT FAIL — ${totalViolations} violation(s):\n`);
  printViolations();
  console.error(FIX_HINT);
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write new baseline and exit
// ============================================================================

const BASELINE_COMMENT =
  'Auto-generated by scripts/lint-llm-chokepoint.mjs. DO NOT edit manually. ' +
  'See T11783 / E9 T11745 / Saga T9831 SG-ARCH-SOLID for context.';

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment: BASELINE_COMMENT,
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-llm-chokepoint: baseline updated -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Baseline mode (default) — fail only on net-add
// ============================================================================

/** @type {{counts: Record<string, number>, total: number} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(`lint-llm-chokepoint: ERROR — could not parse baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }
} else {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment: BASELINE_COMMENT,
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-llm-chokepoint: baseline created -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded). ` +
      'Re-run to check against baseline.',
  );
  process.exit(0);
}

// Compare current counts to baseline — fail on net-add per rule.
/** @type {Array<{ruleId: string, baselineCount: number, currentCount: number, added: number}>} */
const regressions = [];
for (const ruleId of RULE_IDS) {
  const baselineCount = baseline.counts?.[ruleId] ?? 0;
  const currentCount = currentCounts[ruleId] ?? 0;
  if (currentCount > baselineCount) {
    regressions.push({ ruleId, baselineCount, currentCount, added: currentCount - baselineCount });
  }
}

if (regressions.length === 0) {
  const saved = (baseline.total ?? 0) - totalViolations;
  const savedMsg = saved > 0 ? ` (${saved} violation(s) resolved vs baseline — great work!)` : '';
  console.info(
    `lint-llm-chokepoint: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-llm-chokepoint.mjs --update-baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

console.error(`lint-llm-chokepoint: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`);
for (const r of regressions) {
  console.error(
    `  [${r.ruleId}] baseline: ${r.baselineCount} -> current: ${r.currentCount} (+${r.added} new violation(s))`,
  );
}
console.error('\nNew violations (in regressed rules):\n');
printViolations(new Set(regressions.map((r) => r.ruleId)));
console.error(FIX_HINT);
process.exit(1);
