#!/usr/bin/env node
/**
 * Gate 35 — model call sites are registered decision sites (T12663 · spec
 * `system-one-integration` §3.5 · D11158).
 *
 * ## Why
 *
 * The decision ladder (rule → System One → generative → agent → owner) only
 * works if CLEO knows every place that asks a model: its rung, its fallback,
 * its go-live evidence. The registry
 * (`packages/core/src/decide/sites/registry.ts`, T12662) records them. This
 * gate keeps it complete: a new `decide()` site or a new file that calls an
 * LLM entry point fails CI until it is registered, and a System One site
 * cannot run `on` without measured evidence.
 *
 * ## Rules (each counted per file against the baseline)
 *
 * 1. `unregistered-decide-site` — a `decide(` / `askSiteDecision(` call whose
 *    site id (first argument / `siteId:`) is not a registered id: not a string
 *    literal naming one, a `<REGISTRY_CONST>.id`, or a constant exported as one.
 * 2. `unregistered-model-site` — a call to an LLM entry point
 *    (`resolveLLMForSystem`, `resolveLLMForRole`, `executeForRole`,
 *    `getLlmExecutor`, `generateObject`, `generateText`, `streamText`,
 *    `streamObject`) in a file no registry row lists.
 * 3. `registry-file-missing` — a registry row lists a file that does not exist.
 * 4. `on-without-evidence` — a row with `defaultMode: 'on'` whose primary rung
 *    is `system-one` and that has no `goLive` (or whose `evidenceDoc` slug is
 *    absent from `.cleo/docs-publications.json`, when that file exists). The
 *    `cli.decide-ask` debug verb is exempt: nothing acts on its answer.
 * 5. `rung-mismatch` — a file registered only by rows with no `generative` or
 *    `agent` rung that calls an LLM entry point.
 * 6. `chokepoint-bypass` — a model reached around the chokepoint: a direct
 *    AI-SDK call (`generateObject(` …), a raw `.messages.create(`, an AI-SDK
 *    provider factory (`createAnthropic(` …) or a raw provider endpoint
 *    (`/v1/messages`, `/chat/completions`). The chokepoint itself
 *    (`model-runner.ts`, `transports/`, `role-resolver.ts`,
 *    `system-resolver.ts`, `api-mode.ts`) is exempt. The known bypasses (spec
 *    §3.3) are BASELINED, not allowed: they burn down, they never grow.
 *
 * The registry is parsed from source (no build needed), like the other gates.
 *
 * ## Modes
 *
 * Default and `--check`: fail when any (rule, file) count exceeds the
 * baseline, so a new offending file fails even if another was fixed.
 * `--strict`: fail on any violation. `--baseline` / `--update-baseline`:
 * write the current counts to `scripts/.lint-model-call-sites-baseline.json`.
 * `--json`: machine output.
 *
 * Per-line opt-out: `// model-site-allowed: <reason>` on the line of the call
 * or on the line directly above it.
 *
 * @task T12663
 * @epic T12486
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/** The rules, in report order. */
export const RULE_IDS = [
  'unregistered-decide-site',
  'unregistered-model-site',
  'registry-file-missing',
  'on-without-evidence',
  'rung-mismatch',
  'chokepoint-bypass',
];

/** Repo-relative registry path. */
export const REGISTRY_PATH = 'packages/core/src/decide/sites/registry.ts';

/** Repo-relative baseline path. */
export const BASELINE_PATH = 'scripts/.lint-model-call-sites-baseline.json';

/** Per-line opt-out marker. */
export const ALLOW_MARKER = '// model-site-allowed';

/** Sites exempt from `on-without-evidence`, with the reason. */
export const ON_WITHOUT_EVIDENCE_EXEMPT = new Map([
  ['cli.decide-ask', 'debug verb: the operator reads the answer, nothing acts on it'],
]);

/** The chokepoint: exempt from `unregistered-model-site` and `chokepoint-bypass`. */
export const CHOKEPOINT = [
  'packages/core/src/llm/model-runner.ts',
  'packages/core/src/llm/transports/',
  'packages/core/src/llm/role-resolver.ts',
  'packages/core/src/llm/system-resolver.ts',
  'packages/core/src/llm/api-mode.ts',
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  'fixtures',
  '__fixtures__',
  '.svelte-kit',
  'studio-dist',
]);
const EXTENSIONS = new Set(['.ts', '.mts', '.tsx', '.js', '.mjs']);
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts', '.d.ts'];

const ENTRY_POINTS =
  'resolveLLMForSystem|resolveLLMForRole|executeForRole|getLlmExecutor|generateObject|generateText|streamText|streamObject';
const ENTRY_CALL = new RegExp(`(?<![\\w.$])(${ENTRY_POINTS})\\s*\\(`, 'g');
const BYPASS_PATTERNS = [
  /(?<![\w.$])(generateObject|generateText|streamText|streamObject)\s*\(/g,
  /\.messages\.create\s*\(/g,
  /(?<![\w.$])create(Anthropic|OpenAI|OpenAICompatible|GoogleGenerativeAI)\s*\(/g,
  // A provider endpoint built into a URL (template literal); a quoted path
  // alone is data (e.g. generated provider profiles), not a request.
  /(\/v1\/messages|\/chat\/completions)`/g,
];

/**
 * Blank comments (keeping offsets and newlines) so patterns only see code.
 * String and template contents are kept.
 *
 * @param {string} src - Source text.
 * @returns {string} Same length, comments replaced by spaces.
 */
export function blankComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/**
 * Parse the registry source into rows.
 *
 * @param {string} src - `registry.ts` source.
 * @returns {{ constName: string | null, id: string, files: string[], primaryRung: string,
 *   ladder: string[], defaultMode: string, goLive: string | null }[]}
 */
export function parseRegistry(src) {
  const code = blankComments(src);
  const ids = [...code.matchAll(/^\s*id:\s*'([^']+)'/gm)];
  return ids.map((m, k) => {
    const start = m.index ?? 0;
    const end = ids[k + 1]?.index ?? code.length;
    const block = code.slice(start, end);
    const before = code.slice(0, start);
    const decl = /export const (\w+)\s*=\s*\{\s*$/.exec(before);
    const files = /files:\s*\[([\s\S]*?)\]/.exec(block);
    const ladder = /ladder:\s*\[([^\]]*)\]/.exec(block);
    const goLive = /goLive:\s*\{[\s\S]*?evidenceDoc:\s*'([^']*)'/.exec(block);
    return {
      constName: decl ? decl[1] : null,
      id: m[1],
      files: files ? [...files[1].matchAll(/'([^']+)'/g)].map((f) => f[1]) : [],
      primaryRung: /primaryRung:\s*'([^']+)'/.exec(block)?.[1] ?? '',
      ladder: ladder ? [...ladder[1].matchAll(/'([^']+)'/g)].map((r) => r[1]) : [],
      defaultMode: /defaultMode:\s*'([^']+)'/.exec(block)?.[1] ?? '',
      goLive: goLive ? goLive[1] : null,
    };
  });
}

/** 1-based line of `index` in `text`. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Whether the call at `index` is a declaration (`function name(`), not a call. */
function isDeclaration(code, index) {
  return /(function\s*\*?\s*|async\s+)$/.test(code.slice(Math.max(0, index - 20), index));
}

/**
 * Whether the call at `index` is opted out: the marker sits on its line or on
 * the line directly above (a formatter may move a trailing comment there).
 */
function optedOut(lines, text, index) {
  const line = lineOf(text, index);
  return [lines[line - 1], lines[line - 2]].some((l) => (l ?? '').includes(ALLOW_MARKER));
}

/**
 * Whether a site-id argument names a registered site.
 *
 * @param {string} arg - The argument expression, trimmed.
 * @param {{ ids: Set<string>, constNames: Set<string>, aliases: Set<string> }} known
 * @returns {boolean}
 */
export function isRegisteredSiteArg(arg, known) {
  const literal = /^['"`]([^'"`]+)['"`]$/.exec(arg);
  if (literal) return known.ids.has(literal[1]);
  const member = /^(\w+)\.id$/.exec(arg);
  if (member) return known.constNames.has(member[1]);
  return known.aliases.has(arg);
}

/**
 * Scan one file's source.
 *
 * @param {string} rel - Repo-relative path.
 * @param {string} src - Source text.
 * @param {{ known: { ids: Set<string>, constNames: Set<string>, aliases: Set<string> },
 *   filesToRows: Map<string, { primaryRung: string, ladder: string[] }[]> }} ctx
 * @returns {{ rule: string, file: string, line: number, detail: string }[]}
 */
export function scanSource(rel, src, ctx) {
  const out = [];
  const code = blankComments(src);
  const lines = src.split('\n');
  const push = (rule, index, detail) => {
    if (optedOut(lines, src, index)) return;
    out.push({ rule, file: rel, line: lineOf(src, index), detail });
  };
  const inChokepoint = CHOKEPOINT.some((p) => rel === p || rel.startsWith(p));

  // Rule 1: decide( and askSiteDecision( name a registered site.
  for (const m of code.matchAll(/(?<![\w.$])decide\s*\(\s*([^,)]+)/g)) {
    if (isDeclaration(code, m.index ?? 0)) continue;
    const arg = m[1].trim();
    // A signature (`decide(req: DecisionRequest …)`) declares, it does not call.
    if (/^\w+\??\s*:/.test(arg)) continue;
    if (!isRegisteredSiteArg(arg, ctx.known)) {
      push('unregistered-decide-site', m.index ?? 0, `decide(${arg}, …)`);
    }
  }
  for (const m of code.matchAll(/(?<![\w.$])askSiteDecision\s*\(/g)) {
    if (isDeclaration(code, m.index ?? 0)) continue;
    const tail = code.slice(m.index ?? 0, (m.index ?? 0) + 3000);
    const site = /siteId:\s*([^,\n}]+)/.exec(tail);
    const arg = site ? site[1].trim() : '(no siteId)';
    if (!site || !isRegisteredSiteArg(arg, ctx.known)) {
      push('unregistered-decide-site', m.index ?? 0, `askSiteDecision({ siteId: ${arg} })`);
    }
  }

  // Rules 2 and 5: LLM entry points live in registered files of the right rung.
  if (!inChokepoint) {
    const rows = ctx.filesToRows.get(rel);
    for (const m of code.matchAll(ENTRY_CALL)) {
      if (isDeclaration(code, m.index ?? 0)) continue;
      if (!rows) {
        push('unregistered-model-site', m.index ?? 0, `${m[1]}(…) in a file no site lists`);
      } else if (
        !rows.some((r) =>
          [r.primaryRung, ...r.ladder].some((g) => g === 'generative' || g === 'agent'),
        )
      ) {
        push(
          'rung-mismatch',
          m.index ?? 0,
          `${m[1]}(…) in a file registered without a generative/agent rung`,
        );
      }
    }
    // Rule 6: reaching a model around the chokepoint.
    for (const pattern of BYPASS_PATTERNS) {
      for (const m of code.matchAll(pattern)) {
        if (isDeclaration(code, m.index ?? 0)) continue;
        push('chokepoint-bypass', m.index ?? 0, m[0].trim());
      }
    }
  }
  return out;
}

/** Every scannable source file under `packages/*`, repo-relative, posix. */
function listSources(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (
        st.isFile() &&
        EXTENSIONS.has(extname(name)) &&
        !TEST_SUFFIXES.some((s) => name.endsWith(s))
      ) {
        files.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(join(root, 'packages'));
  return files.sort();
}

/**
 * Run every rule over the repository.
 *
 * @param {string} root - Repository root.
 * @returns {{ violations: { rule: string, file: string, line: number, detail: string }[],
 *   counts: Record<string, Record<string, number>> }}
 */
export function scanRepository(root) {
  const registrySrc = readFileSync(join(root, REGISTRY_PATH), 'utf-8');
  const rows = parseRegistry(registrySrc);
  const violations = [];

  // Rules 3 and 4 come from the registry itself.
  const regLines = registrySrc.split('\n');
  const idLine = (id) => regLines.findIndex((l) => l.includes(`id: '${id}'`)) + 1;
  const pubPath = join(root, '.cleo/docs-publications.json');
  const published = existsSync(pubPath) ? readFileSync(pubPath, 'utf-8') : null;
  for (const row of rows) {
    for (const f of row.files) {
      if (!existsSync(join(root, f))) {
        violations.push({
          rule: 'registry-file-missing',
          file: REGISTRY_PATH,
          line: idLine(row.id),
          detail: `${row.id}: ${f}`,
        });
      }
    }
    if (
      row.defaultMode === 'on' &&
      row.primaryRung === 'system-one' &&
      !ON_WITHOUT_EVIDENCE_EXEMPT.has(row.id)
    ) {
      const missing =
        row.goLive === null ||
        row.goLive === '' ||
        (published !== null && !published.includes(`"${row.goLive}"`));
      if (missing) {
        violations.push({
          rule: 'on-without-evidence',
          file: REGISTRY_PATH,
          line: idLine(row.id),
          detail: row.id,
        });
      }
    }
  }

  const sources = listSources(root);
  const texts = new Map(sources.map((f) => [f, readFileSync(join(root, f), 'utf-8')]));
  const constNames = new Set(rows.map((r) => r.constName).filter(Boolean));
  const aliases = new Set();
  for (const text of texts.values()) {
    for (const m of text.matchAll(/export const (\w+)\s*=\s*(\w+)\.id\s*;/g)) {
      if (constNames.has(m[2])) aliases.add(m[1]);
    }
  }
  const known = { ids: new Set(rows.map((r) => r.id)), constNames, aliases };
  const filesToRows = new Map();
  for (const row of rows) {
    for (const f of row.files) filesToRows.set(f, [...(filesToRows.get(f) ?? []), row]);
  }
  for (const [rel, text] of texts)
    violations.push(...scanSource(rel, text, { known, filesToRows }));

  const counts = Object.fromEntries(RULE_IDS.map((r) => [r, {}]));
  for (const v of violations) counts[v.rule][v.file] = (counts[v.rule][v.file] ?? 0) + 1;
  return { violations, counts };
}

/**
 * (rule, file) pairs whose count exceeds the baseline.
 *
 * @param {Record<string, Record<string, number>>} counts - Current counts.
 * @param {Record<string, Record<string, number>>} baseline - Baseline counts.
 * @returns {{ rule: string, file: string, baseline: number, current: number }[]}
 */
export function regressions(counts, baseline) {
  const out = [];
  for (const rule of RULE_IDS) {
    for (const [file, current] of Object.entries(counts[rule] ?? {})) {
      const base = baseline[rule]?.[file] ?? 0;
      if (current > base) out.push({ rule, file, baseline: base, current });
    }
  }
  return out;
}

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {string[]} argv - CLI flags.
 * @returns {number} Exit code.
 */
export function runGate(root, argv = []) {
  const { violations, counts } = scanRepository(root);
  const json = argv.includes('--json');
  const baselinePath = join(root, BASELINE_PATH);

  if (argv.includes('--baseline') || argv.includes('--update-baseline')) {
    const doc = {
      _comment:
        'Generated by scripts/lint-model-call-sites.mjs --baseline (T12663). Per rule, per file: counts may fall, never rise.',
      counts,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(
      `lint-model-call-sites: baseline written (${violations.length} violation(s)).\n`,
    );
    return 0;
  }

  const report = (list) => {
    for (const v of list) process.stderr.write(`  ✗ [${v.rule}] ${v.file}:${v.line} ${v.detail}\n`);
  };
  const FIX =
    'Register the site in packages/core/src/decide/sites/registry.ts (id, files, rung, ladder, fallback, mode), ' +
    'route the model call through resolveLLMForSystem/ModelRunner, or append `// model-site-allowed: <reason>`.\n';

  if (argv.includes('--strict')) {
    if (json) process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`);
    if (violations.length === 0) {
      if (!json) process.stdout.write('lint-model-call-sites: STRICT OK — zero violations.\n');
      return 0;
    }
    process.stderr.write(
      `lint-model-call-sites: STRICT FAIL — ${violations.length} violation(s):\n`,
    );
    report(violations);
    process.stderr.write(FIX);
    return 1;
  }

  if (!existsSync(baselinePath)) {
    process.stderr.write(
      `lint-model-call-sites: no baseline at ${BASELINE_PATH}; run with --baseline and commit it.\n`,
    );
    return 1;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')).counts ?? {};
  const regressed = regressions(counts, baseline);
  if (json)
    process.stdout.write(`${JSON.stringify({ violations, regressions: regressed }, null, 2)}\n`);
  if (regressed.length === 0) {
    if (!json) {
      process.stdout.write(
        `lint-model-call-sites: OK — ${violations.length} baselined violation(s), none new (T12663).\n`,
      );
    }
    return 0;
  }
  process.stderr.write(
    `lint-model-call-sites: FAIL — ${regressed.length} (rule, file) count(s) rose above the baseline:\n`,
  );
  for (const r of regressed) {
    process.stderr.write(`  [${r.rule}] ${r.file}: ${r.baseline} → ${r.current}\n`);
    report(violations.filter((v) => v.rule === r.rule && v.file === r.file));
  }
  process.stderr.write(FIX);
  return 1;
}

if (isMain(import.meta.url)) {
  process.exit(runGate(process.cwd(), process.argv.slice(2)));
}
