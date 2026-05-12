# T946 — Tier 1/2/3 Autonomous Self-Improving Loop Design

**Parent epic**: T942
**Status**: RESEARCH / DESIGN
**Date**: 2026-04-17
**Author**: security-engineer subagent (cleo-prime dispatch)
**Relates to**: ADR-047 (GC Daemon), ADR-051 (Gate Integrity), ADR-049 (Harness Sovereignty)

---

## 1. Sandbox Inventory — what exists, what's missing

Inspected `/mnt/projects/cleo-sandbox/`:

**Present:**
- `AGENTS.md:1-368` — full agent contract, scenario/harness catalogs, the autonomous-loop pseudocode (lines 109-142) already matches Tier 3 intent.
- `docker-compose.yml:1-103` — three isolated nodes (ubuntu:2221, alpine:2222, fedora:2223), bind-mounts `/mnt/projects/cleocode:/sandbox-src:ro`, writes only to `./artifacts`.
- `bin/sandbox*` — dispatcher + `sandbox-up`, `sandbox-install`, `sandbox-run`, `sandbox-test-all`, `sandbox-artifacts`, `sandbox-reset`.
- 11 harnesses including `claude-code`, `claude-sdk`, `codex`, `gemini-cli`, `pi`, `opencode`, `vanilla-node` (`harnesses/`).
- 5 scenarios: `fresh-install-linux`, `upgrade-from-legacy-dotcleo`, `multi-project-registry`, `corrupted-db-recovery`, `harness-e2e` (`scenarios/`).
- Result schema already machine-readable (`result.txt` + `--json`, `AGENTS.md:74-106`).

**Missing for T946:**
- No Ed25519 signing infrastructure (no `bin/sign-receipt`, no `receipts/` dir, no key storage policy).
- No metrics-baseline capture — `AGENTS.md:123-142` loops on PASS/FAIL only, has no notion of "metrics improved".
- No Tier 2 proposal queue — sandbox validates existing CLEO, does not propose changes.
- No auto-merge bridge back to `/mnt/projects/cleocode`. Source mount is read-only (`docker-compose.yml:33`). Tier 3 needs a separate RW worktree on the host (never inside the container).
- No network-egress controls on the sandbox bridge network (`sandbox_net`, `docker-compose.yml:15-17`). For Tier 3 LLM calls from inside a harness, this is acceptable; for hostile-payload isolation it is not.

---

## 2. Tier 1 Loop — Execute existing tasks (lowest risk, ship first)

**Daemon architecture**: reuse the `cleo daemon` pattern already shipping at `packages/cleo/src/gc/daemon.ts:1-60`. This is node-cron v4 sidecar (matches memory D014 cross-platform directive). A new file `packages/cleo/src/sentient/daemon.ts` MUST follow the same pattern: `detached:true`, file stdio, `child.unref()`, state in `.cleo/sentient-state.json`, cron `*/5 * * * *` (every 5 min) for a tight tick.

**Picker**: `cleo orchestrate ready --epic <id>` when a focus epic is configured in `.cleo/sentient.json`; else `cleo next` (returns single task). `orchestrate ready` lives at `packages/cleo/src/dispatch/engines/orchestrate-engine.ts:252` (`orchestrateReady`) — already parallel-safe and wave-aware.

**Worker**: spawn via the existing `orchestrateSpawnExecute` path at `orchestrate-engine.ts:529`. Adapter selection goes through `orchestrateSpawnSelectProvider` (`orchestrate-engine.ts:427`). LLM tier per D014: **Claude Sonnet via Claude Code OAuth** (free for owner) as primary cold-tier; **Ollama+Gemma3-E4B-it** warm-tier fallback when offline or when Anthropic rate-limits. Tier selection is a per-tick decision based on `cleo memory llm-status`.

**Failure handling**:
1. On spawn error → increment `task.meta.retry_count`, retry up to 3× with 30-s / 5-min / 30-min backoff.
2. After 3 failures → mark task `status='stuck'`, append `ObservationKind='incident'` to BRAIN with `title:"Tier1 stall: T###"`, continue with next ready task.
3. On 5 stuck tasks in 1 h → daemon pauses itself, writes kill-switch note to `.cleo/sentient-state.json`, emits stderr banner on next `cleo` invocation.

**Kill switch**: `cleo sentient stop` writes `state.killSwitch = true` to `.cleo/sentient-state.json`. Daemon checks this flag at top of every cron tick before doing any work. `cleo sentient resume` clears it. Hard stop: `cleo daemon stop sentient` (SIGTERM). Dead-man: if `.cleo/sentient-state.json` has `lastTickAt` older than 30 min, CLI on any invocation MUST surface a warning.

---

## 3. Tier 2 Loop — Propose new tasks

**Inputs (per tick, weighted)**:
- **BRAIN recurring-pain patterns**: `cleo memory find --type incident --since 7d`, group by title prefix, threshold ≥ 3 occurrences → candidate.
- **Nexus flow anomalies**: `cleo nexus flows --stale` (flows not exercised in N days despite code change) and `cleo nexus impact <hotspot>` for high-fan-in symbols.
- **Failing tests / flaky tests**: parse `.cleo/audit/gates.jsonl` (ADR-051 §Decision 7) for `test-run` evidence atoms where `failCount>0` or retries>1.
- **Coverage gaps**: Vitest JSON `--coverage` output under threshold.

**Output**: proposed task in `tasks.db` with `status='proposed'` (new enum value — additive to the existing status enum). Required fields are full: title, acceptance criteria, size (small/medium/large), parent epic candidate, and a `meta.proposedBy:"sentient-tier2"` + `meta.evidenceRef:<brain-observation-id>`.

**Queue location decision**: **Reuse `tasks` table with `status='proposed'`**, not a separate `proposals` table. Rationale: (a) zero schema migration friction (DRY), (b) all task tooling — `show`, `find`, `verify` — works unchanged, (c) ADR-051 evidence tooling applies uniformly. The `status` enum extension is additive per the pattern used for `stuck` above.

**Approval CLI**:
```
cleo propose list                     # proposed tasks
cleo propose accept T### [--parent]   # status: proposed → ready; owner-approved
cleo propose reject T### --reason ""  # status: proposed → archived; BRAIN note
cleo propose diff T### T###           # when two similar proposals exist
```
`propose accept` writes a signed receipt (same chain as Tier 3, see §4) with `kind:"proposal.accepted"`.

**Safety**: Tier 2 is strictly proposal-only. It MUST NOT set `status` to anything that a worker would pick up. The daemon self-enforces: `status='proposed'` is filtered out of `orchestrate ready` / `cleo next`. Verified in the query path at `task-engine.ts` candidate selection (must be updated).

---

## 4. Tier 3 Loop — Sandbox experiments with auto-merge

**Worktree model**: on experiment start, the daemon `git worktree add /mnt/projects/cleo-sandbox/experiments/<expId> main` from the **host** cleocode repo. This is RW and separate from the read-only mount `/sandbox-src`. The sandbox container stays read-only; the agent runs **on the host** inside the worktree and uses the sandbox only as its test harness via `./bin/sandbox run <scenario>` (`AGENTS.md:37,105`). This preserves `docker-compose.yml:33`'s RO invariant and leverages the existing `artifacts/` evidence pipeline.

**Experiment types** (each is a Tier 2 proposal kind):
1. `refactor` — simplify hotspots from `cleo nexus clusters`.
2. `optimization` — reduce token/test/build time for a named operation.
3. `test-fix` — close a flaky test identified by Tier 2.
4. `spec-enhancement` — auto-generated spec improvements (narrow scope).

**Gates** (all ADR-051 gates from `.cleo/adrs/ADR-051-programmatic-gate-integrity.md:76-82`, PLUS):
- `metricsImproved` — **new gate**, requires `metrics-delta:<path>` evidence atom (extension to ADR-051 §Decision 9 `EvidenceAtom` union).
- Sandbox pass: `test-run:/mnt/projects/cleo-sandbox/artifacts/.../result.txt == PASS` on at least `ubuntu` node; `alpine` and `fedora` SHOULD also PASS.

**Metrics framework**:
- Baseline capture before diff: run `cleo bench --suite all --json > baseline.json`, hash and record.
- Post-experiment: same command → `after.json`.
- Decision rule: commit iff `strictlyImproved(primary) && forAll(secondary, within1%orImproved)`.
- Registry (stored in brain.db, `ObservationKind='metric'`, new kind): `token_per_op`, `test_duration_ms`, `coverage_pct`, `biome_errors`, `build_ms`, `bundle_kb`, `startup_ms`.

**Ed25519 signing**:
- Key generation: `cleo sentient keygen` on first daemon init, writes `~/.cleo/keys/sentient.ed25519` (`mode 0600`, owner-only) and `~/.cleo/keys/sentient.ed25519.pub`. Uses `@noble/ed25519` (pure JS, already a transitive dep) or llmtxt v2026.4.8 `AgentSession` once wired.
- Signer: `AgentSession.sign(payload)` where payload is `{receiptId, taskId, experimentType, baselineHash, afterHash, metricsDelta, gateEvidence, parentReceiptId}` serialized canonical-JSON. `parentReceiptId` forms a hash chain.
- Receipt ledger: `.cleo/audit/receipts.jsonl` — append-only (open with `O_APPEND`), chained via `parentReceiptId`. Replaces `.cleo/audit/force-bypass.jsonl` conceptually — the old audit file stays but is mostly dead once `--force` is gone (ADR-051 §Decision 3). Receipts reference gate-audit lines by `auditGateLineId`.
- Verification: `cleo sentient verify --from <receiptId>` walks the chain, validates every signature, and re-hashes every `files:`/`commit:`/`test-run:` evidence atom (ADR-051 §Decision 8 staleness semantics applied to the whole receipt chain).

**Auto-merge sequence** (host-side, outside container):
```
1. cd /mnt/projects/cleo-sandbox/experiments/<expId>
2. cleo verify T### --gate implemented --evidence "commit:<sha>;files:..."
3. cleo verify T### --gate testsPassed --evidence "tool:pnpm-test"
4. cleo verify T### --gate qaPassed    --evidence "tool:biome;tool:tsc"
5. cleo verify T### --gate metricsImproved --evidence "metrics-delta:after.json"
6. cleo verify T### --gate ... (remaining gates) ...
7. cleo sandbox run <scenario> ubuntu && cleo sandbox run <scenario> alpine
8. cleo sentient sign T### --parent <prevReceiptId> > receipt.json
9. git -C /mnt/projects/cleocode fetch experiments/<expId> && \
   git -C /mnt/projects/cleocode merge --ff-only FETCH_HEAD
10. cleo complete T### (CLEO re-validates all hard evidence per ADR-051 §Decision 8)
11. git -C /mnt/projects/cleocode worktree remove experiments/<expId>
```
If step 9 is not fast-forwardable (main advanced), abort and re-base the experiment — merge commits are not allowed on auto-merged history. This makes every sentient change a straight-line suffix of main, trivially revertable.

**Kill switch — `cleo revert --from <receiptId>`**:
1. Walk receipt chain forward from `<receiptId>` to HEAD → list of commits.
2. Create a single revert commit: `git revert --no-edit <sha1>..<shaN>` squashed into one, messaged `Revert(sentient): <receiptId>..HEAD — owner kill switch`.
3. Append a new receipt with `kind:"revert"` referencing the reverted chain.
4. Set `.cleo/sentient-state.json.killSwitch=true` (Tier 1/2/3 all pause until `cleo sentient resume`).

This is safer than `reset --hard` (preserves history, ADR-051 §Decision 10 immutability-of-done preserved) and still fast (a single revert commit).

---

## 5. Security analysis

**Sandbox isolation**:
- Docker network `sandbox_net` (`docker-compose.yml:15-17`) is a default bridge. No egress rules. For Tier 3 this is **acceptable** because the host worktree never executes untrusted code; only the sandbox container does, and the container's only write surface is the bind-mounted `artifacts/` directory (`docker-compose.yml:36-37`). Source mount is RO (`docker-compose.yml:33`). Threat surface: a malicious agent could fill `artifacts/` with bogus PASS receipts — mitigated by evidence re-validation (ADR-051 §Decision 8) and by signing the sandbox result file sha256 into the receipt, not the PASS text.
- Harder isolation (`--network=none` for run scripts, seccomp profiles) is a Phase-B hardening. Phase A keeps the existing network.

**Key management**:
- `~/.cleo/keys/sentient.ed25519` with `0600 owner:owner`. On creation, assert file mode programmatically; refuse to sign if mode drifts.
- Envelope encryption (OS keychain — libsecret on Linux) is a Phase-B upgrade. Phase A accepts plain-file-with-0600 because the threat model is "agent-only compromise," not "root compromise."
- Key rotation: `cleo sentient keyrotate` generates a new keypair, signs a `kind:"keyrotate"` receipt with BOTH keys during a 24-h transition window.

**Prompt-injection threat model**:
- A malicious BRAIN observation could hide a directive in its text that steers a Tier 2 proposal toward destructive refactor. Mitigation: Tier 2 proposals feed through a **separate prompt-hygiene pass** (no tools, no memory read) that extracts only the structured fields (title, rationale, acceptance) and drops free-form agent speech. All strings are length-capped.
- Tier 3 agent cannot bypass its own gates because gate writes are persisted by the `cleo verify` CLI on the host, with evidence that the CLI validates against git/fs/toolchain (ADR-051 §Decisions 1-2). The gate-integrity process is **out-of-band** from the experimenting agent. An agent that "claims" tests passed without running them produces `E_EVIDENCE_INSUFFICIENT` and cannot advance.
- Defense-in-depth: the signing key is OWNED by the daemon process, not the experiment agent. The experiment agent calls `cleo sentient sign` which runs a separate process under a separate LLM session that re-reads the receipt content before signing.

**Agents modifying their own gates**: fully addressed by ADR-051 already. The file at `.cleo/adrs/ADR-051-programmatic-gate-integrity.md:177` ("Evidence staleness check on completion") explicitly prevents verify-then-tamper.

---

## 6. Metrics framework (detail)

- Bench command: new `cleo bench --suite <tier1|tier2|tier3|all> --json` aggregates:
  - Vitest run time + pass/fail from `pnpm run test -- --reporter=json`.
  - Biome error count from `pnpm biome ci . --reporter=json`.
  - Build time from `pnpm run build` wall-clock.
  - Bundle KB from `dist/` dir sum.
  - Token-per-op from `cleo token summary --last 20` (already planned in owner notes).
- Storage: brain.db with a new ObservationKind `metric` and a structured payload `{metric: string, value: number, unit: string, runId: string, commitSha: string}`.
- `metricsImproved` validator: reads `baseline.json` and `after.json`, asserts `after.primary < baseline.primary * (1 - minDelta)` where `minDelta=0.01` default; every secondary metric MUST be within `baseline * 1.01` or better.

---

## 7. Integration with ADR-051 — NO duplication

Tier 3 auto-merge **never** writes gates directly. It only calls `cleo verify` which is the existing ADR-051 surface (`.cleo/adrs/ADR-051-programmatic-gate-integrity.md:56-93`). The only additions:
1. New gate `metricsImproved` (extension of the `VerificationGate` union).
2. New evidence atom kind `metrics-delta` (extension of `EvidenceAtom` in ADR-051 §Decision 9).

Both are additive — zero breaking change to existing gate validation code.

---

## 8. Recommendation — phased ship

**Week 1 — Tier 1 MVP** (ships behind `cleo sentient` domain):
- `packages/cleo/src/sentient/daemon.ts` + `state.ts` + `runner.ts` (mirror of `gc/` pattern).
- New CLI: `cleo sentient start|stop|status|resume`.
- Picker wired to `orchestrateReady` + `orchestrateSpawnExecute`.
- Retry/stuck/kill-switch logic.
- **No Ed25519 yet** — Tier 1 doesn't mutate main.

**Week 2 — Tier 2**:
- Add `status='proposed'` + `cleo propose` command family.
- BRAIN pattern extractor (new `packages/cleo/src/sentient/proposer.ts`).
- Tier 2 runs in same daemon tick, rate-limited to 3 proposals/day.
- Prompt-hygiene pass at proposal ingest.

**Week 3-4 — Tier 3** (gated on llmtxt v2026.4.8 `AgentSession` being merged):
- `cleo sentient keygen` + `sign` + `verify`.
- `metricsImproved` gate + `metrics-delta:` evidence atom.
- Worktree experiment runner.
- Auto-merge with `--ff-only` and receipt chain.
- `cleo revert --from <receiptId>` kill switch.
- Sandbox scenario catalog extended with metric-oriented scenarios (baseline-bench, regression-detect).

Ship order is strictly monotonic risk: Tier 1 is reversible by stopping the daemon; Tier 2 is proposal-only (owner gate); Tier 3 is the only tier that writes main, and only after every above mechanism is battle-tested.

---

## File citations

- `/mnt/projects/cleo-sandbox/AGENTS.md:1-368` — sandbox contract.
- `/mnt/projects/cleo-sandbox/docker-compose.yml:15-103` — container topology.
- `/mnt/projects/cleo-sandbox/README.md:30-40` — quickstart.
- `/mnt/projects/cleocode/.cleo/adrs/ADR-051-programmatic-gate-integrity.md:56-291` — gate contract reused whole.
- `/mnt/projects/cleocode/packages/cleo/src/gc/daemon.ts:1-60` — daemon pattern to mirror.
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/orchestrate-engine.ts:252,427,529` — picker/selector/spawner reuse points.
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/orchestrate.ts:340,397,633` — CLI spawn entry points.
