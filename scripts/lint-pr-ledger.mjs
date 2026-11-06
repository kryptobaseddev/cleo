#!/usr/bin/env node
/**
 * Durability ledger check (T14247, SG-CLEO-DURABILITY plan §9.6, council change 6).
 *
 * The durability saga replaces rules with models, so every addition is
 * written down with the rule it deletes, and "net-subtractive" is counted,
 * not claimed. One grammar serves PR bodies and task descriptions, and
 * `cleo doctor durability` (T14249) and the per-engine caps (T14248) read it
 * through {@link parseLedger}. This check is a plain parser: it judges only
 * the pairing rule below and holds no caps or policy.
 *
 * Grammar. A line `Ledger:` starts a ledger. Items follow on the same line,
 * separated by `;`, and/or one per bullet line (`- …` or `* …`) directly
 * below it:
 *
 *   Ledger: adds model <name>; deletes <rule>
 *   Ledger:
 *   - adds <kind> <name> -> deletes <rule>
 *   - adds part <name>
 *   - deletes <rule>
 *   - adds nothing / deletes nothing
 *
 *   <kind>   an exception: verdict | code | key | flag | registry | gate
 *            not an exception: model (a model: a receipt, a census, measured
 *            charges) | part (a helper, predicate, job, report, verb or field
 *            that adds no rule)
 *
 * The pairing rule: an exception must name the rule it deletes
 * (`-> deletes <rule>`); a model or a part needs no pairing.
 *
 * Scope (CI has no task store): a PR is a durability PR when its body has a
 * `Ledger:` line or a `Durability:` line (e.g. `Durability: T14239`). A
 * durability PR fails when it has no ledger, an item does not parse, or an
 * exception names no deletion. Every other PR passes untouched.
 *
 * Inputs (environment): PR_BODY. Exit 0 when the PR passes or is not a
 * durability PR, 1 when flagged.
 *
 * @task T14247
 */

import { isMain } from './lib/is-main.mjs';

/** Kinds that add an exception: each must be paired with the rule it deletes. */
export const EXCEPTION_KINDS = Object.freeze([
  'verdict',
  'code',
  'key',
  'flag',
  'registry',
  'gate',
]);

/** Kinds that add no rule: a model, or a part (helper, predicate, job, report, verb, field). */
export const NON_EXCEPTION_KINDS = Object.freeze(['model', 'part']);

const LEDGER_LINE = /^[ \t>]*(?:[-*][ \t]+)?Ledger[ \t]*:[ \t]*(.*)$/i;
const DURABILITY_LINE = /^[ \t>]*(?:[-*][ \t]+)?Durability[ \t]*:/im;
const BULLET_ITEM = /^[ \t>]*[-*][ \t]+((?:adds|deletes)\b.*)$/i;
const ADDS_ITEM = /^adds[ \t]+([a-z]+)[ \t]*(.*?)(?:[ \t]*->[ \t]*deletes[ \t]+(.+))?$/i;
const DELETES_ITEM = /^deletes[ \t]+(.+)$/i;

/**
 * One parsed ledger item.
 *
 * @typedef {{ type: 'add', kind: string, name: string, deletes: string | null, exception: boolean }
 *   | { type: 'delete', rule: string }
 *   | { type: 'none', what: 'adds' | 'deletes' }} LedgerItem
 */

/**
 * Parse one item's text.
 *
 * @param {string} raw - The item, e.g. `adds gate 41 -> deletes the raw removals`.
 * @returns {{ item: LedgerItem | null, error: string | null }}
 */
export function parseLedgerItem(raw) {
  const text = raw
    .replace(/`/g, '')
    .trim()
    .replace(/[.;]+$/, '');
  if (/^(adds|deletes)[ \t]+nothing$/i.test(text)) {
    return { item: { type: 'none', what: /^adds/i.test(text) ? 'adds' : 'deletes' }, error: null };
  }
  const add = ADDS_ITEM.exec(text);
  if (add) {
    const kind = (add[1] ?? '').toLowerCase();
    const name = (add[2] ?? '').trim();
    const deletes = (add[3] ?? '').trim() || null;
    if (!EXCEPTION_KINDS.includes(kind) && !NON_EXCEPTION_KINDS.includes(kind)) {
      return {
        item: null,
        error: `"${text}": "${kind}" is not a kind. Use one of ${[...EXCEPTION_KINDS, ...NON_EXCEPTION_KINDS].join(', ')}.`,
      };
    }
    if (name === '') return { item: null, error: `"${text}": name what it adds.` };
    if (deletes !== null && /^nothing$/i.test(deletes)) {
      return {
        item: null,
        error: `"${text}": "-> deletes nothing" pairs nothing; name the rule it deletes.`,
      };
    }
    return {
      item: { type: 'add', kind, name, deletes, exception: EXCEPTION_KINDS.includes(kind) },
      error: null,
    };
  }
  const del = DELETES_ITEM.exec(text);
  if (del) return { item: { type: 'delete', rule: (del[1] ?? '').trim() }, error: null };
  return {
    item: null,
    error: `"${text}": an item starts with "adds <kind> <name>" or "deletes <rule>".`,
  };
}

/**
 * Parse every ledger in a text (a PR body or a task description).
 *
 * @param {string} text
 * @returns {{ found: boolean, items: LedgerItem[], errors: string[] }}
 */
export function parseLedger(text) {
  const items = [];
  const errors = [];
  let found = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const head = LEDGER_LINE.exec(lines[i] ?? '');
    if (!head) continue;
    found = true;
    const raws = (head[1] ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    while (i + 1 < lines.length) {
      const bullet = BULLET_ITEM.exec(lines[i + 1] ?? '');
      if (!bullet) break;
      raws.push(bullet[1] ?? '');
      i += 1;
    }
    for (const raw of raws) {
      const { item, error } = parseLedgerItem(raw);
      if (item) items.push(item);
      if (error) errors.push(error);
    }
  }
  return { found, items, errors };
}

/**
 * Judge one PR body.
 *
 * @param {string} body
 * @returns {{ durability: boolean, ok: boolean, problems: string[], items: LedgerItem[] }}
 */
export function checkPrLedger(body) {
  const { found, items, errors } = parseLedger(body);
  const durability = found || DURABILITY_LINE.test(body);
  if (!durability) return { durability, ok: true, problems: [], items };
  const problems = [...errors];
  if (!found) {
    problems.push(
      'A durability PR carries a ledger: a "Ledger:" line with its items, e.g. ' +
        '"Ledger: adds gate <name> -> deletes <rule>; adds model <name>; deletes <rule>".',
    );
  } else if (items.length === 0 && errors.length === 0) {
    problems.push(
      'The ledger lists no item; write "adds nothing" / "deletes nothing" when that is the case.',
    );
  }
  for (const item of items) {
    if (item.type === 'add' && item.exception && item.deletes === null) {
      problems.push(
        `adds ${item.kind} ${item.name}: an exception names the rule it deletes ("-> deletes <rule>"), ` +
          'or it is not an exception (mark it "model" or "part").',
      );
    }
  }
  return { durability, ok: problems.length === 0, problems, items };
}

if (isMain(import.meta.url)) {
  const result = checkPrLedger(process.env.PR_BODY ?? '');
  if (!result.durability) {
    process.stdout.write('lint-pr-ledger: not a durability PR (no Ledger:/Durability: line).\n');
    process.exit(0);
  }
  if (result.ok) {
    const adds = result.items.filter((i) => i.type === 'add').length;
    const deletes = result.items.filter(
      (i) => i.type === 'delete' || (i.type === 'add' && i.deletes),
    ).length;
    process.stdout.write(
      `lint-pr-ledger: OK — ${adds} addition(s), ${deletes} deletion(s) (T14247).\n`,
    );
    process.exit(0);
  }
  for (const problem of result.problems) process.stdout.write(`::error::${problem}\n`);
  process.exit(1);
}
