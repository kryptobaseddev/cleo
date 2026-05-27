# ADR-035: Pi v2+v3 — Native Operations and Exclusive Orchestration

**Date**: 2026-04-07
**Status**: accepted
**Accepted**: 2026-04-07
**Related Tasks**: T261, T262, T263, T264, T265, T266, T267, T268, T269, T270, T271, T272, T273, T274, T275, T276, T277, T278, T279
**Related ADRs**: ADR-031, ADR-033, ADR-014
**Summary**: Resolves the v2 (native Pi operations) and v3 (Pi-exclusive orchestrator) design for the CAAMP Pi harness. Defines a three-tier scope hierarchy (project > user > global), per-verb JSONL session parsing, dual-file models config authority, a real stdio JSON-RPC MCP bridge runtime that lives inside CAAMP (no new package), wiring of the existing CANT topology (`@cleocode/cant` parser + `@cleocode/core/cant` `WorkflowExecutor` — currently dead code) into both `cleo agent start` and a Pi extension via the same two imports (no new package), `PiHarness.spawnSubagent` as the sole subagent path, and a three-mode exclusivity switch (auto/force-pi/legacy) for v3. Ships spec hooks for all 17 downstream implementation tasks. **Adds zero new top-level packages.**
**Keywords**: pi, harness, caamp, mcp, cant, subagent, orchestrator, v2, v3, exclusivity, xdg, scope-hierarchy, jsonl, rcasd, json-rpc, modelcontextprotocol
**Topics**: orchestrate, tools, admin, session

---

T261 is the parent epic and T262 is this ADR; T263–T279 are the downstream implementation tasks whose acceptance criteria reference the spec hooks recorded here.

## Context

In v2026.4.5 we shipped the Pi harness foundation: Pi was registered in `packages/caamp/providers/registry.json` with `priority: "primary"` and `capabilities.harness` populated, and `packages/caamp/src/core/harness/pi.ts` introduced a `PiHarness` class with 10 fully-implemented methods (`installSkill`, `removeSkill`, `listSkills`, `injectInstructions`, `removeInstructions`, `installMcpAsExtension`, `spawnSubagent`, `readSettings`, `writeSettings`, `configureModels`) and 37 passing unit tests in `packages/caamp/tests/unit/harness/pi.test.ts`. Command dispatch already defaults to Pi when Pi is installed via `resolveDefaultTargetProviders()` in `packages/caamp/src/core/harness/index.ts`.

That foundation is **not** a complete Pi-as-orchestrator. Five concrete gaps remain that this ADR addresses as a single coherent design:

1. **No `caamp pi <verb>` command surface.** None of the verbs the epic names (extensions, sessions, models, prompts, themes, cant) exist yet. CAAMP today has command groups for `providers`, `skills`, `instructions`, `config`, `doctor`, `advanced` — but nothing Pi-specific.
2. **MCP bridge is a scaffold, not a runtime.** `installMcpAsExtension` writes a TypeScript stub file under `extensions/mcp-<name>.ts` that logs "not yet implemented". There is no JSON-RPC client, no subprocess lifecycle manager, no tool-schema translator. Pi itself explicitly does not implement MCP (`pi-mono/packages/coding-agent/README.md`); MCP must be added as a Pi extension by us.
3. **CANT runtime bridge is broken.** Eight `.cant` files exist under `.cleo/agents/` and `packages/agents/`. `cleo cant parse` and `cleo cant validate` work via the `@cleocode/cant` napi binding. But `cleo agent start <agentId>` loads and validates the `.cant` profile and then **never passes the AST to `createRuntime()`** (`packages/cleo/src/cli/commands/agent.ts:255–315`). The `WorkflowExecutor` in `packages/core/src/cant/workflow-executor.ts` is dead code at runtime.
4. **`spawnSubagent` is implemented but not the primary path.** CLEO still has subagent-spawning code that calls `child_process.spawn()` directly instead of going through the harness. Until that consolidates, we cannot reason about session attribution or error propagation uniformly.
5. **No exclusivity switch.** The current `resolveDefaultTargetProviders()` already prefers Pi when installed but it does not prevent direct dispatch to other providers — it only changes the default. v3 needs a runtime mode that routes *all* commands through Pi (with non-Pi providers becoming pure spawn targets).

Pi's own architecture, established by exploring `/mnt/projects/pi-code/`, also drives this design and is worth recording explicitly:

- **Scope model**: Pi uses a **two-tier hierarchy** — project-local (`.pi/extensions/`) searched first, then global (`~/.pi/agent/extensions/`). It honours `$PI_CODING_AGENT_DIR`. It is **not XDG**; it uses a hardcoded dotfolder. Discovery is in `pi-mono/packages/coding-agent/src/core/extensions/loader.ts:511–557` (`discoverAndLoadExtensions`).
- **Sessions**: append-only JSONL in `~/.pi/agent/sessions/`. Line 1 is a `{type: "session", version: 3, id, timestamp, cwd, parentSession?}` header; subsequent lines are typed entries (`message`, `thinking_level_change`, `model_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`). Resume by `pi --session <id>` or `pi --fork <id>`. Pi loads the entire session into memory at startup.
- **Models config is split**: `models.json` defines what models exist (custom plus built-ins from `@mariozechner/pi-ai`). `settings.json:enabledModels` filters which are *surfaced*. `defaultModel`/`defaultProvider` also live in `settings.json`.
- **MCP**: not implemented in Pi by design.
- **Extensions are TypeScript modules**, no manifest, loaded via `jiti`. Lifecycle hooks: `session_start`, `session_shutdown`, `before_agent_start`, `turn_start`, `turn_end`, `before_tool_call`. API includes `registerTool`, `registerCommand`, `on`, `ui.*`, `setModel`, `sessionManager`.
- **Subagent spawning** is *demonstrated* in `pi-ext/extensions/subagent-widget.ts` (uses `child_process.spawn()` to invoke `pi` recursively, persists each child to its own JSONL) but is **not a first-class API**. There is no built-in orchestration, exit-code handling, or session-linkage convention.
- **CLI subcommands that the epic names do not exist in Pi**: `pi extensions list`, `pi sessions list`, `pi prompts install`, `pi themes install` — none of these are Pi verbs. Pi's `--list-models`, `--models`, `--session`, `--fork`, and the `pi install/remove/update/list` package manager are the only existing surfaces. Everything else CAAMP must wrap.

The CLEO-OS integration scope plan (`pi-code/CLEO-OS-INTEGRATION-SCOPE.md`) wants XDG paths (`~/.local/share/cleo/`, `~/.config/cleo/`) with a Global Extensions Hub at `~/.local/share/cleo/pi-extensions/`. The provider registry already declares this hub via `capabilities.harness.globalExtensionsHub: "$CLEO_HOME/pi-extensions"`. **Pi's hardcoded dotfolder and CLEO's XDG-aligned hub are two different roots that both need to participate in extension resolution.** This ADR resolves that tension without modifying Pi.

## Decision

### D1 — Three-tier scope hierarchy with explicit precedence

CAAMP wraps Pi's two-tier model with a third tier and a deterministic precedence order. All `caamp pi <verb>` commands that touch extensions, prompts, themes, MCP servers, and CANT files use the same scope model:

| Tier | Path | When chosen | Precedence |
|------|------|-------------|------------|
| `project` | `<cwd>/.pi/extensions/` etc. | repository-scoped, default for `install` verbs | highest |
| `user` | `$PI_CODING_AGENT_DIR` or `~/.pi/agent/...` | user-global, what Pi natively reads | middle |
| `global` | `$CLEO_HOME/pi-extensions/` etc. (default `~/.local/share/cleo/pi-extensions/`) | cross-project hub managed by CleoOS | lowest |

Resolution order on read (list/show): walk **project → user → global**, the first hit wins. Commands always report which tier the result came from.

Conflict handling on write (install/copy): if a file already exists at the target tier, **error by default**; `--force` enables overwrite. Cross-tier name collisions are resolved by precedence — they are not errors and are surfaced via a warning during list operations.

Pi's native loader is **not modified**. CAAMP's role is to copy files into the tier the user picked; Pi's existing two-tier discovery picks them up automatically because tiers `project` and `user` map to Pi's native paths. The `global` tier is symlinked or copied into the `user` tier on first use of any extension from it (lazy materialization). This keeps Pi unmodified while giving CleoOS a real cross-project hub.

> **Spec hook for T263 (`caamp pi extensions`)**: Commands `list`, `install <source>`, `remove <name>` accept `--scope project|user|global` (default `project` for install, all-tiers for list). `list` reports tier per entry. `install` errors on existing target unless `--force`. The 42 spawn-target providers in registry.json are unaffected — extensions are Pi-only.

### D2 — JSONL session parsing: per-verb strategy, never reimplement resume

Pi's session JSONL files can be small (a fresh chat) or many MB (a long-running orchestration). A blanket "load-all" or "stream-everything" rule is wrong. Each verb picks the cheapest strategy:

- **`caamp pi sessions list`** reads only **line 1** of each `*.jsonl` under `~/.pi/agent/sessions/` (and the subagents subdirectory). That single line gives `id`, `timestamp`, `cwd`, `parentSession` — enough for a listing. The file's `mtime` is the last-activity sentinel. **Never** load full session bodies for a list operation.
- **`caamp pi sessions show <id>`** loads the full file (matches Pi's own startup behaviour, simplest). For files over a configurable threshold (default 5 MB), warn and offer `--head N` / `--tail N`.
- **`caamp pi sessions export <id> --jsonl|--md`** streams line-by-line into the output sink without holding the whole file in memory. Markdown export filters to `message`/`custom_message` entry types only.
- **`caamp pi sessions resume <id>`** is a thin shell-out: `exec pi --session <id>`. We do **not** reimplement Pi's resume — Pi owns the lifecycle.

Schema versioning: the line-1 `version: 3` field is checked. `caamp pi sessions list` warns on unknown versions but does not error.

> **Spec hook for T264 (`caamp pi sessions`)**: Verbs `list`, `show <id>`, `export <id>`, `resume <id>`. `list` MUST NOT read past line 1 of any session file. `resume` MUST `exec` Pi rather than reimplement. Output formats: JSON-for-LLM by default, `--human` table for `list`.

### D3 — Models config: dual-file authority, separate verbs

Pi splits model configuration intentionally and we honour that split:

- `models.json` is authoritative for **definitions** — what providers and model IDs exist.
- `settings.json:enabledModels` is authoritative for **selection** — which subset is surfaced to the LLM picker.
- `settings.json:defaultModel` and `defaultProvider` are authoritative for **defaults** — what runs when no model is named.

CAAMP's `caamp pi models` verbs map cleanly onto these slots and never duplicate:

| Verb | Mutates | Reads |
|------|---------|-------|
| `caamp pi models list` | — | both files; renders union with `[active]`/`[default]` flags |
| `caamp pi models add <provider>:<id> [--baseUrl ...]` | `models.json` | — |
| `caamp pi models remove <provider>:<id>` | `models.json` | — |
| `caamp pi models enable <pattern>` | `settings.json:enabledModels` (append) | `models.json` (validate) |
| `caamp pi models disable <pattern>` | `settings.json:enabledModels` (remove) | — |
| `caamp pi models default <provider>:<id>` | `settings.json:defaultModel`+`defaultProvider` | `models.json` (validate) |

Validation: `enable`/`default` cross-check that the referenced model exists in `models.json` (or in Pi's built-in registry from `@mariozechner/pi-ai`). Mutations always go through `PiHarness.writeSettings`, which already does atomic tmp-then-rename.

> **Spec hook for T265 (`caamp pi models`)**: Six verbs above. NEVER write a model definition to `settings.json` or an enable/disable list to `models.json`. Each mutation is atomic and validated against the other file.

### D4 — MCP status in CleoOS: legacy interop only

MCP is not a first-class CleoOS primitive. Pi extensions strictly
dominate MCP tools on every axis: hooks (22 events vs 0), slash
commands (vs none), system-prompt injection (vs none), tool blocking
and rewriting (vs none), custom renderers (vs none), provider
registration (vs none), keybindings (vs none), direct TypeScript
function calls (vs JSON-RPC framing + subprocess overhead per call).

MCP solves multi-client coordination — the scenario where many
independent agents (Claude Desktop, Cursor, Zed, Claude Code, etc.)
need to share tool servers. CleoOS is a single-client architecture:
Pi is the only harness CLEO routes through. The multi-client
problem MCP solves does not exist here.

If a user wants a specific existing MCP server's functionality
inside Pi, the correct answer is "write a Pi extension." The
existing MCP server source is a reference implementation, not a
runtime target. CAAMP does not ship an MCP bridge runtime, and
`installMcpAsExtension` has been removed from PiHarness in this PR.

If future demand justifies a migration ramp, the shape would be a
one-shot `caamp pi extensions import-mcp <source>` converter that
reads an MCP server's tool schema and emits a native Pi extension
`.ts` file. That is optional future work, not a runtime bridge.

### D5 — CANT execution: single engine, cant-bridge.ts as canonical

CANT workflow execution lives entirely in
`packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts` —
a 989-line Pi extension that interprets all 16 workflow statement
types via `pi.exec` shell-out to `cleo cant parse/validate/execute`.
It does NOT import from `@cleocode/*`; it is architecturally pure.

The previously-planned parallel `@cleocode/core/cant/WorkflowExecutor`
namespace has been DELETED in this PR. It was dead code with zero
production callers and strictly duplicate with cant-bridge.ts. Two
engines would have diverged; one engine is simpler and correct.

The `cleo agent start` daemon does NOT execute workflow profiles
internally — it only polls SignalDock for messages. Profile-driven
behaviour (hooks, workflows, skill injection) runs inside Pi sessions
when the user loads the profile via `/cant:load <file>` and invokes
workflows via `/cant:run <file> <workflowName>`. The daemon and the
Pi session are distinct runtimes with distinct purposes.

### D6 — Subagent spawn: PiHarness.spawnSubagent is the only path

`PiHarness.spawnSubagent` becomes the **single canonical subagent spawn path** for all of CLEO. Any code today that calls `child_process.spawn()` to launch a sub-Pi (or any subagent) is migrated to call `PiHarness.spawnSubagent` instead. Direct `spawn()` calls in subagent contexts become a lint error (custom biome rule, not blocking for v2 but tracked for v3 cleanup).

Streaming and attribution conventions:

- **stdout**: Pi's `--mode json` produces line-delimited JSON. The harness line-buffers stdout, parses each line, and forwards it to the parent's session as a `custom_message` JSONL entry tagged `{ subagentId, lineNumber }`. The parent LLM sees subagent output natively in its context.
- **stderr**: line-buffered, tagged `subagent_stderr`, **not** injected into parent context — only logged.
- **Exit codes**: non-zero exit raises a `subagent_failed` event with the captured exit code, signal (if any), and the path to the child's session JSONL. Partial output is preserved, never discarded.
- **Session attribution**: child's session file is at `~/.pi/agent/sessions/subagents/subagent-{parentSessionId}-{taskId}.jsonl`. Parent records the child session ID in its own JSONL via a `custom` entry of type `subagent_link`. Listing the parent shows children automatically.
- **Cleanup**: parent owns the `ChildProcess` reference. On parent shutdown, SIGTERM all children, then SIGKILL after 5 seconds. The 5 s grace is configurable via `settings.json:pi.subagent.terminateGraceMs`.
- **Concurrency**: a parent may run N children. CANT's `parallel: race` maps to `Promise.race(handles.map(h => h.exitPromise))`; `parallel: settle` maps to `Promise.allSettled(...)`. The CANT bridge from D5 emits these constructs as bridge calls so the harness owns the actual spawning.

> **Spec hook for T277 (Orchestrator mode)**: `PiHarness.spawnSubagent` is the only spawn path. All existing direct `child_process.spawn()` callers in CLEO subagent code are migrated. Streaming uses line-delimited JSON. Children attributed to parent via `subagent_link` custom entry. Tests must cover happy path, exit-code propagation, and SIGTERM-then-SIGKILL cleanup.

### D7 — v3 exclusivity: three-mode runtime switch with deprecation warnings

v3 introduces a configuration setting `caamp.exclusivityMode` with three values:

| Mode | Behaviour when Pi installed | Behaviour when Pi absent |
|------|----------------------------|--------------------------|
| `auto` (default) | All dispatch routes through Pi. Direct provider targeting (`--agent claude-code`) emits a deprecation warning, then proceeds by spawning that provider as a Pi subagent. | Falls back to today's multi-provider dispatch with a one-line warning at boot: `Pi is not installed. Running in legacy multi-provider mode. Install with: caamp providers install pi`. |
| `force-pi` | Same as `auto`, but no warnings — Pi is the only path. | Hard error at boot: `force-pi mode requires Pi to be installed`. |
| `legacy` | Today's behaviour preserved. CAAMP dispatches directly to all providers. Pi is just another provider. | Same as `auto` Pi-absent. |

**v2 (T263–T277)**: this setting does not exist; behaviour is today's "Pi preferred when present, falls back when absent". v2 is purely additive.

**v3 (T278/T279)**: the setting is added with default `auto`. `resolveDefaultTargetProviders()` checks the mode. The 42 spawn-target providers in registry.json keep their `installSkill`/`installInstructions` paths working (skills/instructions install is **not** routed through Pi — it remains direct). Only **runtime invocation** (sessions, command execution, prompts, model selection) routes through Pi exclusively in `auto`/`force-pi` modes.

This split is critical: scripts that today run `caamp skills install foo --agent claude-code` continue working unchanged in `auto` mode. Scripts that today run `claude-code "do thing"` get a deprecation warning when invoked through CAAMP, but the actual provider binary still runs — just as a Pi subagent rather than a direct invocation.

Migration story:
- Ship v2 first (T263–T277). Surface no exclusivity changes.
- Ship v3 with `auto` as default and a CHANGELOG entry warning users about the deprecation of direct provider targeting in command execution paths.
- v3.1 (out of scope here) would add a `caamp pi migrate` verb that audits scripts under `.cleo/scripts/` and the user's shell history for direct provider invocations and suggests rewrites. This is a future deliverable, mentioned only so the design leaves room for it.

> **Spec hook for T278 (CAAMP v3 exclusive)**: Add `caamp.exclusivityMode` setting. `resolveDefaultTargetProviders` honours it. Skill/instruction install paths are NOT affected. Deprecation warning is emitted exactly once per process for direct provider targeting in `auto` mode.
>
> **Spec hook for T279 (CLEO v3 exclusive)**: `cleo` dispatch (the agent runtime side) honours the same setting via a shared config reader. `cleo agent start` in `force-pi` mode requires Pi to be installed. Tests cover all three modes × Pi-installed/absent matrix.

### Cross-cutting concerns

**File conflict handling (universal)**: every `caamp pi <noun> install` verb refuses to overwrite an existing file at the target tier without `--force`. Listing across tiers de-duplicates by name with the higher-precedence tier winning, but the conflict is always reported in the listing output (so the user knows they have a shadowed copy).

**Version migration**: CAAMP records the installed Pi version in `.cleo/state/pi-version.txt` after each successful command. On detecting a version change, it runs `caamp pi doctor` automatically (the doctor verb itself is part of T263's scaffolding) and warns about extensions/MCP servers that may need re-installing. It does NOT do automatic data migration; that is opt-in via an explicit `caamp pi migrate` verb (out of scope for this ADR).

**Pi-absent fallback for v2 verbs**: every `caamp pi <verb>` command checks for Pi installation at startup. If absent, the command exits with status 4 (`E_NOT_FOUND`) and a single line: `Pi is not installed. Run: caamp providers install pi`. There is no silent fallback to a different provider — these commands are Pi-specific by name. The default-dispatch behaviour for non-pi verbs (`caamp skills install`, etc.) is unchanged in v2.

**Spec hooks for the remaining features (so each downstream task has at least one copy-pasteable AC)**:

- **T266 (`caamp pi prompts install`)**: target tier (`project`/`user`/`global`) selectable via `--scope`. Source is a directory containing a `prompt.md` plus optional metadata. Conflict handling per universal rule. List verb reads only the directory listing — never reads prompt bodies — for token efficiency.
- **T267 (`caamp pi themes install`)**: same scope+conflict shape as prompts. Theme is a single TypeScript file matching Pi's existing theme module shape (from `pi-ext/themes/`). List verb reports tier per theme.
- **T269 (MCP JSON-RPC client)**: implements `initialize`, `tools/list`, `tools/call`, `shutdown` with stdio transport. Reuses `@modelcontextprotocol/sdk` types. Unit tests with a mock MCP server.
- **T270 (MCP schema translator)**: takes an MCP tool definition (`name`, `description`, `inputSchema`) and emits a Pi tool definition with the same signature. Handles MCP-specific result types (text/image/resource) by converting to Pi's text result format.
- **T271 (MCP subprocess lifecycle)**: spawns child via stdio, monitors exit, retries once on crash, SIGTERM then SIGKILL on parent shutdown.
- **T272 (MCP HTTP/SSE)**: same `bridge.attach` API, different transport. Unit tests with a mock HTTP server.
- **T274 (CANT TS loader)**: thin TS wrapper around the `@cleocode/cant` napi binding that returns a typed AST. Caches parsed ASTs by file mtime.
- **T275 (CANT AST → Pi bridge)**: maps each AST node type (agent, protocol, workflow, token) to the appropriate Pi registration call. Registers an idempotent unregister callback for `session_shutdown`. **Also** wires the same loader into `cleo agent start` via `createRuntime({ profile })`, fixing the existing runtime bridge bug as a side-effect.
- **T276 (`caamp pi cant`)**: install/list/remove verbs honouring the universal scope+conflict rule. Validate verb runs the parser without registering anything (dry-run).

### Architecture-question resolution summary

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Extension/prompts/themes scope | Three tiers: project > user > global. Conflict-on-write errors unless `--force`. Pi unmodified; CleoOS hub is the third tier. | Honours Pi's two-tier reality, adds CleoOS hub, no Pi changes required. |
| 2 | JSONL parsing | Per-verb: list reads line-1 only, show loads-all, export streams, resume shells out to Pi. | Avoids loading multi-MB files for cheap operations; never reimplements Pi-owned semantics. |
| 3 | Models authority | `models.json` = definitions; `settings.json:enabledModels` = selection. Verbs are partitioned, never duplicate. | Pi's split is intentional and works; trying to merge introduces sync bugs. |
| 4 | MCP status | Not a first-class CleoOS primitive. CAAMP ships no MCP runtime bridge; `installMcpAsExtension` removed from PiHarness. Pi extensions strictly dominate MCP tools. | MCP solves multi-client coordination — CleoOS is single-client (Pi). The problem MCP solves does not exist here. |
| 5 | CANT execution | Single engine: `cant-bridge.ts` Pi extension shells out to `cleo cant parse/validate/execute` for all 16 workflow statement types. No `@cleocode/*` import. The parallel `@cleocode/core/cant/WorkflowExecutor` namespace is **deleted** (was dead code, zero production callers). | Two engines would diverge; one canonical engine is simpler and correct. The Pi extension is pure architecturally. |
| 6 | Spawn mechanics | `PiHarness.spawnSubagent` is the only spawn path. Streaming via line-delimited JSON `custom_message` entries. Sessions linked via `subagent_link` custom entries. SIGTERM + 5 s grace + SIGKILL. | Consolidates today's scattered direct-spawn calls; mirrors Pi's own subagent example as the convention. |
| 7 | v3 exclusivity | `caamp.exclusivityMode` setting with `auto`/`force-pi`/`legacy`. Affects runtime invocation only — skill/instruction install paths unchanged. | Allows incremental migration; preserves all existing scripts; lets `force-pi` enforce purity for users who want it. |

## Consequences

### Positive

- **One canonical spawn path** eliminates a class of bugs around session attribution, exit-code propagation, and cleanup that today's scattered `child_process.spawn()` calls cause.
- **MCP-as-extension** lets CLEO support the entire MCP ecosystem without Pi having to add MCP support natively, which Pi has explicitly declined to do.
- **CANT runtime bridge fix is the entire T275 deliverable, not a side-effect.** The wire-up that activates the existing `WorkflowExecutor` (today's dead code in `@cleocode/core/cant`) is the same wire-up the Pi extension needs — both callers import the same two existing packages. Eliminates one of the biggest gaps in the CleoOS vision without adding any new package.
- **v3 exclusivity is opt-out, not opt-in**, so users get the orchestration model on upgrade with a deprecation warning. Scripts keep working. Power users can pin `legacy` mode while they migrate.
- **Three-tier scope** is forwards-compatible with the CleoOS XDG vision while not requiring any Pi modifications.
- **Per-verb JSONL strategies** prevent the obvious memory bloat of "load every session file just to list them" while not over-engineering the cases (show, export) where load-all is fine.

### Negative

- **No new packages are introduced.** The MCP bridge runtime lives under `packages/caamp/src/core/harness/mcp/` next to the existing PiHarness. The CANT bridge is glue between two existing packages (`@cleocode/cant` and `@cleocode/core`'s `cant/` namespace) that are already shipped — `WorkflowExecutor` was dead code waiting to be wired.
- **Three-tier scope adds complexity** to every list/install verb. The conflict-reporting story is non-trivial.
- **MCP crash recovery has a single retry** — sophisticated resilience (circuit breakers, health checks) is out of scope for v2. Long-running orchestrations will see degradation if MCP servers are flaky.
- **`auto` mode's deprecation warning** will frustrate users who have automation that explicitly targets non-Pi providers. We accept this as the cost of the migration story; it is mitigated by the fact that the warning fires only once per process.
- **This ADR locks in Pi's hardcoded `~/.pi/` dotfolder for the user tier** rather than pushing Pi upstream toward XDG. CleoOS gets XDG via the `global` tier, but users sharing a config across machines still have to deal with `~/.pi/`. Upstreaming XDG to Pi is left as a future negotiation with the Pi project.
- **Five fully-featured implementation tasks (T263, T268, T273, T277, T278/T279) are all "large-ish medium" in size** and depend on this ADR being correct. Errors in this design ripple into 17 downstream tasks.

## Alternatives Considered

**A1 — Modify Pi to use XDG directly.** Rejected. We do not own Pi; submitting an XDG migration upstream would be a multi-month negotiation and would still leave us with a transition period where some users have `~/.pi/` and others have `~/.local/share/pi/`. The three-tier wrapper achieves the goal without changing Pi.

**A2 — Single unified config file (`pi.toml`) instead of `models.json` + `settings.json`.** Rejected. Pi's split is load-bearing in `pi-mono`'s `model-registry.ts` and `settings-manager.ts`; collapsing it would require Pi changes and would invalidate every existing user's config. Honouring the split costs nothing and avoids a destructive migration.

**A3 — Reimplement MCP from scratch instead of using `@modelcontextprotocol/sdk`.** Rejected. The official SDK is well-maintained, handles JSON-RPC correctly including edge cases (request IDs, partial responses, transport framing), and shrinks our surface. The marginal cost of one dependency is much smaller than the bug surface of a hand-rolled JSON-RPC client.

**A4 — A new `@cleocode/cant-runtime-bridge` package as a shared loader module.** Rejected (this was an earlier draft of D5). The "shared module" already exists at the package boundary: `@cleocode/cant` is the shared parser, and `@cleocode/core` (the `cant/` namespace) is the shared `WorkflowExecutor`. Both callers — `cleo agent start` and the Pi extension — just need to `import { parseDocument } from '@cleocode/cant'` and `import { WorkflowExecutor } from '@cleocode/core'`. Inventing a third package would add a wrapping layer that does no work the existing packages don't already do.

**A5 — Two separate CANT loader implementations (one in Pi extension, one in `cleo agent start`).** Rejected. The two callers are 5–10 lines of glue each that import from the same two packages and call `register*` methods on different APIs (runtime vs Pi extension). The handler-registration logic inside is identical and lives inline at both call sites. Extracting it into a helper makes sense **only if** it grows past ~30 lines or develops shared error handling — and at that point the helper goes into one of the existing packages (`@cleocode/core`), not into a new top-level package.

**A6 — Skip the v3 exclusivity layer entirely; keep Pi as "preferred provider" forever.** Rejected. The whole point of the Pi pivot (per `cleoos-pi-pivot.md`) is to make Pi the orchestration substrate so we get the Conductor Loop, stage guidance, and CANT runtime in one unified layer. "Preferred but optional" leaves us forever in the today-state where we have to keep two dispatch paths working. The exclusivity switch is what makes the rest of CleoOS coherent.

**A7 — Make the v3 exclusivity switch a hard cutover with no `legacy` mode.** Rejected. Existing scripts and CI pipelines that target specific providers would break on upgrade. The three-mode design is the minimum surface that lets us ship the change without forcing an immediate user migration.

**A8 — Spawn subagents via Pi's slash-command system (`pi /sub`) rather than direct `child_process.spawn()`.** Rejected for v2. Pi's `/sub` command (in `pi-ext/extensions/subagent-widget.ts`) is itself a thin wrapper around `child_process.spawn()`; routing through it adds an extra layer with no semantic gain and makes error propagation harder to reason about. Direct spawn from `PiHarness.spawnSubagent` is simpler. We can revisit if Pi ever exposes a first-class subagent API.

## Addendum (2026-04-07): Option Y collapse

After the initial draft of this ADR, an owner audit revealed that
`cant-bridge.ts` (Pi extension, shipped v2026.4.6) already implements
all 16 workflow statement types via CLI shell-out, and the parallel
`@cleocode/core/cant` WorkflowExecutor namespace was dead code with
zero production callers. The architectural dilemma was whether to:

1. Keep both Path A (cant-bridge.ts) and Path B (WorkflowExecutor)
2. Collapse to Path A only, delete the dead code
3. Collapse to Path B only, rewrite cant-bridge.ts as a thin shim

Owner chose Option 2 (collapse to Path A). This PR:

- Deletes `packages/core/src/cant/*` entirely (1489 LOC removed)
- Removes all MCP traces from CAAMP (Pi extensions strictly dominate
  MCP tools; MCP is not a first-class CleoOS primitive)
- Documents that `cleo agent start`'s daemon is Pi-independent and
  its profile validation is a fail-fast guard, not an execution step
- cant-bridge.ts remains the single canonical executor for CANT
  workflows inside Pi sessions

The T287 epic that would have activated the dead code has been
deleted. T268-T272 (MCP bridge) have been deleted.

## Related

- **ADR-031 / ADR-033** — Provider Adapter Architecture (the foundation this ADR builds on for the harness layer)
- **ADR-014** — RCASD Rename and Protocol Validation (the lifecycle model these tasks slot into)
- **`cleoos-pi-pivot.md`** memory entry — strategic motivation
- **`pi-code/CLEO-OS-INTEGRATION-SCOPE.md`** — Pi-side integration vision
- **T261** epic — parent for Pi v2+v3
- **T262** — this ADR's origin task (complete)
- **T263–T279** — implementation tasks whose acceptance criteria reference this ADR
- **T287** epic — CANT runtime completeness (sibling, created from this ADR's audit addendum)
- **T288–T297** — T287 subtasks closing the WorkflowExecutor gaps
