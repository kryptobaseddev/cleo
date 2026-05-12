# CLEO AGI Self-Healing & Self-Improvement Plan
# 2026-04-21

> For Hermes: Use subagent-driven-development to implement this plan.
> Decision D018 in brain.db confirms the honest diagnosis below.

**Goal:** Transform CLEO from well-scaffolded theatre into a genuinely sentient,
self-healing, self-improving project intelligence system that works across any
project with any LLM harness.

**Architecture:** Multi-phase. Phase 1 makes what exists actually wire together
end-to-end. Phase 2 makes the sentient daemon truly intelligent. Phase 3 makes
the sandbox loop close. Phase 4 wires agent-to-agent conduit.

**Stack:** TypeScript ESM strict, pnpm, vitest, biome, SQLite, Node 24,
@cleocode/core, @cleocode/cleo, cleo-sandbox Docker harnesses.

---

## HONEST DIAGNOSIS

The brain already knows (D018):

> "The shipped system is NOT bleeding-edge. It is unit-tested scaffolding
> with CLI smoke that passed only the narrow paths agents coded AROUND.
> Theater signature: (1) commit messages overclaim capability, (2) CLI-level
> smoke passes while dispatch registry remains broken, (3) scope silently
> reduced without owner flag, (4) real-world multi-substrate integration
> never exercised, (5) CI-green means only tests-I-wrote-pass."

What this means concretely:

### Theatre Identified

1. **Sentient daemon is stopped/never started** — `cleo sentient status` shows
   `Daemon: stopped | picked=0 completed=0`. The machinery exists (daemon.ts,
   tick.ts, propose-tick.ts are real code) but it has never run on a real
   project. Nobody ever ran `cleo sentient start`.

2. **Memory bridge is empty** — `.cleo/memory-bridge.md` contains only its
   header. `cleo refresh-memory` was never called. No agent ever injected
   context from brain.db into their system prompt.

3. **Nexus bridge is populated** (3,115 files, 12,942 symbols) but it is a
   static snapshot injected as AGENTS.md text. No agent actually queries it
   live during task work.

4. **Conduit local transport exists** (conduit.db, LocalTransport) but zero
   agents are registered and zero messages have ever been exchanged. The
   agent-to-agent protocol is fully plumbed but has zero runtime use.

5. **sentient-agent harness** in cleo-sandbox has `sleep infinity` as its
   entrypoint (explicitly noted in README: "T1018 will replace this").

6. **Brain propose-tick runs with structured templates only** — proposals are
   `[T2-BRAIN|NEXUS|TEST]` prefix strings, not LLM-generated insights. This
   was a deliberate anti-prompt-injection guard but means tier-2 proposals
   are deterministic pattern matches, not actual intelligence.

7. **Living Brain 5-substrate traversal exists** (living-brain.ts) but is
   never called from the dispatch layer during normal task work. Agents
   never get the cross-substrate context.

8. **Intelligence module** (patterns.ts, prediction.ts, adaptive-validation.ts)
   exists but `cleo intelligence` is not a CLI command. The module is orphaned.

### What IS Real and Working

- Full SQLite stack: tasks.db, brain.db, nexus.db, conduit.db — all init correctly
- CQRS dispatch layer: 15 domains, all registering operations
- Task lifecycle: add/start/complete/block/fail all work
- Session system: start/end/resume works
- Nexus code analysis: tree-sitter AST pipeline, symbol extraction, smartSearch
- Memory write path: `cleo memory observe/decide/learn/pattern` all write to brain.db
- Memory read: hybrid BM25+RRF search works (confirmed above)
- Sentient daemon code: fully implemented, just never started
- Conduit transport: LocalTransport and HttpTransport fully implemented
- CAAMP: provider/skill registration pipeline works
- cleo-sandbox: Docker infra, scenario runner, 5 scenarios

---

## PHASE 1 — Wire the Real Plumbing (Week 1)

Make every existing piece actually talk to each other in a running system.
No new features. Just closing the gaps.

---

### T1-A: Start the Sentient Daemon and Prove It Picks Tasks

**Objective:** `cleo sentient start` runs the daemon; within one tick cycle
it picks a real pending task and attempts to spawn it.

**Files:**
- Verify: `packages/cleo/src/dispatch/domains/sentient.ts`
- Verify: `packages/core/dist/sentient/daemon.js` (built)
- New scenario: `cleo-sandbox/scenarios/sentient-daemon-lifecycle/`

**Steps:**

1. In the cleocode project root, start a session and create a test task:
   ```bash
   cd /mnt/projects/cleocode
   cleo session start --name "Sentient Test" --scope global
   cleo add "Write hello world to /tmp/proof.txt" --type task
   ```

2. Start the sentient daemon:
   ```bash
   cleo sentient start
   ```

3. Watch the status until it picks the task:
   ```bash
   watch -n 5 'cleo sentient status'
   ```

4. Check the log:
   ```bash
   tail -f .cleo/logs/sentient.log
   ```

5. If it never picks: diagnose by running a manual tick:
   ```bash
   cleo sentient tick --dry-run
   ```

6. Identify and fix the root cause (likely: no adapter configured, or
   `tier1Enabled` defaults to false in sentient-state.json).

7. Create sandbox scenario `sentient-daemon-lifecycle`:
   ```
   cleo-sandbox/scenarios/sentient-daemon-lifecycle/run.sh
   cleo-sandbox/scenarios/sentient-daemon-lifecycle/assertions.sh
   ```
   run.sh: init project, add task, start daemon, wait 15s, check status
   assertions.sh: verify daemon running, stats.ticks > 0

**Verify:** `cleo sentient status` shows `ticks > 0` and daemon pid is live.

---

### T1-B: Wire Memory Bridge — Live Context Injection

**Objective:** `cleo refresh-memory` produces a non-empty memory-bridge.md
that summarizes actual brain.db content, and this gets injected into the
AGENTS.md context block so every harness sees it.

**Files:**
- `packages/core/src/nexus/nexus-bridge.ts` — study this for pattern
- `packages/cleo/src/dispatch/domains/memory.ts` — find `generateMemoryBridgeContent`
- `.cleo/memory-bridge.md` — currently empty

**Steps:**

1. Find where `generateMemoryBridgeContent` is defined:
   ```bash
   grep -r "generateMemoryBridgeContent" packages/ --include="*.ts" -l
   ```

2. Run it directly:
   ```bash
   cleo refresh-memory
   ```

3. If it produces empty output: inspect the function. The issue is likely
   that brain.db has entries but the bridge generator filters them all out
   or has a quality threshold issue. Fix the threshold.

4. After fix, verify the output contains actual decisions, patterns, learnings:
   ```bash
   cat .cleo/memory-bridge.md | head -50
   ```

5. Ensure the AGENTS.md CAAMP block includes the memory-bridge reference:
   ```
   @.cleo/memory-bridge.md
   ```
   This is already in the template from `cleo init`. Verify it persists.

6. Add a test in `packages/cleo/src/dispatch/domains/__tests__/` that
   verifies memory bridge content is non-empty when brain.db has entries.

**Verify:** `cat .cleo/memory-bridge.md` shows actual brain.db summary with
decisions, learnings, and patterns. Not just a header.

---

### T1-C: Wire Living Brain to Dispatch — Agents Get Cross-Substrate Context

**Objective:** When an agent starts working on a task, `getTaskCodeImpact`
from living-brain.ts runs automatically and its output is injected into the
context window via the existing context injection pipeline.

**Files:**
- `packages/core/src/nexus/living-brain.ts`
- `packages/cleo/src/dispatch/domains/nexus.ts`
- `packages/core/src/inject/` — study how injection works
- `packages/core/src/context/index.ts`

**Steps:**

1. Read living-brain.ts fully:
   ```bash
   cat packages/core/src/nexus/living-brain.ts
   ```

2. Read how context is currently injected at task-start:
   ```bash
   cat packages/core/src/inject/injection.ts
   cat packages/core/src/context/index.ts
   ```

3. Find the task-start hook that fires when `cleo orchestrate spawn` runs:
   ```bash
   grep -r "spawn\|task.*start\|context.*inject" packages/core/src/hooks/ --include="*.ts" | head -20
   ```

4. Add a hook: when a task is started via spawn, call `getTaskCodeImpact`
   and append the result to the context injection payload. Keep it bounded
   (max 2000 tokens). Write to a `.cleo/task-context/<taskId>.md` file.

5. Verify the harness receives this file by checking AGENTS.md injection
   or via `cleo session context --task T001`.

6. Add unit test verifying `getTaskCodeImpact` returns non-empty result
   for any task that has associated code symbols.

**Verify:** After `cleo orchestrate spawn T001`, a `.cleo/task-context/T001.md`
file exists with living brain cross-substrate data.

---

### T1-D: Wire Intelligence Module to CLI

**Objective:** `cleo intelligence predict <taskId>` and
`cleo intelligence patterns` work end-to-end via the dispatch layer.

**Files:**
- `packages/core/src/intelligence/index.ts` — already has the functions
- `packages/cleo/src/dispatch/domains/intelligence.ts` — check if exists
- `packages/cleo/src/dispatch/registry.ts` — add intelligence domain ops

**Steps:**

1. Check if intelligence domain handler exists:
   ```bash
   cat packages/cleo/src/dispatch/domains/intelligence.ts 2>/dev/null
   ls packages/cleo/src/dispatch/domains/
   ```

2. If missing, create `packages/cleo/src/dispatch/domains/intelligence.ts`
   following the exact pattern of `diagnostics.ts` or `check.ts`.

3. Register operations in registry.ts:
   - `intelligence query predict` (takes taskId param)
   - `intelligence query patterns` (list detected patterns)
   - `intelligence query risk` (takes taskId param)
   - `intelligence query suggest-gates` (adaptive validation)

4. Add CLI commands in `packages/cleo/src/cli/commands/` if not present.

5. Verify:
   ```bash
   cleo intelligence predict T001
   cleo intelligence patterns
   ```

6. Add tests under `packages/cleo/src/dispatch/domains/__tests__/`.

**Verify:** Both CLI commands return real data from brain.db pattern history.

---

## PHASE 2 — Real Intelligence, Not Templates (Week 2)

Make the propose-tick actually intelligent. Replace structured-template
proposals with LLM-generated ones while preserving safety guarantees.

---

### T2-A: LLM-Powered Propose Tick

**Objective:** When `tier2Enabled=true`, the sentient daemon's propose-tick
calls an LLM to synthesize proposals from brain.db observations, nexus.db
symbol churn, and task completion patterns. Titles are still validated but
can be semantic, not just prefixed tokens.

**Files:**
- `packages/core/src/sentient/propose-tick.ts` (source, not dist)
- Find source: `find . -path "*/sentient/propose-tick.ts" -not -path "*/dist/*"`
- `packages/core/src/sentient/ingesters/brain-ingester.ts`
- `packages/core/src/sentient/ingesters/nexus-ingester.ts`

**Steps:**

1. Read current propose-tick source fully.

2. Identify the ingester output shape — what `BrainIngester` and
   `NexusIngester` produce as `ProposalCandidate[]`.

3. Add a new ingester: `llm-synthesizer-ingester.ts` in
   `packages/core/src/sentient/ingesters/`. This ingester:
   - Takes the top 5 candidates from brain + nexus ingesters
   - Constructs a compact prompt (max 1000 tokens) describing the pattern
   - Calls the configured LLM (use existing `resolveAnthropicApiKey`)
   - Returns up to 3 synthesized `ProposalCandidate` objects
   - Title must pass PROPOSAL_TITLE_PATTERN validation OR use a new
     extended pattern that allows semantic titles with `[T2-LLM]` prefix

4. Add `[T2-LLM]` to PROPOSAL_TITLE_PATTERN regex.

5. Gate: only activates when `tier2Enabled=true` AND `ANTHROPIC_API_KEY` present.

6. Update tests in `packages/core/src/sentient/__tests__/` to cover the
   new ingester with a deterministic mock LLM response.

**Verify:** `cleo sentient propose run` with tier2Enabled produces at least
one `[T2-LLM]` prefixed proposal with a semantic title, visible in
`cleo sentient propose list`.

---

### T2-B: Dream Cycle — Proactive Brain Consolidation

**Objective:** The dream cycle (already referenced in tick.ts via
`checkAndDream`) actually runs on volume/idle triggers and produces
real brain.db consolidations.

**Steps:**

1. Find `checkAndDream`:
   ```bash
   grep -r "checkAndDream\|dreamCycle\|dream" packages/core/src/ --include="*.ts" -l | head -10
   ```

2. Verify it is fully implemented and not a stub.

3. If stub: implement a minimal dream cycle:
   - Query top 20 recent observations from brain.db with low quality_score
   - Call LLM: "Synthesize these observations into 1-3 durable learnings"
   - Write new `brain_learnings` rows with high quality_score
   - Mark source observations as `memory_tier='archived'`

4. Ensure `safeRunTick` in tick.ts calls `checkAndDream` with real deps (not stubs).

5. Add test: create 55 brain observations, run a tick, verify dream triggered.

**Verify:** After 50+ observations exist in brain.db and 5 idle ticks pass,
`cleo memory find --query "consolidated"` returns a learning that was
synthesized by the dream cycle.

---

### T2-C: Self-Update — Nexus Analyzes Its Own Codebase

**Objective:** `cleo nexus analyze` runs automatically after session end,
updating nexus.db with new/changed symbols and regenerating nexus-bridge.md.

**Files:**
- `packages/core/src/nexus/nexus-bridge.ts`
- `packages/cleo/src/dispatch/domains/nexus.ts`
- `packages/core/src/hooks/hooks.ts`

**Steps:**

1. Find the `session.end` hook:
   ```bash
   grep -r "session.*end\|sessionEnd\|onSessionEnd" packages/ --include="*.ts" | head -10
   ```

2. Register a `post:session.end` hook that calls `nexus analyze` on the
   project root if the session touched any `.ts` or `.js` files.

3. The hook should be fire-and-forget (spawns child process, does not block
   session end response).

4. Verify `.cleo/nexus-bridge.md` timestamp updates after `cleo session end`.

5. Add sandbox assertion to `harness-e2e` scenario: after session end,
   nexus-bridge.md was modified within the last 60 seconds.

**Verify:** After `cleo session end`, nexus-bridge.md shows updated timestamp.

---

## PHASE 3 — Close the Sandbox Loop (Week 3)

Make the sentient-agent harness real. T1018 implemented.

---

### T3-A: Wire sentient-agent Entrypoint (T1018)

**Objective:** Replace `sleep infinity` with the real sentient agent loop
that can pick tasks from the project tasks.db and spawn improvements.

**Files:**
- `/mnt/projects/cleo-sandbox/harnesses/sentient-agent/src/entrypoint.ts`
- `/mnt/projects/cleo-sandbox/harnesses/sentient-agent/Dockerfile`

**Steps:**

1. Read current entrypoint.ts fully.

2. Read the daemon-entry.ts in core (from dist types, locate source):
   ```bash
   find . -name "daemon-entry.ts" -not -path "*/dist/*"
   ```

3. Implement entrypoint.ts:
   - Accept `CLEO_EXPERIMENT_ID` and `CLEO_TASK_ID` from env
   - Call `bootstrapDaemon(process.env.WORKSPACE || '/workspace')`
   - Set `tier1Enabled=true` in sentient-state.json
   - Pipe SIGTERM → `stopSentientDaemon`
   - Write PID to `/sandbox-out/sentient.pid`

4. Update Dockerfile CMD from `sleep infinity` to `node dist/entrypoint.js`.

5. Update compose/docker-compose.tier3.yml to pass the correct env vars.

6. Test by running the container against a test project worktree.

**Verify:** `docker compose -f compose/docker-compose.tier3.yml up` starts
the sentient-agent and `docker exec ... cleo sentient status` shows daemon running.

---

### T3-B: Sandbox Scenario — harness-e2e Full Lifecycle

**Objective:** The `harness-e2e` scenario exercises the complete lifecycle
including sentient daemon, brain observe, nexus analyze, and conduit messaging.

**Files:**
- `/mnt/projects/cleo-sandbox/scenarios/harness-e2e/run.sh`
- `/mnt/projects/cleo-sandbox/scenarios/harness-e2e/assertions.sh`

**Steps:**

1. Read current harness-e2e scenario:
   ```bash
   cat /mnt/projects/cleo-sandbox/scenarios/harness-e2e/run.sh
   cat /mnt/projects/cleo-sandbox/scenarios/harness-e2e/assertions.sh
   ```

2. Extend run.sh to include:
   - `cleo sentient start` after `cleo init`
   - `cleo memory observe "Test observation from harness-e2e"` after task add
   - `cleo nexus analyze` after session end
   - `cleo sentient status` at end (capture to artifact)

3. Extend assertions.sh to check:
   - sentient daemon was started (pid file exists or status shows running)
   - brain.db has at least 1 observation
   - nexus-bridge.md was modified in this run
   - `cleo memory find --query "harness"` returns the test observation

4. Run the scenario:
   ```bash
   cd /mnt/projects/cleo-sandbox
   ./bin/sandbox up
   ./bin/sandbox install
   ./bin/sandbox run harness-e2e ubuntu
   ```

5. Fix any failures using the autonomous loop pattern from AGENTS.md.

**Verify:** `./bin/sandbox test-all --json | grep harness-e2e` shows `"result":"PASS"`.

---

## PHASE 4 — Conduit: Agent-to-Agent Communication (Week 4)

Make agents actually talk to each other using the LocalTransport that is
already fully implemented.

---

### T4-A: Register Agents in Conduit and Prove Message Delivery

**Objective:** Two agent instances (e.g., orchestrator + worker) exchange
conduit messages through the local SQLite transport during a task execution.

**Steps:**

1. Find agent registration in conduit:
   ```bash
   cat packages/core/src/conduit/factory.ts
   grep -r "registerAgent\|agentId" packages/core/src/conduit/ --include="*.ts"
   ```

2. Create a test harness script at `scripts/conduit-smoke-test.ts`:
   ```typescript
   // Agent A sends a message to Agent B via LocalTransport
   // Agent B polls and receives it
   // Both agents log to stdout
   ```

3. Run the smoke test:
   ```bash
   node --input-type=module < scripts/conduit-smoke-test.ts
   ```

4. If it works: add it as a vitest integration test.

5. Wire conduit into the sentient spawn: when the daemon spawns a worker via
   `cleo orchestrate spawn`, the daemon sends a conduit message to the worker
   with the task context. The worker sends a conduit message back with its
   completion receipt.

6. Add `cleo conduit status` command showing active agents and message counts.

**Verify:** After a sentient tick completes successfully, `cleo conduit status`
shows at least 2 messages (spawn + receipt) in conduit.db.

---

### T4-B: Hermes-Style Context Injection Pattern

**Objective:** When any harness starts (AGENTS.md is loaded), the memory-bridge
and nexus-bridge content is automatically fresh and injected. No agent should
ever start cold.

This mirrors how Hermes injects memory at every turn via the system prompt.

**Steps:**

1. Study how Hermes injects memory:
   ```bash
   cat /mnt/projects/hermes-agent/agent/prompt_builder.py | grep -A 20 "memory"
   ```

2. In CLEO, the equivalent is the CAAMP injection system (`packages/caamp/`).
   Find how `@.cleo/memory-bridge.md` gets expanded:
   ```bash
   grep -r "memory-bridge\|CAAMP\|injection" packages/caamp/src/ --include="*.ts" | head -20
   ```

3. Ensure the CAAMP resolver calls `cleo refresh-memory` if memory-bridge.md
   is older than 30 minutes before injecting it.

4. Add this auto-refresh to the `cleo session start` hook so every new session
   gets fresh memory context.

5. Update AGENTS.md template (in `packages/core/src/templates/` or wherever
   the seed templates live) to include:
   ```
   <!-- Run: cleo memory digest --brief -->
   ```
   This comment tells harnesses to run the digest command if the bridge is stale.

**Verify:** After creating 5 new brain observations and starting a new session,
the injected memory-bridge.md contains those observations in the summary.

---

## QUALITY GATES (Run After Each Phase)

```bash
# 1. Biome
pnpm biome check --write .

# 2. Build
pnpm run build

# 3. Tests — ZERO new failures
pnpm run test

# 4. Sandbox
cd /mnt/projects/cleo-sandbox && ./bin/sandbox install && ./bin/sandbox test-all

# 5. Live smoke
cleo sentient status
cleo memory find --query "test"
cleo dash
```

---

## ACCEPTANCE CRITERIA (The System Is Real When)

1. `cleo sentient status` shows `ticks > 0, completed > 0` in the cleocode project itself.
2. `cleo memory find --query "anything"` returns brain.db entries that were NOT manually written — they came from the dream cycle or LLM ingester.
3. `cat .cleo/memory-bridge.md` is non-empty and was auto-generated in the last 24 hours.
4. `./bin/sandbox test-all --json` shows ALL 5 scenarios PASS including `harness-e2e`.
5. `cleo conduit status` shows at least one agent exchange in conduit.db.
6. A fresh clone of any project (`cleo init` → `cleo sentient start`) results in the daemon running without manual intervention.
7. Any harness (claude-code, hermes, vanilla-node) can drop a `.cleo/` folder into a project and read real brain context in its first turn.

---

## ANTI-THEATRE CONTRACT

Before marking any task done:
- Run the actual command. Not a unit test. The real CLI.
- Capture real output.
- If output is empty or a stub message: the task is NOT done.
- Do NOT mark tasks complete based on code-compiles-and-tests-pass alone.
- Every task in this plan has a "Verify" step — that step must produce real evidence.

The brain said it. D018 is the law.
