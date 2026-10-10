/**
 * Ask-enforce classifier: does an ended turn ask the owner something in prose?
 *
 * Pure and deterministic, run by the `cleo hook ask-enforce` Stop hook on every
 * turn end, so it is regex-only with no I/O and no model call. It is tuned
 * against false positives: anything that is not the agent's own closing prose
 * (code, quotes, headings, tables, URLs, a research report's open-questions
 * list) is removed first, only the reply's tail is read, and a question
 * attributed to someone else or answered on the spot does not count. Every
 * doubt resolves to `allow`; a corpus test pins the false-positive rate at 0.
 *
 * Design: `cleo docs fetch t13420-ask-enforce-stop-hook-design`.
 *
 * @task T13420
 * @epic T13418
 */

import type { AskEnforceInput, AskEnforceVerdict } from '@cleocode/contracts';

/** Longest excerpt quoted back to the agent in the block reason. */
const EXCERPT_MAX = 160;

/** The tail read is the last two paragraphs, or this many characters if longer. */
const TAIL_MIN_CHARS = 600;

/** A question addressed to the reader (second person, or asking leave to act). */
const READER_DIRECTED =
  /\b(you|your|yours|should i|shall i|can i|may i|do i|should we|shall we|want me|would you|could you|which (?:option|approach|one|path|way|of these)|ok(?:ay)? (?:to|if|with)|is (?:it|that) ok(?:ay)?|good to go|go ahead|proceed|approve|confirm)\b/i;

/** A question reported, not asked ("team-lead asked whether …?"). */
const ATTRIBUTED = /\b(asked|asks|wondered|wonders|wants to know|question (?:was|is) whether)\b/i;

/** An immediate answer that makes the question before it rhetorical. */
const SELF_ANSWER =
  /^(because|since|it(?:'s| is| was)?|that(?:'s| is)?|this|the answer|answer:|short answer|yes|no|nope|not|none|never)\b/i;

/** A question that opens rhetorically ("Did you know …?", "Wondering if …?"). */
const RHETORICAL_OPENER = /^(?:did you know|ever wonder(?:ed)?|wondering (?:if|whether|why))\b/i;

/** Requests for an owner choice or approval written without a question mark. */
const WRITTEN_DECISION: readonly RegExp[] = [
  /\b(?:let me know|tell me) (?:which|whether|if|what|how)\b/i,
  /\bplease (?:confirm|choose|pick|approve|decide|select|advise)\b/i,
  /\b(?:awaiting|waiting (?:for|on)) your (?:approval|decision|go-ahead|confirmation|input|call|answer)\b/i,
  /\byour call\b/i,
  /\b(?:decision needed|needs? (?:a|your) decision|needs? your (?:approval|input|go-ahead|sign-off))\b/i,
  /\breply with (?:a|b|yes|no|1|2|the option)\b/i,
];

/** A written request reported from someone else ("the owner said please confirm"). */
const REPORTED_SPEECH = /\b(said|wrote|told|requested|asked)\b/i;

/** A heading that introduces task-output questions, not questions to the reader. */
const OPEN_QUESTIONS_HEADING =
  /^#{1,6}\s+(?:open questions|unresolved questions|questions for (?:later|follow-?up)|future questions|faq)\b/i;

/**
 * Remove everything that is not the agent's own prose: fenced and inline code,
 * blockquotes, open-questions sections, headings, table rows, URLs and quoted
 * spans.
 */
function neutralise(text: string): string {
  const withoutFences = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '');
  const kept: string[] = [];
  let inOpenQuestions = false;
  for (const line of withoutFences.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inOpenQuestions = OPEN_QUESTIONS_HEADING.test(line);
      kept.push('');
      continue;
    }
    if (inOpenQuestions) continue;
    if (/^\s*>/.test(line) || /^\s*\|/.test(line)) {
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”/g, ' ');
}

/** The reply's tail: its last two paragraphs, or its last {@link TAIL_MIN_CHARS} characters if longer. */
function tailParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const tail = paragraphs.slice(-2);
  let size = tail.reduce((n, p) => n + p.length, 0);
  for (let i = paragraphs.length - 3; i >= 0 && size < TAIL_MIN_CHARS; i--) {
    const p = paragraphs[i] as string;
    tail.unshift(p);
    size += p.length;
  }
  return tail;
}

/** Split a paragraph into sentences; list items and lines count as their own. */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/\n+/)
    .flatMap((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split(/(?<=[.?!])\s+/))
    .map((s) => s.replace(/[*_]+/g, '').trim())
    .filter((s) => s.length > 0);
}

function excerpt(sentence: string): string {
  return sentence.length <= EXCERPT_MAX ? sentence : `${sentence.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Classify one ended turn.
 *
 * @param input - The final reply, the turn's tool calls and the ask-tool names.
 * @returns `block` when the reply's tail asks the owner something in prose and
 *   the turn made no ask-tool call; `allow` otherwise, including on any doubt.
 *
 * @example
 * ```typescript
 * classifyOwnerAsk({
 *   lastAssistantText: 'Tests pass. Should I merge it?',
 *   turnToolCalls: [],
 *   askToolNames: ['AskUserQuestion'],
 * }).verdict; // "block"
 * ```
 */
export function classifyOwnerAsk(input: AskEnforceInput): AskEnforceVerdict {
  const text = input.lastAssistantText?.trim();
  if (!text) return { verdict: 'allow', signal: 'no-text', excerpt: null };

  const askNames = new Set(input.askToolNames);
  if (input.turnToolCalls.some((name) => askNames.has(name))) {
    return { verdict: 'allow', signal: 'asked', excerpt: null };
  }
  if (input.stopHookActive === true || (input.blocksThisTurn ?? 0) >= 1) {
    return { verdict: 'allow', signal: 'loop-guard', excerpt: null };
  }
  if (/\bhitl\.request\b/.test(text) && /"question"\s*:/.test(text)) {
    return { verdict: 'allow', signal: 'hitl-request', excerpt: null };
  }

  for (const paragraph of tailParagraphs(neutralise(text))) {
    const list = sentences(paragraph);
    for (let i = 0; i < list.length; i++) {
      const sentence = list[i] as string;
      if (/\?["')\]]*$/.test(sentence)) {
        if (!READER_DIRECTED.test(sentence) || ATTRIBUTED.test(sentence)) continue;
        if (RHETORICAL_OPENER.test(sentence)) continue;
        const next = list[i + 1];
        if (next !== undefined && !next.endsWith('?') && SELF_ANSWER.test(next)) continue;
        return { verdict: 'block', signal: 'prose-question', excerpt: excerpt(sentence) };
      }
      if (WRITTEN_DECISION.some((re) => re.test(sentence)) && !REPORTED_SPEECH.test(sentence)) {
        return { verdict: 'block', signal: 'written-decision', excerpt: excerpt(sentence) };
      }
    }
  }
  return { verdict: 'allow', signal: 'clean', excerpt: null };
}

/**
 * The block reason the agent reads: re-ask with the harness ask tool.
 *
 * @param verdict - A `block` verdict from {@link classifyOwnerAsk}.
 * @param askToolName - The provider's ask tool, or `null` for the `hitl.request` fallback.
 * @returns One paragraph telling the agent how to re-ask.
 */
export function askEnforceReason(verdict: AskEnforceVerdict, askToolName: string | null): string {
  const quoted = verdict.excerpt ? ` ("${verdict.excerpt}")` : '';
  const how = askToolName
    ? `Re-ask it with the \`${askToolName}\` tool`
    : 'Re-ask it as one LAFS `hitl.request` envelope `{question, options[{label, description}], recommended}`';
  return `CLEO ask-enforce: your reply ends with an owner question or decision in prose${quoted}. ${how}: 2-4 options, recommended first, each with a label and a description of what happens and its trade-offs. Keep the rest of your reply. If the question was rhetorical, restate it without asking.`;
}
