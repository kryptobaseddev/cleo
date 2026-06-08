/**
 * Cleo-owned Pi `StreamFn` — the Gate-13-respecting LLM route (T11761 · S2 · T11898).
 *
 * Pi's agent loop performs every LLM call through a single pluggable seam: the
 * `streamFn` passed as the 6th positional arg to `runAgentLoop`. The DEFAULT
 * streamFn (`pi-ai`'s `streamSimple`) resolves a provider from `pi-ai`'s own
 * registry and falls back to reading `process.env[<PROVIDER>_API_KEY]` when no
 * explicit key is supplied — a credential-resolution path OUTSIDE Cleo's E9
 * chokepoint, and a Gate-13 violation.
 *
 * {@link createPiStreamFn} supplies a Cleo-owned replacement that routes the
 * loop's LLM calls through {@link resolveLLMForSystem} (the E9 resolution
 * chokepoint) → {@link ModelRunner.build} (the single SSoT transport factory).
 * Passing this streamFn to `runAgentLoop` means `pi-ai`'s `stream.ts` /
 * `withEnvApiKey` is NEVER reached for the loop — the registry env-fallback
 * cannot fire (foundation §5.1, the single most important suppression lever).
 *
 * ## Gate-13 cleanliness (verified)
 *
 * This file CALLS `resolveLLMForSystem` + `ModelRunner.build` only. It constructs
 * NO transport (`new *Transport`), NO SDK client (`createAnthropic` /
 * `new Anthropic`), reads NO `*_API_KEY` env var, and carries NO hardcoded model
 * literal — all of that stays inside `model-runner.ts` / `transports/**` (the
 * Gate-13 allowlist). The descriptor's `model` comes from the resolver
 * (registry / role-config), never a literal here.
 *
 * ## Zod ↔ TypeBox quarantine (Gate 10)
 *
 * Pi tool schemas are TypeBox, but `pi-ai`'s `validateToolArguments` also accepts
 * plain JSON-schema tools. Cleo tool definitions are Zod (live in `core/src/llm/`).
 * {@link zodToolToTransportTool} converts a Zod schema → JSON Schema via Zod v4's
 * native `z.toJSONSchema` (NO `zod-to-json-schema` dep, NO typebox value-import),
 * so the cleo↔Pi tool boundary carries ZERO typebox. typebox remains a transitive
 * dep used only INSIDE `pi-agent-core`; it never appears in cleo source and never
 * reaches `packages/contracts/`.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import type { ResolvedLLMDescriptor } from '@cleocode/contracts';
import type {
  TransportMessage,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';
// Type-only imports from the two exit-clean Pi packages. `import type` is fully
// erased at runtime — it does NOT trigger `pi-ai`'s `register-builtins` (foundation
// §3.1). The `AssistantMessageEventStream` VALUE is imported below from the same
// barrel; that single value-import is what (benignly, inertly) populates the
// `pi-ai` provider registry with lazy closures — see the purity note there.
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
} from '@earendil-works/pi-ai';
// VALUE import: the FACTORY that builds the stream Pi's `StreamFn` MUST return.
// `AssistantMessageEventStream` itself collides in the `pi-ai` barrel (re-exported
// both as a value AND as a type-only name), so the class cannot be value-imported;
// `createAssistantMessageEventStream()` is the clean value export. Importing it
// from the `pi-ai` barrel evaluates `register-builtins` (populates the registry
// with inert lazy closures — NO env read, NO client construction at import;
// foundation §3.2). We OWN the loop's LLM path via this custom streamFn, so the
// registry is never CONSULTED — populated-but-unused, the accepted inert side
// effect, not a leak.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { getLogger } from '../../logger.js';
import { ModelRunner } from '../model-runner.js';
import { resolveLLMForSystem } from '../system-resolver.js';
import { wrapPiError } from './pi-errors.js';
import type { PiAgentRunContext } from './pi-types.js';

/**
 * A Cleo tool definition in the form the Pi streamFn bridges to Pi's loop.
 *
 * Cleo tools carry a Zod parameter schema; {@link createPiStreamFn} converts it
 * to a JSON-schema {@link TransportTool} so NO typebox value-import is needed at
 * the boundary (Gate 10). The bridge is intentionally one-directional: cleo →
 * Pi as JSON-schema; Pi validates internally; cleo re-validates received args
 * against the Zod schema at the guard boundary (defense in depth, S3+).
 */
export interface PiZodTool {
  /** Tool name as Pi/the provider will see it. */
  readonly name: string;
  /** Human-readable description for the model. */
  readonly description: string;
  /** Zod schema for the tool's input parameters. */
  readonly parameters: z.ZodType;
}

/**
 * Convert a Cleo Zod-schema tool into a JSON-schema {@link TransportTool}.
 *
 * Uses Zod v4's native `z.toJSONSchema` — no `zod-to-json-schema` dependency and,
 * crucially, NO typebox value-import. The resulting `inputSchema` is a plain JSON
 * Schema object the transport passes through verbatim.
 *
 * @param tool - The Cleo Zod tool.
 * @returns The transport-shaped JSON-schema tool.
 */
export function zodToolToTransportTool(tool: PiZodTool): TransportTool {
  // Zod v4's native `z.toJSONSchema` renders a plain JSON Schema object — NO
  // `zod-to-json-schema` dep and NO typebox value-import at this boundary, so
  // the cleo↔Pi tool surface carries zero typebox (Gate 10).
  const inputSchema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
  };
}

const logger = getLogger('pi-stream-fn');

/**
 * Build a Cleo-owned {@link StreamFn} for one Pi agent run.
 *
 * The returned function matches Pi's `StreamFn` contract structurally:
 * `(model, context, options?) => AssistantMessageEventStream`. It MUST NOT throw
 * — every failure is encoded as a terminal `error` event on the returned stream
 * (Pi's never-throw streaming contract).
 *
 * Flow per call:
 *   1. `resolveLLMForSystem(ctx.system)` — the E9 resolution chokepoint.
 *   2. Build a clean {@link ResolvedLLMDescriptor} from the resolved fields.
 *   3. `ModelRunner.build(descriptor)` — the single SSoT transport factory.
 *   4. Stream `NormalizedDelta` chunks from the built transport session and
 *      project them onto Pi's `AssistantMessageEvent` protocol, terminating with
 *      a `done` (success) or `error` (failure) event.
 *
 * `pi-ai`'s `stream.ts` / `withEnvApiKey` is never reached — the registry
 * env-fallback cannot fire for the loop.
 *
 * @param ctx - The Pi run context (system-of-use label + identity + signal).
 * @returns A Cleo-owned `StreamFn`.
 */
export function createPiStreamFn(ctx: PiAgentRunContext): StreamFn {
  return (model: Model<string>, context: Context, options?: SimpleStreamOptions) => {
    const out = createAssistantMessageEventStream();
    // Detach the async producer; the stream itself is returned synchronously so
    // the loop can begin consuming immediately (Pi's contract).
    void produce(out, model, context, options, ctx).catch((err) => {
      // A failure escaping the producer is encoded as a terminal error event —
      // never thrown (Pi's `StreamFn` must not throw / reject).
      emitError(out, model, wrapPiError(err).message);
    });
    return out;
  };
}

/**
 * Drive the cleo transport session and project its deltas onto Pi's event stream.
 *
 * @param out - The Pi event stream to push events onto.
 * @param model - Pi's model descriptor for this call (id/provider/api carried for
 *   the terminal `AssistantMessage` shape; resolution is by `ctx.system`, NOT by
 *   this model id — the resolver/registry is the SSoT).
 * @param context - The Pi request context (system prompt + messages + tools).
 * @param _options - Pi stream options (reserved; thinking/temperature flow via
 *   the resolved descriptor's capabilities in a later subtask).
 * @param ctx - The Pi run context (system-of-use label).
 */
async function produce(
  out: AssistantMessageEventStream,
  model: Model<string>,
  context: Context,
  _options: SimpleStreamOptions | undefined,
  ctx: PiAgentRunContext,
): Promise<void> {
  // 1. E9 resolution chokepoint. Never throws (resolver contract).
  const resolved = await resolveLLMForSystem(ctx.system, {
    ...(ctx.projectRoot !== undefined ? { projectRoot: ctx.projectRoot } : {}),
  });
  if (!resolved.credential?.apiKey && resolved.authType !== 'aws_sdk') {
    // No credential reachable — surface a typed terminal error (graceful: the
    // loop sees an error AssistantMessage and stops, the daemon is unharmed).
    emitError(out, model, `no credential resolved for system "${ctx.system}"`);
    return;
  }

  // 2. Clean descriptor from resolved fields (NO model literal here — the model
  //    is whatever the resolver/registry produced).
  const descriptor = toDescriptor(resolved);

  // 3. Single SSoT transport factory. The transport/client construction lives
  //    inside ModelRunner — this file constructs nothing.
  const built = await ModelRunner.build(descriptor);

  // 4. Stream deltas → Pi events.
  const aggregate = freshAssistantMessage(descriptor.model, model);
  out.push({ type: 'start', partial: aggregate });

  const messages = toTransportMessages(context);
  let text = '';
  let stop: StopReason = 'stop';
  let started = false;
  try {
    // Abort is enforced at the loop level by `runAgentLoop`'s signal +
    // `wrapPiCall` containment; `SendOptions` carries no per-call signal, so the
    // stream is driven to completion or until the loop tears it down.
    for await (const delta of built.session.stream(messages)) {
      if (delta.text) {
        if (!started) {
          started = true;
          out.push({ type: 'text_start', contentIndex: 0, partial: aggregate });
        }
        text += delta.text;
        setText(aggregate, text);
        out.push({ type: 'text_delta', contentIndex: 0, delta: delta.text, partial: aggregate });
      }
      if (delta.stopReason) {
        stop = normalizeStop(delta.stopReason);
      }
    }
  } catch (err) {
    // A mid-stream transport failure → terminal error event (never thrown).
    emitError(out, model, wrapPiError(err).message);
    return;
  }

  if (started) {
    out.push({ type: 'text_end', contentIndex: 0, content: text, partial: aggregate });
  }
  setText(aggregate, text);
  aggregate.stopReason = stop;
  logger.debug({ system: ctx.system, model: descriptor.model, stop }, 'pi stream complete');
  out.push({ type: 'done', reason: doneReason(stop), message: aggregate });
  out.end(aggregate);
}

/**
 * Build a {@link ResolvedLLMDescriptor} from a resolved-for-system envelope.
 *
 * Only the descriptor surface `ModelRunner.build` consumes is projected — the
 * resolver's extra `client` field is dropped so no SDK client leaks through this
 * boundary. The `model` comes from the resolver (registry/role-config), never a
 * literal.
 *
 * @param resolved - The `resolveLLMForSystem` envelope.
 * @returns A clean descriptor for `ModelRunner.build`.
 */
function toDescriptor(
  resolved: Awaited<ReturnType<typeof resolveLLMForSystem>>,
): ResolvedLLMDescriptor {
  return {
    provider: resolved.provider,
    model: resolved.model,
    credential: resolved.credential
      ? {
          provider: resolved.credential.provider,
          apiKey: resolved.credential.apiKey,
          source: resolved.credential.source,
          authType: resolved.credential.authType,
        }
      : null,
    source: resolved.source,
    ...(resolved.credentialLabel !== undefined
      ? { credentialLabel: resolved.credentialLabel }
      : {}),
    apiMode: resolved.apiMode,
    baseUrl: resolved.baseUrl,
    authType: resolved.authType,
    ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
  };
}

/**
 * Project a Pi {@link Context} onto Cleo {@link TransportMessage}s.
 *
 * Pi messages carry rich content blocks; for the v0 read/stream path we project
 * to the transport's text form. The system prompt is threaded separately by the
 * transport (carried on the request, not as a message), so only user/assistant/
 * tool turns are mapped.
 *
 * @param context - Pi's request context.
 * @returns Cleo transport messages.
 */
function toTransportMessages(context: Context): TransportMessage[] {
  return context.messages.map((m) => {
    const role: TransportMessage['role'] =
      m.role === 'assistant' ? 'assistant' : m.role === 'toolResult' ? 'tool' : 'user';
    const content = extractText(m);
    const msg: TransportMessage = { role, content };
    if (m.role === 'toolResult' && m.toolCallId) {
      return { ...msg, toolUseId: m.toolCallId };
    }
    return msg;
  });
}

/**
 * Extract a plain-text representation of a Pi message's content for the v0
 * transport projection.
 *
 * @param m - A Pi message (user/assistant/toolResult).
 * @returns The concatenated visible text.
 */
function extractText(m: Context['messages'][number]): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c ? String((c as TextContent).text) : '',
      )
      .join('');
  }
  return '';
}

/** Build a fresh, empty Pi {@link AssistantMessage} to accumulate the response into. */
function freshAssistantMessage(model: string, piModel: Model<string>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: piModel.api,
    provider: piModel.provider,
    model,
    usage: zeroUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** Set (or replace) the single text content block on an accumulating message. */
function setText(message: AssistantMessage, text: string): void {
  const block: TextContent = { type: 'text', text };
  // Replace the content array with a single text block (v0 — no tool-call/
  // thinking projection on this path yet).
  (message.content as TextContent[]) = text ? [block] : [];
}

/** A zeroed {@link AssistantMessage} usage record (token accounting is S3+). */
function zeroUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Map a Cleo normalized stop-reason string onto Pi's {@link StopReason} union. */
function normalizeStop(reason: string): StopReason {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_use':
    case 'toolUse':
      return 'toolUse';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'stop';
  }
}

/** Narrow a {@link StopReason} to the subset valid on Pi's `done` event. */
function doneReason(stop: StopReason): 'stop' | 'length' | 'toolUse' {
  return stop === 'length' ? 'length' : stop === 'toolUse' ? 'toolUse' : 'stop';
}

/**
 * Emit a terminal `error` event + `end` on a Pi stream (the never-throw failure
 * channel). Used for resolution/credential/transport failures.
 *
 * @param out - The Pi event stream.
 * @param piModel - The Pi model descriptor (for the error AssistantMessage shape).
 * @param message - Human-readable failure reason.
 */
function emitError(
  out: AssistantMessageEventStream,
  piModel: Model<string>,
  message: string,
): void {
  const errMsg: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: piModel.api,
    provider: piModel.provider,
    model: piModel.id,
    usage: zeroUsage(),
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
  out.push({ type: 'error', reason: 'error', error: errMsg });
  out.end(errMsg);
}
