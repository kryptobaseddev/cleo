/**
 * `cleo hook ask-enforce --provider <p>`: the Stop hook that enforces the
 * owner ask-tool rule (T13420).
 *
 * When an agent's turn ends, the harness pipes its Stop payload to this hook.
 * The hook finds the final assistant message and the tool calls made since the
 * last user prompt (from the payload, or from the tail of the transcript it
 * names), asks the core classifier whether the reply asks the owner something
 * in prose without an ask-tool call, and when it does answers in the harness's
 * own protocol to block the stop with a re-ask instruction.
 *
 * Every failure is fail-open: exit 0 with nothing on stdout, so a broken hook
 * never traps a session. The loop guard (`stop_hook_active`, Cursor's
 * `loop_count`) allows the second stop of a turn unconditionally.
 *
 * Providers and their block answers (sources: CAAMP `PROVIDER_ASK_TOOLS` audit,
 * T13419):
 * - `claude-code`, `codex`, `copilot-cli`: `{"decision":"block","reason"}`.
 * - `gemini-cli` (`AfterAgent`): `{"decision":"deny","reason"}`.
 * - `cursor` (`stop`): `{"followup_message"}`, only when `status` is `completed`.
 * - `opencode` (CLEO plugin on `session.idle`): `{"block":true,"reason"}`; the
 *   plugin re-prompts with the reason.
 * - `kimi`: exit 2 with the reason on stderr (Kimi ignores `decision`). Kimi
 *   sends no message or transcript, so the hook allows until it can read one.
 *
 * Loop bound: the harness's own fields (`stop_hook_active`, Cursor's
 * `loop_count`). Kimi allows one stop-hook continuation per turn itself, and
 * the CLEO opencode plugin must send `stop_hook_active: true` on the stop that
 * follows its own re-prompt; neither is installed until that bound is tested.
 *
 * Mode: `CLEO_ASK_ENFORCE` = `block` (default) | `warn` | `off`. `warn` never
 * blocks; Claude Code and Codex show the reason as a `systemMessage`.
 *
 * Design: `cleo docs fetch t13420-ask-enforce-stop-hook-design`.
 *
 * @task T13420
 * @epic T13418
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AskEnforceMode, AskEnforceVerdict, HookJsonValue } from '@cleocode/contracts';

/** Harnesses `cleo hook ask-enforce` answers for. */
export const ASK_ENFORCE_PROVIDERS = [
  'claude-code',
  'codex',
  'copilot-cli',
  'gemini-cli',
  'cursor',
  'opencode',
  'kimi',
] as const;

/** One of {@link ASK_ENFORCE_PROVIDERS}. */
export type AskEnforceProvider = (typeof ASK_ENFORCE_PROVIDERS)[number];

/** Most transcript bytes read from the end of the file. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

type JsonRecord = { readonly [key: string]: HookJsonValue };

function isRecord(value: HookJsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: HookJsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** What the hook extracted from one Stop payload. */
export interface StopTurn {
  /** Final assistant message, when found. */
  readonly lastAssistantText: string | null;
  /** Tool names called since the last user prompt. */
  readonly toolCalls: readonly string[];
  /** The harness already re-prompted from a stop hook this turn. */
  readonly stopHookActive: boolean;
  /** Stops already blocked this turn (Cursor `loop_count`). */
  readonly loopCount: number;
  /** Cursor only: the agent loop's end status. */
  readonly status: string | undefined;
}

/** A transcript entry's role in the turn scan. */
type TranscriptEntry =
  | { readonly kind: 'user-prompt' }
  | { readonly kind: 'assistant'; readonly text: string; readonly tools: readonly string[] }
  | { readonly kind: 'tool'; readonly tools: readonly string[] }
  | { readonly kind: 'other' };

function contentText(content: HookJsonValue | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is JsonRecord => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function contentTools(content: HookJsonValue | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is JsonRecord => isRecord(b) && b.type === 'tool_use')
    .map((b) => str(b.name))
    .filter((n): n is string => n !== undefined);
}

/**
 * Classify one transcript line: Claude Code (`type: user|assistant`, `message`)
 * and Codex rollouts (`type: response_item`, `payload`).
 */
export function transcriptEntry(line: string): TranscriptEntry {
  let raw: HookJsonValue;
  try {
    raw = JSON.parse(line) as HookJsonValue;
  } catch {
    return { kind: 'other' };
  }
  if (!isRecord(raw)) return { kind: 'other' };
  const message = raw.message;
  if (isRecord(message) && (raw.type === 'user' || raw.type === 'assistant')) {
    const content = message.content;
    if (raw.type === 'assistant') {
      return { kind: 'assistant', text: contentText(content), tools: contentTools(content) };
    }
    const isToolResult =
      Array.isArray(content) && content.some((b) => isRecord(b) && b.type === 'tool_result');
    return isToolResult || contentText(content) === ''
      ? { kind: 'other' }
      : { kind: 'user-prompt' };
  }
  const payload = raw.payload;
  if (raw.type === 'response_item' && isRecord(payload)) {
    if (payload.type === 'message' && payload.role === 'user') return { kind: 'user-prompt' };
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = Array.isArray(payload.content)
        ? payload.content
            .filter((b): b is JsonRecord => isRecord(b) && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('\n')
        : '';
      return { kind: 'assistant', text, tools: [] };
    }
    const name = str(payload.name);
    if (name && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      return { kind: 'tool', tools: [name] };
    }
  }
  return { kind: 'other' };
}

/**
 * Scan a transcript tail backwards to the last user prompt: the final
 * assistant text and every tool called in between.
 *
 * @param text - JSONL (whole lines; see {@link readTranscriptTail}).
 */
export function scanTranscriptTail(text: string): {
  lastAssistantText: string | null;
  toolCalls: string[];
} {
  const lines = text.split('\n');
  let lastAssistantText: string | null = null;
  const toolCalls: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (!line) continue;
    const entry = transcriptEntry(line);
    if (entry.kind === 'user-prompt') break;
    if (entry.kind === 'assistant') {
      if (lastAssistantText === null && entry.text.trim()) lastAssistantText = entry.text;
      toolCalls.push(...entry.tools);
    } else if (entry.kind === 'tool') {
      toolCalls.push(...entry.tools);
    }
  }
  return { lastAssistantText, toolCalls };
}

/** Read at most {@link TRANSCRIPT_TAIL_BYTES} from the end of a file; `''` on any error. */
export function readTranscriptTail(path: string): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf-8');
    // A tail that starts mid-file starts mid-line: drop the partial first line.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Extract the ended turn from a Stop payload.
 *
 * @param stdin - the payload as the harness wrote it.
 * @param readTail - transcript reader (injectable for tests).
 * @returns the turn, or `null` when the payload is not JSON.
 */
export function parseStopTurn(
  stdin: string,
  readTail: (path: string) => string = readTranscriptTail,
): StopTurn | null {
  let raw: HookJsonValue;
  try {
    raw = JSON.parse(stdin) as HookJsonValue;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const transcript = str(raw.transcript_path) ?? str(raw.transcriptPath);
  const scanned = transcript
    ? scanTranscriptTail(readTail(transcript))
    : { lastAssistantText: null, toolCalls: [] };
  const toolCalls = Array.isArray(raw.tool_calls)
    ? raw.tool_calls.filter((n): n is string => typeof n === 'string')
    : [];
  return {
    lastAssistantText:
      str(raw.last_assistant_message) ?? str(raw.prompt_response) ?? scanned.lastAssistantText,
    toolCalls: [...toolCalls, ...scanned.toolCalls],
    stopHookActive: raw.stop_hook_active === true,
    loopCount: typeof raw.loop_count === 'number' ? raw.loop_count : 0,
    status: str(raw.status),
  };
}

/** The hook mode from `CLEO_ASK_ENFORCE` (default `block`). */
export function askEnforceMode(env: Readonly<Record<string, string | undefined>>): AskEnforceMode {
  const value = env.CLEO_ASK_ENFORCE?.trim().toLowerCase();
  return value === 'off' || value === 'warn' ? value : 'block';
}

/** The harness answer: what to print, and the exit code. */
export interface StopHookAnswer {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const SILENT: StopHookAnswer = { stdout: '', stderr: '', exitCode: 0 };

/**
 * Render a verdict in the provider's Stop-hook protocol.
 *
 * @param provider - the harness.
 * @param verdict - the classifier's answer.
 * @param reason - the re-ask message.
 * @param mode - `block` or `warn` (`off` never reaches here).
 * @param turn - the parsed turn (Cursor's `status`).
 */
export function renderStopAnswer(
  provider: AskEnforceProvider,
  verdict: AskEnforceVerdict,
  reason: string,
  mode: AskEnforceMode,
  turn: StopTurn,
): StopHookAnswer {
  if (verdict.verdict !== 'block' || mode === 'off') return SILENT;
  const json = (value: HookJsonValue): StopHookAnswer => ({
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    exitCode: 0,
  });
  if (mode === 'warn') {
    return provider === 'claude-code' || provider === 'codex'
      ? json({ systemMessage: reason })
      : SILENT;
  }
  switch (provider) {
    case 'claude-code':
    case 'codex':
    case 'copilot-cli':
      return json({ decision: 'block', reason });
    case 'gemini-cli':
      return json({ decision: 'deny', reason });
    case 'cursor':
      return turn.status === undefined || turn.status === 'completed'
        ? json({ followup_message: reason })
        : SILENT;
    case 'opencode':
      return json({ block: true, reason });
    case 'kimi':
      return { stdout: '', stderr: `${reason}\n`, exitCode: 2 };
  }
}

/** Ask-tool lookup the hook needs (CAAMP in production; injectable for tests). */
export interface AskToolLookup {
  /** The provider's own ask tool, or `null` (use the `hitl.request` fallback). */
  readonly toolFor: (provider: AskEnforceProvider) => string | null;
  /** Every ask-tool name any harness uses (a misidentified provider never blocks a real ask). */
  readonly allNames: () => readonly string[];
}

/** CAAMP-backed {@link AskToolLookup}, loaded lazily to keep hook startup small. */
export async function caampAskToolLookup(): Promise<AskToolLookup> {
  const { getProviderAskTool, PROVIDER_ASK_TOOLS } = await import('@cleocode/caamp');
  return {
    toolFor: (provider) => getProviderAskTool(provider).toolName,
    allNames: () =>
      Object.values(PROVIDER_ASK_TOOLS).flatMap((entry) => [
        ...(entry.toolName ? [entry.toolName] : []),
        ...(entry.additionalToolNames ?? []),
      ]),
  };
}

/**
 * Run the ask-enforce hook for one Stop payload.
 *
 * @param provider - the harness.
 * @param stdin - the Stop payload.
 * @param env - environment (mode).
 * @param lookup - ask-tool names.
 * @returns what to print and the exit code; {@link SILENT} on any doubt.
 */
export async function askEnforceHook(
  provider: AskEnforceProvider,
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  lookup: AskToolLookup,
): Promise<StopHookAnswer> {
  const mode = askEnforceMode(env);
  if (mode === 'off') return SILENT;
  const turn = parseStopTurn(stdin);
  if (turn === null) return SILENT;
  const { askEnforceReason, classifyOwnerAsk } = await import(
    '@cleocode/core/harness/ask-enforce.js'
  );
  const verdict = classifyOwnerAsk({
    lastAssistantText: turn.lastAssistantText,
    turnToolCalls: turn.toolCalls,
    askToolNames: lookup.allNames(),
    stopHookActive: turn.stopHookActive,
    blocksThisTurn: turn.loopCount,
  });
  return renderStopAnswer(
    provider,
    verdict,
    askEnforceReason(verdict, lookup.toolFor(provider)),
    mode,
    turn,
  );
}
