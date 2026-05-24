#!/usr/bin/env node
/**
 * Lint rule: validate the central invariants registry self-consistency in
 * BOTH directions — AC1/AC2/AC3 of T10338 / Saga T10326
 * SG-SUBSTRATE-RECONCILIATION Wave 3 R4.
 *
 * Why this matters
 * ----------------
 * Saga T10326 (post-Wave 2) consolidated every numbered invariant the system
 * relies on into a single SSoT at `packages/contracts/src/invariants/`. The
 * registry serves four downstream consumers:
 *
 *   - R5 (T10339, SHIPPED) — `packages/core/src/release/invariants/registry.ts`
 *     now consumes the central substrate (ADR-056 D5).
 *   - R6 (T10340)          — `cleo doctor --audit-invariants` will walk every
 *     entry to surface enforcement gaps to the operator.
 *   - R8 (T10342)          — auto-renders the canonical invariant docs page
 *     from registry metadata.
 *   - R4 (this gate)       — CI regression gate that keeps the registry
 *     truthful so the three downstream consumers can trust it.
 *
 * Two checks run on every invocation:
 *
 *   FORWARD CHECK — for every entry in `INVARIANTS_REGISTRY`:
 *     (a) `runtimeGate.module` (when non-null) points at a file that exists.
 *     (b) `runtimeGate.functionName` (when non-null) is exported by that file
 *         (matched via `export function NAME` OR `export const NAME = ...` OR
 *         `export class NAME ...` patterns — same shape the script uses to
 *         introspect TS sources without depending on a built artifact).
 *     (c) `lintRule.lintScript` (when present) points at a file that exists.
 *     (d) `doctorAudit.lintScript` (when present) points at a file that exists.
 *     (e) Every `tests[]` entry resolves to an existing file OR an existing
 *         directory (test-helper directories are legitimate refs — see
 *         `packages/core/src/orchestration/__tests__/` in ORC-005).
 *
 *   REVERSE CHECK — for each canonical ADR source file, grep its declaration
 *   syntax for numbered codes and assert each `(adr, code)` pair appears in
 *   the registry:
 *     - ADR-073 declares I1-I8 via inline `**I# — Name.**`.
 *     - ADR-070 declares ORC-001..ORC-014 via a markdown table row
 *       `| ORC-###  | Name | severity | enforcement |`.
 *     - ADR-056 declares D1-D6 via H3 headings `### D# — Name`.
 *
 *   The reverse check accepts the explicit `{ runtime: 'docs-only' }` marker
 *   form (see DOCS_ONLY_OVERRIDES below) for legitimate display-only
 *   invariants that intentionally have no registry entry yet. This is a
 *   forward-compatibility hook — any genuinely "registered" code must round-
 *   trip; any "intentionally absent" code must be explicitly noted.
 *
 * Why parse TS source instead of importing from dist?
 * ---------------------------------------------------
 * Sibling lint scripts (`lint-paths-ssot.mjs`, `lint-saga-label-anti-pattern.mjs`,
 * `lint-contracts-dep.mjs`) are pure static analyzers — they read .ts source
 * and parse it. The registry entries are structured TS literals with a
 * predictable shape, so a state-machine parser is both cheap and keeps the
 * CI gate independent of the build step. (Bonus: catches "registry drift"
 * even before TS compiles.)
 *
 * Baseline mode (default)
 * -----------------------
 * On first run the script writes `scripts/.lint-invariant-registry-baseline.json`
 * with the current violation counts per rule. Subsequent runs FAIL if the
 * count for any rule INCREASES (net-add). Count decreases are always
 * accepted — they mean progress.
 *
 * Flags
 * -----
 *  - `--strict`           — fail on ANY violation (zero-tolerance gate).
 *  - `--baseline`         — alias for `--update-baseline`; overwrite the
 *                           baseline JSON with the current counts.
 *  - `--update-baseline`  — same as `--baseline`.
 *  - `--json`             — emit a machine-readable summary on stdout for
 *                           downstream consumers (R6 doctor audit, T10340).
 *
 * Opt-out
 * -------
 * The registry's own `runtimeGate: null` markers ARE the opt-out for entries
 * that legitimately lack a runtime guard. There is no per-line bypass — the
 * registry's typed structure is the surface that gets validated.
 *
 * Reverse-check escape hatch: add the `(adr, code)` pair to
 * `DOCS_ONLY_OVERRIDES` below to declare it as a display-only invariant that
 * intentionally does not require a registry entry.
 *
 * @task T10338 — R4: CI gate validates registry coverage + ADR-code symmetry
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @see packages/contracts/src/invariants/index.ts        — registry SSoT
 * @see packages/contracts/src/invariants/adr-073-saga.ts — I1-I8 module
 * @see packages/contracts/src/invariants/adr-070-orchestration.ts — ORC-001..ORC-014
 * @see packages/contracts/src/invariants/adr-056-release.ts — D1-D6 module
 * @see scripts/lint-paths-ssot.mjs               — structural template (forward checks)
 * @see scripts/lint-saga-label-anti-pattern.mjs  — structural template (baseline mode)
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Per-ADR registry source files. Each file exports a
 * `readonly RegisteredInvariant[]` literal that the parser below decodes.
 */
const REGISTRY_SOURCES = [
  'packages/contracts/src/invariants/adr-073-saga.ts',
  'packages/contracts/src/invariants/adr-070-orchestration.ts',
  'packages/contracts/src/invariants/adr-056-release.ts',
];

/**
 * Per-ADR markdown sources + the regex that matches their canonical
 * invariant-declaration syntax. The captured group MUST yield the bare code
 * (e.g. `I3`, `ORC-001`, `D5`).
 *
 * Note on precision: the patterns deliberately anchor on visible
 * declaration syntax (bold inline, H3 heading, table row) so prose
 * mentions of codes elsewhere in the document are ignored. False
 * negatives (missing a declaration) are acceptable here because the
 * forward check already validates registry-side completeness; false
 * positives (matching a prose mention) would fire confusing errors.
 */
const ADR_DECLARATION_PATTERNS = [
  {
    adr: 'ADR-073',
    file: '.cleo/adrs/ADR-073-above-epic-naming.md',
    // `**I3 — Tier promotion ...`
    pattern: /^\*\*(I[0-9]+)\s*[—-]/gm,
  },
  {
    adr: 'ADR-070',
    file: '.cleo/adrs/ADR-070-three-tier-orchestration.md',
    // `| ORC-001  | Orchestrator ...`
    pattern: /^\|\s*(ORC-[0-9]+)\s*\|/gm,
  },
  {
    adr: 'ADR-056',
    file: '.cleo/adrs/ADR-056-db-ssot-and-release-completion-invariant.md',
    // `### D1 — Database topology ...`
    pattern: /^###\s+(D[0-9]+)\s*[—-]/gm,
  },
];

/**
 * Reverse-check escape hatch for display-only invariants that intentionally
 * do not require a registry entry. Add `(adr, code)` pairs here when the
 * registry's coverage is deliberately incomplete (for example, when a code
 * is reserved for documentation cross-reference but has no enforcement
 * surface).
 *
 * Empty by default — at the time of writing every ADR-declared code IS
 * registered (28 entries: I1-I8 + ORC-001..ORC-014 + D1-D6). Future
 * docs-only invariants should land here with a `// reason:` comment.
 */
const DOCS_ONLY_OVERRIDES = new Set([
  // example: 'ADR-073.I9', // reason: reserved for future hierarchy axis
]);

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-invariant-registry-baseline.json';

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join('/');
}

/**
 * Check whether a given repo-relative path exists as either a file or
 * directory. Used for `tests[]` entries that may legitimately reference a
 * directory of test files (see ORC-005's `packages/core/src/orchestration/__tests__/`).
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function pathExists(relPath) {
  if (!existsSync(relPath)) return false;
  try {
    statSync(relPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Match an exported binding inside a TS source file. Accepts the three
 * `export {function|const|class}` forms used across the codebase — this
 * mirrors the visible API surface that downstream callers can reach.
 *
 * @param {string} source — TS source text
 * @param {string} name — exported identifier to find
 * @returns {boolean}
 */
function hasExportedBinding(source, name) {
  // Escape any regex metachars in `name` (defensive — identifiers don't
  // contain metachars but keeps the parser robust).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:function|const|let|class|type|interface)\\s+${escaped}\\b`,
  );
  return re.test(source);
}

// ============================================================================
// Registry parser
// ============================================================================

/**
 * @typedef {Object} RegistryEntry
 * @property {string} adr
 * @property {string} code
 * @property {string} severity
 * @property {{module: string, functionName: string} | null} runtimeGate
 * @property {{lintScript: string} | null | undefined} lintRule
 * @property {{lintScript: string} | null | undefined} doctorAudit
 * @property {string[]} tests
 * @property {string} sourceFile  — registry file the entry was parsed from
 * @property {number} startLine   — 1-based line where the entry begins
 */

/**
 * Parse a `RegisteredInvariant` literal from a TS source file. The parser
 * is intentionally line-oriented and field-targeted — it does NOT attempt
 * to be a general TS parser. Every entry in the source files follows the
 * stable shape demonstrated by the T10335/T10336/T10339 modules:
 *
 *   {
 *     adr: 'ADR-073',
 *     code: 'I3',
 *     name: '...',
 *     description: '...',
 *     severity: 'error',
 *     runtimeGate: {
 *       module: SAGA_ENFORCEMENT_MODULE,
 *       functionName: 'assertSagaInvariantI3',
 *     },
 *     lintRule: null,
 *     doctorAudit: null,
 *     tests: [SAGA_ENFORCEMENT_TESTS],
 *   },
 *
 * Constants like `SAGA_ENFORCEMENT_MODULE` are resolved against the file's
 * top-level `const NAME = 'value';` declarations.
 *
 * @param {string} file
 * @returns {RegistryEntry[]}
 */
function parseRegistryFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // Build a const-lookup table from `const NAME = 'value';` declarations at
  // file scope. This is how the source files share module paths across
  // multiple entries (see SAGA_ENFORCEMENT_MODULE in adr-073-saga.ts).
  /** @type {Record<string, string>} */
  const consts = {};
  const constDecl = /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['"])(.+?)\2\s*;\s*$/;
  for (const line of lines) {
    const m = constDecl.exec(line);
    if (m) consts[m[1]] = m[3];
  }

  /** @param {string} raw */
  const resolveValue = (raw) => {
    const trimmed = raw.trim().replace(/,$/, '').trim();
    // Quoted string literal
    const qm = /^(['"`])(.*)\1$/.exec(trimmed);
    if (qm) return qm[2];
    // Const reference
    if (consts[trimmed] !== undefined) return consts[trimmed];
    // Literal null / undefined
    if (trimmed === 'null' || trimmed === 'undefined') return null;
    return trimmed; // fall back — caller can detect unresolved
  };

  /** @type {RegistryEntry[]} */
  const entries = [];
  /** @type {Partial<RegistryEntry> & {tests?: string[]} | null} */
  let current = null;
  let inRuntimeGate = false;
  let inLintRule = false;
  let inDoctorAudit = false;
  let inTests = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Entry start — first `adr: '...',` line we see kicks off a new entry.
    const adrMatch = /^adr:\s*(['"])([^'"]+)\1\s*,?\s*$/.exec(trimmed);
    if (adrMatch) {
      current = { adr: adrMatch[2], tests: [], sourceFile: toPosixRel(file), startLine: i + 1 };
      inRuntimeGate = inLintRule = inDoctorAudit = inTests = false;
      continue;
    }

    if (!current) continue;

    // `code: 'X',`
    const codeMatch = /^code:\s*(['"])([^'"]+)\1\s*,?\s*$/.exec(trimmed);
    if (codeMatch) {
      current.code = codeMatch[2];
      continue;
    }

    // `severity: 'error',`
    const sevMatch = /^severity:\s*(['"])([^'"]+)\1\s*,?\s*$/.exec(trimmed);
    if (sevMatch) {
      current.severity = sevMatch[2];
      continue;
    }

    // `runtimeGate: null,`
    if (/^runtimeGate:\s*null\s*,?\s*$/.test(trimmed)) {
      current.runtimeGate = null;
      continue;
    }
    // `runtimeGate: {`
    if (/^runtimeGate:\s*\{\s*$/.test(trimmed)) {
      inRuntimeGate = true;
      current.runtimeGate = { module: '', functionName: '' };
      continue;
    }
    if (inRuntimeGate) {
      const mod = /^module:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (mod) {
        const resolved = resolveValue(mod[1]);
        if (typeof resolved === 'string' && current.runtimeGate) {
          current.runtimeGate.module = resolved;
        }
        continue;
      }
      const fn = /^functionName:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (fn) {
        const resolved = resolveValue(fn[1]);
        if (typeof resolved === 'string' && current.runtimeGate) {
          current.runtimeGate.functionName = resolved;
        }
        continue;
      }
      if (/^},?\s*$/.test(trimmed)) {
        inRuntimeGate = false;
        continue;
      }
    }

    // `lintRule: null,` or `lintRule: {`
    if (/^lintRule:\s*null\s*,?\s*$/.test(trimmed)) {
      current.lintRule = null;
      continue;
    }
    if (/^lintRule:\s*\{\s*$/.test(trimmed)) {
      inLintRule = true;
      current.lintRule = { lintScript: '' };
      continue;
    }
    if (inLintRule) {
      const ls = /^lintScript:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (ls) {
        const resolved = resolveValue(ls[1]);
        if (typeof resolved === 'string' && current.lintRule) {
          current.lintRule.lintScript = resolved;
        }
        continue;
      }
      if (/^},?\s*$/.test(trimmed)) {
        inLintRule = false;
        continue;
      }
    }

    // `doctorAudit: null,` or `doctorAudit: { ... }`
    if (/^doctorAudit:\s*null\s*,?\s*$/.test(trimmed)) {
      current.doctorAudit = null;
      continue;
    }
    if (/^doctorAudit:\s*\{\s*$/.test(trimmed)) {
      inDoctorAudit = true;
      current.doctorAudit = { lintScript: '' };
      continue;
    }
    if (inDoctorAudit) {
      const ls = /^lintScript:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (ls) {
        const resolved = resolveValue(ls[1]);
        if (typeof resolved === 'string' && current.doctorAudit) {
          current.doctorAudit.lintScript = resolved;
        }
        continue;
      }
      if (/^},?\s*$/.test(trimmed)) {
        inDoctorAudit = false;
        continue;
      }
    }

    // `tests: [],` (single line, empty)
    if (/^tests:\s*\[\s*\]\s*,?\s*$/.test(trimmed)) {
      current.tests = [];
      continue;
    }
    // `tests: [SOME_REF],` (single line with one entry)
    const testsInline = /^tests:\s*\[\s*(.+?)\s*\]\s*,?\s*$/.exec(trimmed);
    if (testsInline) {
      const inner = testsInline[1];
      // Could be one or more comma-separated refs.
      /** @type {string[]} */
      const list = [];
      for (const piece of inner.split(',')) {
        const t = piece.trim();
        if (!t) continue;
        const resolved = resolveValue(t);
        if (typeof resolved === 'string') list.push(resolved);
      }
      current.tests = list;
      continue;
    }
    // `tests: [`
    if (/^tests:\s*\[\s*$/.test(trimmed)) {
      inTests = true;
      current.tests = [];
      continue;
    }
    if (inTests) {
      if (/^\]\s*,?\s*$/.test(trimmed)) {
        inTests = false;
        continue;
      }
      // One ref per line.
      const piece = trimmed.replace(/,$/, '').trim();
      if (piece) {
        const resolved = resolveValue(piece);
        if (typeof resolved === 'string') current.tests?.push(resolved);
      }
      continue;
    }

    // Entry close — `},` at toplevel inside the array. We commit the entry
    // when we see the closing brace AND we've collected `code`.
    if (/^},?\s*$/.test(trimmed) && current.code) {
      entries.push(
        /** @type {RegistryEntry} */ ({
          adr: current.adr ?? '',
          code: current.code,
          severity: current.severity ?? 'info',
          runtimeGate: current.runtimeGate ?? null,
          lintRule: current.lintRule ?? null,
          doctorAudit: current.doctorAudit ?? null,
          tests: current.tests ?? [],
          sourceFile: current.sourceFile ?? '',
          startLine: current.startLine ?? 0,
        }),
      );
      current = null;
    }
  }

  return entries;
}

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline') || args.includes('--baseline');
const EMIT_JSON = args.includes('--json');

// ============================================================================
// Parse the registry
// ============================================================================

/** @type {RegistryEntry[]} */
const allEntries = [];
for (const src of REGISTRY_SOURCES) {
  if (!existsSync(src)) {
    console.error(`lint-invariant-registry: ERROR — registry source missing: ${src}`);
    process.exit(1);
  }
  allEntries.push(...parseRegistryFile(src));
}

// Build a fast lookup keyed by `${adr}.${code}` (mirrors the runtime
// registry shape from packages/contracts/src/invariants/index.ts).
/** @type {Map<string, RegistryEntry>} */
const registryByKey = new Map();
for (const e of allEntries) {
  const key = `${e.adr}.${e.code}`;
  if (registryByKey.has(key)) {
    console.error(
      `lint-invariant-registry: ERROR — duplicate registry key parsed: ${key} (in ${e.sourceFile}:${e.startLine})`,
    );
    process.exit(1);
  }
  registryByKey.set(key, e);
}

// ============================================================================
// Forward check — every registry entry's referenced paths exist
// ============================================================================

/** @type {Array<{ruleId: string, key: string, file: string, line: number, message: string}>} */
const violations = [];

/**
 * Forward-check rule IDs — these mirror the per-rule counts emitted into
 * the baseline JSON, so adding a new rule below means adding the rule ID
 * to the baseline shape via `--update-baseline`.
 */
const FORWARD_RULES = {
  RUNTIME_MODULE_MISSING: 'forward-runtime-module-missing',
  RUNTIME_FUNCTION_MISSING: 'forward-runtime-function-missing',
  LINT_SCRIPT_MISSING: 'forward-lint-script-missing',
  DOCTOR_AUDIT_MISSING: 'forward-doctor-audit-missing',
  TEST_PATH_MISSING: 'forward-test-path-missing',
};

const REVERSE_RULES = {
  ADR_CODE_NOT_REGISTERED: 'reverse-adr-code-not-registered',
};

const ALL_RULE_IDS = [...Object.values(FORWARD_RULES), ...Object.values(REVERSE_RULES)];

for (const entry of allEntries) {
  const key = `${entry.adr}.${entry.code}`;

  // (a) + (b) — runtimeGate validity
  if (entry.runtimeGate !== null) {
    const { module: mod, functionName } = entry.runtimeGate;
    if (!mod) {
      violations.push({
        ruleId: FORWARD_RULES.RUNTIME_MODULE_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `runtimeGate.module unresolved for ${key} (likely missing top-level const)`,
      });
    } else if (!pathExists(mod)) {
      violations.push({
        ruleId: FORWARD_RULES.RUNTIME_MODULE_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `runtimeGate.module path does not exist on disk: ${mod}`,
      });
    } else if (!functionName) {
      violations.push({
        ruleId: FORWARD_RULES.RUNTIME_FUNCTION_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `runtimeGate.functionName unresolved for ${key}`,
      });
    } else {
      // Confirm the function is exported from the target module.
      const modSrc = readFileSync(mod, 'utf8');
      if (!hasExportedBinding(modSrc, functionName)) {
        violations.push({
          ruleId: FORWARD_RULES.RUNTIME_FUNCTION_MISSING,
          key,
          file: entry.sourceFile,
          line: entry.startLine,
          message: `runtimeGate.functionName '${functionName}' is not exported by ${mod}`,
        });
      }
    }
  }

  // (c) — lintRule.lintScript existence
  if (entry.lintRule?.lintScript) {
    if (!pathExists(entry.lintRule.lintScript)) {
      violations.push({
        ruleId: FORWARD_RULES.LINT_SCRIPT_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `lintRule.lintScript path does not exist: ${entry.lintRule.lintScript}`,
      });
    }
  }

  // (d) — doctorAudit.lintScript existence
  if (entry.doctorAudit?.lintScript) {
    if (!pathExists(entry.doctorAudit.lintScript)) {
      violations.push({
        ruleId: FORWARD_RULES.DOCTOR_AUDIT_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `doctorAudit.lintScript path does not exist: ${entry.doctorAudit.lintScript}`,
      });
    }
  }

  // (e) — every test path exists
  for (const t of entry.tests) {
    if (!pathExists(t)) {
      violations.push({
        ruleId: FORWARD_RULES.TEST_PATH_MISSING,
        key,
        file: entry.sourceFile,
        line: entry.startLine,
        message: `tests entry does not exist: ${t}`,
      });
    }
  }
}

// ============================================================================
// Reverse check — every ADR-declared code is in the registry
// ============================================================================

for (const { adr, file, pattern } of ADR_DECLARATION_PATTERNS) {
  if (!existsSync(file)) {
    // Don't fail just because an ADR file is missing — record it so the
    // operator notices but treat it as a separate concern.
    console.error(`lint-invariant-registry: WARN — ADR source missing: ${file}`);
    continue;
  }
  const md = readFileSync(file, 'utf8');
  /** @type {Set<string>} */
  const declaredCodes = new Set();
  // String.matchAll() avoids the `while ((m = exec()))` assign-in-expression
  // anti-pattern flagged by biome — and produces an iterator we can consume
  // directly. The `/g` flag is required (enforced by matchAll itself).
  for (const match of md.matchAll(pattern)) {
    declaredCodes.add(match[1]);
  }

  for (const code of declaredCodes) {
    const key = `${adr}.${code}`;
    if (registryByKey.has(key)) continue;
    if (DOCS_ONLY_OVERRIDES.has(key)) continue;
    violations.push({
      ruleId: REVERSE_RULES.ADR_CODE_NOT_REGISTERED,
      key,
      file: toPosixRel(file),
      line: 0,
      message:
        `${adr} declares ${code} but it is not registered in packages/contracts/src/invariants/. ` +
        `Add an entry to the matching adr-*.ts module OR list ${key} in DOCS_ONLY_OVERRIDES with a reason.`,
    });
  }
}

// ============================================================================
// Build per-rule counts
// ============================================================================

/** @type {Record<string, number>} */
const currentCounts = {};
for (const ruleId of ALL_RULE_IDS) currentCounts[ruleId] = 0;
for (const v of violations) currentCounts[v.ruleId] = (currentCounts[v.ruleId] ?? 0) + 1;

const totalViolations = violations.length;
const totalEntries = allEntries.length;
const totalReverseDeclarations = ADR_DECLARATION_PATTERNS.reduce((acc, p) => {
  if (!existsSync(p.file)) return acc;
  const md = readFileSync(p.file, 'utf8');
  /** @type {Set<string>} */
  const codes = new Set();
  for (const match of md.matchAll(p.pattern)) {
    codes.add(match[1]);
  }
  return acc + codes.size;
}, 0);

// ============================================================================
// JSON mode — emit a machine-readable summary for R6 doctor audit
// ============================================================================

if (EMIT_JSON) {
  const summary = {
    tool: 'lint-invariant-registry',
    task: 'T10338',
    saga: 'T10326',
    epic: 'T10327',
    registryEntries: totalEntries,
    reverseDeclarations: totalReverseDeclarations,
    totalViolations,
    counts: currentCounts,
    violations,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(totalViolations === 0 ? 0 : 1);
}

// ============================================================================
// Strict mode
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info(
      `lint-invariant-registry: STRICT OK (${totalEntries} registry entries, ${totalReverseDeclarations} ADR-declared codes, 0 violations)`,
    );
    process.exit(0);
  }
  console.error(`lint-invariant-registry: STRICT FAIL — ${totalViolations} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.key} (${v.file}:${v.line})`);
    console.error(`    -> ${v.message}`);
  }
  process.exit(1);
}

// ============================================================================
// Baseline mode
// ============================================================================

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-invariant-registry.mjs --baseline. ' +
          'DO NOT edit manually. See T10338 / Saga T10326 R4 for context.',
        registryEntries: totalEntries,
        reverseDeclarations: totalReverseDeclarations,
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-invariant-registry: baseline updated -> ${BASELINE_PATH} (${totalViolations} violations recorded; ${totalEntries} entries, ${totalReverseDeclarations} reverse decls)`,
  );
  process.exit(0);
}

// ============================================================================
// Default mode — compare against baseline, fail on net-add
// ============================================================================

/** @type {{counts: Record<string, number>, total: number} | null} */
let baseline = null;
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(`lint-invariant-registry: ERROR — could not parse baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }
} else {
  // No baseline yet — write it and succeed on first run.
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-invariant-registry.mjs. ' +
          'DO NOT edit manually. See T10338 / Saga T10326 R4 for context.',
        registryEntries: totalEntries,
        reverseDeclarations: totalReverseDeclarations,
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-invariant-registry: baseline created -> ${BASELINE_PATH} (${totalViolations} violations recorded). Re-run to check against baseline.`,
  );
  process.exit(0);
}

/** @type {Array<{ruleId: string, baselineCount: number, currentCount: number, added: number}>} */
const regressions = [];
for (const ruleId of ALL_RULE_IDS) {
  const baselineCount = baseline.counts?.[ruleId] ?? 0;
  const currentCount = currentCounts[ruleId] ?? 0;
  if (currentCount > baselineCount) {
    regressions.push({
      ruleId,
      baselineCount,
      currentCount,
      added: currentCount - baselineCount,
    });
  }
}

if (regressions.length === 0) {
  const saved = (baseline.total ?? 0) - totalViolations;
  const savedMsg = saved > 0 ? ` (${saved} violation(s) resolved vs baseline — great work!)` : '';
  console.info(
    `lint-invariant-registry: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0}, entries: ${totalEntries}, reverse: ${totalReverseDeclarations})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-invariant-registry.mjs --baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(
  `lint-invariant-registry: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`,
);
for (const r of regressions) {
  console.error(
    `  [${r.ruleId}] ${r.baselineCount} -> ${r.currentCount} (+${r.added} violations added)`,
  );
}

console.error('\nNew violations:\n');
for (const v of violations) {
  const reg = regressions.find((r) => r.ruleId === v.ruleId);
  if (!reg) continue;
  console.error(`  [${v.ruleId}] ${v.key} (${v.file}:${v.line})`);
  console.error(`    -> ${v.message}`);
}

console.error(
  '\nFix:\n' +
    '  • Forward `runtime-module-missing`: ensure runtimeGate.module points to an existing TS file.\n' +
    '  • Forward `runtime-function-missing`: ensure functionName is `export`ed from the target module.\n' +
    '  • Forward `lint-script-missing`: ensure lintRule.lintScript path exists in `scripts/`.\n' +
    '  • Forward `doctor-audit-missing`: ensure doctorAudit.lintScript path exists.\n' +
    '  • Forward `test-path-missing`: ensure every tests[] entry resolves (file OR directory).\n' +
    '  • Reverse `adr-code-not-registered`: add a RegisteredInvariant entry for the missing\n' +
    '    `<adr>.<code>` pair in packages/contracts/src/invariants/adr-*.ts. If the code is\n' +
    '    intentionally docs-only, add it to DOCS_ONLY_OVERRIDES in this script with a reason.\n' +
    '  • Background: see ADR-073 §1.2 (I1-I8), ADR-070 §"Invariants" (ORC-001..ORC-014),\n' +
    '    ADR-056 §Decision (D1-D6).\n',
);
process.exit(1);
