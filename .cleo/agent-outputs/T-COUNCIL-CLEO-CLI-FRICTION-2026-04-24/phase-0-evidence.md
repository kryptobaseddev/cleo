# Phase 0 — Evidence Pack (CLEO CLI Orchestration Friction)

## Restated question

**Do CLEO's orchestration-layer rough edges (dirty `--json`, atomicity role lock, miscalibrated classifier, plus 3 smaller UX gaps) warrant one consolidated fix-epic or multiple targeted tasks, and which is the load-bearing fix that unblocks autonomous orchestration?**

Decision shape: one epic vs. multiple epics · ship in v2026.4.134 release vs. defer · classifier overhaul vs. patch · strict `--json` contract vs. tolerant parsers.

## Evidence pack

1. **`cleo orchestrate spawn --json` emits resolver warning on stdout before JSON** — observed output line 1: `[agent-resolver] WARN: agent 'project-dev-lead' not found in project/global/packaged/fallback tiers — falling back to universal base 'cleo-subagent' at '/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/agents/cleo-subagent.cant'. Run 'cleo agent install --global <path>' to register a concrete persona.` Line 2 then has the `{"success":true,...}` payload. Every `--json` consumer must `sed -n '2p'` or `grep '^{"success"'` to parse. Protocol bug — `--json` should emit ONLY JSON on stdout; warnings belong on stderr.

2. **E_ATOMICITY_VIOLATION fix-hint references a `--role` switch that doesn't exist at the CLI layer** — observed: `{"code":"E_ATOMICITY_VIOLATION","message":"Worker role for task T1222 declares 4 files (max 3). Split into subtasks or promote to lead.","fixHint":"Split task T1222 into 2 subtasks with cleo add --parent T1222"}`. But `cleo update --role` means `work|research|experiment|bug|spike|release` (orthogonal to --type T944), NOT the atomicity worker/lead axis. No in-band CLI escape hatch to promote a task from worker→lead atomicity role. Workaround = drop files until ≤3, which defeats the scope-discipline intent.

3. **Classifier over-indexes on title keywords** — observed: `{"agentId":"project-docs-worker","role":"worker","confidence":0.95,"reason":"Structural heuristic matched project-docs-worker (confidence 0.95)","usedFallback":false}` for task "Fix CLEO engine — tasks.complete must reject verification_json NULL + populate modified_by+session_id". A code-fix task on `packages/cleo/src/dispatch/engines/task-engine.ts` classified as docs-worker at 95% confidence forced `--protocol implementation` override. High confidence on the wrong classification is the structural defect — a low-confidence miss could fall through to heuristics, a high-confidence miss poisons every downstream decision (atomicity ceiling, tier budget, skill selection).

4. **`cleo create` does not exist — the correct verb is `cleo add`** — observed `cleo create --type epic ...` → `Unknown command create`. The CLI has 30+ verbs and the mental-model gap "create/new/make vs. add" is a common first-time-user stumble. No `did-you-mean` suggestion offered.

5. **Strict-mode requires `--parent` on every task creation with no recoverable default** — observed: `{"code":"E_VALIDATION","message":"Tasks must have a parent (epic or task) in strict mode. Use --parent <epicId>, --type epic for a root-level epic, or set lifecycle.mode to \"advisory\".","fix":"cleo add \"Task title\" --parent T### --acceptance \"AC1|AC2|AC3\""}`. Hit fresh each session — owner has no memory that the current task-creation flow requires mandatory parent declaration even for one-off tasks. Defensible behavior, painful UX.

6. **File scope (`--files`) is discovered only at spawn time, not at task creation** — observed creation flow: `cleo add --type task` succeeds with NO file scope; then `cleo orchestrate spawn` fails with `E_ATOMICITY_NO_SCOPE: Worker role for task T1222 lacks file scope (AC.files). Workers MUST declare their files.` Forces round-trip: create → spawn → fail → `cleo update --files ...` → re-spawn. Should either be a creation-time prompt/requirement or deferred until task actually advances to implementation pipeline stage.

7. **Agent `project-dev-lead` / `project-docs-worker` not registered despite being the classifier's chosen agent** — observed fallback chain: classifier picks `project-dev-lead`, resolver WARNs that it's not found in any tier, falls back to universal base `cleo-subagent`. The classifier is choosing agents the registry doesn't have — this is the upstream cause of evidence item #1's stdout pollution (the warning wouldn't fire if the classifier's outputs matched the registry). Shared root cause: classifier/registry contract is unwritten.

## Evidence pack — verification

7 items (at limit). 3 are owner-confirmed orchestration defects (items 1–3). 3 are orchestrator-observed friction (items 4–6). 1 is a shared root cause pointer (item 7). All have concrete citations (error codes, exact text strings, CLI verb names, observed file paths). Within the 3–7 range.
