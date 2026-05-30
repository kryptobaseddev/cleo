#!/usr/bin/env node
/**
 * SQLite schema canonicalization audit (T11263 · E10 · Saga T11242 SG-DB-SUBSTRATE-V2).
 *
 * AST-walks every Drizzle `sqliteTable(...)` definition across the cleocode
 * monorepo and emits a machine-readable per-column typing inventory plus a
 * conformance report against the consolidated dual-scope SQLite target
 * (Pattern A: single-file-per-scope, domain-prefixed tables —
 * `tasks_*` / `brain_*` / `conduit_*` / `docs_*` / `telemetry_*`).
 *
 * This is the REPRODUCIBLE source for `docs/migration/sqlite-schema-canonical.md`
 * (T11331 deliverable). It is NOT hand-curated: it parses the real schema files
 * with the TypeScript compiler API, so re-running it after any schema edit keeps
 * the canonical typing report in sync (T11328 AC4).
 *
 * ## What it classifies per column
 * - `affinity`      — declared SQLite storage class (TEXT/INTEGER/REAL/BLOB)
 *                     derived from the Drizzle builder (`text`/`integer`/`real`/`blob`).
 * - `semanticType`  — inferred domain meaning (boolean / timestamp-text /
 *                     timestamp-epoch / timestamp-date / enum / json / id / fk /
 *                     numeric / text / blob / real).
 * - `nullable`      — true unless `.notNull()` or `.primaryKey()` is chained.
 * - `default`       — the literal/SQL default expression if present.
 * - `enumValues`    — for `text({ enum: X })`, the identifier of the enum const.
 * - `mode`          — Drizzle column mode (`boolean` / `timestamp` / `buffer` …).
 * - `nonConformer`  — populated when the column violates a target invariant
 *                     (mixed timestamp representation, bare-text enum-like status,
 *                     missing boolean CHECK, etc.) with the target domain table.
 *
 * ## Usage
 *   node scripts/audit-sqlite-schema.mjs
 *   node scripts/audit-sqlite-schema.mjs --out docs/migration/sqlite-schema-columns.json
 *
 * Output (default): `docs/migration/sqlite-schema-columns.json` — the canonical
 * machine-readable column table consumed by the human report and by T11245 (E2).
 *
 * @task T11328
 * @task T11329
 * @task T11330
 * @task T11331
 * @epic T11263
 * @saga T11242
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * The complete inventory of files holding Drizzle `sqliteTable(...)` definitions.
 * Mirrors the T11263 scope: the `*-schema.ts` family (chain/conduit/memory/
 * nexus/signaldock/skills/tasks + agent) + the `store/schema/` subdomain
 * modules + nexus + playbooks + telemetry. `validation-schemas.ts` is a
 * Drizzle→Zod derivation (no `sqliteTable`) so it is intentionally excluded from
 * the column walk but recorded in the meta block.
 *
 * @type {string[]}
 */
const SCHEMA_FILES = [
  'packages/core/src/store/schema/tasks.ts',
  'packages/core/src/store/schema/attachments.ts',
  'packages/core/src/store/schema/audit.ts',
  'packages/core/src/store/schema/background-jobs.ts',
  'packages/core/src/store/schema/evidence-bindings.ts',
  'packages/core/src/store/schema/experiments.ts',
  'packages/core/src/store/schema/lifecycle.ts',
  'packages/core/src/store/schema/manifest.ts',
  'packages/core/src/store/schema/provenance/commits.ts',
  'packages/core/src/store/schema/provenance/pull-requests.ts',
  'packages/core/src/store/schema/provenance/releases.ts',
  'packages/core/src/store/chain-schema.ts',
  'packages/core/src/store/conduit-schema.ts',
  'packages/core/src/store/memory-schema.ts',
  'packages/core/src/store/nexus-schema.ts',
  'packages/core/src/store/signaldock-schema.ts',
  'packages/core/src/store/skills-schema.ts',
  'packages/core/src/agents/agent-schema.ts',
  'packages/core/src/telemetry/schema.ts',
  'packages/nexus/src/schema/code-index.ts',
  'packages/playbooks/src/schema.ts',
];

/**
 * Maps each source file to its target consolidated scope + domain table prefix
 * under Pattern A. Used to attribute every column to its exodus destination
 * (T11328 AC3).
 *
 * @type {Record<string, { scope: string; prefix: string }>}
 */
const FILE_DOMAIN = {
  'packages/core/src/store/schema/tasks.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/attachments.ts': { scope: 'tasks', prefix: 'docs_' },
  'packages/core/src/store/schema/audit.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/background-jobs.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/evidence-bindings.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/experiments.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/lifecycle.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/manifest.ts': { scope: 'tasks', prefix: 'docs_' },
  'packages/core/src/store/schema/provenance/commits.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/schema/provenance/pull-requests.ts': {
    scope: 'tasks',
    prefix: 'tasks_',
  },
  'packages/core/src/store/schema/provenance/releases.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/chain-schema.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/store/conduit-schema.ts': { scope: 'tasks', prefix: 'conduit_' },
  'packages/core/src/store/memory-schema.ts': { scope: 'brain', prefix: 'brain_' },
  'packages/core/src/store/nexus-schema.ts': { scope: 'brain', prefix: 'nexus_' },
  'packages/core/src/store/signaldock-schema.ts': { scope: 'brain', prefix: 'signaldock_' },
  'packages/core/src/store/skills-schema.ts': { scope: 'brain', prefix: 'skills_' },
  'packages/core/src/agents/agent-schema.ts': { scope: 'tasks', prefix: 'tasks_' },
  'packages/core/src/telemetry/schema.ts': { scope: 'tasks', prefix: 'telemetry_' },
  'packages/nexus/src/schema/code-index.ts': { scope: 'brain', prefix: 'nexus_' },
  'packages/playbooks/src/schema.ts': { scope: 'tasks', prefix: 'tasks_' },
};

/** Drizzle column builder identifier → declared SQLite affinity. */
const BUILDER_AFFINITY = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB',
  numeric: 'NUMERIC',
};

/**
 * Recognized domain table-name prefixes. Used to keep {@link targetTableName}
 * idempotent: a table already carrying its domain prefix (e.g. `brain_*`) must
 * not be double-prefixed at exodus time.
 *
 * @type {string[]}
 */
const KNOWN_PREFIXES = [
  'tasks_',
  'brain_',
  'conduit_',
  'docs_',
  'telemetry_',
  'nexus_',
  'signaldock_',
  'skills_',
];

/** Column-name timestamp markers. */
const TS_SUFFIXES = ['_at', 'At'];
/** Column-name JSON-in-TEXT markers. */
const JSON_SUFFIXES = ['_json', 'Json'];

/**
 * Computes the consolidated exodus target table name for a physical table.
 *
 * Idempotent: a table already carrying any recognized domain prefix is left
 * unchanged; otherwise the file's domain prefix is prepended.
 *
 * @param {string} tableName — physical SQLite table name.
 * @param {string} prefix — the file's domain prefix (e.g. `brain_`).
 * @returns {string} the prefixed target table name.
 */
function targetTableName(tableName, prefix) {
  // Leading-underscore meta tables (`_conduit_meta`) keep their identity.
  const bare = tableName.replace(/^_+/, '');
  if (KNOWN_PREFIXES.some((p) => bare.startsWith(p))) return tableName;
  return `${prefix}${tableName}`;
}

/**
 * Reads + parses a TypeScript source file into an AST SourceFile.
 *
 * @param {string} absPath — absolute path to the `.ts` file.
 * @returns {ts.SourceFile} parsed AST node.
 */
function parseSource(absPath) {
  const src = readFileSync(absPath, 'utf8');
  return ts.createSourceFile(absPath, src, ts.ScriptTarget.Latest, true);
}

/**
 * Extracts the string literal value of an AST node, or null if it is not a
 * plain string literal.
 *
 * @param {ts.Node | undefined} node — candidate node.
 * @returns {string | null} the literal text or null.
 */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/**
 * Renders a default-value AST node into a stable, comparable string.
 *
 * @param {ts.Node} node — the argument to `.default(...)`.
 * @returns {string} normalised default expression.
 */
function renderDefault(node) {
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'sql') {
    return `sql\`${node.template.getText().replace(/^`|`$/g, '')}\``;
  }
  return node.getText().trim();
}

/**
 * Classifies a single Drizzle column definition into its canonical descriptor.
 *
 * Walks the chained call expression
 * (`text('name', opts).notNull().default(...).primaryKey()`) collecting the
 * base builder, options object (`{ enum, mode, autoIncrement }`), and each
 * chained modifier.
 *
 * @param {string} fieldName — the TS property name (camelCase).
 * @param {ts.Expression} valueExpr — the right-hand-side expression.
 * @returns {ColumnDescriptor | null} the descriptor, or null when the value is
 *   not a column builder.
 */
function classifyColumn(fieldName, valueExpr) {
  /** @type {ts.Node} */
  let cursor = valueExpr;
  let nullable = true;
  let isPrimaryKey = false;
  let isUnique = false;
  let hasReference = false;
  let defaultExpr = null;
  let columnName = null;
  let builder = null;
  let enumRef = null;
  let mode = null;
  let autoIncrement = false;

  while (ts.isCallExpression(cursor)) {
    const callee = cursor.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === 'notNull') {
        nullable = false;
      } else if (method === 'primaryKey') {
        isPrimaryKey = true;
        nullable = false;
        const opt = cursor.arguments[0];
        if (opt && ts.isObjectLiteralExpression(opt)) {
          for (const p of opt.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              p.name.getText() === 'autoIncrement' &&
              p.initializer.kind === ts.SyntaxKind.TrueKeyword
            ) {
              autoIncrement = true;
            }
          }
        }
      } else if (method === 'unique') {
        isUnique = true;
      } else if (method === 'references') {
        hasReference = true;
      } else if (method === 'default') {
        defaultExpr = cursor.arguments[0] ? renderDefault(cursor.arguments[0]) : null;
      }
      cursor = callee.expression;
    } else if (ts.isIdentifier(callee)) {
      builder = callee.text;
      columnName = literalText(cursor.arguments[0]);
      const opts = cursor.arguments[1];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const p of opts.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = p.name.getText();
          if (key === 'enum') {
            enumRef = p.initializer.getText();
          } else if (key === 'mode') {
            mode = literalText(p.initializer);
          } else if (key === 'autoIncrement' && p.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            autoIncrement = true;
          }
        }
      }
      break;
    } else {
      break;
    }
  }

  if (!builder || !BUILDER_AFFINITY[builder] || !columnName) return null;

  const affinity = BUILDER_AFFINITY[builder];
  const semanticType = inferSemantic({
    builder,
    affinity,
    columnName,
    enumRef,
    mode,
    isPrimaryKey,
    hasReference,
    defaultExpr,
  });

  return {
    field: fieldName,
    column: columnName,
    builder,
    affinity,
    semanticType,
    nullable,
    isPrimaryKey,
    isUnique,
    hasReference,
    default: defaultExpr,
    enumRef,
    mode,
    autoIncrement,
  };
}

/**
 * Infers the canonical semantic type for a column from builder, options, and
 * naming heuristics.
 *
 * @param {{
 *   builder: string; affinity: string; columnName: string;
 *   enumRef: string | null; mode: string | null;
 *   isPrimaryKey: boolean; hasReference: boolean; defaultExpr: string | null;
 * }} ctx — classification context.
 * @returns {string} canonical semantic type tag.
 */
function inferSemantic(ctx) {
  const { builder, columnName, enumRef, mode, isPrimaryKey, hasReference, defaultExpr } = ctx;

  if (mode === 'boolean') return 'boolean';
  if (mode === 'timestamp' || mode === 'timestamp_ms') return 'timestamp-date';
  if (mode === 'buffer') return 'blob';
  if (mode === 'json') return 'json';

  if (enumRef) return 'enum';

  // JSON-in-TEXT by `_json`/`Json` suffix, OR by an empty-array/object default
  // literal (`'[]'` / `'{}'`) — the convention used by conduit/topic tables
  // that omit the suffix (e.g. messages.attachments, messages.metadata).
  if (builder === 'text') {
    if (JSON_SUFFIXES.some((s) => columnName.endsWith(s))) return 'json';
    if (defaultExpr === "'[]'" || defaultExpr === "'{}'") return 'json';
  }

  if (TS_SUFFIXES.some((s) => columnName.endsWith(s))) {
    if (builder === 'integer') return 'timestamp-epoch';
    if (builder === 'text') return 'timestamp-text';
  }

  if (builder === 'real') return 'real';
  if (builder === 'blob') return 'blob';

  if (builder === 'integer') {
    if (/^(enabled|auto_|is_|has_)/.test(columnName) || columnName === 'grade_mode') {
      return 'boolean-untyped';
    }
    return 'numeric';
  }

  if (builder === 'text') {
    if (isPrimaryKey && (columnName === 'id' || columnName.endsWith('_id'))) return 'id';
    if (hasReference) return 'fk';
    if (columnName === 'id' || columnName.endsWith('_id')) return 'id';
    return 'text';
  }

  return 'text';
}

/**
 * Walks a SourceFile collecting every `export const X = sqliteTable('name', {...})`
 * definition with its columns.
 *
 * @param {ts.SourceFile} sf — parsed source file.
 * @param {string} relPath — repo-relative path (for provenance).
 * @returns {Array<TableDescriptor>} table descriptors.
 */
function extractTables(sf, relPath) {
  const tables = [];

  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'sqliteTable'
      ) {
        const tableVar = node.name.getText();
        const tableName = literalText(init.arguments[0]) ?? tableVar;
        const colsArg = init.arguments[1];
        const columns = [];
        if (colsArg && ts.isObjectLiteralExpression(colsArg)) {
          for (const prop of colsArg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const fieldName = prop.name.getText();
            const desc = classifyColumn(fieldName, prop.initializer);
            if (desc) columns.push(desc);
          }
        }
        tables.push({ tableVar, tableName, relPath, columns });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return tables;
}

/**
 * Applies non-conformance rules against the consolidated dual-scope target and
 * annotates each column with a `nonConformer` reason + target domain table.
 *
 * Rules (T11328 AC3 / T11329 / T11330):
 *  - R1 boolean-untyped INTEGER flag without `{ mode: 'boolean' }` + CHECK.
 *  - R2 mixed timestamp representation (epoch vs ISO-text vs Date) — target = TEXT ISO8601.
 *  - R3 enum-like bare `text('status'|'kind'|...)` lacking `{ enum }` CHECK.
 *  - R4 JSON-in-TEXT column lacking a documented validator (informational).
 *
 * @param {Array<TableDescriptor>} tables — descriptors from {@link extractTables}.
 * @returns {Array<TableDescriptor>} same descriptors with `nonConformer` populated.
 */
function annotateNonConformers(tables) {
  const ENUM_LIKE_NAMES = new Set([
    'status',
    'kind',
    'type',
    'state',
    'visibility',
    'content_type',
    'change_type',
    'mode',
    'role',
    'severity',
    'priority',
    'link_type',
    'sync_direction',
    'relation_type',
  ]);

  for (const t of tables) {
    const domain = FILE_DOMAIN[t.relPath] ?? { scope: '?', prefix: '?' };
    const targetTable = targetTableName(t.tableName, domain.prefix);
    for (const c of t.columns) {
      c.targetScope = domain.scope;
      c.targetTable = targetTable;
      const reasons = [];

      if (c.semanticType === 'boolean-untyped') {
        reasons.push('INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1))');
      }

      if (c.semanticType === 'timestamp-epoch') {
        reasons.push('INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK');
      } else if (c.semanticType === 'timestamp-date') {
        reasons.push(
          'Drizzle { mode: "timestamp" } Date mapping — target canonical form is TEXT ISO8601 + CHECK',
        );
      }

      if (
        c.builder === 'text' &&
        !c.enumRef &&
        ENUM_LIKE_NAMES.has(c.column) &&
        c.semanticType !== 'fk' &&
        c.semanticType !== 'id'
      ) {
        reasons.push(`enum-like TEXT '${c.column}' lacks { enum } / CHECK (col IN (...))`);
      }

      if (c.semanticType === 'json') {
        reasons.push('JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330)');
      }

      c.nonConformer = reasons.length ? reasons.join(' | ') : null;
    }
  }
  return tables;
}

/**
 * Renders the per-table column inventory as GitHub-Flavoured Markdown tables,
 * grouped by consolidated scope then by source file. This is the reproducible
 * body embedded into `docs/migration/sqlite-schema-canonical.md` between the
 * `<!-- AUDIT:BEGIN -->` / `<!-- AUDIT:END -->` markers — so the human report's
 * column tables are never hand-transcribed (T11328 AC4).
 *
 * @param {Array<TableDescriptor>} tables — annotated descriptors.
 * @returns {string} markdown body.
 */
function renderMarkdown(tables) {
  /** @type {Map<string, Map<string, TableDescriptor[]>>} */
  const byScope = new Map();
  for (const t of tables) {
    const scope = t.columns[0]?.targetScope ?? '?';
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    const byFile = byScope.get(scope);
    if (!byFile.has(t.relPath)) byFile.set(t.relPath, []);
    byFile.get(t.relPath).push(t);
  }

  const lines = [];
  for (const scope of [...byScope.keys()].sort()) {
    lines.push(`### Scope: \`${scope}\` (target DB: \`.cleo/${scope}.db\`)`, '');
    const byFile = byScope.get(scope);
    for (const relPath of [...byFile.keys()].sort()) {
      lines.push(`#### \`${relPath}\``, '');
      for (const t of byFile.get(relPath)) {
        const target = t.columns[0]?.targetTable ?? t.tableName;
        lines.push(`##### \`${t.tableName}\` → \`${target}\``, '');
        lines.push(
          '| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |',
        );
        lines.push('|---|---|---|:--:|:--:|:--:|:--:|---|---|');
        for (const c of t.columns) {
          const flagN = c.nullable ? '✓' : '';
          const flagPk = c.primaryKey ? '✓' : '';
          const flagUq = c.unique ? '✓' : '';
          const flagFk = c.fk ? '✓' : '';
          const def = c.default ? `\`${c.default.replace(/\|/g, '\\|')}\`` : '';
          const note = c.nonConformer
            ? `⚠ ${c.nonConformer.replace(/\|/g, '\\|')}`
            : c.enumRef
              ? `\`${c.enumRef.replace(/\|/g, '\\|')}\``
              : '';
          lines.push(
            `| \`${c.column}\` | ${c.affinity} | ${c.semanticType} | ${flagN} | ${flagPk} | ${flagUq} | ${flagFk} | ${def} | ${note} |`,
          );
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

/**
 * Entry point — parse all schema files, classify, annotate, and emit JSON
 * (default) plus an optional `--markdown <path>` per-table table dump.
 *
 * @returns {void}
 */
function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outRel =
    outArgIdx >= 0 ? process.argv[outArgIdx + 1] : 'docs/migration/sqlite-schema-columns.json';
  const outPath = join(REPO_ROOT, outRel);
  const mdArgIdx = process.argv.indexOf('--markdown');
  const mdRel = mdArgIdx >= 0 ? process.argv[mdArgIdx + 1] : null;

  /** @type {Array<TableDescriptor>} */
  const allTables = [];
  for (const rel of SCHEMA_FILES) {
    const abs = join(REPO_ROOT, rel);
    const sf = parseSource(abs);
    const tables = extractTables(sf, relative(REPO_ROOT, abs));
    allTables.push(...tables);
  }
  annotateNonConformers(allTables);

  let totalColumns = 0;
  /** @type {Record<string, number>} */
  const semanticCounts = {};
  let nonConformerCount = 0;
  for (const t of allTables) {
    for (const c of t.columns) {
      totalColumns += 1;
      semanticCounts[c.semanticType] = (semanticCounts[c.semanticType] ?? 0) + 1;
      if (c.nonConformer) nonConformerCount += 1;
    }
  }

  const out = {
    generatedBy: 'scripts/audit-sqlite-schema.mjs',
    task: 'T11263',
    children: ['T11328', 'T11329', 'T11330', 'T11331'],
    target: 'SQLite consolidation Pattern A — 2 scopes (tasks/brain), domain-prefixed tables',
    schemaFiles: SCHEMA_FILES,
    counts: {
      tables: allTables.length,
      columns: totalColumns,
      nonConformers: nonConformerCount,
      bySemanticType: semanticCounts,
    },
    tables: allTables.map((t) => ({
      tableVar: t.tableVar,
      tableName: t.tableName,
      relPath: t.relPath,
      targetScope: t.columns[0]?.targetScope ?? null,
      targetTable: t.columns[0]?.targetTable ?? null,
      columns: t.columns.map((c) => ({
        field: c.field,
        column: c.column,
        affinity: c.affinity,
        semanticType: c.semanticType,
        nullable: c.nullable,
        primaryKey: c.isPrimaryKey,
        unique: c.isUnique,
        fk: c.hasReference,
        default: c.default,
        enumRef: c.enumRef,
        mode: c.mode,
        autoIncrement: c.autoIncrement,
        nonConformer: c.nonConformer,
      })),
    })),
  };

  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  if (mdRel) {
    writeFileSync(join(REPO_ROOT, mdRel), `${renderMarkdown(allTables)}\n`, 'utf8');
    process.stderr.write(`[audit-sqlite-schema] markdown table dump → ${mdRel}\n`);
  }

  process.stderr.write(
    `[audit-sqlite-schema] ${allTables.length} tables, ${totalColumns} columns, ` +
      `${nonConformerCount} non-conformers → ${outRel}\n`,
  );
  for (const [k, v] of Object.entries(semanticCounts).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`  ${k.padEnd(18)} ${v}\n`);
  }
}

/**
 * @typedef {object} ColumnDescriptor
 * @property {string} field — TS property identifier (camelCase).
 * @property {string} column — physical SQLite column name (snake_case).
 * @property {string} builder — Drizzle builder identifier (text/integer/real/blob).
 * @property {string} affinity — declared SQLite affinity (TEXT/INTEGER/REAL/BLOB).
 * @property {string} semanticType — inferred canonical semantic type.
 * @property {boolean} nullable — whether the column permits NULL.
 * @property {boolean} isPrimaryKey — column is (part of) the primary key.
 * @property {boolean} isUnique — column carries a UNIQUE constraint.
 * @property {boolean} hasReference — column declares a `.references(...)` FK.
 * @property {string | null} default — rendered default expression, if any.
 * @property {string | null} enumRef — `{ enum }` identifier, if any.
 * @property {string | null} mode — Drizzle column mode, if any.
 * @property {boolean} autoIncrement — INTEGER PK autoincrement flag.
 * @property {string} [targetScope] — consolidated scope (tasks/brain).
 * @property {string} [targetTable] — domain-prefixed target table name.
 * @property {string | null} [nonConformer] — non-conformance reason(s), or null.
 */

/**
 * @typedef {object} TableDescriptor
 * @property {string} tableVar — exported Drizzle table variable name.
 * @property {string} tableName — physical SQLite table name.
 * @property {string} relPath — repo-relative source path.
 * @property {ColumnDescriptor[]} columns — classified columns.
 */

main();
