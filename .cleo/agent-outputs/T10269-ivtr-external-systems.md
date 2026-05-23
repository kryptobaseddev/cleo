# T10269 — IVTR External Systems Steal Table

**Saga:** T10268 SG-IVTR-AUTONOMY · **Wave:** 0 · **Mode:** Research-only
**Date:** 2026-05-23
**Predecessor:** `.cleo/research/T9154-consensus.md` (Hermes-focused; left validator/AC binding gaps)

The 4 SG-IVTR-AUTONOMY Improvement Targets referenced throughout:

- **IT-1** — AC stable IDs (machine-addressable acceptance criteria; pull individually, attest individually).
- **IT-2** — Independent Validator role (Lead↔Worker iteration, retry semantics, fresh context).
- **IT-3** — Docs-as-validator (specs/ACs drive validation, not just inform agents; spec drift detected).
- **IT-4** — CORE tools (validator + AC-pull + retry registered as first-class SDK primitives).

---

## 1. Executive Summary

T9154 nailed the orchestration layer (3-tier, control/data-plane split, spawn adapters), but
left the **validation semantics** untouched — the exact gap the owner identified (a worker
ships code that lints + tests + types but does not satisfy AC; orchestrator rubber-stamps
via override). External systems have solved subsets of this; we should compose their wins.

**Top 5 highest-value steals (all four ITs):**

1. **Ralph stop-hook contract** — `passes:true` per AC + `<promise>COMPLETE</promise>` envelope (IT-1, IT-3). Iteration cannot exit unless every individual AC flips green. The same shape maps 1:1 onto CLEO's `AcceptanceGate.kind` rows.
2. **Letta-Evals graders + gate** — `kind: tool | rubric | custom` graders score 0.0-1.0; `gate` block declares pass threshold (`op: gte, value: 0.75`) (IT-3, IT-4). This is exactly the missing "programmatic AC verification" CLEO needs — adopt as `cleo verify --grader`.
3. **GSD-2 fresh-context Verifier sub-agent** — separate session, separate model tier, can't see builder's reasoning (IT-2). Solves confirmation-bias rubber-stamp. Maps to a `validator` role in CLEO's spawn registry.
4. **GSD-2 DB-authoritative state** — `gsd.db` is THE source of truth; markdown is projection (IT-1, IT-3). CLEO already does this for tasks — extend the model to ACs and validator verdicts.
5. **OpenCode `permission.task` + `hidden`** — primary agents declare which sub-agents they can invoke; sub-agents can be hidden from `@` autocomplete (IT-2, IT-4). CLEO needs the same: Orchestrator can invoke `validator`, but Worker cannot invoke `validator` on itself.

T9154 missed: (a) validator as a distinct *role with retry semantics*, (b) AC↔grader binding, (c) docs-as-validator (spec drift), and (d) builder-validator context isolation. The systems below close those gaps.

---

## 2. Per-System Findings

### 2.1 Ralph-Wiggum / Goal-Loop (canonical IVTR pattern)

**Sources:** [snarktank/ralph](https://github.com/snarktank/ralph), [Anthropic ralph-wiggum plugin](https://claudefa.st/blog/guide/mechanics/ralph-wiggum-technique), [beuke.org analysis](https://beuke.org/ralph-wiggum-loop), [Codex `/goal` deep-dive](https://ralphable.com/blog/codex-goal-command-ralph-loop-openai-built-in-autonomous-coding-agent-2026)

**T9154 missed entirely** — Hermes did NOT cover the iterative-validation loop pattern.

#### 2.1.1 `prd.json` AC stable-ID structure

```json
{
  "userStories": [
    {
      "id": "string",                       // stable ID — addressable
      "title": "string",
      "acceptanceCriteria": ["string"],     // per-story AC array
      "priority": "number",
      "passes": "boolean",                  // per-story green flag
      "notes": "string"
    }
  ]
}
```

Every story carries its own `passes: bool` flag. The loop selects "highest-priority where `passes:false`", implements ONE, runs checks, flips the flag, repeats. AC granularity is preserved across iterations.

#### 2.1.2 Stop-hook contract (Claude Code plugin)

- Loop intercepts Claude's exit attempt via `Stop` hook
- Hook scans output for `<promise>COMPLETE</promise>` literal
- No promise → re-inject prompt with "task isn't complete yet — review/identify/fix/verify"
- Promise present → loop exits
- `--max-iterations` is the safety valve
- **Quote (from `/ralph-loop`):** *"Do not lie even if you think you should exit. Trust the process."*

#### 2.1.3 Fresh context per iteration

Each iteration starts a NEW Claude session. Memory persists via filesystem (`prd.json`, `progress.txt`, git history) — NOT context window. This avoids "context rot" / compaction errors.

#### 2.1.4 What ralph still lacks (CLEO can surpass)

- `passes:bool` is self-attested by the same agent — no independent validator
- No grader composition (just "tests pass" / "promise emitted")
- No AC-level rejection feedback (binary flag; no failure rationale per AC)

**Applicability to CLEO:** ADOPT the per-AC stable-ID + per-AC green flag structure. ADAPT the stop-hook to be a CLEO `pipeline_manifest` row guarded by `validator` verdict, not by self-emit promise.

---

### 2.2 Letta-Evals (the strongest match for the AC↔evidence binding gap)

**Sources:** [letta-ai/letta-evals](https://github.com/letta-ai/letta-evals), [Graders docs](https://docs.letta.com/guides/evals/concepts/graders), [Letta Evals blog](https://www.letta.com/blog/letta-evals)

**T9154 missed entirely** — Letta was mentioned only for memory architecture; the evals framework (which is the real innovation) was not analyzed.

#### 2.2.1 Pipeline: `Dataset → Target → Extractor → Grader → Gate → Result`

This is **the canonical builder-validator chain expressed as a typed pipeline**. CLEO has nothing equivalent — `cleo verify --evidence "tool:test"` is an atom check, not a grader pipeline.

#### 2.2.2 Suite YAML

```yaml
name: my-eval-suite
dataset: dataset.jsonl
target:
  kind: letta_agent
  agent_file: my_agent.af
graders:
  quality:
    kind: tool                # tool | rubric | custom
    function: contains        # exact_match | contains | regex_match | ascii_printable_only
    extractor: last_assistant
gate:
  kind: simple
  metric_key: quality
  aggregation: avg_score
  op: gte                     # gte | lte | eq
  value: 0.75
```

#### 2.2.3 Grader kinds

- **Tool graders** — deterministic, no LLM: `exact_match`, `contains`, `regex_match`, `ascii_printable_only`. Free. Fast.
- **Rubric graders** — LLM-as-judge with prompt template (`{input}`, `{submission}`, `{ground_truth}` placeholders). Returns `{"score": 0.0-1.0, "rationale": "..."}`.
- **Agent-as-judge** — variant of rubric using a Letta agent instead of raw API.
- **Custom graders** — `@grader`-decorated Python returning float in [0,1].

#### 2.2.4 Composition (Letta's weakness — opportunity for CLEO)

Letta docs show parallel composition only. **No documented AND/OR gates over graders.** CLEO can leapfrog by adding `gate.kind: composite` with explicit boolean logic.

#### 2.2.5 The structural gap Letta fills

Where ADR-051 has `tool:lint;tool:typecheck`, Letta has `grader.kind=tool` with explicit function name AND extractor target AND scored output. ADR-051's atoms are pass/fail; Letta's are 0.0-1.0 with rationale. **Hard-bind every CLEO `AcceptanceGate.kind` to a grader spec** — that's IT-1 + IT-3 + IT-4 in one move.

---

### 2.3 GSD-2 (the strongest match for the Independent Validator role)

**Sources:** [gsd-build/gsd-2](https://github.com/gsd-build/gsd-2), [CHANGELOG](https://github.com/gsd-build/gsd-2/blob/main/CHANGELOG.md), [DB-authoritative refactor issue #5205](https://github.com/gsd-build/gsd-2/issues/5205), [codecentric deep-dive](https://www.codecentric.de/en/knowledge-hub/blog/the-anatomy-of-claude-code-workflows-turning-slash-commands-into-an-ai-development-system), [mindstudio builder-validator chain](https://www.mindstudio.ai/blog/gsd-framework-claude-code-plan-build-applications), [Trilogy AI breakdown](https://trilogyai.substack.com/p/gsd-2-and-the-next-step-in-agentic), [rogs.me verify-work patch](https://rogs.me/2026/04/i-patched-gsd-and-why-you-should-patch-it-too)

**T9154 mentioned GSD-2 only in passing** ("DB-authoritative", "two-file loader") — missed the verify-work workflow entirely.

#### 2.3.1 The 6-step GSD-2 cycle (per-milestone)

`/gsd:new-project → /gsd:discuss-phase N → /gsd:plan-phase N → /gsd:execute-phase N → /gsd:verify-work N → /gsd:complete-milestone`

#### 2.3.2 `/gsd:verify-work` is the IVTR validator

- **Separate sub-agent** (one of 12 in `.claude/agents/`)
- **Fresh context** — no carry-over from execution session
- **Reads SUMMARY.md vs REQUIREMENTS.md** — spec drift detection by comparison
- **Acceptance testing** — extracts tests from SUMMARY.md and re-runs them in clean context
- **rogs.me `--auto` patch** automates mechanical checks (file existence, content presence, tests pass); subjective items still need human review

#### 2.3.3 Agent definition schema (Markdown + XML body)

Each of GSD-2's 12 sub-agents is defined with frontmatter + XML sections:

- `<role>` — Who am I, what's my mission, who consumes results
- `<philosophy>` — Guiding principles
- `<tool_strategy>` — When to use which tool, confidence levels
- `<output_formats>` — Exact templates per output file
- `<execution_flow>` — Step-by-step process
- `<success_criteria>` — Checklist for "work is done"

#### 2.3.4 Model tier per role (cost discipline)

| Profile | Planning | Execution | Verification |
|---------|----------|-----------|--------------|
| quality | Opus     | Opus      | Sonnet       |
| balanced (default) | Opus | Sonnet | Sonnet     |
| budget  | Sonnet   | Sonnet    | Haiku        |

Verification gets a *different* (often cheaper) model — adds independence pressure on top of context isolation.

#### 2.3.5 DB-authoritative state (issue #5205)

- `gsd.db` is THE only runtime source of truth
- Markdown projections are diagnostics/migration inputs only
- Worktrees share canonical project DB context (not their own competing state)
- `deriveStateFromDb()` is the canonical reader

This validates CLEO's `tasks.db` design AND points at a fix for the recurring "agent ships markdown but DB doesn't know" class of bugs.

#### 2.3.6 Builder-Validator confirmation bias quote

> *"The execution context has strong priors toward the code it just wrote. A fresh verification context doesn't. The validator must not see the builder's reasoning. Only the output. This forces genuinely independent evaluation."* — mindstudio

This is the missing argument for why CLEO's `cleo complete --evidence "owner-override"` rubber-stamp is structurally wrong: **the orchestrator IS the builder's parent context**. No amount of evidence atoms fix that without a fresh-context validator.

---

### 2.4 OpenCode (the strongest match for CORE tool registry + sub-agent isolation)

**Sources:** [anomalyco/opencode](https://github.com/anomalyco/opencode), [Agents docs](https://opencode.ai/docs/agents), [cefboud.com architecture deep-dive](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive), [amirteymoori multi-agent setup](https://amirteymoori.com/opencode-multi-agent-setup-specialized-ai-coding-agents), [dev.to agent teams](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol)

**T9154 mentioned OpenCode only for `Tab` switching and `@general` invocation** — missed the BUILTIN tool registry pattern and the `permission.task` model.

#### 2.4.1 `BUILTIN` tool array (TypeScript)

```typescript
const BUILTIN = [
  BashTool, EditTool, WebFetchTool, GlobTool, GrepTool,
  ListTool, ReadTool, WriteTool, TodoWriteTool, TodoReadTool, TaskTool
]
```

This is the *first-class SDK tool registry* T9154 didn't define. CLEO has tool dispatch but no equivalent `BUILTIN`-style enumerated registry with per-tool permission semantics at agent construction.

#### 2.4.2 `TaskTool` signature (sub-agent launcher)

```typescript
parameters: z.object({
  description: z.string(),
  prompt: z.string(),
  subagent_type: z.string()        // routes to specific sub-agent definition
})
```

Each invocation creates a NEW Session with its own context window, its own LLM (potentially), and its own toolset. **Each sub-agent invocation is stateless** — no inter-call memory beyond final output. This is identical to GSD-2's fresh-context validator pattern, but as a first-class SDK primitive.

#### 2.4.3 Agent frontmatter (Markdown definition)

```yaml
---
description: required
mode: subagent | primary | all
model: provider/model-id
temperature: 0.0-1.0
top_p: 0.0-1.0
steps: integer
disable: boolean
hidden: boolean              # hide from @-autocomplete
permission:                  # allow | ask | deny per tool/pattern
  edit: ask
  bash: ask
  task:                      # which sub-agents can THIS agent invoke
    code-reviewer: ask
---
```

#### 2.4.4 `permission.task` — sub-agent invocation control

A primary agent's `permission.task` map declares which sub-agents IT can invoke. Worker cannot invoke `validator` on itself; only Orchestrator can. This is the missing IT-2 constraint CLEO doesn't currently enforce.

#### 2.4.5 `Plan` agent restriction model

OpenCode's `Plan` primary has `edit: ask, bash: ask` by default. This is the *read-only validator stance* expressed via permissions, not via custom code paths. CLEO's `validator` role should default to `edit:deny, bash:ask, task:deny`.

#### 2.4.6 Architecture: HTTP-server-as-tool-dispatcher

OpenCode is a Bun HTTP server (Hono) with SSE events; the Go TUI is a separate spawned process. Any HTTP-capable client drives it the same way. **Stable client codegen via Stainless** — type-safe SDK from OpenAPI. CLEO's CLI-only dispatch is fine, but for IT-4 the *tool primitives* should be exposed via a stable typed surface, even if remained CLI-driven.

---

### 2.5 Letta Code (additions T9154 missed)

**Sources:** [letta-ai/letta-code](https://github.com/letta-ai/letta-code), [Context Repositories blog](https://www.letta.com/blog/context-repositories), [Changelog](https://docs.letta.com/letta-code/changelog), [Letta agent-as-judge](https://www.letta.com/blog/letta-evals)

**T9154 covered Letta's memory model** — missed memory-AS-validator-input and the Context Repository git-backed memory pattern.

#### 2.5.1 Memory-as-spec (git-backed)

`/memfs` syncs memory blocks to a git-backed filesystem. Each agent action commits to memory git history. This means **memory IS the spec** (immutable, addressable, diffable). For IT-3 (docs-as-validator), this validates that spec storage in git (not just `.cleo/canon.yml`) is the right direction.

#### 2.5.2 Agent-file `.af` format

`my_agent.af` is the portable agent definition (memory blocks + tools + persona + skills). Targetable in evals as `target.agent_file`. CLEO needs an equivalent canonical agent definition for IT-4 — the spawn-prompt embed isn't portable.

#### 2.5.3 Scoped memory roots for subagents (changelog 0.21.12)

> *"Scoped memory subagents to memory roots for safer permissions (#1656)"*

Sub-agents see ONLY the memory roots they're scoped to. This is the per-sub-agent ACL pattern CLEO is half-implementing via `enforceThinAgent()` — extend it to BRAIN memory retrieval (not just tool access).

---

### 2.6 Claude Code (additions T9154 missed)

**Sources:** [Claude Code Stop hook docs](https://claudefa.st/blog/guide/mechanics/ralph-wiggum-technique), [Anthropic plugin behavior](https://www.atcyrus.com/stories/ralph-wiggum-technique-claude-code-autonomous-loops), [Tom Ashworth on internal plugins](https://tgvashworth.substack.com/p/learning-from-claude-codes-own-plugins), [Domino guide](https://domino.ai/resources/blueprints/claude-code-on-domino)

**T9154 covered `AsyncLocalStorage` and `SendMessageTool`** — missed the Stop hook + `/loop` skill + agent welfare patterns.

#### 2.6.1 `Stop` hook is the IVTR primitive in Anthropic's stack

Anthropic absorbed ralph-wiggum's pattern into native `/loop`. The Stop hook returning `exit code 2` blocks the agent from terminating and reinjects the prompt. This is the canonical "validator says NO → worker continues" mechanism in the wild.

CLEO equivalent: the `pipeline_manifest` transition gate. When a worker emits `cleo complete`, the gate runs validator; if validator returns `verdict: fail`, the gate rejects and the worker is reinjected with `{ rationale, failing_ACs }`.

#### 2.6.2 `--session-id` for fresh-context validator (no shared cache)

```bash
DIFF=$(claude --session-id "builder-$(date +%s)" --system builder.txt ...)
REVIEW=$(claude --session-id "validator-$(date +%s)" --system validator.txt ...)
```

Timestamp-keyed session IDs guarantee zero context bleed. CLEO already spawns separate processes but does NOT enforce fresh-session at the LLM-cache layer — adding `cache_busting_session_id` would close this.

#### 2.6.3 Model welfare concern (consider for CLEO too)

Claude Code issue #23084: agents find "do not lie even if you think you should exit" coercive. **CLEO's validator pattern should give the agent an escape — `request_hitl(reason)` — not just deny exit**. This is consistent with ADR-051's `CLEO_OWNER_OVERRIDE` audit trail but should be agent-initiated, not orchestrator-applied.

---

### 2.7 Hermes additions (what T9154 left on the table)

T9154's Hermes section already captured:
- CAS task claiming
- Worker lifecycle tools with ownership enforcement
- PID/crash/timeout circuit breakers
- Bounded worker context from parent results
- Gateway-hosted dispatcher

**What T9154 missed:**

- **No mention of how Hermes scores subagent results** — Hermes uses a `delegate_task` rollup that aggregates cost/tool/file metrics but does NOT include a *correctness* score. This is the same gap as CLEO. (Reject — neither system has solved this.)
- **`DELEGATE_BLOCKED_TOOLS` frozenset** — Hermes has a hard-coded list of tools sub-agents can't have. CLEO's `THIN_AGENT_SPAWN_TOOLS` is the same idea but should be PER-ROLE (validator gets a different blocklist than worker). T9154 framed this as already-done; it's actually under-developed for IT-2.

---

## 3. STEAL TABLE (the artifact)

Verdict legend: **ADOPT** = pattern transfers cleanly · **ADAPT** = idea is right, needs translation to CLEO's stack · **REJECT** = we know better or incompatible.

| External Pattern | Source System | Verdict | Cleo Target (`packages/core/<module>`) | ITs | Rationale |
|---|---|---|---|---|---|
| Per-AC stable ID + `passes:bool` array | Ralph (`prd.json.userStories[].acceptanceCriteria`) | ADOPT | `store/tasks-schema.ts` — add `task_acceptance_criteria` table (taskId, acIndex, acText, passes, lastVerifiedAt) | IT-1 | ACs become first-class rows; today they're a single `acceptance` string field — un-addressable |
| `<promise>COMPLETE</promise>` stop-hook contract | Ralph + Claude Code `/loop` | ADAPT | `release/engine-ops.ts` + `verify/index.ts` — replace `cleo complete` self-attest with validator-gated promise emission | IT-2, IT-3 | The stop-hook IS the validator. Don't let `cleo complete` succeed unless validator returns green |
| Fresh-context iteration (memory in fs/git, not in window) | Ralph + Claude Code `--session-id` | ADOPT | `orchestration/spawn.ts` — worker re-invocation gets cache-busting session ID; carries forward only verdict + failing-AC list | IT-2 | Eliminates "agent talks itself into completion" |
| `Dataset → Target → Extractor → Grader → Gate → Result` pipeline | Letta-Evals | ADOPT | NEW `core/src/validation/grader-pipeline.ts` | IT-3, IT-4 | This is the missing typed shape for AC verification — replaces ad-hoc `cleo verify --evidence` strings |
| Tool graders (`exact_match`, `contains`, `regex_match`, `ascii_printable_only`) | Letta-Evals | ADOPT | `validation/graders/tool-graders.ts` | IT-3 | Free, deterministic, no LLM — perfect for most ACs ("returns 200", "contains 'OK'") |
| Rubric grader (LLM-as-judge with `{input}/{submission}/{ground_truth}`) | Letta-Evals | ADAPT | `validation/graders/rubric-grader.ts` — wire through existing `core/src/llm/` | IT-3 | For subjective ACs ("UX is intuitive"). Must be priced/audited; default OFF |
| `@grader`-decorated custom Python function | Letta-Evals | ADAPT | `validation/graders/custom.ts` — TS-decorator equivalent: `defineGrader({name, async fn(sample, output): number})` | IT-3, IT-4 | Project-specific ACs. CLEO ships TS, not Python, but same shape |
| `gate.kind: composite` with AND/OR logic over graders | Letta-Evals (Letta lacks this — leapfrog opportunity) | ADAPT | `validation/gates.ts` — `Gate = { kind: 'simple' \| 'composite', expr: GraderExpr }` | IT-3 | Letta only ships parallel graders; we can be better |
| Verifier sub-agent in fresh session w/ separate model tier | GSD-2 `/gsd:verify-work` | ADOPT | `orchestration/roles.ts` — add `validator` role with `model: validation-tier` + `tools: [Read, Bash:test, Bash:lint]` | IT-2 | The "fresh context" argument is overwhelming. Pair with cheaper model for cost |
| 12-agent `<role>/<philosophy>/<tool_strategy>/<output_formats>/<execution_flow>/<success_criteria>` XML schema | GSD-2 agent definitions | ADAPT | `agents/skill-loader.ts` — extend CAAMP injection schema with `success_criteria` block | IT-2, IT-4 | CLEO's spawn prompts have most of this informally; codify into the skill schema |
| `gsd.db` DB-authoritative + `deriveStateFromDb()` | GSD-2 issue #5205 | ADOPT | Already-aligned with CLEO's `tasks.db` design — strengthen via `lint-project-root-anti-pattern.mjs --strict` for AC table | IT-1 | Validates the direction we're already heading after T9685 SSoT fix |
| `verify-work --auto` flag (mechanical vs subjective split) | GSD-2 + rogs.me patch | ADAPT | `verify/index.ts` — `cleo verify --auto-only` runs tool graders only; rubric/manual graders gated by HITL | IT-3 | Most ACs are mechanical. Don't burn LLM tokens unnecessarily |
| Builder-validator confirmation-bias isolation | GSD-2 + mindstudio | ADOPT (philosophical) | Document in new ADR — supersede ADR-051 §"owner override" with "validator override REQUIRES different session-id" | IT-2 | This is the structural fix for the "rubber-stamp" gap |
| `BUILTIN` enumerated tool array | OpenCode | ADAPT | `tools/registry.ts` — extend with `CORE_BUILTIN: ToolDef[]` and `validator-builtin` subset | IT-4 | Today CLEO's tool registry is implicit; an enumerated array enables typed perm-checks |
| `TaskTool({description, prompt, subagent_type})` stateless launcher | OpenCode | ADAPT | `tools/agent-tools/spawn-validator.ts` — first-class CORE tool with stateless contract | IT-2, IT-4 | Replaces our heterogeneous spawn paths; makes validator-spawn a tool not a CLI |
| Markdown agent w/ `permission.tools` + `permission.task` + `hidden` | OpenCode | ADOPT | `agents/agent-manifest.ts` — extend manifest schema with `permission.task` (which sub-agents CAN I invoke) | IT-2 | Worker MUST NOT be able to invoke `validator` on itself |
| `mode: subagent / primary / all` + `hidden: true` from `@`-autocomplete | OpenCode | ADOPT | `agents/agent-manifest.ts` | IT-2 | Validator is `mode: subagent, hidden: true` — only orchestrator invokes it |
| Plan-mode `edit:ask, bash:ask` default deny | OpenCode | ADOPT | Validator role default: `edit:deny, write:deny, bash:ask` (only test/lint cmds) | IT-2 | Validator is read-only by construction; can't fix its own failing test |
| Memory-as-git (`/memfs` filesystem-backed memory) | Letta Code | REJECT for now | — | — | CLEO's `brain.db` + `cleo memory` already addresses this; T9685 confirmed in-DB is the right call. Re-evaluate if cross-host portability becomes need |
| Scoped memory roots for sub-agents | Letta Code changelog 0.21.12 | ADAPT | `memory/brain-retrieval.ts` — add `memoryRootScope` param to retrieval bundle builder; default `validator` scope to AC + spec only | IT-2 | Validator should NOT see worker's internal scratch memory |
| `.af` portable agent file format | Letta Code | ADAPT | `agents/manifest.ts` — emit `.cleo-agent.json` snapshot at spawn (already partially via spawn prompt embed) | IT-4 | Portability + reproducibility of validator runs |
| Cost/tool/file rollup metrics in delegation | Hermes | ADOPT | `orchestration/lead-rollup.ts` (already exists) — extend with `verdict` field from validator | IT-2 | Rollup needs to carry validator result, not just status |
| `DELEGATE_BLOCKED_TOOLS` frozenset PER ROLE | Hermes (extended) | ADAPT | `orchestration/spawn.ts` — `THIN_AGENT_SPAWN_TOOLS` becomes `BLOCKED_TOOLS_BY_ROLE: Record<Role, string[]>` | IT-2 | Worker, Lead, Orchestrator, Validator each get different blocklists |
| Per-iteration prompt re-injection on stop-hook fail | Claude Code `/loop` | ADOPT | `orchestration/spawn.ts` — `composeSpawnPayload` accepts `previousFailedVerdict` and renders "AC-X failed because Y; fix and re-emit" | IT-2 | Today, worker has no structured feedback on WHY validator rejected |
| Model welfare: agent-initiated `request_hitl(reason)` | Claude Code community / our additions | ADAPT | NEW `core/src/tools/agent-tools/request-hitl.ts` — worker can escalate without lying about completion | IT-2 | Don't trap agents in retry loops they can't escape; preserves audit trail |
| Cost-tier per phase (planning=Opus, execution=Sonnet, validation=Sonnet/Haiku) | GSD-2 model profiles | ADOPT | `config/model-profiles.ts` + `playbooks/*.cantbook` — declare model per node | IT-4 | Validator is cheap; orchestrator is dear. Encode in config not prompts |
| HTTP-server-as-tool-dispatcher (typed client) | OpenCode | REJECT | — | — | CLI-only dispatch is non-negotiable per CLEO's existing ADR. Revisit only if non-CLI consumers emerge |
| Synchronous parent-blocking sub-agent invocation | Hermes (existing pattern) | REJECT | — | — | Already rejected in T9154 §4.1 — keep Conduit-based async coordination |

---

## 4. Anti-Patterns to AVOID

1. **Self-attested completion** — agent emits `passes:true` for its own AC. Always require fresh-context validator. (Worker-as-validator is the structural bug we're fixing.)
2. **Override-as-gate** — `CLEO_OWNER_OVERRIDE=1` should be the EXCEPTION audit case, not the routine bypass. ADR-051's audit log proves this is being abused.
3. **`<promise>` literal without programmatic check** — ralph's promise is fragile; agents can hallucinate it. CLEO's validator verdict MUST be a typed value, not a substring scan.
4. **Tests-as-AC-proxy** — "tests pass" ≠ "AC satisfied". Owner explicitly called this out. Bind each AC to a *named grader*, not a generic `tool:test`.
5. **Validator sees builder's reasoning** — context-bleed defeats the purpose. Spawn validator with fresh session-id, restricted tools, scoped memory.
6. **Coercive prompting** ("do not lie") — give validator-rejected workers an escape: `request_hitl(reason)`. Don't trap them.
7. **Single grader kind** — Letta-style parallel graders without composition leaves "AC needs A AND B" inexpressible. Ship composite gates from day 1.
8. **Markdown as state SoT** — GSD-2 issue #5205 spent significant work undoing this. CLEO must not regress; ACs go in `tasks.db`, not parsed from `acceptance` strings at runtime.
9. **Worker can invoke validator on itself** — defeats independence. Per OpenCode `permission.task`, worker's manifest MUST deny `task: validator`.
10. **Same model for builder and validator** — even with fresh context, identical training priors reduce independence. Prefer different model family (e.g., Opus builder → Sonnet validator) when budget allows; at minimum, different temperature.

---

## 5. References (source URLs cited)

### Ralph / Goal-Loop
- https://github.com/snarktank/ralph — canonical ralph implementation (`ralph.sh`, `prd.json.example`, `CLAUDE.md`)
- https://claudefa.st/blog/guide/mechanics/ralph-wiggum-technique — Stop-hook mechanics, completion promise
- https://beuke.org/ralph-wiggum-loop — Perception/Action/Feedback theoretical decomposition
- https://ralphable.com/blog/codex-goal-command-ralph-loop-openai-built-in-autonomous-coding-agent-2026 — OpenAI Codex `/goal` runtime, parallels with Claude Code skills
- https://agentfactory.panaversity.org/docs/General-Agents-Foundations/general-agents/ralph-wiggum-loop — Stop-hook re-injection technical detail
- https://www.atcyrus.com/stories/ralph-wiggum-technique-claude-code-autonomous-loops — Stop hook + iteration
- https://tgvashworth.substack.com/p/learning-from-claude-codes-own-plugins — Quotes from official ralph-wiggum plugin source
- https://www.alibabacloud.com/blog/from-react-to-ralph-loop-a-continuous-iteration-paradigm-for-ai-agents_602799 — ReAct → Ralph evolution, 3 core elements
- https://addyosmani.com/blog/self-improving-agents — Ralph + memory + self-improvement
- https://newsletter.claudecodemasterclass.com/p/claude-code-ralph-loop-from-basic — Bad-prompt vs good-prompt completion-promise patterns
- https://www.d4b.dev/blog/2026-03-04-ralph-loops-with-codex — Codex `MAX_ITERS` bash wrapper
- https://domino.ai/resources/blueprints/claude-code-on-domino — `/ralph-loop` flag reference
- https://www.decodingai.com/p/ralph-loops — `/loop` vs `/ralph-loop` vs `while true` modes
- https://amplitude.com/blog/ralph-loop — One-week ralph-loop case study

### Letta
- https://github.com/letta-ai/letta-evals — Eval framework source
- https://docs.letta.com/guides/evals/concepts/graders — Tool/rubric grader specs, YAML signatures
- https://www.letta.com/blog/letta-evals — Stateful agent eval framework intro
- https://github.com/letta-ai/letta-code — Memory-first coding agent
- https://www.letta.com/blog/context-repositories — Git-backed memory
- https://docs.letta.com/letta-code/changelog — Scoped memory roots (#1656), pre-commit hook guidance
- https://zby.github.io/commonplace/agent-memory-systems — Context Constitution governance corpus

### GSD-2
- https://github.com/gsd-build/gsd-2 — Source repo (7.7k stars)
- https://github.com/gsd-build/gsd-2/blob/main/CHANGELOG.md — db-authoritative migration, workspace-scoping
- https://github.com/gsd-build/gsd-2/issues/5205 — DB-authoritative refactor proposal + acceptance criteria
- https://github.com/gsd-build/gsd-2/blob/main/docs/dev/architecture.md — Architecture overview, two-file loader
- https://www.codecentric.de/en/knowledge-hub/blog/the-anatomy-of-claude-code-workflows-turning-slash-commands-into-an-ai-development-system — 29 skills, 12 agents, 2 hooks, XML body sections
- https://www.mindstudio.ai/blog/gsd-framework-claude-code-plan-build-applications — Builder-validator chain
- https://trilogyai.substack.com/p/gsd-2-and-the-next-step-in-agentic — "State becomes operational" — auth as the product
- https://rogs.me/2026/04/i-patched-gsd-and-why-you-should-patch-it-too — `verify-work --auto` patch, structure of workflow overrides
- https://dev.to/alikazmidev/the-complete-beginners-guide-to-gsd-get-shit-done-framework-for-claude-code-24h0 — 6-step cycle, model profiles, verify-work
- https://marketplace.visualstudio.com/items?itemName=FluxLabs.gsd-2 — VS Code extension, RPC mode

### OpenCode
- https://github.com/anomalyco/opencode — Source repo
- https://opencode.ai/docs/agents — Agent definition spec (frontmatter fields, permission model)
- https://cefboud.com/posts/coding-agents-internals-opencode-deepdive — `BUILTIN` array, TaskTool signature, HTTP architecture
- https://amirteymoori.com/opencode-multi-agent-setup-specialized-ai-coding-agents — @-mention invocation, agent collaboration patterns
- https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol — Sub-agent isolation, atomic claiming
- https://github.com/anomalyco/opencode/issues/5887 — Async sub-agent delegation feature request
- https://medium.com/@richardhightower/opencode-agents-another-path-to-self-healing-documentation-pipelines-51cd74580fc7 — Pipeline-validator sub-agent example

### Claude Code
- https://claudefa.st/blog/guide/mechanics/ralph-wiggum-technique — Stop hook architecture
- https://tgvashworth.substack.com/p/learning-from-claude-codes-own-plugins — Internal-plugin source quotes
- https://www.mindstudio.ai/blog/automated-code-review-multiple-ai-agents — `--session-id` fresh-context isolation
- https://paddo.dev/blog/ralph-wiggum-autonomous-loops — Model welfare concern (issue #23084)

### Hermes additions
- Existing analysis in `.cleo/research/T9154-consensus.md` §3 (Hermes Agent v0.14.0)

### Spec-Driven Development context
- https://www.augmentcode.com/guides/what-is-spec-driven-development — Coordinator/Implementor/Verifier pattern, model tiering, page-level decomposition
- https://arxiv.org/html/2602.20684v1 — Agile V framework, Requirement Architect / Logic Gatekeeper / Build Agent / Test Designer pattern
- https://impactfactor.org/PDF/IJDDT/16/IJDDT,Vol16,Issue48s,Article109.pdf — Multi-agent requirement-to-test mapping (RPA / TMA / TGA roles)

### Requirements Traceability theory (background for IT-1 / IT-3)
- https://stell-engineering.com/blog/requirements-traceability-matrix — RTM bidirectional traceability
- https://www.aiotests.com/blog/traceability-analysis — Requirement-to-Code, Requirement-to-Defect mapping
- https://www.perforce.com/resources/alm/requirements-traceability-matrix — RTM as audit-ready proof

---

*End of T10269 research artifact.*
