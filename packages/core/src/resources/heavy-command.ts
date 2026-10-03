/**
 * Heavy-command planner for the provider hook (`cleo hook heavy-command`).
 *
 * An agent harness hands the hook the shell command line an agent is about to
 * run. This module finds the heavy commands in it (test runners, compilers,
 * builds, installs) and rewrites each one to `cleo run --wait --class <c> --`,
 * so it is admitted through the machine-wide ResourceGovernor like every other
 * heavy job. Recognition is {@link looksHeavy} / {@link resolveRunClass} from
 * the dependency-free `run-class.ts` (the same code `cleo run` uses to infer
 * its class); this module only adds the shell structure around them.
 *
 * The rewrite never changes what the line does. It wraps the heavy simple
 * command IN PLACE and leaves every operator to the agent's own shell, so
 * pipelines, `pipefail`, `|&`, `&>`, globs and the `time` keyword keep their
 * meaning in whatever shell runs the line (zsh, bash, dash):
 *
 * - `pnpm test | tail` → `cleo run … -- pnpm test | tail`
 * - `pnpm test &> out.log` → `cleo run … -- pnpm test &> out.log`
 * - `cd x && pnpm test` → `cd x && cleo run … -- pnpm test` (the `cd` still
 *   moves the agent's shell)
 * - `CI=1 pnpm test` → `CI=1 cleo run … -- pnpm test` (the assignment reaches
 *   `cleo run`, which passes its environment on)
 *
 * The prefix asks `cleo run` for `--passthrough`: the child keeps the line's
 * stdin, stdout and stderr, and its exit code comes back unchanged. Only the
 * prefix is inserted; every other byte of the line stays as written.
 *
 * A heavy command is only reported (`warn`), never rewritten, when it runs in
 * a subshell, inside `$(…)` or backticks, as a background job (`&`), inside a
 * compound command (`if`, `for`, `while`, `case`, `{ …; }`, `!`), reads a
 * heredoc, or shares a pipeline with another heavy command (both would start
 * at once and could wait on each other through the pipe).
 *
 * What counts as heavy is entirely `run-class`'s call: only the command word
 * counts (`git commit -m vitest` and `grep -rn tsc .` never do), and
 * `--version`/`--help` and watch/dev/serve modes are never heavy, because a
 * job that never exits would hold a slot forever.
 *
 * @module resources/heavy-command
 * @task T12983
 * @epic T12978
 */

import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  HeavyCommandHookMode,
  HeavyCommandPlan,
  HeavyCommandSegment,
  ResourceClass,
} from '@cleocode/contracts';
import { looksHeavy, resolveRunClass } from './run-class.js';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** One shell word, with what the planner needs to know about it. */
interface Word {
  readonly kind: 'word';
  readonly start: number;
  readonly end: number;
  /** Value after quote removal; expansions are left verbatim. */
  readonly value: string;
  /** Contains a `$` or backtick expansion outside single quotes. */
  readonly expands: boolean;
  /** Starts with an unquoted `NAME=`: an assignment in command position. */
  readonly assignment: boolean;
  /** Entirely unquoted and unescaped (a reserved word can only be bare). */
  readonly bare: boolean;
}

/** A control or redirection operator. */
interface Op {
  readonly kind: 'op';
  readonly start: number;
  readonly end: number;
  readonly op: string;
}

type Token = Word | Op;

/** The lexed form of a command line (or of one `$(…)` body). */
interface Lexed {
  /** The text the token offsets index into. */
  readonly src: string;
  readonly tokens: readonly Token[];
  /** Command substitution bodies, lexed the same way. */
  readonly substitutions: readonly Lexed[];
  /** Offset just past the lexed text (past the closing `)` in paren mode). */
  readonly end: number;
  /** Set when the text is not valid shell (unterminated quote or `$(`). */
  readonly error: string | null;
}

/** Operators, longest first so a prefix never shadows a longer one. */
const OPERATORS = [
  ';;&',
  '&>>',
  '<<<',
  '<<-',
  '&&',
  '||',
  ';;',
  ';&',
  '|&',
  '&>',
  '<<',
  '>>',
  '<&',
  '>&',
  '<>',
  '>|',
  '&',
  '|',
  ';',
  '<',
  '>',
  '(',
  ')',
];

const OPERATOR_START = new Set(['|', '&', ';', '<', '>', '(', ')']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mutable word under construction. */
interface Draft {
  start: number;
  value: string;
  expands: boolean;
  assignment: boolean;
  bare: boolean;
}

/** A heredoc whose body starts after the next newline. */
interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

/**
 * Lex `src` from `from` the way a POSIX shell tokenises it. In `paren` mode
 * (a `$(…)` body) lexing stops at the unmatched `)`.
 */
function lexShell(src: string, from: number, mode: 'top' | 'paren'): Lexed {
  const tokens: Token[] = [];
  const substitutions: Lexed[] = [];
  const pending: PendingHeredoc[] = [];
  let heredocDelimiterNext: { stripTabs: boolean } | null = null;
  let depth = 0;
  // Asserted so control flow does not narrow it to `null`: the closures below assign it.
  let cur = null as Draft | null;
  let i = from;

  const fail = (error: string): Lexed => ({ src, tokens, substitutions, end: src.length, error });
  const begin = (at: number): Draft => {
    cur ??= {
      start: at,
      value: '',
      expands: false,
      assignment: false,
      bare: true,
    };
    return cur;
  };
  const finish = (at: number): void => {
    if (cur === null) return;
    const word: Word = {
      kind: 'word',
      start: cur.start,
      end: at,
      value: cur.value,
      expands: cur.expands,
      assignment: cur.assignment,
      bare: cur.bare,
    };
    tokens.push(word);
    cur = null;
    if (heredocDelimiterNext !== null) {
      pending.push({ delimiter: word.value, stripTabs: heredocDelimiterNext.stripTabs });
      heredocDelimiterNext = null;
    }
  };
  /** Skip heredoc bodies that start at `at` (just past a newline). */
  const skipHeredocs = (at: number): number => {
    let pos = at;
    for (const doc of pending.splice(0)) {
      while (pos < src.length) {
        const nl = src.indexOf('\n', pos);
        const lineEnd = nl === -1 ? src.length : nl;
        let line = src.slice(pos, lineEnd);
        if (doc.stripTabs) line = line.replace(/^\t+/, '');
        pos = nl === -1 ? src.length : nl + 1;
        if (line === doc.delimiter) break;
      }
    }
    return pos;
  };
  /** Consume a `$` construct at `at`; returns the offset past it. */
  const dollar = (at: number, draft: Draft): number | Lexed => {
    const next = src[at + 1];
    if (next === '(' && src[at + 2] === '(') {
      const close = matchArithmetic(src, at + 3);
      if (close === -1) return fail('unterminated $((');
      draft.value += src.slice(at, close);
      draft.expands = true;
      return close;
    }
    if (next === '(') {
      const body = lexShell(src, at + 2, 'paren');
      if (body.error !== null) return body;
      substitutions.push(body);
      draft.value += src.slice(at, body.end);
      draft.expands = true;
      return body.end;
    }
    if (next === '{') {
      const close = src.indexOf('}', at + 2);
      if (close === -1) return fail('unterminated ${');
      draft.value += src.slice(at, close + 1);
      draft.expands = true;
      return close + 1;
    }
    if (next === "'") {
      let j = at + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return fail("unterminated $'");
      draft.value += src.slice(at + 2, j);
      draft.bare = false;
      return j + 1;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?$!#@*-])/.exec(src.slice(at + 1));
    if (name) {
      draft.value += `$${name[0]}`;
      draft.expands = true;
      return at + 1 + name[0].length;
    }
    draft.value += '$';
    return at + 1;
  };
  /** Consume a backtick substitution at `at`; returns the offset past it. */
  const backtick = (at: number, draft: Draft): number | Lexed => {
    let j = at + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) return fail('unterminated backtick');
    substitutions.push(lexShell(src.slice(at + 1, j).replace(/\\`/g, '`'), 0, 'top'));
    draft.value += src.slice(at, j + 1);
    draft.expands = true;
    return j + 1;
  };

  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t') {
      finish(i);
      i++;
    } else if (ch === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
      } else if (i + 1 >= src.length) {
        return fail('trailing backslash');
      } else {
        const d = begin(i);
        d.value += src[i + 1];
        d.bare = false;
        i += 2;
      }
    } else if (ch === '\n') {
      finish(i);
      tokens.push({ kind: 'op', start: i, end: i + 1, op: '\n' });
      i = pending.length > 0 ? skipHeredocs(i + 1) : i + 1;
    } else if (ch === '#' && cur === null) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) return fail('unterminated single quote');
      const d = begin(i);
      d.value += src.slice(i + 1, close);
      d.bare = false;
      i = close + 1;
    } else if (ch === '"') {
      const d = begin(i);
      d.bare = false;
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const c = src[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1] as string)) {
          if (src[j + 1] !== '\n') d.value += src[j + 1];
          j += 2;
        } else if (c === '$') {
          const r = dollar(j, d);
          if (typeof r !== 'number') return r;
          j = r;
        } else if (c === '`') {
          const r = backtick(j, d);
          if (typeof r !== 'number') return r;
          j = r;
        } else {
          d.value += c;
          j++;
        }
      }
      if (!closed) return fail('unterminated double quote');
      i = j + 1;
    } else if (ch === '$') {
      const r = dollar(i, begin(i));
      if (typeof r !== 'number') return r;
      i = r;
    } else if (ch === '`') {
      const r = backtick(i, begin(i));
      if (typeof r !== 'number') return r;
      i = r;
    } else if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      // Process substitution: one word.
      const d = begin(i);
      const body = lexShell(src, i + 2, 'paren');
      if (body.error !== null) return body;
      substitutions.push(body);
      d.value += src.slice(i, body.end);
      d.expands = true;
      i = body.end;
    } else if (OPERATOR_START.has(ch)) {
      if (mode === 'paren' && ch === ')' && depth === 0) {
        finish(i);
        return { src, tokens, substitutions, end: i + 1, error: null };
      }
      // `2>&1`: an all-digit word glued to a redirection is its fd.
      let start = i;
      if ((ch === '<' || ch === '>') && cur?.bare && /^\d+$/.test(cur.value)) {
        start = cur.start;
        cur = null;
      } else {
        finish(i);
      }
      const op = OPERATORS.find((o) => src.startsWith(o, i)) as string;
      if (op === '(') depth++;
      if (op === ')') depth--;
      if (op === '<<' || op === '<<-') heredocDelimiterNext = { stripTabs: op === '<<-' };
      tokens.push({ kind: 'op', start, end: i + op.length, op });
      i += op.length;
    } else if (ch === '=' && cur !== null && !cur.assignment && cur.bare && NAME.test(cur.value)) {
      cur.assignment = true;
      cur.value += ch;
      i++;
    } else {
      const d = begin(i);
      d.value += ch;
      i++;
    }
  }
  finish(src.length);
  if (mode === 'paren') return fail('unterminated $(');
  return { src, tokens, substitutions, end: src.length, error: null };
}

/** Offset past the `))` closing a `$((` that opened before `from`, or -1. */
function matchArithmetic(src: string, from: number): number {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') {
      if (depth === 0) return src[j + 1] === ')' ? j + 2 : -1;
      depth--;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

/** Shell words that open or continue a compound command. */
const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'case',
  'esac',
  'while',
  'until',
  'for',
  'in',
  'select',
  'function',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/** Short `--class` names for the classes {@link resolveRunClass} infers. */
const CLASS_ALIAS: Readonly<Partial<Record<ResourceClass, string>>> = {
  'test-run': 'test',
  typecheck: 'typecheck',
  'scoped-build': 'build',
  'full-build': 'full-build',
  'db-heavy': 'db',
};

function base(token: string): string {
  return token.split('/').pop() ?? token;
}

/** Whether a command is already governed: `cleo run …` or `~/.cleo-heavy/run.sh …`. */
function isGoverned(argv: readonly string[]): boolean {
  const head = argv[0] ?? '';
  if ((base(head) === 'cleo' || base(head) === 'ct') && argv[1] === 'run') return true;
  return head.endsWith('.cleo-heavy/run.sh');
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const REDIRECTIONS = new Set([
  '<',
  '>',
  '>>',
  '<<',
  '<<-',
  '<<<',
  '<&',
  '>&',
  '<>',
  '>|',
  '&>',
  '&>>',
]);
const SEPARATORS = new Set(['&&', '||', ';', '\n', '&', ';;', ';&', ';;&']);
/** Reserved words that open a compound command (in command position). */
const COMPOUND_OPEN = new Set(['if', 'while', 'until', 'for', 'case', 'select', '{', 'function']);
/** Reserved words that close one. */
const COMPOUND_CLOSE = new Set(['fi', 'done', 'esac', '}']);

/** One pipeline stage: its words and whether it reads a heredoc. */
interface Stage {
  readonly words: readonly Word[];
  readonly heredoc: boolean;
}

/** One list element (a pipeline between separators). */
interface Element {
  readonly tokens: readonly Token[];
  /** Ended by `&`: a background job. */
  readonly background: boolean;
  /** Inside, or part of, a subshell or a compound command. */
  readonly nested: boolean;
}

/**
 * Split a token stream into list elements, marking every element that sits in
 * a subshell or compound command. Paren and compound depth are tracked across
 * elements, so `if x; then pnpm test; fi` marks the middle element nested.
 */
function splitElements(tokens: readonly Token[]): Element[] {
  const out: Element[] = [];
  let group: Token[] = [];
  let paren = 0;
  let compound = 0;
  let nested = false;
  let atCommand = true;
  const flush = (background: boolean): void => {
    if (group.length > 0) out.push({ tokens: group, background, nested });
    group = [];
    nested = paren > 0 || compound > 0;
    atCommand = true;
  };
  for (const t of tokens) {
    if (t.kind === 'op' && SEPARATORS.has(t.op)) {
      flush(t.op === '&');
      continue;
    }
    group.push(t);
    if (t.kind === 'op') {
      if (t.op === '(' || t.op === ')') {
        nested = true;
        paren += t.op === '(' ? 1 : -1;
      }
      if (t.op === '(' || t.op === '|' || t.op === '|&') atCommand = true;
      continue;
    }
    if (!atCommand) continue;
    if (t.bare && RESERVED.has(t.value)) {
      nested = true;
      if (COMPOUND_OPEN.has(t.value)) compound++;
      if (COMPOUND_CLOSE.has(t.value)) compound--;
    } else if (!t.assignment) {
      atCommand = false;
    }
  }
  flush(false);
  // An unbalanced line is not one this planner understands: treat it all as nested.
  if (paren !== 0 || compound !== 0) return out.map((e) => ({ ...e, nested: true }));
  return out;
}

function splitStages(tokens: readonly Token[]): Stage[] {
  const stages: Stage[] = [];
  let words: Word[] = [];
  let heredoc = false;
  let skipNext = false;
  for (const t of tokens) {
    if (t.kind === 'op') {
      if (t.op === '|' || t.op === '|&') {
        stages.push({ words, heredoc });
        words = [];
        heredoc = false;
      } else if (REDIRECTIONS.has(t.op)) {
        heredoc ||= t.op === '<<' || t.op === '<<-';
        skipNext = true;
      }
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    words.push(t);
  }
  stages.push({ words, heredoc });
  return stages;
}

/** The stage's words from its command word on (leading assignments dropped). */
function commandWords(stage: Stage): readonly Word[] {
  let k = 0;
  while (k < stage.words.length && (stage.words[k] as Word).assignment) k++;
  return stage.words.slice(k);
}

/** Drop a leading `time` keyword and its flags; returns the words after them. */
function afterTime(words: readonly Word[]): readonly Word[] {
  if (words[0]?.bare !== true || words[0].value !== 'time') return words;
  let k = 1;
  while (k < words.length && (words[k] as Word).value.startsWith('-')) k++;
  return words.slice(k);
}

function values(words: readonly Word[]): string[] {
  return words.map((w) => w.value);
}

/**
 * The `cleo run` flag that keeps the child's stdio and exit code (#1777). The
 * hook's rewrite depends on it: without it `cleo run` prints its own envelope
 * on stdout, which a pipe or redirection would capture.
 */
export const CLEO_RUN_PASSTHROUGH_FLAG = '--passthrough';

/** Options for {@link planHeavyCommand}. */
export interface HeavyCommandPlanOptions {
  /** The directory the command line starts in (class inference). */
  readonly cwd: string;
  /**
   * `cleo run --wait --timeout` in seconds: how long a governed command may
   * queue before it gives up with `E_RESOURCE_DEFERRED`. Omitted: `--wait`
   * with `cleo run`'s own default.
   */
  readonly waitTimeoutSec?: number;
}

/** The `cleo run` prefix for one governed command. */
function governedPrefix(runClass: string, waitTimeoutSec: number | undefined): string {
  const timeout = waitTimeoutSec === undefined ? '' : ` --timeout ${waitTimeoutSec}`;
  return `cleo run --wait ${CLEO_RUN_PASSTHROUGH_FLAG}${timeout} --class ${runClass} --`;
}

interface Analysis {
  readonly segments: HeavyCommandSegment[];
  readonly edits: { readonly at: number; readonly text: string }[];
  readonly blockers: string[];
}

/** The literal source of a run of words (first word start to last word end). */
function spanOf(src: string, words: readonly Word[]): string {
  const first = words[0];
  const last = words[words.length - 1];
  return first && last ? src.slice(first.start, last.end) : '';
}

/** Where an element starts and ends in its source. */
function elementSpan(element: Element): { readonly start: number; readonly end: number } {
  const first = element.tokens[0] as Token;
  const last = element.tokens[element.tokens.length - 1] as Token;
  return { start: first.start, end: last.end };
}

function analyse(lexed: Lexed, opts: HeavyCommandPlanOptions, depth: number): Analysis {
  const { src } = lexed;
  const result: Analysis = { segments: [], edits: [], blockers: [] };
  for (const sub of lexed.substitutions) {
    const inner = analyse(sub, opts, depth + 1);
    result.segments.push(...inner.segments);
    result.blockers.push(...inner.blockers);
  }
  let cwd = opts.cwd;
  for (const element of splitElements(lexed.tokens)) {
    const stages = splitStages(element.tokens);
    const span = elementSpan(element);
    const text = src.slice(span.start, span.end);

    // Track `cd <literal>` so class inference sees the directory it runs in.
    const simple = stages.length === 1 ? commandWords(stages[0] as Stage) : [];
    if (simple[0]?.value === 'cd' && simple.length <= 2 && !simple.some((w) => w.expands)) {
      const target = simple[1]?.value ?? '~';
      if (target !== '-') {
        cwd = target.startsWith('~')
          ? join(homedir(), target.slice(1))
          : isAbsolute(target)
            ? target
            : resolve(cwd, target);
      }
      continue;
    }

    // Reserved words are skipped only to find a heavy command to report.
    const runWords = (s: Stage): readonly Word[] => {
      const words = commandWords(s);
      let k = 0;
      while (k < words.length && (words[k] as Word).bare && RESERVED.has((words[k] as Word).value))
        k++;
      return afterTime(words.slice(k));
    };
    if (stages.some((s) => isGoverned(values(runWords(s))))) continue;
    const heavy = stages.filter((s) => looksHeavy(values(runWords(s))));
    if (heavy.length === 0) continue;

    for (const stage of heavy) {
      const words = runWords(stage);
      const resolved = resolveRunClass(undefined, values(words), cwd);
      const runClass = CLASS_ALIAS[resolved] ?? 'build';
      const prefix = governedPrefix(runClass, opts.waitTimeoutSec);
      const blocker =
        depth > 0
          ? 'it runs inside a command substitution'
          : element.background
            ? 'it runs as a background job (&)'
            : element.nested
              ? 'it runs inside a subshell or a compound command'
              : stage.heredoc
                ? 'it reads a heredoc'
                : heavy.length > 1
                  ? 'two heavy commands share one pipeline and would start at once'
                  : null;
      if (blocker !== null) {
        // Hint only: the heavy command itself in its governed form.
        result.segments.push({
          text,
          runClass,
          governed: `${prefix} ${spanOf(src, words)}`,
          argv: values(words),
        });
        result.blockers.push(blocker);
        continue;
      }
      // In place: the prefix goes right before the command word, after any
      // assignments, redirections or `time` keyword in front of it.
      const at = (words[0] as Word).start;
      const governed = `${src.slice(span.start, at)}${prefix} ${src.slice(at, span.end)}`;
      result.segments.push({ text, runClass, governed, argv: values(words) });
      result.edits.push({ at, text: `${prefix} ` });
    }
  }
  return result;
}

/**
 * Decide what the hook does with one shell command line.
 *
 * @param command - the command line as the agent wrote it.
 * @param opts - where it starts, and how long a governed command may queue.
 * @returns `none`, a `rewrite` with every heavy command governed in place, or
 *   a `warn` when a heavy command sits where a rewrite could change behaviour.
 *
 * @example
 * ```ts
 * planHeavyCommand('cd pkg && pnpm vitest run a.test.ts', { cwd: '/repo' });
 * // { action: 'rewrite',
 * //   command: 'cd pkg && cleo run --wait --passthrough --class test -- pnpm vitest run a.test.ts', … }
 * planHeavyCommand('npx tsc --noEmit 2>&1 | head -50', { cwd: '/repo', waitTimeoutSec: 300 });
 * // command: 'cleo run --wait --passthrough --timeout 300 --class build -- npx tsc --noEmit 2>&1 | head -50'
 * planHeavyCommand('for f in a b; do pnpm test $f; done', { cwd: '/repo' }).action; // 'warn'
 * ```
 */
export function planHeavyCommand(command: string, opts: HeavyCommandPlanOptions): HeavyCommandPlan {
  const lexed = lexShell(command, 0, 'top');
  if (lexed.error !== null) return { action: 'none' };
  const { segments, edits, blockers } = analyse(lexed, opts, 0);
  if (segments.length === 0) return { action: 'none' };
  if (blockers.length > 0) {
    return { action: 'warn', reason: [...new Set(blockers)].join('; '), segments };
  }
  let rewritten = command;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    rewritten = rewritten.slice(0, edit.at) + edit.text + rewritten.slice(edit.at);
  }
  return { action: 'rewrite', command: rewritten, segments };
}

// ---------------------------------------------------------------------------
// Mode, availability, pressure
// ---------------------------------------------------------------------------

const MODES = new Set<string>(['rewrite', 'warn', 'off']);

/**
 * Whether `value` (trimmed, any case) names a hook mode. The hook reads the
 * config only when the environment variable does not.
 *
 * @param value - e.g. `process.env.CLEO_HEAVY_COMMAND_HOOK`.
 */
export function isHeavyCommandHookMode(value: string | undefined): boolean {
  return value !== undefined && MODES.has(value.trim().toLowerCase());
}

/**
 * The hook mode: the `CLEO_HEAVY_COMMAND_HOOK` environment variable, else the
 * `resources.heavyCommandHook` config value, else `rewrite`. Unknown values
 * are ignored.
 *
 * @param envValue - `process.env.CLEO_HEAVY_COMMAND_HOOK`.
 * @param configValue - the resolved `resources.heavyCommandHook`.
 * @returns the effective mode.
 */
export function resolveHeavyHookMode(
  envValue: string | undefined,
  configValue: string | undefined,
): HeavyCommandHookMode {
  for (const v of [envValue, configValue]) {
    const mode = v?.trim().toLowerCase();
    if (mode !== undefined && MODES.has(mode)) return mode as HeavyCommandHookMode;
  }
  return 'rewrite';
}

/**
 * `resources.heavyCommandHook` from the merged global + project config, or
 * `undefined` when it is unset, invalid or unreadable. `cleo init` and
 * `cleo upgrade` install (or, for `off`, remove) the hook from this value
 * alone; the environment variable only switches the hook at run time.
 *
 * @param projectRoot - the project whose `.cleo/config.json` to read.
 */
export async function configuredHeavyHookMode(
  projectRoot: string,
): Promise<HeavyCommandHookMode | undefined> {
  try {
    const { getConfigValue } = await import('../config/registry.js');
    const value = await getConfigValue<string>('resources.heavyCommandHook', { projectRoot });
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
    return mode !== undefined && MODES.has(mode) ? (mode as HeavyCommandHookMode) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project whose config the hook reads: the nearest directory at or above
 * `cwd` holding a `.cleo/` directory, so an opt-out in the project config
 * still applies when the agent's shell sits in a subdirectory. Falls back to
 * `cwd` (the global config still applies there). Never walks into `$HOME`.
 *
 * @param cwd - the directory the command line starts in.
 */
export function heavyHookProjectRoot(cwd: string): string {
  const home = homedir();
  let dir = resolve(cwd);
  for (;;) {
    if (dir === home) break;
    if (existsSync(join(dir, '.cleo'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/**
 * Whether `name` resolves to an executable on `pathValue` (a `PATH` string).
 * A rewrite to `cleo run` only helps if the agent's shell can find `cleo`.
 *
 * @param name - the executable name, e.g. `cleo`.
 * @param pathValue - the `PATH` to search.
 */
export function executableOnPath(name: string, pathValue: string | undefined): boolean {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // Not here.
    }
  }
  return false;
}

/**
 * One context line when the machine is under pressure (`hold` = yellow,
 * `backoff` = red), or `null` when it is fine or the sample fails. Takes one
 * bounded sample through the platform backend (one `sysctl` exec on macOS,
 * `/proc` reads on Linux).
 *
 * @param timeoutMs - give up and return `null` after this long.
 */
export async function heavyPressureNotice(timeoutMs = 1500): Promise<string | null> {
  try {
    const { classifyPressure, defaultResourceBackend } = await import('./monitor.js');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), timeoutMs);
      timer.unref();
    });
    const sample = await Promise.race([defaultResourceBackend().sample(), timeout]);
    clearTimeout(timer);
    if (sample === null) return null;
    const { state, reason } = classifyPressure(sample);
    if (state === 'ok') return null;
    const level = state === 'backoff' ? 'red' : 'yellow';
    return (
      `[cleo] Machine pressure is ${level} (${reason}). Heavy commands queue for the shared budget: ` +
      'run single test files, and prefer CI as evidence (cleo verify <id> --gate testsPassed --evidence "ci:<pr>").'
    );
  } catch {
    return null;
  }
}
