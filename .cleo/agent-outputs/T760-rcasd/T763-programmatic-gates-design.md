# T763 — Programmatic Acceptance-Criteria Gate Architecture

**Task**: T763 (epic T760 "RCASD hardening")
**Type**: design / architecture
**Status**: DRAFT — for owner review, NO implementation yet
**Date**: 2026-04-16
**Author**: cleo-prime (research subagent, Opus 4.6 / 1M)
**Absolute path**: `/mnt/projects/cleocode/.cleo/agent-outputs/T760-rcasd/T763-programmatic-gates-design.md`

---

## 0. Executive Summary

CLEO's acceptance criteria today are free-text strings stored in `Task.acceptance: string[]`. They are inspected by the agent, self-attested, and then a separate 6-gate verification bitmap (`implemented / testsPassed / qaPassed / cleanupDone / securityPassed / documented`) records a yes/no verdict. Neither half is machine-verifiable: the agent could write "Pomodoro timer 25/5/15" as acceptance, set `testsPassed=true`, and no runtime code ever asserts the timer actually does 25/5/15. The Pomodoro benchmark (SUPREME_REPORT §3.3) caught CLEO's agent marking all three gates green while having shipped only unit tests — no runtime check ever disagreed with the self-report.

GSD solves part of this with REQ-IDs (`TIMER-03`, `A11Y-04`) in `REQUIREMENTS.md` that a human closes against `1-VERIFY.md`. That is better traceability than CLEO has, but it is still markdown, still human-verifiable only, and still trusts the author.

This document proposes a **typed, discriminated-union `AcceptanceGate`** that co-exists with free-text strings, a `cleo verify <taskId> --run` command that executes each structured gate against the live project, a `cleo req add` ergonomic entry-point that gives each gate a stable REQ-ID, and a three-phase migration that adds the type first, populates second, and enforces last. Nothing breaks on day one; by phase 3 the `cleo complete` command cannot mark a task done unless every programmatic gate actually passed on disk. The contract is a pure extension of the existing `Task.acceptance?: string[]` — the storage column, the enforcement layer, and the CLI surface all admit strings and gates side by side.

The result is a system that beats GSD's REQ-ID layer on three axes: gates are **queryable** (SQLite, not markdown), **automatic** (runtime can execute them, markdown cannot), and **chained** (failed gates feed the existing verification round state so the orchestrator IVTR re-spawn loop reacts without extra glue). CLEO already has a RCASD pipeline, a verification-rounds state machine, a lifecycle gate-results table (`lifecycle_gate_results`), and an agent-spawn orchestrator. Programmatic gates sit in the one hole left: *what specifically must be true on disk for this task to be done*.

---

## 1. Current State

### 1.1 Schema

`packages/core/src/store/tasks-schema.ts:165` stores acceptance as a JSON blob:

```ts
acceptanceJson: text('acceptance_json').default('[]'),
```

`packages/contracts/src/task.ts:173` types the parsed shape as:

```ts
/** Acceptance criteria for completion. @defaultValue undefined */
acceptance?: string[];
```

`packages/core/src/store/converters.ts:38` parses the column via `safeParseJsonArray(row.acceptanceJson)`.

There is no runtime validator that checks the acceptance strings match any state of the world. The only enforcement is **count** (`packages/core/src/tasks/enforcement.ts:27` `checkMin`, configurable `minimumCriteria` default 3). An agent can satisfy the enforcement by writing three empty-of-meaning strings.

### 1.2 Verification state (separate from acceptance)

`packages/core/src/validation/verification.ts` defines:

```ts
export const VERIFICATION_GATE_ORDER = [
  'implemented', 'testsPassed', 'qaPassed',
  'cleanupDone', 'securityPassed', 'documented',
] as const;

export interface VerificationGates {
  implemented: boolean | null;
  testsPassed: boolean | null;
  qaPassed: boolean | null;
  cleanupDone: boolean | null;
  securityPassed: boolean | null;
  documented: boolean | null;
}
```

These six gates are the ONLY things `cleo complete` actually reads before allowing a task to transition to `done` (`packages/core/src/tasks/complete.ts:179`). They are set by agents calling `cleo update --verification`. **No machine verifies that a `testsPassed=true` actually corresponds to a test suite exit code 0 on disk.**

### 1.3 Lifecycle gate results (exists, underused)

The DB already has a `lifecycle_gate_results` table (`tasks-schema.ts:401`) with `gateName / result / checkedAt / checkedBy / details / reason`. Today this records human/agent-asserted gate results from the RCASD pipeline (spec phase, consensus phase, etc.) — but the content in the `details` field is free-text, and no executor populates it. This table is the right home for structured programmatic gate results; it just needs a typed producer.

### 1.4 What the Pomodoro benchmark showed

From the supplied benchmark outputs (`.cleo/agent-outputs/T-POMODORO-BENCH-2026-04-16/cleo/`):

```jsonc
// T001 epic
"acceptance": [
  "Todos CRUD with inline edit",
  "Pomodoro timer 25/5/15 with long-break every 4th cycle, configurable",
  "Visual circular progress ring + chime on phase end",
  "Dark/light theme with OS auto-detect and manual toggle, persisted",
  "localStorage persistence for todos/settings/counters",
  "Keyboard shortcuts Space/N/Enter/Delete",
  "Responsive mobile-first down to 360px",
  "ARIA + focus rings + full keyboard nav",
  "README with run/test/architecture",
  "3+ automated tests covering timer math, CRUD, localStorage round-trip"
],
"verification": {
  "passed": true,
  "gates": { "implemented": true, "testsPassed": true, "qaPassed": true },
  "lastAgent": "cleo-prime"
}
```

The agent wrote those ten strings, the agent set the three gates, and the agent's own word was the only check. SUPREME §3.3 confirmed this was a *false positive* for `qaPassed` — CLEO shipped only unit tests when the acceptance text implied integration testing. The gate system lets the agent grade itself with no opposing audit.

### 1.5 What already works (and we are extending, not replacing)

- `Task.acceptance?: string[]` — the free-text list. **Stays.** Humans write intent here.
- `VerificationGates` — the six categorical rollups (implemented, testsPassed, …). **Stays.** These remain agent-asserted roll-ups over the detailed gate layer.
- `lifecycle_gate_results` — the evidence table. **Extends.** Programmatic gate results land here with full provenance.
- `cleo complete` — the completion gate. **Extends.** Learns to run programmatic gates before flipping status.

---

## 2. Proposed Schema

### 2.1 The `AcceptanceGate` discriminated union

```ts
// packages/contracts/src/acceptance-gate.ts  (NEW FILE)

/**
 * A machine-verifiable acceptance gate.
 *
 * Gates coexist with free-text criteria in `Task.acceptance`; the runtime
 * executes only gates, and records results in `task.verification.gateResults`
 * and in the `lifecycle_gate_results` DB table.
 *
 * @epic T760
 * @task T763
 */
export type AcceptanceGate =
  | TestGate
  | FileGate
  | CommandGate
  | LintGate
  | HttpGate
  | ManualGate;

/** Fields every gate carries. */
export interface GateBase {
  /**
   * Optional REQ-ID (GSD-style: `TIMER-03`, `A11Y-04`). When present, the
   * gate becomes addressable via `cleo req show T001 --id TIMER-03` and
   * its result is indexed in `lifecycle_gate_results.gate_name`.
   */
  req?: string;

  /**
   * Free-text description of what this gate is checking. Shown in
   * `cleo show` output and in failure messages. Required so agents and
   * humans can read the gate without executing it.
   */
  description: string;

  /**
   * If true, a failure of this gate does not block completion — it is
   * recorded as a warning in `lifecycle_gate_results.result = 'warn'`.
   * Default false.
   */
  advisory?: boolean;

  /**
   * Gate timeout in milliseconds. Default 120_000 (2 min). Prevents
   * a runaway `cleo verify --run` from hanging the pipeline.
   */
  timeoutMs?: number;
}

/**
 * Run a command; pass when exit code is 0 (or explicit code), and when
 * at least `minCount` matching assertions hold in stdout. Designed for
 * test suites: `{ kind:"test", command:"pnpm test", expect:"pass" }`.
 */
export interface TestGate extends GateBase {
  kind: 'test';
  /** Shell command. Executed via `node:child_process.spawn`, no shell=true. */
  command: string;
  /** Arguments split explicitly (to avoid shell injection). */
  args?: string[];
  /**
   * - `"pass"`: exit code 0 AND stdout contains no `FAIL|failing|Error:` regex.
   * - `"exit0"`: exit code 0 only (permissive mode).
   */
  expect: 'pass' | 'exit0';
  /** Minimum number of tests that must have run. Optional. */
  minCount?: number;
  /** Working directory relative to project root. Default `.` */
  cwd?: string;
  /** Env overrides. Keys must match `/^[A-Z_][A-Z0-9_]*$/`. */
  env?: Record<string, string>;
}

/**
 * Assert properties of a file on disk. Multiple assertions are AND-ed:
 * all must hold for the gate to pass.
 */
export interface FileGate extends GateBase {
  kind: 'file';
  /** Absolute or project-root-relative path. Globs not supported here — use one gate per path. */
  path: string;
  assertions: FileAssertion[];
}

export type FileAssertion =
  | { type: 'exists' }
  | { type: 'absent' }
  | { type: 'nonEmpty' }
  | { type: 'maxBytes'; value: number }
  | { type: 'minBytes'; value: number }
  | { type: 'contains'; value: string }
  | { type: 'matches'; regex: string /* serialized RegExp source */; flags?: string }
  | { type: 'sha256'; value: string }; // for lock-files / snapshots

/**
 * Run any CLI command and assert its exit code + optional stdout match.
 * Escape hatch for anything TestGate/LintGate/HttpGate don't cover.
 */
export interface CommandGate extends GateBase {
  kind: 'command';
  cmd: string;
  args?: string[];
  /** Expected exit code. Default 0. */
  exitCode?: number;
  /** stdout must match this regex (serialized). */
  stdoutMatches?: string;
  /** stderr must match this regex (serialized). */
  stderrMatches?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Run a static-analysis tool and require a clean result.
 * Wraps the common cases with known exit codes so agents don't re-invent them.
 */
export interface LintGate extends GateBase {
  kind: 'lint';
  tool: 'biome' | 'eslint' | 'tsc' | 'prettier' | 'rustc' | 'clippy';
  /** Tool args. Defaults: biome→`check .`, eslint→`.`, tsc→`--noEmit`. */
  args?: string[];
  /** `"clean"` means zero findings; `"noErrors"` tolerates warnings. */
  expect: 'clean' | 'noErrors';
  cwd?: string;
}

/**
 * Hit a URL, assert status + optional body match. For tasks that ship a
 * webapp or API. The runner starts a server only if `startCommand` is set
 * and tears it down after the probe.
 */
export interface HttpGate extends GateBase {
  kind: 'http';
  url: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
  status: number;
  bodyMatches?: string; // regex source
  headers?: Record<string, string>;
  /** Pre-probe command to start a server. Runs in background; killed after probe. */
  startCommand?: string;
  /** Milliseconds to wait after starting before probing. Default 2000. */
  startupDelayMs?: number;
}

/**
 * Explicit escape hatch: a gate the runtime CANNOT verify. Requires a
 * human or a different agent to set `verification.gateResults[i].result`
 * to `pass|fail|warn` before `cleo complete` will accept it.
 *
 * This is the ONLY gate variant that preserves today's free-text behaviour.
 * Use for subjective criteria: "copy reads well", "visual design matches mockup".
 */
export interface ManualGate extends GateBase {
  kind: 'manual';
  /** Question/prompt shown to the human or agent. */
  prompt: string;
  /** Optional list of valid verdicts. Default: `['pass','fail']`. */
  verdicts?: ('pass' | 'fail' | 'warn')[];
}

// ─── Result types ─────────────────────────────────────────────────────

/**
 * Result of running one gate. Persisted to `lifecycle_gate_results` and
 * also summarized in `task.verification.gateResults`.
 */
export interface GateResult {
  /** Index in the task's acceptance array so agent can reference "gate #3". */
  index: number;
  /** REQ-ID if the gate had one, else undefined. */
  req?: string;
  kind: AcceptanceGate['kind'];
  result: 'pass' | 'fail' | 'warn' | 'skipped' | 'error';
  /** Wall-clock duration of the gate execution. */
  durationMs: number;
  /** Truncated stdout/stderr or file-snippet, for the failure message. */
  evidence?: string;
  /** Error message when result is `error` (the gate itself crashed). */
  errorMessage?: string;
  /** Timestamp at which the gate ran. */
  checkedAt: string;
  /** Agent or user that ran the gate (for auditability). */
  checkedBy: string;
}
```

### 2.2 Extension to `Task`

```ts
// packages/contracts/src/task.ts   — additive only

export interface Task {
  // … existing fields unchanged …

  /**
   * Acceptance criteria for completion. Elements may be free-text strings
   * (agent self-attestation) or structured {@link AcceptanceGate} objects
   * that `cleo verify --run` executes against the project.
   *
   * @defaultValue undefined
   */
  acceptance?: (string | AcceptanceGate)[];
}

export interface TaskVerification {
  // … existing fields unchanged …

  /**
   * Per-gate results from the last `cleo verify --run`, in the same
   * order as `Task.acceptance`. Strings in `acceptance` produce
   * `{ kind: 'manual', result: 'skipped' }` entries — they are pass-through.
   *
   * @defaultValue undefined
   */
  gateResults?: GateResult[];

  /** ISO timestamp of the most recent gate-execution run. */
  gatesLastRunAt?: string | null;
}
```

### 2.3 Storage — zero migration required

The `tasks.acceptance_json` column already holds `text(JSON)`. A mixed
`(string | AcceptanceGate)[]` array round-trips through the same column
because JSON admits both `"string"` and `{kind:"test",...}` elements.
`packages/core/src/store/converters.ts:38` (`safeParseJsonArray`) already
returns `unknown[]` before the contract narrows it; we only need to widen
the contract narrowing.

`task.verification.gateResults` lives inside the existing `verification_json`
column as an additional object field. Drizzle schema untouched.

The `lifecycle_gate_results` table (already present) is reused: each
programmatic gate execution produces one row with `gate_name = REQ-ID or "gate-$index"`,
`result = pass/fail/warn`, `checked_by = cleo-verify or <agent>`, and
`details = JSON.stringify(GateResult)`.

**Net schema change: zero tables, zero columns. The DB already has every
row we need — we are populating columns that today hold default values.**

---

## 3. JSON example — Pomodoro epic converted to gates

The benchmark's T001 acceptance, converted. This is the *output of the
migration phase 2 tool* described in §6.

```jsonc
{
  "id": "T001",
  "title": "Build Todo+Pomodoro Timer web app (static client)",
  "type": "epic",
  "acceptance": [

    {
      "kind": "test",
      "req": "TEST-01",
      "description": "≥3 automated tests covering timer math, CRUD, localStorage round-trip",
      "command": "node",
      "args": ["--test", "tests/*.test.mjs"],
      "expect": "pass",
      "minCount": 3,
      "cwd": "."
    },

    {
      "kind": "file",
      "req": "PERSIST-01",
      "description": "localStorage persistence module exists and is non-trivial",
      "path": "src/store.js",
      "assertions": [
        { "type": "exists" },
        { "type": "minBytes", "value": 200 },
        { "type": "matches", "regex": "localStorage\\.(setItem|getItem)", "flags": "m" }
      ]
    },

    {
      "kind": "file",
      "req": "TIMER-03",
      "description": "Pomodoro defaults are 25/5/15 with configurable cadence",
      "path": "src/timer.js",
      "assertions": [
        { "type": "exists" },
        { "type": "matches", "regex": "work[^\\d]{1,12}25|25[^\\d]{1,12}work" },
        { "type": "matches", "regex": "cadence|longBreakEvery" }
      ]
    },

    {
      "kind": "file",
      "req": "A11Y-04",
      "description": "ARIA landmarks + skip link + aria-live region",
      "path": "index.html",
      "assertions": [
        { "type": "contains", "value": "role=\"main\"" },
        { "type": "contains", "value": "aria-live" },
        { "type": "matches", "regex": "<a [^>]*href=\"#main\"[^>]*>\\s*Skip" }
      ]
    },

    {
      "kind": "lint",
      "req": "QUALITY-01",
      "description": "Source passes biome check clean",
      "tool": "biome",
      "args": ["check", "."],
      "expect": "clean"
    },

    {
      "kind": "http",
      "req": "SMOKE-01",
      "description": "Serving the static app returns the HTML shell",
      "startCommand": "npx serve -p 8123 .",
      "startupDelayMs": 2000,
      "url": "http://127.0.0.1:8123/",
      "method": "GET",
      "status": 200,
      "bodyMatches": "<title>[^<]*Pomodoro"
    },

    {
      "kind": "manual",
      "req": "UX-01",
      "description": "Dark/light/auto theme cycle is visually usable",
      "prompt": "Open the app, click the theme toggle three times. Does it cycle auto→light→dark→auto? Press Space and does Start/Pause toggle? Pass=yes-yes."
    },

    "README with run/test/architecture"
  ]
}
```

Observations on the example:

- **The last entry is a raw string**, preserved unchanged. The new system accepts mixed arrays indefinitely.
- **Every structured gate carries a `req` ID**. `TIMER-03` is the same identifier GSD used in `REQUIREMENTS.md`; here it is queryable: `cleo req show T001 --id TIMER-03` returns the gate body. No markdown involved.
- **`qaPassed=true` would be machine-derived**, not agent-asserted. After the `cleo verify --run` pass, the runtime sees all test/file/lint/http gates green and sets `verification.gates.testsPassed = true` automatically. The benchmark false-positive (agent marked qaPassed=true while shipping only unit tests) is structurally prevented by the `minCount: 3` on TEST-01 plus the absence of a separate integration-test gate that an agent could have failed to skip.
- **Manual gates are allowed but carry a prompt**. An agent cannot silently set `UX-01` to pass — the orchestrator or human must explicitly acknowledge the prompt via `cleo verify T001 --manual UX-01 --verdict pass --note "verified"`.

---

## 4. Runtime — the `cleo verify` subcommand family

### 4.1 `cleo verify <taskId> --run`

Executes each programmatic gate in acceptance order. Writes results to
`task.verification.gateResults` and to `lifecycle_gate_results`.

**Signature**:

```
cleo verify <taskId> --run
  [--gate <index-or-req>]         # run one gate only
  [--skip-manual]                  # auto-skip ManualGate entries (CI mode)
  [--timeout <ms>]                 # per-gate override
  [--parallel <n>]                 # max parallel gates (default 1; some gates conflict)
  [--dry-run]                      # print what would run, don't execute
  [--json]                         # machine-readable output envelope
  [--fail-fast]                    # stop on first failure (default: run all, report all)

Exit codes:
  0  — all non-advisory gates passed
  20 — one or more gates failed            (ExitCode.LIFECYCLE_GATE_FAILED)
  21 — gate runner crashed                 (ExitCode.VERIFICATION_INIT_FAILED)
  22 — task has no programmatic gates      (ExitCode.NO_GATES_TO_RUN — new)
  60 — gate timeout exceeded               (retryable)
```

**Sample output** (`--json` envelope, LAFS-compliant per ADR-039):

```json
{
  "success": false,
  "data": {
    "taskId": "T001",
    "ranAt": "2026-04-16T05:12:03.441Z",
    "totalGates": 7,
    "passed": 5,
    "failed": 1,
    "skipped": 1,
    "gates": [
      {
        "index": 0, "req": "TEST-01", "kind": "test",
        "result": "pass", "durationMs": 3142,
        "evidence": "tests/timer.test.mjs … ok 7/7"
      },
      {
        "index": 2, "req": "TIMER-03", "kind": "file",
        "result": "fail", "durationMs": 4,
        "evidence": "src/timer.js matched /work.*25/ but NOT /cadence|longBreakEvery/ — cadence setting missing",
        "errorMessage": "assertion 3 of 3 did not match"
      },
      {
        "index": 6, "req": "UX-01", "kind": "manual",
        "result": "skipped", "durationMs": 0,
        "evidence": "--skip-manual active; no human verdict recorded"
      }
    ]
  },
  "error": {
    "code": "LIFECYCLE_GATE_FAILED",
    "message": "1 of 7 gates failed: TIMER-03 (file)",
    "fix": "Ensure src/timer.js exposes a configurable long-break cadence; re-run `cleo verify T001 --run --gate TIMER-03`"
  },
  "meta": { "operation": "verify.run", "requestId": "…", "duration_ms": 7412 }
}
```

### 4.2 `cleo verify <taskId> --manual <req> --verdict <pass|fail|warn> [--note]`

Record a human/agent verdict for a `ManualGate`. Writes a single
`GateResult` with `checkedBy = <currentAgent>`, `result = <verdict>`.

```
cleo verify T001 --manual UX-01 --verdict pass --note "visually verified by owner"
```

### 4.3 `cleo verify <taskId> --report [--format md|json]`

Read-only — dumps the last gate-run status. For pipeline observability.

### 4.4 `cleo req` family (GSD-style ergonomics)

```
cleo req add <taskId> --id TIMER-03 --description "…" \
  --gate '{"kind":"file","path":"src/timer.js","assertions":[…]}'

cleo req show <taskId> [--id TIMER-03] [--json]

cleo req list <taskId>                # list all REQ-IDs
cleo req list --across-epic T760      # list across an epic

cleo req update <taskId> --id TIMER-03 --gate '{…}'

cleo req remove <taskId> --id TIMER-03

cleo req find <query>                  # fuzzy-search REQ descriptions
```

The `--gate` argument accepts:
1. A JSON string (as above).
2. `--gate @path/to/gate.json` for longer bodies.
3. One of the shortcut flags: `--test-cmd "pnpm test"`, `--file src/x.js:contains:foo`, `--http http://localhost/ =200`. These lower typing overhead for the common cases.

REQ-ID uniqueness is scoped per task; `cleo req add T001 --id TIMER-03` with an existing TIMER-03 returns `ExitCode.DUPLICATE_REQ` (new code, 23).

---

## 5. Integration with `cleo complete`

### 5.1 Today's flow (`complete.ts:158-197`)

```
loadTask → check dependencies → createAcceptanceEnforcement.validateCompletion →
  if verification.enabled && type != epic:
    check task.verification.passed === true AND all required gates === true
  if children incomplete && type == epic: fail
  flip status='done', write verification, auto-complete parent if all siblings done
```

### 5.2 New flow (additive)

A new step is inserted between "acceptance enforcement" and "verification rollup check":

```
loadTask → check dependencies → createAcceptanceEnforcement.validateCompletion →
  [NEW] if task.acceptance contains ≥1 AcceptanceGate:
          require task.verification.gatesLastRunAt within the last 10 minutes
          require task.verification.gateResults contains one entry per gate
          require all non-advisory gates: result === 'pass'
          if any fail:
            throw CleoError(LIFECYCLE_GATE_FAILED, …, {fix: "cleo verify <id> --run"})
  [NEW] auto-promote rollup gates when programmatic gates all pass:
          if any TestGate.result == 'pass':           verification.gates.testsPassed = true
          if any LintGate.result == 'pass':           verification.gates.qaPassed = true (partial)
          if all programmatic gates pass:             verification.gates.implemented = true
          (agent still has to confirm the remaining rollups; we never *downgrade* here)
  check task.verification.passed === true AND all required gates === true
  flip status='done', …
```

**Config knobs** added under `enforcement.gates`:

```yaml
enforcement:
  gates:
    mode: "block" | "warn" | "off"       # default "block" in phase 3
    maxRunAgeSeconds: 600                 # reject stale gate runs
    runOnComplete: true                   # auto-invoke verify --run as part of complete
    allowForce: false                     # `cleo complete --force` bypass (owner-only)
```

### 5.3 `cleo complete --force`

When `allowForce: true` in config **and** the invoking identity is `owner`
(resolved via `cleo session whoami` against the signaldock ownership graph),
a `--force` flag skips programmatic gate requirements and emits a warning
into `failureLog` recording the bypass. This is the explicit escape hatch
for emergencies. Agents cannot set this config; only human owners can.

### 5.4 Exit-code contract changes

Add to `@cleocode/contracts` ExitCode enum:

| Code | Name | Meaning |
|-----:|------|---------|
| 22 | `NO_GATES_TO_RUN` | `verify --run` invoked on task with zero programmatic gates |
| 23 | `DUPLICATE_REQ` | `cleo req add` with a REQ-ID that already exists on the task |
| 24 | `GATE_RUN_STALE` | `cleo complete` rejected because last gate run is older than `maxRunAgeSeconds` |
| 25 | `MANUAL_GATE_UNRESOLVED` | `cleo complete` rejected because a ManualGate has no verdict recorded |

All four are **retryable** except DUPLICATE_REQ.

---

## 6. Migration strategy — three phases

### Phase 1 — Add the type (weeks 1-2, v2026.M+1.0)

**Goal**: schema extension exists, no existing tasks are affected.

- Ship `@cleocode/contracts/acceptance-gate.ts` as NEW file.
- Widen `Task.acceptance` to `(string | AcceptanceGate)[]`.
- Widen `packages/core/src/store/converters.ts` `safeParseJsonArray` narrowing.
- Ship `cleo verify --run` that only *reads* programmatic gates and prints
  results. Does NOT wire to `cleo complete`.
- Ship `cleo req add/show/list/update/remove/find` but `add` only writes
  — no runtime enforcement yet.
- Every existing task continues working unchanged because `string[]` is a
  subset of `(string | AcceptanceGate)[]`.
- New config key `enforcement.gates.mode = "off"` by default.

**Success criterion**: `cleo add` accepts a gate via `--acceptance '{"kind":"file",…}'` or via `cleo req add`; `cleo verify T001 --run` executes it and prints results; `cleo complete T001` still works identically whether gates pass or fail.

### Phase 2 — Populate (weeks 3-4, v2026.M+1.x)

**Goal**: convert existing high-value tasks to use gates; build migration tools.

- Ship `cleo req migrate <taskId>` — reads each free-text string, runs it
  through a heuristic converter that proposes a gate template the agent
  must confirm:

  | Free-text pattern | Proposed gate template |
  |---|---|
  | `/tests? pass\|testing/i` | `{kind:"test",command:"{detected}",expect:"pass"}` using `.cleo/project-context.json.testing.command` |
  | `/biome\|lint\|typecheck\|tsc/i` | `{kind:"lint",tool:<detected>,expect:"clean"}` |
  | `/\\.(md\|ts\|tsx\|rs\|py\|html\|css)\\b/` | `{kind:"file",path:"<extracted>",assertions:[{type:"exists"},{type:"nonEmpty"}]}` |
  | `/(endpoint\|http\|GET\|POST\|return 200)/i` | `{kind:"http",…}` — prompts for URL |
  | else | `{kind:"manual",prompt:"<original text>"}` |

  The command prints the proposed conversion and writes it only with
  `--apply`. The heuristic is allowed to be wrong — it is a *scaffold*,
  not an auto-upgrade.

- Ship `cleo req migrate --scope=epic T760 --apply` to batch-convert.
- Add `cleoos doctor --gates` that audits the task graph and reports
  "tasks with gates: N / total M" so progress is observable.
- Add a biome-style migration linter at `cleo req lint` that flags:
  - `FileGate` paths that don't exist in the repo at the time of the add.
  - `TestGate` commands not present in `package.json/scripts`.
  - `HttpGate` URLs that look like private IPs but don't have `startCommand`.
- Flip `enforcement.gates.mode = "warn"` so `cleo complete` prints a
  "gate N failed — did you mean to run verify first?" message but still
  succeeds.

**Success criterion**: ≥ 80 % of *new* tasks created in this window carry
at least one programmatic gate; `cleo req migrate` can convert a historical
epic in one command; no existing automation is broken.

### Phase 3 — Enforce (weeks 5-6, v2026.M+2.0)

**Goal**: `cleo complete` rejects tasks whose programmatic gates haven't
passed on disk within the last run window.

- Flip `enforcement.gates.mode = "block"` as default.
- `cleo complete` now calls `verify --run` when `runOnComplete: true`
  (default). Agents can short-circuit by running verify first and
  invoking complete with `--no-rerun` (for long test suites).
- `cleo-subagent` return-message format is extended (§7.1) so the
  orchestrator IVTR loop knows exactly which REQ-ID failed and can
  spawn a fix-agent with `--focus TIMER-03` rather than re-running
  the entire task.
- The old `VerificationGates.testsPassed / qaPassed / implemented`
  are auto-promoted based on programmatic results (§5.2). Agents
  keep authority over `cleanupDone / securityPassed / documented`
  because those are harder to fully automate and deserve the
  per-domain agent.

**Success criterion**: Re-running the Pomodoro benchmark on CLEO
cannot produce `testsPassed=true` without real tests passing on disk;
SUPREME-style audit cannot find a gap between self-report and reality
because the self-report is derived from reality.

---

## 7. Orchestrator integration (IVTR loop)

### 7.1 Return-message contract for cleo-subagents

Today subagents return a terse summary line. Extend the envelope so the
orchestrator can route on gate failure:

```json
{
  "summary": "Implementation complete. 6 of 7 gates passed. See MANIFEST.jsonl.",
  "status": "complete" | "partial" | "blocked",
  "gates": {
    "passed": 6,
    "failed": 1,
    "failures": [
      {
        "req": "TIMER-03",
        "kind": "file",
        "evidence": "…",
        "hint": "Expose long-break cadence setting in src/timer.js"
      }
    ]
  },
  "manifestPath": ".cleo/agent-outputs/MANIFEST.jsonl"
}
```

The orchestrator rule becomes: if `status == "partial"` and
`gates.failures.length > 0`, spawn a **fix-agent** with the failing
REQ-IDs as input, not the whole task. This replaces today's brittle
"re-spawn with the whole task context" loop with surgical re-spawns.

### 7.2 Reference in cleo-subagent base protocol

Update `~/.local/share/cleo/templates/CLEO-INJECTION.md` §Phase 3 to
instruct subagents to include `gates` block in their return when the
task had programmatic gates and `cleo verify --run` was invoked.

### 7.3 Reference to `ct-orchestrator` skill

The `ct-orchestrator` skill (referenced in `AGENTS.md`) gets a new
§ "Gate-failure triage" that codifies:

1. Read `task.verification.gateResults`.
2. Partition failures by `kind`:
   - `test` → spawn `coder` with `--focus-gate TEST-01` (implementation bug).
   - `file` with missing path → spawn `coder` with `--focus-gate PERSIST-01` (missed scope).
   - `lint` → spawn `cleanup` domain agent (no re-implementation).
   - `http` → spawn `qa` agent (runtime issue, often config).
   - `manual` → surface to owner chat; do not auto-re-spawn.

Each fix-agent spawns with a scoped focus instead of the whole task,
cutting re-run costs dramatically and preserving the original
implementation work.

---

## 8. What NOT to do

These are design decisions we are explicitly **rejecting** and the reasons:

1. **Do not remove free-text acceptance**. Every existing task in every
   tasks.db in the wild has string-only acceptance. Blast-radius of a
   breaking change here is infinite. Strings stay forever.

2. **Do not invent a DSL**. A line like
   `"when file src/timer.js then contains /25/ and contains /cadence/"`
   looks pretty but means building a parser, a grammar, a highlighter,
   and a learning curve. The discriminated union above is boring
   structured JSON. Every AI agent on the planet can generate it;
   every IDE's JSON schema can validate it. We get the *same* expressive
   power as a DSL with none of the maintenance burden. The "shortcut
   flags" on `cleo req add` (`--file src/x.js:contains:foo`) give the
   CLI ergonomics a DSL would without committing to one.

3. **Do not invent a new DB table**. `lifecycle_gate_results` already
   exists and was designed for this purpose; we just need a structured
   producer. Adding a table breaks future migrations' linearity and
   spawns a sync-between-tables problem we don't need.

4. **Do not auto-generate gates from natural language on completion**.
   Migration heuristics at `cleo req migrate` are *opt-in* and must be
   confirmed by an agent/human. Silent auto-gate-promotion would be
   worse than no gates — agents would game the heuristic.

5. **Do not block completion on manual gates when in a non-interactive
   environment**. `--skip-manual` exists for CI. The manual-verdict
   requirement is for *interactive human/agent* completions; headless
   runs accept the skip and record `result: "skipped"`.

6. **Do not make gates the *only* acceptance mechanism**. A task that
   says "copy reads well to a person" has legitimate reason to be a
   ManualGate or even a raw string. Programmatic gates are the *default
   when verifiable* — they are not a replacement for human judgement
   on subjective criteria.

7. **Do not wire gate execution into `cleo add`**. Adding a task must
   not require a running build. Gate execution only happens at
   `cleo verify --run` or at `cleo complete` — both of which happen
   after work is done.

8. **Do not allow `cmd: "string with spaces"` without `args`**. The
   TestGate/CommandGate examples use `command + args?: string[]` on
   purpose — passing a full shell string is a shell-injection vector
   and also makes cross-platform testing harder. The `spawn` call is
   always `shell: false`.

---

## 9. Why this beats GSD's REQ-ID-in-markdown

| Property | GSD `REQUIREMENTS.md` + `1-VERIFY.md` | CLEO `AcceptanceGate` |
|---|---|---|
| **Addressable** | Yes, via string grep on REQ-ID | Yes, via `cleo req show <taskId> --id TIMER-03`, SQL-queryable, indexed |
| **Machine-verifiable** | **No** — `1-VERIFY.md` is a human-written markdown table | **Yes** — `cleo verify --run` executes each gate, records real results |
| **Stale-detection** | **No** — you can commit a green `1-VERIFY.md` against broken code | **Yes** — `cleo complete` rejects gate-run older than `maxRunAgeSeconds` (default 10 min) |
| **Queryable across tasks** | Grep across `.planning/**/*.md` | `SELECT * FROM tasks JOIN lifecycle_gate_results …` or `cleo req find <query>` |
| **Traceability to evidence** | "PASS" in a cell, no link to run artifacts | Each `GateResult` carries `evidence` field; full row in `lifecycle_gate_results` with `checkedAt/checkedBy/details` |
| **Composable with session state** | Requires reading external markdown | Native to `cleo show`, `cleo session briefing`, `cleo dash` |
| **Escape hatch for subjective criteria** | All requirements equal in markdown | `ManualGate` explicitly marked; surfaces to orchestrator differently |
| **Re-spawn on failure** | Cannot tell the orchestrator "re-do only TIMER-03" without re-reading the whole file | Fix-agent spawned with `--focus-gate TIMER-03` (§7.3) |
| **Cost to update** | Edit markdown + re-run every test manually + update VERIFY table | `cleo req update T001 --id TIMER-03 --gate '{...}'` + `cleo verify --run --gate TIMER-03` |
| **Drift between REQ and code** | Easy: the markdown and the source code can lie | Hard: the gate IS code-colocated; `FileGate.path` points at the actual artifact |

**The deeper point**: GSD's REQ-IDs are a *documentation* layer. CLEO's
gates are an *executable* layer. The three benchmark scores that put
CLEO at 79 vs GSD at 75 did not capture this difference because the task
was small enough that markdown-traceability was "good enough". For a
50k-LOC codebase with 400 tasks open, the difference compounds: CLEO's
task graph tells you *in SQL* which REQs are currently broken; GSD tells
you which markdown cells currently say PASS.

---

## 10. What breaks / what doesn't

### Does not break

- **Every existing task** — mixed `(string | AcceptanceGate)[]` is a widening, not a narrowing. Old `string[]` data parses unchanged.
- **Every existing test** — enforcement layer keeps `checkMin` against total array length including gates. Three gates count for three criteria.
- **`cleo complete` for a task with zero programmatic gates** — the new §5.2 step is a no-op when there are no gates, and in Phase 1 `enforcement.gates.mode="off"` means nothing changes for anyone until they opt in.
- **Every release automation** — the new `verify --run` is additive; nothing in `releaseShip` depends on it.
- **Agent protocols** — the base protocol in `CLEO-INJECTION.md` still applies; the extension to the return envelope (§7.1) is backward-compatible JSON.

### Might need attention

- **Config file**: `enforcement.gates` block is new. Older CLEO binaries ignore unknown config keys (they do today — tested in the enforcement.ts defaults path). Forward-compat OK.
- **Schema-versioned exports**: `cleo export --format todo-json` should emit the mixed-array form; consumers that parsed `acceptance` as `string[]` need to widen. Add a `--legacy-strings-only` flag for external consumers who can't adapt immediately.
- **Import tools**: `cleo import` will need to gracefully downgrade gates to strings when the target format does not support them (GitHub issues, Linear) — emit the `description` field as the string representation.
- **Backfill module** (`packages/core/src/backfill/index.ts:263`) — already sets `acceptanceJson = JSON.stringify(generated)`. If `generated` is widened to include gates in the future, tests pass. Nothing needs to change today.

### Actually breaks

- **Anything that does `for (const c of task.acceptance) console.log(c.toLowerCase())`**. A gate object has no `.toLowerCase()`. Fix: `typeof c === 'string' ? c : c.description`. This pattern is present only in `packages/cleo/src/cli/commands/show.ts` rendering code (2 lines); trivial guard.
- **External `TaskCreate.acceptance?: string[]`** in `@cleocode/contracts` → needs widening, same as `Task.acceptance`. One line.
- **Any agent prompt that says "write 3 acceptance criteria as strings"** — still works, just stops being the *best* practice.

Net: one signature widening, two render sites updated, and a new module. The rest is additive.

---

## 11. Acceptance criteria for this task (dogfood moment)

Applying the proposed system to its own design task, T763, the acceptance
array *would* look like this after Phase 2:

```jsonc
"acceptance": [
  {
    "kind": "file",
    "req": "DESIGN-01",
    "description": "Design document exists and covers all 8 design points",
    "path": ".cleo/agent-outputs/T760-rcasd/T763-programmatic-gates-design.md",
    "assertions": [
      { "type": "exists" },
      { "type": "minBytes", "value": 15000 },
      { "type": "contains", "value": "AcceptanceGate" },
      { "type": "matches", "regex": "Phase 1.*Phase 2.*Phase 3", "flags": "s" }
    ]
  },
  {
    "kind": "file",
    "req": "DESIGN-02",
    "description": "Schema snippet is complete TypeScript with discriminated union",
    "path": ".cleo/agent-outputs/T760-rcasd/T763-programmatic-gates-design.md",
    "assertions": [
      { "type": "contains", "value": "kind: 'test'" },
      { "type": "contains", "value": "kind: 'file'" },
      { "type": "contains", "value": "kind: 'command'" },
      { "type": "contains", "value": "kind: 'lint'" },
      { "type": "contains", "value": "kind: 'http'" },
      { "type": "contains", "value": "kind: 'manual'" }
    ]
  },
  {
    "kind": "manual",
    "req": "OWNER-APPROVAL",
    "description": "Owner reviews and approves the design before any implementation",
    "prompt": "Read §2-§9. Approve for Phase 1 implementation?"
  }
]
```

(This task has `status: pending` and `type: task`, so full RCASD pipeline
gates apply once it is promoted to `implementation` stage — out of scope
for this research subagent.)

---

## 12. Implementation roadmap (sketch, for the downstream T764/T765 subtasks)

Not part of this deliverable, but documented so the owner can scope the
follow-on work:

| Phase | Task | Packages touched | Rough sizing |
|---|---|---|---|
| 1 | Add `AcceptanceGate` contract | `@cleocode/contracts` | S |
| 1 | Widen `Task.acceptance` + converter | `@cleocode/contracts`, `packages/core/src/store/converters.ts` | S |
| 1 | `cleo verify --run` skeleton (read-only) | `packages/core/src/validation/*`, `packages/cleo/src/dispatch/domains/verify.ts` (new) | M |
| 1 | Gate executors (file, test, command, lint) | `packages/core/src/validation/gate-executors/*` (new) | M |
| 1 | `cleo req add/show/list` | `packages/cleo/src/dispatch/domains/req.ts` (new) | M |
| 2 | `cleo req migrate` heuristic converter | `packages/core/src/tasks/migrate-acceptance.ts` (new) | M |
| 2 | `http` and `manual` gate executors | `packages/core/src/validation/gate-executors/*` | S |
| 2 | Render-site updates in `cleo show` | `packages/cleo/src/cli/commands/show.ts` | S |
| 3 | Wire into `cleo complete` | `packages/core/src/tasks/complete.ts` | M |
| 3 | Orchestrator return-envelope extension | `templates/CLEO-INJECTION.md`, `ct-orchestrator` skill | S |
| 3 | Migration linter `cleo req lint` | `packages/cleo/src/dispatch/domains/req.ts` | S |

Total: roughly 3 medium-sized tasks, 7 small ones. One release cycle per
phase (≤ 1 week each). Realistic: v2026.M+1..M+3 across three patches.

---

## 13. Open questions for owner review

Flagging the assumptions this design makes that the owner may want to
revisit before implementation starts:

- **Q1**: Should the `minCount` field on `TestGate` be *tests run* or
  *tests passed*? Today I spec it as "ran", reasoning: if 10 ran and
  all 10 passed but 7 is the minCount, that's a pass. But if 3 ran and
  passed with minCount 7, that's a fail. This seems right but is
  ambiguous in the TestGate JSDoc. Owner to confirm.

- **Q2**: Should `cleo complete --force` require any flag beyond
  `allowForce: true` in config? I propose yes — `--force --reason "…"`
  and it writes the reason into `failureLog` plus `auditLog`. Owner
  to confirm this is enough friction.

- **Q3**: Does the orchestrator IVTR re-spawn-on-fail loop (§7.3) need
  a max-round limit separate from today's `verification.round` limit
  of 5? I assume same limit applies. Owner to confirm.

- **Q4**: Should `ManualGate` verdicts be writable by any agent or
  restricted to certain agent types (e.g., `qa`, `owner`)? The
  circular-validation prevention (`checkCircularValidation` in
  `verification.ts:379`) already blocks self-approval; extending it
  to gate verdicts would be consistent. Owner to confirm scope.

- **Q5**: For Phase 2 migration, should we set a **deadline** by which
  all un-migrated tasks get `enforcement.gates.mode="warn"` nag
  messages? Or is opt-in forever fine? I recommend a 2-release
  deadline after Phase 1 ships to avoid a long tail of un-migrated
  tasks. Owner to confirm.

- **Q6**: The `sha256` FileAssertion type is included for lock-file
  scenarios (`pnpm-lock.yaml` hash must match). Do you actually want
  this? It is the most rigid assertion and may be over-engineering
  for v1. I included it because I expect a future "release-ship
  attestation" task to want it. Owner can cut this from Phase 1 if
  minimal scope matters more.

---

## 14. Conclusion

This design closes the single biggest gap SUPREME's Pomodoro judgement
surfaced: CLEO's acceptance criteria are *claims* the agent grades itself
on, with no opposing check. By adding a narrow, typed `AcceptanceGate`
union that coexists with free-text strings, extending `cleo verify --run`
to execute gates against the live project, wiring `cleo complete` to
reject stale-or-failing runs, and routing gate-level failures back into
the orchestrator IVTR loop with REQ-ID precision, we get the GSD-style
traceability layer (and more — ours is executable) without breaking a
single existing task. The `lifecycle_gate_results` table and the
verification-rounds machinery already exist; this proposal is mostly
about *populating the columns we already have with structured data
instead of free text*.

Three phases. Each phase is shippable alone. The whole set turns CLEO's
task graph from "the agent said all gates passed" into "the runtime
proved all gates passed 8 minutes ago." That is the difference between a
self-reported check-list and an auditable quality gate, and it is the
move that lets CLEO's queryable task graph moat (§SUPREME 7 "What CLEO
does better") mean "your agents cannot lie to you about completion."

---

*End of T763 design document.*
