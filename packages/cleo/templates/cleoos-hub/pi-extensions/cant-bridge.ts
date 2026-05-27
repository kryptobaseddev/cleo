/**
 * CleoOS CANT runtime bridge — Phase 4.
 *
 * Installed to: $CLEO_HOME/pi-extensions/cant-bridge.ts
 * Loaded by:    Pi via `-e <path>` or settings.json extensions array
 *
 * CLEO's CANT DSL (.cant files) mixes two tiers of constructs:
 *   1. Deterministic pipelines — pure subprocess orchestration, executed
 *      by the Rust `cant-cli` binary via `cleo cant execute`.
 *   2. Workflow-level constructs — LLM- or human-dependent (sessions,
 *      choices, discretions, approvals, parallel, try/catch, loops). These
 *      MUST execute in TypeScript inside Pi because they need the LLM
 *      harness or the operator.
 *
 * This bridge parses .cant files via `cleo cant parse`, validates via
 * `cleo cant validate`, delegates pipelines back to `cleo cant execute`,
 * and interprets Workflow statements using Pi's subagent spawning and UI
 * primitives. When an Agent section declares `skills:`, the bridge fetches
 * protocol text from SKILL.md via `cleo skills info` and injects it into
 * subsequent Pi LLM turns through `before_agent_start`.
 *
 * Commands:
 *   /cant:load <file>                          — parse + validate + auto-load skills
 *   /cant:run <file> <workflowName>            — interpret a Workflow body
 *   /cant:execute-pipeline <file> --name <n>   — shortcut to cleo cant execute
 *   /cant:info                                 — print bridge state
 *
 * Mock mode: `CLEOOS_MOCK=1` skips CLI calls and returns synthetic data.
 *
 * Guardrails (owner directive):
 *   - NO hand-authored protocol text; always shell out to `cleo skills info`.
 *   - NO imports from @cleocode/*; extension shells out via CLI only.
 *   - NO top-level await; all work happens inside handlers.
 *   - ALL commands/hooks registered synchronously in the factory.
 *   - Honor ctx.signal for cancellation.
 *   - Never pass shell metacharacters to pi.exec; always use the args array.
 *   - Wrap every CLI failure in try/catch + ctx.ui.notify; never crash.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// --- LAFS envelope + CANT AST shapes (all shapes match `cleo cant parse` output) ---

/** Minimal LAFS envelope shared by every `cleo` CLI command. */
interface LafsMinimalEnvelope<T = unknown> {
  ok: boolean;
  r?: T;
  error?: { code: string | number; message: string };
  _m?: { op: string; rid: string };
}

/** CANT property (key/value pair from frontmatter or sections). */
interface CantProperty { key: string; value: unknown }

/** CANT hook block attached to an agent. */
interface CantHook { event: string; body: CantStatement[] }

/** CANT agent section — top-level declaration carrying skills and permissions. */
interface CantAgentSection {
  type: "Agent";
  name: string;
  properties: CantProperty[];
  permissions?: Record<string, string[]>;
  hooks?: CantHook[];
}

/** CANT workflow section — interpreted statement-by-statement by this bridge. */
interface CantWorkflowSection {
  type: "Workflow";
  name: string;
  params: CantProperty[];
  body: CantStatement[];
}

/** CANT pipeline section — delegated to the Rust cant-cli executor. */
interface CantPipelineSection {
  type: "Pipeline";
  name: string;
  params: CantProperty[];
  steps: unknown[];
}

/** CANT hook section (top-level hook, not nested inside an agent). */
interface CantHookSection { type: "Hook"; event: string; body: CantStatement[] }

/** Union of all top-level section types produced by `cleo cant parse`. */
type CantSection =
  | CantAgentSection
  | CantWorkflowSection
  | CantPipelineSection
  | CantHookSection;

/** Discretion payload — prose the LLM must interpret at runtime. */
interface CantDiscretion { prose: string }

/** Simple CANT expression — supports equality, boolean literals, and var refs. */
interface CantExpression {
  kind: "literal" | "var" | "equals";
  value?: boolean | string | number;
  name?: string;
  left?: CantExpression;
  right?: CantExpression;
}

/** Condition used by Conditional / LoopUntil — either a pure expression or LLM-routed prose. */
type CantCondition = { Expression: CantExpression } | { Discretion: CantDiscretion };

/** Branch of a Conditional statement. */
interface CantConditionalElif { condition: CantCondition; body: CantStatement[] }

/** Target of a Session statement. */
type CantSessionTarget = { Prompt: string } | { Agent: string };

/** Supported CANT statements (fields we do not use are omitted). */
type CantStatement =
  | { type: "Session"; target: CantSessionTarget; properties?: CantProperty[] }
  | { type: "Parallel"; modifier: "Race" | "Settle" | null; arms: CantStatement[][] }
  | {
      type: "Conditional";
      condition: CantCondition;
      then_body: CantStatement[];
      elif_branches: CantConditionalElif[];
      else_body: CantStatement[];
    }
  | { type: "ApprovalGate"; properties: CantProperty[] }
  | { type: "Repeat"; count: number; body: CantStatement[] }
  | { type: "ForLoop"; variable: string; iterable: unknown; body: CantStatement[] }
  | { type: "LoopUntil"; body: CantStatement[]; condition: CantCondition }
  | {
      type: "TryCatch";
      try_body: CantStatement[];
      catch_name?: string;
      catch_body: CantStatement[];
      finally_body: CantStatement[];
    }
  | { type: "Expression" }
  | { type: "Property" }
  | { type: "Binding" }
  | { type: "Directive" };

/** Full CANT document — the `r.document` field from `cleo cant parse`. */
interface CantDocument {
  kind: "Agent" | "Workflow" | "Pipeline" | null;
  frontmatter: { kind?: string; version?: string; properties: CantProperty[] } | null;
  sections: CantSection[];
  span?: unknown;
}

/** Response shape from `cleo cant parse`. */
interface CantParseResult { document: CantDocument }

/** Response shape from `cleo cant validate`. */
interface CantValidateResult {
  valid: boolean;
  diagnostics?: Array<{ severity: string; message: string }>;
}

/** Response shape from `cleo skills info`. */
interface SkillInfoResult { name: string; description?: string; content?: string }

/**
 * Module-level bridge state. One agent can be loaded at a time per Pi session;
 * one workflow can be running at a time. Nested workflow spawns are handled
 * by spawning a child `pi` process rather than reentering this machine.
 */
interface BridgeState {
  loadedAgent: {
    file: string;
    name: string;
    declaredSkills: string[];
    permissions: Record<string, string[]>;
  } | null;
  runningWorkflow: { file: string; name: string; startedAt: Date } | null;
}

const STATUS_KEY = "cleo-cant";
const state: BridgeState = { loadedAgent: null, runningWorkflow: null };

// --- CLI + mock helpers ---

/**
 * Invoke the `cleo` CLI via pi.exec and parse stdout as a LAFS envelope.
 * Returns the unwrapped result payload or undefined on any failure. Mirrors
 * the helper in orchestrator.ts so behavior stays consistent.
 */
async function cleoCli<T = unknown>(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  let result: ExecResult;
  try {
    result = await pi.exec("cleo", args, { signal });
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const lines = result.stdout.trim().split("\n");
  const envLine = [...lines].reverse().find((l) => l.trim().startsWith("{"));
  if (!envLine) return undefined;
  try {
    const env = JSON.parse(envLine) as LafsMinimalEnvelope<T>;
    if (env.ok && env.r !== undefined) return env.r;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Whether `CLEOOS_MOCK=1` is set. Skips all CLI calls. */
function isMock(): boolean { return process.env.CLEOOS_MOCK === "1"; }

/** Synthetic CANT document for mock mode. */
function mockDocument(agentName: string): CantDocument {
  return {
    kind: "Agent",
    frontmatter: { kind: "agent", version: "1.0", properties: [] },
    sections: [
      {
        type: "Agent",
        name: agentName,
        properties: [],
        permissions: { read: ["*"], write: ["./mock"] },
        hooks: [],
      },
      {
        type: "Workflow",
        name: "default",
        params: [],
        body: [{ type: "Session", target: { Prompt: "mock prompt" } }],
      },
    ],
  };
}

// --- AST + path utilities ---

/** Find the first Agent section in a parsed document. */
function findAgent(doc: CantDocument): CantAgentSection | undefined {
  return doc.sections.find((s): s is CantAgentSection => s.type === "Agent");
}

/** Find a named Workflow section in a parsed document. */
function findWorkflow(doc: CantDocument, name: string): CantWorkflowSection | undefined {
  return doc.sections.find(
    (s): s is CantWorkflowSection => s.type === "Workflow" && s.name === name,
  );
}

/** Extract the `skills:` declaration from an agent's properties. */
function extractSkills(agent: CantAgentSection): string[] {
  const prop = agent.properties.find((p) => p.key === "skills");
  if (!prop) return [];
  const v = prop.value;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

/** Extract a string-valued property by key. */
function propString(props: CantProperty[], key: string): string | undefined {
  const p = props.find((x) => x.key === key);
  return typeof p?.value === "string" ? p.value : undefined;
}

/**
 * Resolve an agent reference to a .cant file on disk. Checks
 * `$PWD/.cleo/agents/`, `$CLEO_HOME/agents/`, then `$HOME/.local/share/cleo/agents/`.
 */
function resolveAgentFile(cwd: string, agentName: string): string | undefined {
  const candidates = [
    join(cwd, ".cleo", "agents", `${agentName}.cant`),
    process.env.CLEO_HOME
      ? join(process.env.CLEO_HOME, "agents", `${agentName}.cant`)
      : undefined,
    join(homedir(), ".local", "share", "cleo", "agents", `${agentName}.cant`),
  ].filter((p): p is string => typeof p === "string");
  for (const path of candidates) if (existsSync(path)) return path;
  return undefined;
}

/**
 * Minimal expression evaluator: boolean literals, var refs, equality.
 * Returns false for unsupported shapes so malformed ASTs fall through
 * to the else branch rather than throwing.
 */
function evalExpression(
  expr: CantExpression | undefined,
  env: Record<string, unknown>,
): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "literal":
      return Boolean(expr.value);
    case "var":
      return Boolean(env[expr.name ?? ""]);
    case "equals": {
      const l = expr.left ? evalExpression(expr.left, env) : false;
      const r = expr.right ? evalExpression(expr.right, env) : false;
      return l === r;
    }
    default:
      return false;
  }
}

// --- Subagent spawn (Session { Prompt: ... }) ---

/**
 * Spawn a Pi subagent for a Session.Prompt statement via
 * `pi --mode json -p --no-session <prompt>`. Scans JSONL stdout for
 * `message_end` to confirm the turn completed; honors ctx.signal by
 * killing the child on abort.
 */
function spawnSubagent(
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<{ code: number; sawMessageEnd: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      "pi",
      ["--mode", "json", "-p", "--no-session", prompt],
      { stdio: ["ignore", "pipe", "pipe"], shell: false },
    );

    let buffer = "";
    let sawMessageEnd = false;

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.lastIndexOf("\n");
      if (newlineIdx < 0) return;
      const complete = buffer.slice(0, newlineIdx).split("\n");
      buffer = buffer.slice(newlineIdx + 1);
      for (const line of complete) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const evt = JSON.parse(trimmed) as { type?: string };
          if (evt.type === "message_end") sawMessageEnd = true;
        } catch {
          // Partial or non-JSON line — ignore.
        }
      }
    });
    child.stderr.on("data", () => {
      // Intentionally discarded — Pi logs are out-of-band.
    });

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already be dead.
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", () => resolve({ code: 1, sawMessageEnd }));
    child.on("exit", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, sawMessageEnd });
    });
  });
}

// --- Workflow interpreter ---

/** Execution environment shared across statements in a single workflow run. */
interface RunEnv {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  cwd: string;
  vars: Record<string, unknown>;
}

/** Execute statements in order; errors propagate to enclosing TryCatch. */
async function runBody(body: CantStatement[], env: RunEnv): Promise<void> {
  for (const stmt of body) {
    if (env.ctx.signal?.aborted) return;
    await runStatement(stmt, env);
  }
}

/** Interpret a single CANT statement. */
async function runStatement(stmt: CantStatement, env: RunEnv): Promise<void> {
  switch (stmt.type) {
    case "Session":
      await runSession(stmt, env);
      return;
    case "Parallel":
      await runParallel(stmt, env);
      return;
    case "Conditional":
      await runConditional(stmt, env);
      return;
    case "ApprovalGate":
      await runApprovalGate(stmt, env);
      return;
    case "Repeat":
      for (let i = 0; i < stmt.count; i += 1) {
        if (env.ctx.signal?.aborted) return;
        await runBody(stmt.body, env);
      }
      return;
    case "ForLoop":
      await runForLoop(stmt, env);
      return;
    case "LoopUntil":
      await runLoopUntil(stmt, env);
      return;
    case "TryCatch":
      await runTryCatch(stmt, env);
      return;
    case "Expression":
    case "Property":
    case "Binding":
    case "Directive":
      if (env.ctx.hasUI) {
        env.ctx.ui.notify(`cant: skipping ${stmt.type} (v1 no-op)`, "info");
      }
      return;
  }
}

/**
 * Execute a Session. Prompt targets spawn a Pi subagent; Agent targets
 * resolve the agent's .cant file and load it (recursive load).
 */
async function runSession(
  stmt: Extract<CantStatement, { type: "Session" }>,
  env: RunEnv,
): Promise<void> {
  if ("Prompt" in stmt.target) {
    const prompt = stmt.target.Prompt;
    if (env.ctx.hasUI) env.ctx.ui.setStatus(STATUS_KEY, "cant: session → pi subagent");
    if (isMock()) {
      if (env.ctx.hasUI) env.ctx.ui.notify(`[mock] subagent prompt: ${prompt}`, "info");
      return;
    }
    const res = await spawnSubagent(prompt, env.ctx.signal);
    if (res.code !== 0 && env.ctx.hasUI) {
      const suffix = res.sawMessageEnd ? "" : " (no message_end seen)";
      env.ctx.ui.notify(`cant: subagent exited ${res.code}${suffix}`, "warning");
    }
    return;
  }

  const agentName = stmt.target.Agent;
  const file = resolveAgentFile(env.cwd, agentName);
  if (!file) {
    if (env.ctx.hasUI) {
      env.ctx.ui.notify(`cant: could not resolve agent '${agentName}'`, "error");
    }
    return;
  }
  await loadAgentFile(file, env.pi, env.ctx);
}

/** Race resolves on first settled arm; Settle waits for all (null → Settle). */
async function runParallel(
  stmt: Extract<CantStatement, { type: "Parallel" }>,
  env: RunEnv,
): Promise<void> {
  const promises = stmt.arms.map((arm) => runBody(arm, env));
  if (stmt.modifier === "Race") {
    await Promise.race(promises);
    return;
  }
  await Promise.allSettled(promises);
}

/**
 * Execute a Conditional. Expression conditions evaluate deterministically;
 * Discretion conditions route to the THEN arm in v1 so we never block
 * waiting on LLM routing, surfacing the prose via sendMessage + notify.
 */
async function runConditional(
  stmt: Extract<CantStatement, { type: "Conditional" }>,
  env: RunEnv,
): Promise<void> {
  if (await evaluateCondition(stmt.condition, env, "conditional")) {
    await runBody(stmt.then_body, env);
    return;
  }
  for (const elif of stmt.elif_branches) {
    if (await evaluateCondition(elif.condition, env, "elif")) {
      await runBody(elif.body, env);
      return;
    }
  }
  await runBody(stmt.else_body, env);
}

/**
 * Evaluate a condition. Discretion routes to THEN (v1 default) after
 * surfacing the prose to the operator and the LLM session.
 */
async function evaluateCondition(
  condition: CantCondition,
  env: RunEnv,
  label: string,
): Promise<boolean> {
  if ("Expression" in condition) {
    return evalExpression(condition.Expression, env.vars);
  }
  const prose = condition.Discretion.prose;
  if (env.ctx.hasUI) {
    env.ctx.ui.notify(
      `cant: ${label} discretion routed to THEN arm (v1 default) — ${prose.slice(0, 80)}`,
      "info",
    );
  }
  env.pi.sendMessage(
    {
      customType: "cleo-cant-discretion",
      content: `Discretion: ${prose}`,
      display: true,
    },
    { triggerTurn: false },
  );
  return true;
}

/**
 * Pop a confirmation dialog for an ApprovalGate; if denied, throw so an
 * enclosing TryCatch can handle it. Non-interactive mode approves in mock,
 * denies otherwise.
 */
async function runApprovalGate(
  stmt: Extract<CantStatement, { type: "ApprovalGate" }>,
  env: RunEnv,
): Promise<void> {
  const title = propString(stmt.properties, "title") ?? "CANT approval gate";
  const message = propString(stmt.properties, "message") ?? "Approve to continue?";
  if (!env.ctx.hasUI) {
    if (isMock()) return;
    throw new Error(`ApprovalGate '${title}' denied (no UI available)`);
  }
  const approved = await env.ctx.ui.confirm(title, message);
  if (!approved) throw new Error(`ApprovalGate '${title}' denied by operator`);
}

/** ForLoop — v1 only supports hardcoded array-literal iterables. */
async function runForLoop(
  stmt: Extract<CantStatement, { type: "ForLoop" }>,
  env: RunEnv,
): Promise<void> {
  if (!Array.isArray(stmt.iterable)) {
    if (env.ctx.hasUI) {
      env.ctx.ui.notify("cant: ForLoop iterable is not an array literal (v1)", "warning");
    }
    return;
  }
  for (const item of stmt.iterable) {
    if (env.ctx.signal?.aborted) return;
    const previous = env.vars[stmt.variable];
    env.vars[stmt.variable] = item;
    try {
      await runBody(stmt.body, env);
    } finally {
      env.vars[stmt.variable] = previous;
    }
  }
}

/**
 * LoopUntil: run body, eval condition, repeat until true. Bounded by a
 * safety cap so malformed .cant files cannot wedge the session.
 */
async function runLoopUntil(
  stmt: Extract<CantStatement, { type: "LoopUntil" }>,
  env: RunEnv,
): Promise<void> {
  const MAX_ITERS = 1_000;
  for (let i = 0; i < MAX_ITERS; i += 1) {
    if (env.ctx.signal?.aborted) return;
    await runBody(stmt.body, env);
    if (await evaluateCondition(stmt.condition, env, "loop-until")) return;
  }
  if (env.ctx.hasUI) {
    env.ctx.ui.notify(`cant: LoopUntil hit ${MAX_ITERS}-iteration safety cap`, "warning");
  }
}

/**
 * JS try/catch/finally around the body. The caught error is exposed to
 * the catch arm via env.vars[catch_name] so the body can inspect it.
 */
async function runTryCatch(
  stmt: Extract<CantStatement, { type: "TryCatch" }>,
  env: RunEnv,
): Promise<void> {
  try {
    await runBody(stmt.try_body, env);
  } catch (err) {
    const name = stmt.catch_name ?? "error";
    const previous = env.vars[name];
    env.vars[name] = err instanceof Error ? err.message : String(err);
    try {
      await runBody(stmt.catch_body, env);
    } finally {
      env.vars[name] = previous;
    }
  } finally {
    await runBody(stmt.finally_body, env);
  }
}

// --- Parse + load helpers ---

/**
 * Parse a .cant file into a document, honoring mock mode and catching any
 * CLI throw. Returns undefined after surfacing an error notification; the
 * caller should bail immediately on undefined.
 */
async function parseDocument(
  file: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<CantDocument | undefined> {
  if (isMock()) return mockDocument("mock-agent");
  try {
    const parsed = await cleoCli<CantParseResult>(pi, ["cant", "parse", file], ctx.signal);
    if (!parsed?.document) {
      if (ctx.hasUI) ctx.ui.notify(`cant: failed to parse ${file}`, "error");
      return undefined;
    }
    return parsed.document;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`cant: parse threw — ${msg}`, "error");
    return undefined;
  }
}

/**
 * Validate a .cant file via `cleo cant validate`. Returns true on success or
 * mock mode; false after surfacing a notification on any failure.
 */
async function validateDocument(
  file: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (isMock()) return true;
  try {
    const validation = await cleoCli<CantValidateResult>(
      pi,
      ["cant", "validate", file],
      ctx.signal,
    );
    if (validation && !validation.valid) {
      const first = validation.diagnostics?.[0]?.message ?? "invalid";
      if (ctx.hasUI) ctx.ui.notify(`cant: validation failed — ${first}`, "error");
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`cant: validate threw — ${msg}`, "error");
    return false;
  }
}

/**
 * Parse + validate + populate bridge state for a .cant file. Used by both
 * `/cant:load` and the Session { Agent } statement (recursive load).
 */
async function loadAgentFile(
  file: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const document = await parseDocument(file, pi, ctx);
  if (!document) return;
  if (!(await validateDocument(file, pi, ctx))) return;

  const agent = findAgent(document);
  if (!agent) {
    if (ctx.hasUI) ctx.ui.notify(`cant: ${file} has no Agent section`, "warning");
    return;
  }

  const skills = extractSkills(agent);
  state.loadedAgent = {
    file,
    name: agent.name,
    declaredSkills: skills,
    permissions: agent.permissions ?? {},
  };

  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, `cant: ${agent.name} (${skills.length} skills)`);
    ctx.ui.notify(`cant: loaded agent '${agent.name}' with ${skills.length} skills`, "info");
  }
}

/**
 * Parse a .cant file, locate the named workflow, and interpret its body.
 * Rejects nested runs (one workflow at a time per session) and clears the
 * running-workflow marker on exit.
 */
async function runWorkflow(
  file: string,
  workflowName: string,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (state.runningWorkflow) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `cant: workflow '${state.runningWorkflow.name}' is already running`,
        "warning",
      );
    }
    return;
  }

  const document = await parseDocument(file, pi, ctx);
  if (!document) return;

  const workflow = findWorkflow(document, workflowName);
  if (!workflow) {
    if (ctx.hasUI) {
      ctx.ui.notify(`cant: workflow '${workflowName}' not found in ${file}`, "error");
    }
    return;
  }

  state.runningWorkflow = { file, name: workflowName, startedAt: new Date() };
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, `cant: running ${workflowName}`);
    ctx.ui.notify(`cant: running workflow '${workflowName}'`, "info");
  }

  const env: RunEnv = { pi, ctx, cwd: ctx.cwd, vars: {} };

  try {
    await runBody(workflow.body, env);
    if (ctx.hasUI) ctx.ui.notify(`cant: workflow '${workflowName}' complete`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`cant: workflow '${workflowName}' threw — ${msg}`, "error");
  } finally {
    state.runningWorkflow = null;
    if (ctx.hasUI && state.loadedAgent) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `cant: ${state.loadedAgent.name} (${state.loadedAgent.declaredSkills.length} skills)`,
      );
    } else if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

// --- before_agent_start skill injection ---

/**
 * Fetch each declared skill's metadata from `cleo skills info` and stitch
 * it into a system-prompt prefix. This is the SSoT enforcement point: the
 * bridge never hand-authors protocol text.
 */
async function composeSkillPrompt(
  pi: ExtensionAPI,
  agentName: string,
  skills: string[],
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (skills.length === 0) return undefined;

  const parts: string[] = [`## Skills Loaded from .cant agent ${agentName}`, ""];
  let injectedAny = false;

  for (const skill of skills) {
    if (signal?.aborted) return undefined;
    if (isMock()) {
      parts.push(`### ${skill}`, `[mock] ${skill} description`, "");
      injectedAny = true;
      continue;
    }
    try {
      const info = await cleoCli<SkillInfoResult>(pi, ["skills", "info", skill], signal);
      if (!info) continue;
      parts.push(`### ${info.name}`);
      if (info.description) parts.push(info.description);
      if (info.content) parts.push(info.content);
      parts.push("");
      injectedAny = true;
    } catch {
      // Non-fatal — skip this skill and continue.
    }
  }

  return injectedAny ? parts.join("\n") : undefined;
}

// --- Pi extension factory ---

/**
 * Pi extension factory. Registers the four CANT bridge commands, the
 * before_agent_start skill-injection hook, and the session_shutdown
 * cleanup. Registration is synchronous so Pi discovers everything before
 * the first event loop tick.
 */
export default function (pi: ExtensionAPI): void {
  // before_agent_start: inject the loaded agent's skills. If no agent is
  // loaded, return {} so orchestrator.ts's own hook still fires and loads
  // the Tier 0 baseline. Protocol text comes exclusively from SKILL.md via
  // `cleo skills info` — never hand-authored.
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (!state.loadedAgent) return {};
    try {
      const prompt = await composeSkillPrompt(
        pi,
        state.loadedAgent.name,
        state.loadedAgent.declaredSkills,
        ctx.signal,
      );
      if (!prompt) return {};
      return { systemPrompt: prompt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) ctx.ui.notify(`cant: skill injection threw — ${msg}`, "error");
      return {};
    }
  });

  // /cant:load <file>
  pi.registerCommand("cant:load", {
    description: "Parse, validate, and load a .cant file (auto-injects agent skills)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const file = args.trim();
      if (!file) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /cant:load <file>", "error");
        return;
      }
      try {
        await loadAgentFile(file, pi, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`cant:load threw — ${msg}`, "error");
      }
    },
  });

  // /cant:run <file> <workflowName>
  pi.registerCommand("cant:run", {
    description: "Run a named workflow from a .cant file",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
      if (parts.length < 2) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /cant:run <file> <workflowName>", "error");
        return;
      }
      const [file, workflowName] = parts as [string, string];
      try {
        await runWorkflow(file, workflowName, pi, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`cant:run threw — ${msg}`, "error");
      }
    },
  });

  // /cant:execute-pipeline <file> --name <pipelineName>
  pi.registerCommand("cant:execute-pipeline", {
    description: "Delegate to Rust cant-cli pipeline executor",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter((p) => p.length > 0);
      const nameIdx = tokens.indexOf("--name");
      if (tokens.length === 0 || nameIdx === -1 || nameIdx === tokens.length - 1) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /cant:execute-pipeline <file> --name <pipelineName>", "error");
        }
        return;
      }
      const file = tokens[0];
      const pipelineName = tokens[nameIdx + 1];
      if (!file || file.startsWith("--") || !pipelineName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /cant:execute-pipeline <file> --name <pipelineName>", "error");
        }
        return;
      }

      if (isMock()) {
        pi.sendMessage(
          {
            customType: "cleo-cant-execute",
            content: `[mock] executed pipeline '${pipelineName}' from ${file}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      try {
        const result = await pi.exec(
          "cleo",
          ["cant", "execute", file, "--pipeline", pipelineName],
          { signal: ctx.signal },
        );
        const body =
          result.code === 0
            ? result.stdout.trim() || "(no output)"
            : `exit ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`;
        pi.sendMessage(
          { customType: "cleo-cant-execute", content: body, display: true },
          { triggerTurn: false },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`cant:execute-pipeline threw — ${msg}`, "error");
      }
    },
  });

  // /cant:info
  pi.registerCommand("cant:info", {
    description: "Show the loaded .cant agent and running workflow state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines: string[] = [];
      if (state.loadedAgent) {
        const skills =
          state.loadedAgent.declaredSkills.length === 0
            ? "(none)"
            : state.loadedAgent.declaredSkills.join(", ");
        const permKeys = Object.keys(state.loadedAgent.permissions);
        const perms = permKeys.length === 0 ? "(none)" : permKeys.join(", ");
        lines.push(
          `Loaded agent: ${state.loadedAgent.name}`,
          `  file: ${state.loadedAgent.file}`,
          `  skills: ${skills}`,
          `  permissions: ${perms}`,
        );
      } else {
        lines.push("Loaded agent: (none)");
      }

      if (state.runningWorkflow) {
        const elapsedS = Math.floor(
          (Date.now() - state.runningWorkflow.startedAt.getTime()) / 1_000,
        );
        lines.push(
          "",
          `Running workflow: ${state.runningWorkflow.name}`,
          `  file: ${state.runningWorkflow.file}`,
          `  elapsed: ${elapsedS}s`,
        );
      } else {
        lines.push("", "Running workflow: (none)");
      }

      pi.sendMessage(
        { customType: "cleo-cant-info", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          state.loadedAgent ? `cant: loaded ${state.loadedAgent.name}` : "cant: no agent loaded",
          "info",
        );
      }
    },
  });

  // session_shutdown: clear state so a reload starts clean.
  pi.on("session_shutdown", async () => {
    state.loadedAgent = null;
    state.runningWorkflow = null;
  });
}
