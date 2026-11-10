/**
 * Bounded SQL extractor for the parse-loop pipeline (T14383).
 *
 * Reads SQL DDL text without a grammar: comments are blanked (offsets and line
 * numbers are kept), statements are split on `;` outside string literals,
 * quoted identifiers, dollar-quoted bodies and `BEGIN … END` / `CASE … END`
 * blocks, and each statement is matched against the DDL forms below.
 *
 * - **Schema objects**: `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX`.
 * - **Triggers**: `CREATE TRIGGER`, with the table it fires on and the tables
 *   its body writes or reads.
 * - **Constraints**: `PRIMARY KEY`, `UNIQUE`, `CHECK` and `FOREIGN KEY` /
 *   `REFERENCES`, inline or table-level, recorded on the table node; a foreign
 *   key is also a reference to the table it names.
 * - **Migrations**: `ALTER TABLE` (add/drop/rename column, rename table, add
 *   constraint) and `DROP TABLE|VIEW|INDEX|TRIGGER`, recorded as references
 *   from the file to the object it changes.
 *
 * The graph has no SQL node kinds yet, so SQL objects use the nearest existing
 * kind and carry the exact SQL kind in `meta.sqlKind`: tables and views are
 * `record`, indexes `property`, triggers `function`. SQL nodes are never
 * registered in the symbol table, so no code call can resolve to them.
 *
 * Not extracted: DML statements, column-level types, routines (`CREATE
 * FUNCTION|PROCEDURE`), literal SQL inside executable sources, and dynamic SQL.
 *
 * @task T14383
 * @module pipeline/extractors/sql-extractor
 */

import type {
  GraphNode,
  GraphNodeKind,
  GraphRelation,
  GraphRelationType,
} from '@cleocode/contracts';
import { confidenceLabelFromNumeric } from '@cleocode/contracts/graph.js';

/** SQL object kinds the extractor emits as graph nodes. */
export type SqlObjectKind = 'table' | 'view' | 'index' | 'trigger';

/** One table constraint recorded on a table node's `meta.constraints`. */
export interface SqlConstraint {
  /** Constraint form. */
  type: 'primary-key' | 'unique' | 'check' | 'foreign-key';
  /** Declared constraint name, when the SQL names it. */
  name?: string;
  /** Constrained columns (empty for a table-level CHECK). */
  columns: string[];
  /** Referenced table and columns of a foreign key. */
  references?: { table: string; columns: string[] };
}

/**
 * A reference from an extracted node (or the file, for a migration statement)
 * to a table or view named in SQL, resolved by {@link linkSqlReferences}.
 */
export interface SqlTableReference {
  /** Source node id, or the file path for a migration statement. */
  source: string;
  /** Referenced object name, lower-cased and unqualified. */
  target: string;
  /** Relation emitted once the target resolves. */
  type: Extract<GraphRelationType, 'accesses' | 'queries'>;
  /** Why the reference exists (e.g. `foreign key references`). */
  reason: string;
}

/** Everything the extractor read from one SQL file. */
export interface SqlExtraction {
  /** Repository-relative path of the SQL file. */
  filePath: string;
  /** Table, view, index and trigger nodes, first definition per name wins. */
  nodes: GraphNode[];
  /** References to tables and views, linked after every SQL file is read. */
  references: SqlTableReference[];
  /** `ALTER TABLE … RENAME TO` pairs (lower-cased old → new name). */
  renames: { from: string; to: string }[];
  /** Statements that are neither recognized DDL nor DML. */
  unrecognizedStatements: number;
}

/** Result of linking every SQL file's references into the graph. */
export interface SqlLinkResult {
  /** References resolved to at least one table or view definition. */
  linked: number;
  /** References whose target no indexed SQL file defines. */
  unresolved: number;
}

const NODE_KIND: Record<SqlObjectKind, GraphNodeKind> = {
  table: 'record',
  view: 'record',
  index: 'property',
  trigger: 'function',
};

const NAME = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})?`;
const IF_NOT_EXISTS = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?`;

const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+${IF_NOT_EXISTS}(${QUALIFIED})\s*([\s\S]*)$`,
  'i',
);
const CREATE_VIEW = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?VIEW\s+${IF_NOT_EXISTS}(${QUALIFIED})[\s\S]*?\bAS\b([\s\S]*)$`,
  'i',
);
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?${IF_NOT_EXISTS}(${QUALIFIED})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED})\s*(?:USING\s+\w+\s*)?\(([\s\S]*?)\)`,
  'i',
);
const CREATE_TRIGGER = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${IF_NOT_EXISTS}(${QUALIFIED})([\s\S]*?)\bON\s+(${QUALIFIED})([\s\S]*)$`,
  'i',
);
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+([\s\S]*)$`,
  'i',
);
const DROP_OBJECT = new RegExp(
  String.raw`^DROP\s+(?:MATERIALIZED\s+)?(TABLE|VIEW|INDEX|TRIGGER)\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED})`,
  'i',
);
/** DML, transaction control and session pragmas: statements, not schema. */
const NON_SCHEMA_STATEMENT =
  /^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|VALUES|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|SET|VACUUM|ANALYZE|EXPLAIN|ATTACH|DETACH|REINDEX|GRANT|REVOKE|COMMENT)\b/i;
/** Tables a query body reads or writes. */
const TABLE_IN_BODY = new RegExp(
  String.raw`\b(FROM|JOIN|INTO|UPDATE)\s+(?:OR\s+\w+\s+)?(?:ONLY\s+)?(${QUALIFIED})`,
  'gi',
);
const REFERENCES = new RegExp(String.raw`\bREFERENCES\s+(${QUALIFIED})\s*(?:\(([^)]*)\))?`, 'i');

/** Strip identifier quoting and any schema qualifier: `main."Items"` → `Items`. */
function unqualify(name: string): string {
  const parts = name.match(new RegExp(NAME, 'g')) ?? [name];
  const last = parts[parts.length - 1] ?? name;
  if (last.startsWith('"')) return last.slice(1, -1).replace(/""/g, '"');
  if (last.startsWith('`') || last.startsWith('[')) return last.slice(1, -1);
  return last;
}

/** Lower-cased lookup key for an object name (unquoted SQL identifiers fold case). */
function nameKey(name: string): string {
  return unqualify(name).toLowerCase();
}

/** Split a comma list of column names, ignoring sort order and collation words. */
function columnList(text: string): string[] {
  return splitTopLevel(text)
    .map((part) => part.trim().match(new RegExp(`^${NAME}`))?.[0])
    .filter((part): part is string => Boolean(part))
    .map(unqualify);
}

/**
 * Blank `--` and `/* … *\/` comments with spaces, keeping newlines and every
 * string literal, so offsets and line numbers still match the original text.
 */
function blankComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '-' && next === '-') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const stop = quotedEnd(source, index);
      out += source.slice(index, stop);
      index = stop;
    } else if (char === '$') {
      const tag = source.slice(index).match(/^\$[A-Za-z_]*\$/)?.[0];
      const end = tag ? source.indexOf(tag, index + tag.length) : -1;
      const stop = tag ? (end === -1 ? source.length : end + tag.length) : index + 1;
      out += source.slice(index, stop);
      index = stop;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

/** End offset (exclusive) of the quoted span opening at `start`. */
function quotedEnd(source: string, start: number): number {
  const open = source[start];
  const close = open === '[' ? ']' : open;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === close) {
      if (close !== ']' && source[index + 1] === close) index += 2;
      else return index + 1;
    } else index++;
  }
  return source.length;
}

/** One statement's text and its offset in the comment-blanked source. */
interface Statement {
  text: string;
  start: number;
  end: number;
}

/**
 * Split blanked SQL into statements on `;` at block depth zero. Inside a
 * `CREATE TRIGGER` statement `BEGIN` opens a block; `CASE` always does; `END`
 * closes one. Quoted and dollar-quoted spans never split a statement.
 */
function splitStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  const push = (end: number): void => {
    const raw = source.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) statements.push({ text, start: start + lead, end: start + lead + text.length });
  };
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = quotedEnd(source, index);
      continue;
    }
    if (char === '$') {
      const tag = source.slice(index).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag) {
        const end = source.indexOf(tag, index + tag.length);
        index = end === -1 ? source.length : end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char) && !/[\w$]/.test(source[index - 1] ?? '')) {
      const word = source.slice(index).match(/^[A-Za-z_]\w*/)?.[0] ?? char;
      const upper = word.toUpperCase();
      if (upper === 'CASE') depth++;
      else if (upper === 'END' && depth > 0) depth--;
      else if (
        upper === 'BEGIN' &&
        /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(
          source.slice(start, index).trimStart(),
        )
      )
        depth++;
      index += word.length;
      continue;
    }
    if (char === ';' && depth === 0) {
      push(index);
      start = index + 1;
    }
    index++;
  }
  push(source.length);
  return statements;
}

/** Split on commas at parenthesis depth zero, outside quoted spans. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = quotedEnd(text, index);
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index++;
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim());
}

/** Text inside the parentheses that open at the start of `text`, else null. */
function parenthesized(text: string): string | null {
  if (!text.startsWith('(')) return null;
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = quotedEnd(text, index);
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return text.slice(1, index);
    index++;
  }
  return null;
}

/** Constraints and column names declared in a `CREATE TABLE ( … )` body. */
function tableBody(body: string): { columns: string[]; constraints: SqlConstraint[] } {
  const columns: string[] = [];
  const constraints: SqlConstraint[] = [];
  for (const rawPart of splitTopLevel(body)) {
    let part = rawPart.trim();
    let name: string | undefined;
    const named = part.match(new RegExp(String.raw`^CONSTRAINT\s+(${NAME})\s+`, 'i'));
    if (named?.[1]) {
      name = unqualify(named[1]);
      part = part.slice(named[0].length);
    }
    const withName = (constraint: SqlConstraint): SqlConstraint =>
      name ? { ...constraint, name } : constraint;
    const tableLevel = part.match(/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b\s*/i);
    if (tableLevel?.[1]) {
      const form = tableLevel[1].toUpperCase().replace(/\s+/g, ' ');
      const rest = part.slice(tableLevel[0].length);
      const inner = parenthesized(rest) ?? '';
      if (form === 'CHECK') constraints.push(withName({ type: 'check', columns: [] }));
      else if (form === 'FOREIGN KEY') {
        const target = rest.match(REFERENCES);
        constraints.push(
          withName({
            type: 'foreign-key',
            columns: columnList(inner),
            ...(target?.[1]
              ? {
                  references: {
                    table: unqualify(target[1]),
                    columns: columnList(target[2] ?? ''),
                  },
                }
              : {}),
          }),
        );
      } else
        constraints.push(
          withName({
            type: form === 'UNIQUE' ? 'unique' : 'primary-key',
            columns: columnList(inner),
          }),
        );
      continue;
    }
    const column = part.match(new RegExp(`^${NAME}`))?.[0];
    if (!column) continue;
    const columnName = unqualify(column);
    columns.push(columnName);
    const definition = part.slice(column.length);
    if (/\bPRIMARY\s+KEY\b/i.test(definition))
      constraints.push({ type: 'primary-key', columns: [columnName] });
    if (/\bUNIQUE\b/i.test(definition)) constraints.push({ type: 'unique', columns: [columnName] });
    if (/\bCHECK\s*\(/i.test(definition))
      constraints.push({ type: 'check', columns: [columnName] });
    const target = definition.match(REFERENCES);
    if (target?.[1])
      constraints.push({
        type: 'foreign-key',
        columns: [columnName],
        references: { table: unqualify(target[1]), columns: columnList(target[2] ?? '') },
      });
  }
  return { columns, constraints };
}

/** Distinct tables a query body reads or writes, lower-cased. */
function tablesInBody(body: string): string[] {
  const tables = new Set<string>();
  for (const match of body.matchAll(TABLE_IN_BODY)) {
    const name = match[2];
    // `DELETE FROM x`, `INSERT INTO x`, `UPDATE x`, `FROM x`, `JOIN x` — skip keywords.
    if (name && !/^(?:SELECT|SET|VALUES|DEFAULT|NEW|OLD)$/i.test(name)) tables.add(nameKey(name));
  }
  return [...tables];
}

/** 1-based line of an offset. */
function lineAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Extract SQL schema objects, triggers, constraints and migration statements.
 *
 * @param filePath - Repository-relative path of the SQL file
 * @param source - The file's text
 * @returns Nodes for the file plus the table references to link across files
 * @example
 * ```ts
 * const sql = extractSql('db/schema.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
 * sql.nodes[0]?.meta?.['sqlKind']; // 'table'
 * ```
 */
export function extractSql(filePath: string, source: string): SqlExtraction {
  const blanked = blankComments(source);
  const lineStarts = [0];
  for (let index = 0; index < blanked.length; index++)
    if (blanked[index] === '\n') lineStarts.push(index + 1);
  const nodes = new Map<string, GraphNode>();
  const references: SqlTableReference[] = [];
  const renames: { from: string; to: string }[] = [];
  let unrecognizedStatements = 0;

  const addNode = (
    sqlKind: SqlObjectKind,
    name: string,
    statement: Statement,
    meta: Record<string, unknown> = {},
  ): string => {
    const objectName = unqualify(name);
    const id = `${filePath}::${objectName}`;
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        kind: NODE_KIND[sqlKind],
        name: objectName,
        filePath,
        startLine: lineAt(lineStarts, statement.start),
        endLine: lineAt(lineStarts, Math.max(statement.start, statement.end - 1)),
        language: 'sql',
        exported: false,
        meta: { sqlKind, ...meta },
      });
    return id;
  };
  const refer = (
    source: string,
    target: string,
    type: SqlTableReference['type'],
    reason: string,
  ): void => {
    references.push({ source, target: nameKey(target), type, reason });
  };

  for (const statement of splitStatements(blanked)) {
    const text = statement.text;
    const table = text.match(CREATE_TABLE);
    if (table?.[1]) {
      const rest = (table[2] ?? '').trim();
      const body = parenthesized(rest);
      const { columns, constraints } = body ? tableBody(body) : { columns: [], constraints: [] };
      const id = addNode('table', table[1], statement, { columns, constraints });
      for (const constraint of constraints)
        if (constraint.references)
          refer(id, constraint.references.table, 'accesses', 'foreign key references');
      if (!body && /^AS\b/i.test(rest))
        for (const source of tablesInBody(rest)) refer(id, source, 'queries', 'table created from');
      continue;
    }
    const view = text.match(CREATE_VIEW);
    if (view?.[1]) {
      const id = addNode('view', view[1], statement);
      for (const source of tablesInBody(view[2] ?? ''))
        refer(id, source, 'queries', 'view selects from');
      continue;
    }
    const index = text.match(CREATE_INDEX);
    if (index?.[1] && index[2]) {
      const id = addNode('index', index[1], statement, {
        table: unqualify(index[2]),
        columns: columnList(index[3] ?? ''),
        unique: /^CREATE\s+UNIQUE\b/i.test(text),
      });
      refer(id, index[2], 'accesses', 'index on table');
      continue;
    }
    const trigger = text.match(CREATE_TRIGGER);
    if (trigger?.[1] && trigger[3]) {
      const timing = (trigger[2] ?? '').replace(/\s+/g, ' ').trim();
      const id = addNode('trigger', trigger[1], statement, {
        table: unqualify(trigger[3]),
        event: timing,
      });
      refer(id, trigger[3], 'accesses', 'trigger fires on table');
      for (const target of tablesInBody(trigger[4] ?? ''))
        refer(id, target, 'queries', 'trigger body reads or writes');
      continue;
    }
    const alter = text.match(ALTER_TABLE);
    if (alter?.[1]) {
      const action = (alter[2] ?? '').trim();
      const renamed = action.match(new RegExp(String.raw`^RENAME\s+TO\s+(${QUALIFIED})`, 'i'));
      if (renamed?.[1]) renames.push({ from: nameKey(alter[1]), to: nameKey(renamed[1]) });
      const verb = action.match(/^\w+(?:\s+(?:COLUMN|CONSTRAINT|TO))?/i)?.[0] ?? 'ALTER';
      refer(filePath, alter[1], 'accesses', `migration: ALTER TABLE ${verb.toUpperCase()}`);
      const target = action.match(REFERENCES);
      if (target?.[1]) refer(filePath, target[1], 'accesses', 'migration: foreign key references');
      continue;
    }
    const drop = text.match(DROP_OBJECT);
    if (drop?.[1] && drop[2]) {
      // A dropped index or trigger names no table; only tables and views link.
      if (/^(?:TABLE|VIEW)$/i.test(drop[1]))
        refer(filePath, drop[2], 'accesses', `migration: DROP ${drop[1].toUpperCase()}`);
      continue;
    }
    if (!NON_SCHEMA_STATEMENT.test(text)) unrecognizedStatements++;
  }
  return { filePath, nodes: [...nodes.values()], references, renames, unrecognizedStatements };
}

/**
 * Link every SQL file's table references to the table and view nodes the
 * indexed SQL files define. A definition in the referencing file wins; a name
 * defined in exactly one other file links with import-scoped confidence; a
 * name defined in several files links to each at ambiguous confidence.
 * `ALTER TABLE … RENAME TO` makes the new name resolve to the renamed table.
 *
 * @param extractions - Every SQL file's extraction from this run
 * @param graph - Graph that already holds the extracted nodes
 * @returns How many references resolved and how many stayed unlinked
 * @example
 * ```ts
 * const { linked, unresolved } = linkSqlReferences([extractSql('a.sql', sql)], graph);
 * ```
 */
export function linkSqlReferences(
  extractions: Iterable<SqlExtraction>,
  graph: { addRelation(rel: GraphRelation): void },
): SqlLinkResult {
  const all = [...extractions];
  const definitions = new Map<string, GraphNode[]>();
  for (const extraction of all)
    for (const node of extraction.nodes) {
      const sqlKind = node.meta?.['sqlKind'];
      if (sqlKind !== 'table' && sqlKind !== 'view') continue;
      const key = node.name.toLowerCase();
      definitions.set(key, [...(definitions.get(key) ?? []), node]);
    }
  for (const extraction of all)
    for (const { from, to } of extraction.renames) {
      const renamed = definitions.get(from);
      if (renamed && !definitions.has(to)) definitions.set(to, renamed);
    }
  let linked = 0;
  let unresolved = 0;
  for (const extraction of all)
    for (const reference of extraction.references) {
      const candidates = definitions.get(reference.target) ?? [];
      const local = candidates.filter((node) => node.filePath === extraction.filePath);
      const targets = local.length ? local : candidates;
      if (targets.length === 0) {
        unresolved++;
        continue;
      }
      const confidence = local.length ? 0.95 : targets.length === 1 ? 0.9 : 0.5;
      linked++;
      for (const target of targets) {
        if (target.id === reference.source) continue;
        graph.addRelation({
          source: reference.source,
          target: target.id,
          type: reference.type,
          confidence,
          confidenceLabel: confidenceLabelFromNumeric(confidence),
          reason: reference.reason,
        });
      }
    }
  return { linked, unresolved };
}
