/**
 * `PiAgentAdapter` — the in-process Pi agent-loop embed (T11761 · S2 · T11898).
 *
 * THE KEYSTONE of the Pi-harness work: the Pi agent loop runs **in-process**
 * inside the Cleo daemon as the body of the `SkillRunner` strategy slot, with
 * ZERO authority. It:
 *
 *  - resolves its LLM ONLY through the E9 chokepoint (`resolveLLMForSystem` →
 *    `ModelRunner`) via the Cleo-owned {@link createPiStreamFn} — `pi-ai`'s
 *    registry env-fallback is never reached;
 *  - touches the filesystem/shell ONLY through the deny-first
 *    {@link GuardedExecutionEnv} (S1) bound to the injected guarded tool surface;
 *  - reads its session identity from the daemon-stamped env (NEVER mints one);
 *  - runs under {@link wrapPiCall} containment so a `process.exit()` from any Pi
 *    code path becomes a thrown typed error, not a daemon-fatal exit;
 *  - is gated behind a **default-OFF** feature flag ({@link isPiRunnerEnabled}).
 *
 * The `SkillRunner` slot (`SkillExecutorAdapterOptions.runner`, line 124 of
 * `skill-executor-adapter.ts`) CALLS this adapter via {@link createPiSkillRunner};
 * the adapter is NOT hosted inside `defaultSkillRunner` (which stays untouched).
 *
 * Session durability is S3's concern: this subtask uses
 * {@link InMemorySessionStorage} (in-RAM, no DB writer, no lease) so the
 * read/stream path is buildable with ZERO write authority.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import type {
  GuardedToolSurface,
  SkillExecuteInput,
  SkillExecuteResult,
} from '@cleocode/contracts/tools/skill-executor';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
} from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, runAgentLoop } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { getLogger } from '../../logger.js';
import {
  resolveAgentIdFromEnv,
  resolveParentSessionIdFromEnv,
  resolveSessionIdFromEnv,
} from '../../sessions/session-id.js';
import type { SkillRunner } from '../../skills/skill-executor-adapter.js';
import type { Skill } from '../../skills/types.js';
import type { AgentToolRegistry } from '../../tools/agent-registry.js';
import { type ToolBudgetLimits, ToolCallBudget, ToolDispatchEngine } from '../../tools/dispatch.js';
import { PiContainmentError, wrapPiCall } from './pi-errors.js';
import { createPiStreamFn } from './pi-stream-fn.js';
import { buildPiAgentTools } from './pi-tool-bridge.js';
import type { PiAgentResult, PiAgentRunContext } from './pi-types.js';

const logger = getLogger('pi-agent-adapter');

/**
 * Default-OFF feature flag controlling whether the Pi runner is constructed and
 * used. Reads `CLEO_PI_RUNNER_ENABLED === '1'`. The whole adapter is gated by
 * this — when disabled, {@link createPiSkillRunner} is never wired into the
 * dispatcher and `defaultSkillRunner` runs instead.
 *
 * @returns `true` when the Pi runner is explicitly enabled.
 */
export function isPiRunnerEnabled(): boolean {
  return process.env['CLEO_PI_RUNNER_ENABLED'] === '1';
}

/**
 * Construction dependencies for {@link PiAgentAdapter}.
 */
export interface PiAgentAdapterDeps {
  /**
   * The {@link SystemOfUseLabel} this adapter resolves its LLM through (E9).
   * Defaults to `'task-executor'` when the SkillRunner closure builds the ctx.
   */
  readonly system?: PiAgentRunContext['system'];
  /**
   * Project root for config + credential resolution. Defaults to
   * `process.cwd()` inside `resolveLLMForSystem`.
   */
  readonly projectRoot?: string;
  /**
   * The frozen {@link AgentToolRegistry} whose tools the loop may CALL (T1740 ·
   * AC6). When supplied, {@link run} builds a {@link ToolDispatchEngine} over it
   * + the injected guarded surface and projects executable `AgentTool`s onto the
   * loop, so a model tool-call actually runs through the dispatch engine. When
   * omitted the loop is text-only (no tools offered for execution) — the prior
   * behaviour, preserved so existing callers are unchanged.
   */
  readonly registry?: AgentToolRegistry;
  /**
   * Optional per-run tool-call budget limits (T1740 · AC5) applied to the
   * dispatch engine: max call count, per-call timeout, total time. Omitted →
   * unbounded.
   */
  readonly budget?: ToolBudgetLimits;
}

/**
 * In-process Pi agent-loop adapter with ZERO authority.
 *
 * {@link run} drives `pi-agent-core`'s `runAgentLoop` with a Cleo-owned streamFn
 * (Gate-13), an in-RAM session (no DB writer), and `wrapPiCall` exit/error
 * containment, then projects the terminal assistant message onto a
 * {@link PiAgentResult}. It NEVER throws past the containment boundary for a Pi
 * failure — a Pi error becomes a `{ status: 'failure', error }` result.
 */
export class PiAgentAdapter {
  /** Construction defaults merged under the per-run {@link PiAgentRunContext}. */
  readonly #deps: PiAgentAdapterDeps;

  /**
   * Construct the adapter.
   *
   * `deps` supplies the construction-time defaults (resolution system + project
   * root) that {@link run} merges UNDER the per-call context — a field the call
   * supplies on `ctx` always wins. The factory {@link createPiSkillRunner} builds
   * the full `ctx` from these same deps; a direct caller may pass a partial `ctx`
   * and rely on the deps for the rest.
   *
   * @param deps - Resolution system + optional project root defaults.
   */
  constructor(deps: PiAgentAdapterDeps = {}) {
    this.#deps = deps;
  }

  /**
   * Run one Pi agent turn over the guarded tool surface.
   *
   * The `tools` surface is the injected {@link GuardedToolSurface}; the v0
   * read/stream path threads it into the loop for future tool wiring (S3+ maps
   * Pi's `ExecutionEnv` onto it). Resolution + streaming are owned by
   * {@link createPiStreamFn} (Gate-13). The session id MUST already be
   * daemon-stamped (read from env in {@link createPiSkillRunner}); the adapter
   * never mints one.
   *
   * @param prompt - The user prompt for this turn.
   * @param tools - The deny-first guarded tool surface (injected, never built here).
   * @param ctx - The run context (system label + daemon-stamped identity + signal).
   * @returns The terminal {@link PiAgentResult}; never throws for a Pi failure.
   */
  async run(
    prompt: string,
    tools: GuardedToolSurface,
    ctx: PiAgentRunContext,
  ): Promise<PiAgentResult> {
    // Merge construction defaults UNDER the per-call ctx — a field the caller
    // supplied on `ctx` always wins; deps fill the `projectRoot` gap.
    const runCtx: PiAgentRunContext =
      ctx.projectRoot === undefined && this.#deps.projectRoot !== undefined
        ? { ...ctx, projectRoot: this.#deps.projectRoot }
        : ctx;

    try {
      const messages = await wrapPiCall(async (signal) => {
        // In-RAM session seeded with the daemon-stamped id — the default
        // `createSessionId()` uuidv7 mint is never reached (ZERO authority,
        // no DB writer, no lease).
        const repo = new InMemorySessionRepo();
        const session = await repo.create({ id: runCtx.sessionId });
        const metadata = await session.getMetadata();
        if (metadata.id !== runCtx.sessionId) {
          // Identity contract violation — refuse rather than run under a minted id.
          throw new PiContainmentError(
            'E_PI_LOOP_FAILED',
            `Pi session id mismatch: expected daemon-stamped "${runCtx.sessionId}", got "${metadata.id}"`,
          );
        }
        // The streamFn is the single Gate-13 LLM route; `signal` is the
        // containment-managed abort threaded into the loop.
        const streamFn = createPiStreamFn({ ...runCtx, signal });
        const config = this.#buildConfig();
        const events: AgentEvent[] = [];
        const emit = (event: AgentEvent): void => {
          events.push(event);
        };
        // AC6 — close the tool-call loop. When a registry is wired, build the
        // T1740 dispatch engine over it + the injected guarded surface, project
        // executable `AgentTool`s onto the loop context, and (separately) advertise
        // the same schemas to the model on the wire (Context.tools is read by the
        // streamFn). When NO registry is supplied the loop is text-only — the
        // guarded surface is still asserted so the seam is never ambient.
        void tools;
        const agentContext = this.#buildAgentContext(tools);
        const result = await runAgentLoop(
          [userMessage(prompt)],
          agentContext,
          config,
          emit,
          signal,
          streamFn,
        );
        return result;
      }, runCtx.signal);

      return projectResult(messages);
    } catch (err) {
      // Containment already mapped Pi exits/aborts/failures to a typed error.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ system: runCtx.system, error: message }, 'pi agent run failed (contained)');
      return { status: 'failure', output: {}, error: message };
    }
  }

  /**
   * Build the {@link AgentLoopConfig} for this run.
   *
   * The `model` is a syntactically-valid placeholder ONLY — the actual provider/
   * model/credential is resolved inside the streamFn by `ctx.system`, never by
   * this descriptor (the resolver/registry is the SSoT, NOT a literal here). The
   * placeholder id is a non-model-literal sentinel so it cannot trip Gate-13's
   * `hardcoded-model-literal` rule.
   *
   * @returns The loop config.
   */
  #buildConfig(): AgentLoopConfig {
    return {
      model: placeholderModel(),
      // Pass AgentMessages straight through to the LLM boundary — the streamFn
      // re-projects them onto cleo transport messages. Must not throw (Pi contract).
      convertToLlm: (messages: AgentMessage[]) => messages as never,
    };
  }

  /**
   * Build the loop's {@link AgentContext}, wiring the executable tools when a
   * registry is configured (T1740 · AC6).
   *
   * With a registry: a {@link ToolDispatchEngine} is constructed over it + the
   * injected guarded surface + the optional run-scoped budget, and {@link
   * buildPiAgentTools} projects executable `AgentTool`s onto `context.tools`. The
   * loop reads those `execute` bodies when the model emits a tool-call, so the
   * call runs through the dispatch engine (lookup → validate → availability →
   * budget → guarded side effect → formatted result) and the result is fed back.
   * Without a registry the context is text-only — the prior behaviour.
   *
   * @param tools - The injected guarded tool surface every executable runs through.
   * @returns The loop context (`systemPrompt` + empty transcript + optional tools).
   */
  #buildAgentContext(tools: GuardedToolSurface): AgentContext {
    if (!this.#deps.registry) {
      return { systemPrompt: '', messages: [] };
    }
    const engine = new ToolDispatchEngine({
      registry: this.#deps.registry,
      tools,
      ...(this.#deps.budget !== undefined ? { budget: new ToolCallBudget(this.#deps.budget) } : {}),
    });
    const agentTools = buildPiAgentTools(engine, this.#deps.registry);
    // `buildPiAgentTools` returns the structural `AgentTool` subset the loop
    // reads (name/description/parameters/label/execute); the cast bridges to
    // `pi-agent-core`'s generic `AgentTool<TSchema, TDetails>` without importing
    // its TypeBox-parameterized type into the bridge (Gate-10 quarantine).
    return {
      systemPrompt: '',
      messages: [],
      tools: agentTools as unknown as AgentContext['tools'],
    };
  }
}

/**
 * Factory returning a {@link SkillRunner} whose body delegates to
 * {@link PiAgentAdapter.run}.
 *
 * This is the seam adaptation: the real `SkillRunner` shape is
 * `(skill, input) => Promise<SkillExecuteResult>` — it carries NO free `prompt`
 * / `ctx`, so the closure DERIVES the prompt from the skill+context and reads
 * the daemon-stamped identity from env. When the env is un-stamped the runner
 * fails closed (it NEVER mints a session id).
 *
 * Wire it into the dispatcher behind the default-OFF flag:
 * ```ts
 * new SkillExecutorAdapter({
 *   runner: isPiRunnerEnabled() ? createPiSkillRunner(deps) : undefined,
 * });
 * ```
 *
 * @param deps - Adapter construction deps (resolution system + project root).
 * @returns A `SkillRunner` that runs the Pi loop in-process.
 */
export function createPiSkillRunner(deps: PiAgentAdapterDeps = {}): SkillRunner {
  // The adapter receives the full deps (incl. the optional tool registry + budget
  // for AC6 tool-call dispatch).
  const adapter = new PiAgentAdapter(deps);
  return async (skill, input): Promise<SkillExecuteResult> => {
    const sessionId = resolveSessionIdFromEnv();
    if (sessionId === null) {
      // ZERO authority: a Pi-in-process run without a daemon-stamped session is
      // a contract violation. Fail closed — never mint.
      return {
        status: 'failure',
        output: {},
        error:
          'E_PI_NO_SESSION_IDENTITY: CLEO_SESSION_ID is not set; the Pi runner refuses to mint a session id',
      };
    }
    const ctx: PiAgentRunContext = {
      system: deps.system ?? 'task-executor',
      sessionId,
      agentId: resolveAgentIdFromEnv(),
      parentSessionId: resolveParentSessionIdFromEnv(),
      ...(deps.projectRoot !== undefined ? { projectRoot: deps.projectRoot } : {}),
    };
    const prompt = buildPromptFromSkill(skill, input);
    const result = await adapter.run(prompt, input.tools, ctx);
    return result.status === 'success'
      ? { status: 'success', output: result.output }
      : {
          status: 'failure',
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
  };
}

/**
 * Derive the Pi prompt from a resolved skill + its execution input.
 *
 * v0: the skill's content is the instruction body; the accumulated context is
 * appended as a JSON block so the model can read prior bindings. Kept small and
 * deterministic — the richer prompt-template path is a later subtask.
 *
 * @param skill - The resolved skill (frontmatter + content).
 * @param input - The execution input (skill id + context + tools).
 * @returns The composed prompt string.
 */
function buildPromptFromSkill(skill: Skill, input: SkillExecuteInput): string {
  const body = skill.content ?? skill.frontmatter.description ?? skill.name;
  const contextKeys = Object.keys(input.context);
  const contextBlock =
    contextKeys.length > 0 ? `\n\n## Context\n${JSON.stringify(input.context, null, 2)}` : '';
  return `${body}${contextBlock}`;
}

/** Build a Pi user {@link AgentMessage} from a prompt string. */
function userMessage(prompt: string): AgentMessage {
  return {
    role: 'user',
    content: prompt,
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * Project the loop's terminal assistant message onto a {@link PiAgentResult}.
 *
 * The loop returns the full `AgentMessage[]`; the last assistant message's text
 * is the terminal output. A `stopReason: 'error'` message becomes a failure.
 *
 * @param messages - The loop's returned message list.
 * @returns The projected result.
 */
function projectResult(messages: AgentMessage[]): PiAgentResult {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) {
    return { status: 'success', output: { text: '' } };
  }
  const text = assistantText(last);
  const stopReason = (last as { stopReason?: string }).stopReason;
  if (stopReason === 'error') {
    const errorMessage = (last as { errorMessage?: string }).errorMessage ?? 'pi loop error';
    return { status: 'failure', output: { text }, error: errorMessage };
  }
  return { status: 'success', output: { text } };
}

/** Extract concatenated visible text from a Pi assistant message. */
function assistantText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

/**
 * Build a syntactically-valid placeholder {@link Model} for the loop config.
 *
 * The streamFn ignores this model for resolution (it resolves by `ctx.system`),
 * so the fields are inert sentinels. The `id`/`name` are NON-model-literals so
 * they never trip Gate-13's `hardcoded-model-literal` rule, and `provider` is a
 * neutral marker (NOT a real provider's credential trigger).
 *
 * @returns A placeholder model.
 */
function placeholderModel(): Model<string> {
  return {
    id: 'cleo-resolved',
    name: 'cleo-resolved',
    api: 'anthropic-messages',
    provider: 'cleo',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}
