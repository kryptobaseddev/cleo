#!/usr/bin/env node
/**
 * render-invariants-docs.mjs — Auto-render `docs/registry/INVARIANTS.md` from
 * the central `INVARIANTS_REGISTRY` SSoT at
 * `packages/contracts/src/invariants/`.
 *
 * The script is the docs-side of the central invariants substrate built by
 * the Saga T10326 SG-SUBSTRATE-RECONCILIATION programme:
 *
 *   - R1 (T10335, SHIPPED) — registry + ADR-073 I1-I8.
 *   - R2 (T10336, SHIPPED) — ADR-070 ORC-001..ORC-014 enumerated.
 *   - R3 (T10337, SHIPPED) — ADR-056 D1-D6 enumerated.
 *   - R4 (T10338, SHIPPED) — CI gate validates registry coverage.
 *   - R5 (T10339, SHIPPED) — `core/release` consumes the central substrate.
 *   - R8 (this task, T10342) — auto-render the canonical docs page.
 *
 * Why auto-render?
 * ----------------
 * Before T10342 every numbered invariant lived in two places: the registry
 * literal (the SSoT) AND prose paragraphs in the ADR markdown. The two
 * inevitably drifted — R6 (T10340) doctor audit hit this on day one when
 * ADR-073's prose listed I3/I5/I7 as "warning" while the registry already
 * marked them "error". This script collapses the doc surface back to the
 * SSoT: editing the registry is the ONLY way to change the docs page.
 *
 * Output
 * ------
 * Generates `docs/registry/INVARIANTS.md` (path relative to repo root):
 *
 *   1. AUTO-GENERATED banner with a back-link to this script.
 *   2. Summary block (per-ADR count + total).
 *   3. One H2 section per source ADR, in registration order
 *      (ADR-073, ADR-056, ADR-070 — same order as `INVARIANTS_REGISTRY`).
 *   4. A markdown table per ADR with columns:
 *      `Code | Name | Severity | RuntimeGate | Tests | Description`.
 *   5. Cross-link footer pointing back at the ADRs + the SSoT modules.
 *
 * Modes
 * -----
 *   - default (write): regenerate `docs/registry/INVARIANTS.md`.
 *   - `--check`: render to memory, compare against the committed file. Exits
 *     non-zero on mismatch — the CI gate (`.github/workflows/ci.yml` job
 *     `Invariants Docs Render Drift (T10342)`) runs this mode.
 *   - `--stdout`: render to stdout (handy for ad-hoc previews).
 *
 * Determinism
 * -----------
 * Two consecutive runs MUST produce byte-identical output. The script:
 *   - Iterates the registry in declaration order (no sort by code/name).
 *   - Uses POSIX path separators in every string emitted.
 *   - Writes `\n` line endings exclusively.
 *   - Does NOT inject a timestamp (the AUTO-GENERATED banner names the
 *     source script — readers know how to find the timestamp by `git log`).
 *
 * @task T10342 — R8: auto-render docs/registry/INVARIANTS.md from registry
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @see packages/contracts/src/invariants/index.ts — SSoT
 * @see scripts/lint-invariant-registry.mjs        — R4 CI gate (T10338)
 * @see packages/cleo/scripts/generate-command-manifest.mjs — render-pattern reference
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Paths ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const OUTPUT_FILE = resolve(REPO_ROOT, 'docs', 'registry', 'INVARIANTS.md');
const REGISTRY_DIST = resolve(PKG_ROOT, 'dist', 'invariants', 'index.js');
const SCRIPT_REL = toPosixRel(REPO_ROOT, fileURLToPath(import.meta.url));

// ─── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const MODE_CHECK = args.includes('--check');
const MODE_STDOUT = args.includes('--stdout');

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an absolute path into a POSIX repo-relative path. Used by every
 * emitted path string so Linux/macOS/Windows all yield identical output.
 *
 * @param {string} base — anchor directory (repo root).
 * @param {string} target — absolute path to convert.
 * @returns {string}
 */
function toPosixRel(base, target) {
  return relative(base, target).split(sep).join('/');
}

/**
 * Escape pipe characters and newlines in a string so it can appear in a
 * markdown table cell without breaking the table syntax.
 *
 * @param {string} input
 * @returns {string}
 */
function escapeCell(input) {
  return input.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format the `runtimeGate` column for one invariant entry.
 *
 * The cell shows the bare function name + parenthesised module path when a
 * guard exists; otherwise an italicised "none" placeholder so the table row
 * stays aligned and grep-able.
 *
 * @param {{module: string, functionName: string} | null | undefined} gate
 * @returns {string}
 */
function formatRuntimeGate(gate) {
  if (!gate) return '_none_';
  return `\`${gate.functionName}\` (\`${gate.module}\`)`;
}

/**
 * Format the `tests` column.
 *
 * @param {readonly string[]} tests
 * @returns {string}
 */
function formatTests(tests) {
  if (tests.length === 0) return '_none_';
  return tests.map((t) => `\`${t}\``).join('<br>');
}

/**
 * Map an ADR ID to the canonical ADR markdown path. Read-only mapping —
 * adding a new source ADR happens here (and in the registry SSoT).
 *
 * @param {string} adr
 * @returns {string}
 */
function adrSourcePath(adr) {
  switch (adr) {
    case 'ADR-073':
      return '.cleo/adrs/ADR-073-above-epic-naming.md';
    case 'ADR-070':
      return '.cleo/adrs/ADR-070-three-tier-orchestration.md';
    case 'ADR-056':
      return '.cleo/adrs/ADR-056-db-ssot-and-release-completion-invariant.md';
    default:
      return `.cleo/adrs/${adr}.md`;
  }
}

/**
 * Map an ADR ID to its registry module path (relative to repo root).
 *
 * @param {string} adr
 * @returns {string}
 */
function adrModulePath(adr) {
  switch (adr) {
    case 'ADR-073':
      return 'packages/contracts/src/invariants/adr-073-saga.ts';
    case 'ADR-070':
      return 'packages/contracts/src/invariants/adr-070-orchestration.ts';
    case 'ADR-056':
      return 'packages/contracts/src/invariants/adr-056-release.ts';
    default:
      return 'packages/contracts/src/invariants/index.ts';
  }
}

// ─── Registry import ──────────────────────────────────────────────────────

/**
 * Load the compiled invariants registry from `dist/`. The script ALWAYS
 * reads from `dist/` (never `src/`) so the on-disk shape downstream
 * consumers receive is the shape that gets rendered. The contracts package
 * build step is a prerequisite — `pnpm --filter @cleocode/contracts run
 * build:ts` is run by the CI gate before invoking this script.
 *
 * @returns {Promise<{
 *   INVARIANTS_REGISTRY: Readonly<Record<string, {
 *     adr: string;
 *     code: string;
 *     name: string;
 *     description: string;
 *     severity: 'info' | 'warning' | 'error';
 *     runtimeGate: {module: string; functionName: string} | null;
 *     lintRule?: {lintScript: string} | null;
 *     doctorAudit?: {lintScript: string} | null;
 *     tests: readonly string[];
 *     deprecated?: boolean;
 *   }>>;
 * }>}
 */
async function loadRegistry() {
  if (!existsSync(REGISTRY_DIST)) {
    console.error(
      `render-invariants-docs: registry dist not found at ${REGISTRY_DIST}\n` +
        '  Run `pnpm --filter @cleocode/contracts run build:ts` first.',
    );
    process.exit(2);
  }
  const mod = await import(REGISTRY_DIST);
  if (!mod.INVARIANTS_REGISTRY) {
    console.error('render-invariants-docs: INVARIANTS_REGISTRY missing from dist export');
    process.exit(2);
  }
  return mod;
}

// ─── Renderer ─────────────────────────────────────────────────────────────

/**
 * Render the full markdown document. Pure function — same input, same
 * output. Determinism is enforced by:
 *   1. Iterating `Object.values(registry)` (declaration order, since the
 *      registry is built by spreading per-ADR arrays in a fixed order).
 *   2. Grouping by `adr` using insertion-ordered `Map`.
 *   3. No timestamps, no random IDs, no environment-dependent strings.
 *
 * @param {Readonly<Record<string, {
 *   adr: string;
 *   code: string;
 *   name: string;
 *   description: string;
 *   severity: 'info' | 'warning' | 'error';
 *   runtimeGate: {module: string; functionName: string} | null;
 *   tests: readonly string[];
 *   deprecated?: boolean;
 * }>>} registry
 * @returns {string}
 */
function render(registry) {
  const allEntries = Object.values(registry);

  /** @type {Map<string, typeof allEntries>} */
  const byAdr = new Map();
  for (const entry of allEntries) {
    const bucket = byAdr.get(entry.adr) ?? [];
    bucket.push(entry);
    byAdr.set(entry.adr, bucket);
  }

  const lines = [];

  // ─── Banner ─────────────────────────────────────────────────────────────
  lines.push('<!--');
  lines.push('  AUTO-GENERATED — DO NOT EDIT MANUALLY.');
  lines.push('');
  lines.push(`  Regenerate via: pnpm render:invariants`);
  lines.push(`  Source script:  ${SCRIPT_REL}`);
  lines.push('  Source SSoT:    packages/contracts/src/invariants/index.ts');
  lines.push('');
  lines.push('  Editing this file directly will be reverted by the next');
  lines.push('  `Invariants Docs Render Drift (T10342)` CI gate run.');
  lines.push('-->');
  lines.push('');
  lines.push('# Invariants Registry');
  lines.push('');
  lines.push(
    'This page catalogues every numbered invariant the CLEO system relies on. ' +
      'It is **auto-rendered** from the central `INVARIANTS_REGISTRY` SSoT at ' +
      '`packages/contracts/src/invariants/`. Editing the source files is the ' +
      'only way to change this page.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| ADR | Entries | Source module |');
  lines.push('| --- | --- | --- |');
  let total = 0;
  for (const [adr, entries] of byAdr) {
    total += entries.length;
    lines.push(`| [\`${adr}\`](${adrSourcePath(adr)}) | ${entries.length} | \`${adrModulePath(adr)}\` |`);
  }
  lines.push(`| **Total** | **${total}** | — |`);
  lines.push('');

  // ─── Per-ADR sections ───────────────────────────────────────────────────
  for (const [adr, entries] of byAdr) {
    lines.push(`## ${adr}`);
    lines.push('');
    lines.push(`Source ADR: [\`${adrSourcePath(adr)}\`](../../${adrSourcePath(adr)})`);
    lines.push('');
    lines.push(`Registry module: \`${adrModulePath(adr)}\``);
    lines.push('');
    lines.push('| Code | Name | Severity | RuntimeGate | Tests | Description |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const entry of entries) {
      const codeCell = entry.deprecated
        ? `\`${escapeCell(entry.code)}\` _(deprecated)_`
        : `\`${escapeCell(entry.code)}\``;
      const cells = [
        codeCell,
        escapeCell(entry.name),
        `\`${escapeCell(entry.severity)}\``,
        formatRuntimeGate(entry.runtimeGate),
        formatTests(entry.tests),
        escapeCell(entry.description),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  // ─── Footer ─────────────────────────────────────────────────────────────
  lines.push('## See also');
  lines.push('');
  lines.push(
    '- `packages/contracts/src/invariants/index.ts` — central registry (SSoT).',
  );
  lines.push(
    '- `scripts/lint-invariant-registry.mjs` — R4 CI gate (T10338) that ' +
      'validates this registry stays truthful.',
  );
  lines.push(
    '- `packages/core/src/release/invariants/registry.ts` — R5 (T10339) ' +
      'consumer of the ADR-056 D1-D6 substrate.',
  );
  lines.push(
    '- `cleo doctor --audit-invariants` — R6 (T10340) per-invariant ' +
      'enforcement audit.',
  );
  lines.push('');

  return `${lines.join('\n')}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { INVARIANTS_REGISTRY } = await loadRegistry();
  const rendered = render(INVARIANTS_REGISTRY);

  if (MODE_STDOUT) {
    process.stdout.write(rendered);
    return;
  }

  if (MODE_CHECK) {
    if (!existsSync(OUTPUT_FILE)) {
      console.error(
        `render-invariants-docs: --check failed — ${toPosixRel(REPO_ROOT, OUTPUT_FILE)} does not exist.\n` +
          '  Run `pnpm render:invariants` to generate it.',
      );
      process.exit(1);
    }
    const onDisk = readFileSync(OUTPUT_FILE, 'utf8');
    if (onDisk === rendered) {
      const entries = Object.keys(INVARIANTS_REGISTRY).length;
      console.info(
        `render-invariants-docs: --check passed (${entries} entries rendered, file matches).`,
      );
      return;
    }
    console.error(
      `render-invariants-docs: --check failed — ${toPosixRel(REPO_ROOT, OUTPUT_FILE)} is out of sync with the registry.\n` +
        '  Run `pnpm render:invariants` and commit the result.',
    );
    // Best-effort diff hint: print line-count delta so CI logs surface the
    // scale of the drift even without piping into `git diff`.
    const onDiskLines = onDisk.split('\n').length;
    const renderedLines = rendered.split('\n').length;
    console.error(
      `  On-disk:   ${onDiskLines} lines\n  Rendered:  ${renderedLines} lines`,
    );
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, rendered, 'utf8');
  const entries = Object.keys(INVARIANTS_REGISTRY).length;
  console.info(
    `render-invariants-docs: wrote ${entries} entries to ${toPosixRel(REPO_ROOT, OUTPUT_FILE)}`,
  );
}

main().catch((err) => {
  console.error('render-invariants-docs: failed', err);
  process.exit(2);
});
