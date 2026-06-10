/**
 * Tools system barrel exports.
 *
 * Provides the complete tools system ported from
 * `packages/cleo/src/dispatch/engines/tools-engine.ts` (ENG-MIG-8 / T1575).
 *
 * Sub-domains exposed:
 *   issue.*      - Issue diagnostics
 *   skill.*      - Skill discovery, dispatch, catalog, precedence
 *   provider.*   - CAAMP provider registry
 *   adapter.*    - Provider adapter management
 *
 * ## Atomic-tool surface (T11474 · E-TOOLS-WIRE)
 *
 * The barrel ALSO exposes the atomic fs/shell tool layer (E3) — but ONLY through
 * the deny-first {@link createToolGuard} chokepoint. The raw side-effecting
 * primitives (`writeFileAtomic`, `executeShell`, `runGit`, …) are deliberately
 * NOT re-exported here: a consumer obtains them by calling `createToolGuard()`
 * and using the returned {@link ToolGuard} surface, so every fs/shell call is
 * funnelled through one policy point and there is no public bypass (AC2). What
 * is exported from the atomic layer:
 *   - {@link createToolGuard} + {@link ToolGuard} / {@link ToolGuardPolicy} /
 *     {@link GuardMode} / {@link GuardDeniedError} — the guarded entrypoint.
 *   - {@link GUARD_ENFORCE_DEADLINE} / {@link GUARD_ENFORCE_FLIP_ENABLED} /
 *     {@link resolveDefaultGuardMode} — the date-gated default-mode mechanism
 *     (held at `warn` behind the owner-gated flip, AC4).
 *   - {@link ShellExecutor} + {@link defaultShellExecutor} — the injectable
 *     process layer threaded INTO the guard's `executeShell`/`runGit` (does not
 *     bypass policy; it is the substitutable subprocess mechanism).
 *
 * @task T1575 — ENG-MIG-8
 * @task T11474 — E-TOOLS-WIRE (atomic-tool surface through the guard)
 * @epic T1566
 */

// BrainTools (Category B) — pure-functional BRAIN retrieval SDK tools (T10070 / T9835)
export * from '../brain-tools/index.js';
export type { DoctorProjectOptions, DoctorProjectResult } from '../doctor/doctor-project.js';
// ProjectTools SDK Tools (Category B) — scaffold + doctor primitives (T10069 / T9835b)
export { doctorProject } from '../doctor/doctor-project.js';
// Engine operations — tools domain (ENG-MIG-8 / T1575)
export {
  toolsAdapterActivate,
  toolsAdapterDetect,
  toolsAdapterDispose,
  toolsAdapterHealth,
  toolsAdapterList,
  toolsAdapterShow,
  toolsIssueDiagnostics,
  toolsProviderDetect,
  toolsProviderHooks,
  toolsProviderInject,
  toolsProviderInjectStatus,
  toolsProviderList,
  toolsProviderSupports,
  toolsSkillCatalogInfo,
  toolsSkillCatalogProfiles,
  toolsSkillCatalogProtocols,
  toolsSkillCatalogResources,
  toolsSkillDependencies,
  toolsSkillDispatch,
  toolsSkillFind,
  toolsSkillInstall,
  toolsSkillList,
  toolsSkillPrecedenceResolve,
  toolsSkillPrecedenceShow,
  toolsSkillRefresh,
  toolsSkillShow,
  toolsSkillSpawnProviders,
  toolsSkillUninstall,
  toolsSkillVerify,
} from '../engine/engine-ops.js';
export type { ScaffoldGlobalResult } from '../scaffold/scaffold-global.js';
export { scaffoldGlobal } from '../scaffold/scaffold-global.js';
export type {
  ScaffoldProjectOptions,
  ScaffoldProjectResult,
  ScaffoldProjectStep,
} from '../scaffold/scaffold-project.js';
export { scaffoldProject } from '../scaffold/scaffold-project.js';
// SDK Tools (Category B) — harness-agnostic infrastructure (T1768 / ADR-064)
export * from '../sdk/index.js';
// TaskTools (Category B) — pure-functional task graph SDK tools (T10068 / T9835)
export * from '../task-tools/index.js';
// Agent-facing tool registry (T1739 · E-TOOLS · epic T11456) — the Hermes
// `tools/registry.py` analogue. Self-discovering, OpenAI-format schema-emitting,
// toolset-grouped, availability-gated, frozen-after-init registry. Side effects
// always route through the guarded surface; auto-discovery is an EXPLICIT init()
// (NOT at module import — AC7).
export {
  AGENT_TOOL_REGISTER_FN,
  type AgentToolDescriptor,
  type AgentToolDiscoveryOptions,
  type AgentToolExecutable,
  AgentToolRegistry,
  ALWAYS_AVAILABLE,
  type AvailabilityCheck,
  createAgentToolRegistry,
  type ToolAvailabilityContext,
} from './agent-registry.js';
// Agent-facing tool families (T1741 · epic T11456) — terminal `run_shell` (PTY +
// non-PTY spawn fallback), paginated `read_file_paged`, atomic `write_file_atomic`,
// fuzzy `apply_patch`, ripgrep `search_files`, and the git family. Pure helpers
// (pagination, fuzzy patch, rg/git output parsing) are exported for direct unit
// testing; every executable routes side effects through the guarded surface.
export {
  applyFuzzyPatch,
  type FuzzyPatchOutcome,
  GIT_LOG_FORMAT,
  paginateLines,
  parseGitLog,
  parseGitStatus,
  parseRipgrepOutput,
  registerAgentToolFamilies,
} from './agent-tool-families.js';
// Web + browser agent tools (T1742 · epic T11456) — the `web` toolset:
// `web_search` (pluggable keyless backends), `web_extract` (HTML→markdown), and
// the Playwright-driven `browser_*` family. Playwright is OPTIONAL + lazily
// loaded; the browser tools register but report unavailable (with an install
// hint) when it is absent. The `browser_vision` AI call routes through the E9
// `resolveLLMForSystem` chokepoint + sealed credential — no raw provider call.
export {
  BrowserSession,
  isPlaywrightAvailable,
  PLAYWRIGHT_INSTALL_HINT,
  type PlaywrightLoader,
} from './browser-driver.js';
export { registerBuiltinAgentTools } from './builtin-agent-tools.js';
// Agent tool-call dispatch engine (T1740 · epic T11456) — the SDK chokepoint that
// turns a model-emitted tool-call into an executed, LLM-safe result: registry
// lookup → Zod-validate → availability → run-scoped budget → guarded execution →
// classified result + LLM-facing formatting. Pure dispatch; defines NO new tool
// primitive (Gate-11) and makes NO LLM call (Gate-13). The Pi adapter binds the
// loop's tool execution to this engine (AC6 — see core/src/llm/pi/pi-tool-bridge).
export {
  flattenZodIssues,
  formatToolResultForLlm,
  formatToolValueForLlm,
  MAX_TOOL_RESULT_CHARS,
  redactErrorMessage,
  TOOL_DISPATCH_ERROR_CODE,
  type ToolArgIssue,
  type ToolBudgetLimits,
  type ToolBudgetSnapshot,
  type ToolCall,
  ToolCallBudget,
  ToolDispatchEngine,
  type ToolDispatchEngineDeps,
  type ToolDispatchErrorKind,
  type ToolDispatchFailure,
  type ToolDispatchResult,
  type ToolDispatchSuccess,
  type ToolResultPayload,
  ToolTimeoutError,
} from './dispatch.js';
// Subprocess env scrubbing (T11897 · security) — the chokepoint builds a minimal,
// allowlisted child env so daemon secrets never leak and a Pi-controlled loader
// hook / PATH can never reach a spawned process.
export {
  isForbiddenEnvName,
  type ScrubEnvOptions,
  scrubSubprocessEnv,
  TRUSTED_PATH,
} from './env-scrub.js';
// `execute_code` agent tool (T11946 · M7) — the `agent` toolset's guarded
// code-execution capability. Routes every run through the existing
// `resolveExecutionEnv` selector (Gondolin micro-VM when available, in-process
// guarded `ExecutionEnv` otherwise — gondolin is OPTIONAL, so core builds with it
// ABSENT). Registered always; available() hides it unless `capabilities.codeExec`.
export {
  buildExecCommand,
  codeExecAvailable,
  EXEC_CODE_LANGUAGES,
  type ExecCodeAgentToolOptions,
  type ExecCodeLanguage,
  type ExecCodeResult,
  type ExecutionEnvResolver,
  registerExecCodeAgentTool,
} from './exec-code-agent-tool.js';
// Atomic-tool guard chokepoint (E3 · T11407 · T11474) — the ONLY public route to
// the fs/shell primitives. Raw primitives are intentionally not re-exported.
export {
  createToolGuard,
  GUARD_ENFORCE_DEADLINE,
  GUARD_ENFORCE_FLIP_ENABLED,
  GuardDeniedError,
  type GuardMode,
  resolveDefaultGuardMode,
  type ToolGuard,
  type ToolGuardPolicy,
} from './guard.js';
// PTY shell runner (T1741) — the terminal toolset's execution backend; lazily +
// optionally loads `node-pty`, transparently degrading to non-PTY `spawn`.
export { runPty } from './pty.js';
export { type ZodSchemaTool, zodSchemaToOpenAITool } from './schema-gen.js';
// Injectable shell executor (E3 · T11406) — threaded into the guard's
// executeShell/runGit; substitutes the subprocess layer in tests/sandboxes.
export { defaultShellExecutor, type ShellExecutor } from './shell.js';
export { registerWebAgentTools, type WebAgentToolOptions } from './web-agent-tools.js';
export {
  defaultHttpFetch,
  duckDuckGoBackend,
  extractTitle,
  fetchAndExtract,
  type HttpFetch,
  htmlToMarkdown,
  makeSearxngBackend,
  parseDuckDuckGoHtml,
  parseSearxngJson,
  resolveSearchBackends,
  runSearch,
  type WebSearchBackend,
} from './web-search-backends.js';
