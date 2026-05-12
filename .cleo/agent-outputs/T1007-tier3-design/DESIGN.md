# T1007 Tier 3 — Governed Execution Pipeline Design

**Status**: Research-stage design. Owner review required before implementation begins.
**Date**: 2026-04-20
**Parent Epic**: T1007 (Sentient Loop Completion)
**Blocking tasks**: T1009, T1010, T1011, T1012
**Depends on**: T991 Wave 1 (write-path guardrails), llmtxt/identity + llmtxt/events (Wave B, shipped)

---

## 0. Executive Summary

Tier 3 enables CLEO to autonomously generate, sandbox-test, and merge code
improvements without human approval of each individual change — but with a
cryptographically anchored kill-switch that makes every change attributable,
verifiable, and reversible to any historical point.

The four tasks in scope form a single interlocking pipeline:

```
T1009 (container)  →  T1010 (signing chain)  →  T1011 (merge ritual)  →  T1012 (revert)
    |                       |                         |                        |
sandbox agent          baseline + events         FF-only + kill-switch    chain walker +
runs inside            Merkle-chained            10-step checkpoint       squashed revert
Docker with            llmtxt/events             worktree cleanup
--network=none         Ed25519 signed            abort-on-fail
```

The design reuses `llmtxt/identity` and `llmtxt/events` primitives shipped in
Wave B (T947) per owner Constraint #4 (zero primitive duplication).

---

## 1. Trust Model

### 1.1 Per-tier trust surface

| Tier | Execution context | Writes to | Trust requirement |
|------|------------------|-----------|-------------------|
| Tier 1 | Host process, daemon | tasks.db (task status only) | CLI + CLEO gate validation |
| Tier 2 | Host process, propose tick | tasks.db (status='proposed' only) | CLI + 3/day rate limiter + owner accept gate |
| Tier 3 | Container (sentient-agent) | Worktree only (RW, isolated) | All of Tier 1+2 PLUS: Ed25519 signed events, externally-anchored baseline, FF-only merge, 10 kill-switch checkpoints, owner-signed revert |

### 1.2 Attacker-adjacent surfaces

The surfaces a hostile actor (or compromised LLM session) could target:

1. **The experiment agent itself** — running inside the sandbox container; all
   writes go to the worktree volume only. Cannot reach `cleocode/` directly.
2. **The `artifacts/` volume** — writable by the container; can be filled with
   fake PASS receipts. Mitigation: the merge ritual re-executes tests on the
   host from the worktree, never trusting container-reported results.
3. **The event chain** — llmtxt/events Merkle structure makes insertion/deletion
   detectable. RFC 3161 daily anchor timestamps make rollback undetectable if
   the anchor predate is violated.
4. **The signing key** — `CLEO_KMS_ADAPTER` selects env/Vault/AWS. The daemon
   process owns the signing capability; the experiment agent never holds the key.
5. **sentient-state.json** — the kill-switch flag. `fs.watch` delivers SIGTERM
   within 2 ticks of any write. Cannot be silently bypassed.
6. **The git history** — FF-only merge + squashed revert ensures straight-line
   history. No merge commits obscure authorship.

### 1.3 The 11 Round 2 Contrarian Attacks and Tier 3 Mitigations

These attacks were identified in T943 Round 2 and T946 security analysis:

| # | Attack | Tier 3 Mitigation |
|---|--------|-------------------|
| 1 | **Sandbox RO mount was theatrical** — agent ran on HOST RW filesystem | T1009: sentient-agent container runs experiment; host worktree mounted RW *inside* the container only; `cleocode/` source remains RO; host repo never directly touched by agent |
| 2 | **Auto-rebase = verify-then-tamper** — if FF fails, auto-rebasing re-runs on modified state | T1011: `git merge --ff-only`; if not fast-forwardable → experiment is **aborted, full stop**. NEVER auto-rebase. NEVER retry merge on drifted main. |
| 3 | **mode-0600 keyfile is NOT production-ready** — prompt-injected agent runs as same OS user, can read the key | T1010: `CLEO_KMS_ADAPTER` abstraction; default to env-var secret (not on-disk); Vault/AWS adapters for production; daemon process owns sign context, not the experiment agent |
| 4 | **receipts.jsonl is locally rewriteable** — `O_APPEND` does not prevent file replacement | T1010: llmtxt/events Merkle chain replaces receipts.jsonl; each event links `parentHash`; tampering breaks chain verification; RFC 3161 daily anchor timestamps resist timeline rollback |
| 5 | **metricsImproved baseline is gameable** — agent could write an artificially slow baseline | T1010: baseline event is written by the daemon on the host (not by the experiment agent), signed with Ed25519 **before** the experiment worktree is created; baseline timestamp must predate worktree creation timestamp (enforced via git reflog check) |
| 6 | **Network-none isolation is absent** — default bridge allows egress from sandbox container | T1009: `sentient-agent` service in docker-compose has `--network=none` default; LLM traffic routes through a pinned HTTP proxy allowlist on the host (llm-gateway sidecar with URL allow-list) |
| 7 | **Container artifacts can be forged** — bogus PASS receipts writable to `artifacts/` volume | T1011: merge ritual runs `pnpm run test` directly on the HOST from the worktree path (never trusts container-produced result text); test-run evidence atom references a fresh host-side JSON report |
| 8 | **Kill-switch mid-experiment limbo** — if kill fires between steps, experiment is in undefined state | T1011: 10 sequential kill-switch checkpoints; on kill at any step, experiment is marked `aborted_by_kill_switch` in llmtxt/events; `git worktree remove --force` cleans state; no limbo left |
| 9 | **Tier 2 picker race** — `status='proposed'` tasks not excluded from Tier 1 worker pickup | Already fixed in T1008: `dependency-check.ts` excludes `proposed` from `orchestrate ready` / `cleo next` |
| 10 | **Receipt chain fork** — two concurrent experiments write branching chain | T1010: per-experiment chain isolation; each experiment starts a new sub-chain with its own `experimentId`; global chain is append-only; concurrent experiments are serialized by the daemon (one experiment at a time per project) |
| 11 | **Owner-impersonation resume** — compromised agent calls `cleo sentient resume` | T1012: `cleo sentient resume` after a `cleo revert` requires an owner-signed attestation (same `ownerPubkeys` allowlist pattern from `cleo bug` severity gating); bare resume is only valid when kill-switch was set by the daemon's own self-pause logic (not by `cleo revert`) |

---

## 2. Container Topology

### 2.1 Docker service layout

Tier 3 introduces a new service alongside the existing test nodes. The
existing `ubuntu`, `alpine`, and `fedora` services remain for **test
validation** (T1011 step 7). A dedicated `sentient-agent` service runs the
LLM experiment agent.

```yaml
# docker-compose.tier3.yml (extends /mnt/projects/cleo-sandbox/docker-compose.yml)

services:
  sentient-agent:
    build:
      context: .
      dockerfile: dockerfiles/sentient-agent.Dockerfile
    image: cleo-sandbox/sentient-agent:local
    container_name: cleo-sandbox-sentient-agent
    hostname: sentient-agent
    networks: []                          # --network=none default
    dns: []
    environment:
      - CLEO_LLM_GATEWAY=http://host-gateway:8765  # host-side proxy, not internet
      - CLEO_EXPERIMENT_ID=${CLEO_EXPERIMENT_ID}
      - CLEO_TASK_ID=${CLEO_TASK_ID}
    volumes:
      - type: bind
        source: /mnt/projects/cleocode                  # source tree
        target: /sandbox-src
        read_only: true
      - type: bind
        source: /mnt/projects/cleo-sandbox/experiments/${CLEO_EXPERIMENT_ID}
        target: /workspace                              # RW worktree
      - type: bind
        source: ./artifacts/${CLEO_EXPERIMENT_ID}       # output only
        target: /sandbox-out
    security_opt:
      - seccomp=./seccomp/sentient-agent-profile.json
    mem_limit: 2g
    cpus: "1.0"
    pids_limit: 256
    ulimits:
      nofile:
        soft: 1024
        hard: 1024
    restart: no                          # experiment is single-shot
    stop_signal: SIGTERM
    stop_grace_period: 10s
```

### 2.2 Volume mount policy

| Volume | Container path | Mode | Owner | Purpose |
|--------|---------------|------|-------|---------|
| `/mnt/projects/cleocode` | `/sandbox-src` | RO | daemon | Reference source (read for context) |
| `/mnt/projects/cleo-sandbox/experiments/<expId>` | `/workspace` | RW | agent | Active git worktree — agent writes patches here |
| `./artifacts/<expId>` | `/sandbox-out` | RW | agent | Test results, metrics JSON, logs |

The agent never writes to `/mnt/projects/cleocode` directly. The worktree
at `/mnt/projects/cleo-sandbox/experiments/<expId>` is created on the HOST
by the daemon before the container starts, and deleted by the daemon after
the merge ritual completes (or aborts).

### 2.3 Network policy

The `sentient-agent` service uses `networks: []` (Docker `--network=none`).
The only permitted network call is to the `llm-gateway` sidecar running on
the host at a fixed port. The gateway allowlist is configured in
`.cleo/sentient.json.llmGatewayAllowlist` and is validated at daemon start.

```
sentient-agent container
  │
  └── (no network by default)
  └── host-gateway port 8765  ← ONLY path for LLM calls
        │
        └── allowlist: [api.anthropic.com, ...]
        └── deny: everything else
```

LLM-gateway sidecar is a lightweight Node HTTP proxy:
`packages/core/src/sentient/llm-gateway.ts` (new file, T1009-S3).

### 2.4 seccomp profile

The seccomp profile at `cleo-sandbox/seccomp/sentient-agent-profile.json`
restricts syscalls to the minimum needed for Node.js + git + pnpm. Key
denials:
- `ptrace` — denied (prevents process inspection)
- `mount` / `umount2` — denied (no remount attacks)
- `setuid` / `setgid` — denied (no privilege escalation)
- `socket` with `AF_INET` / `AF_INET6` — denied (network isolation at
  kernel level; the gateway uses a Unix socket injected via the host)
- `clone` with `CLONE_NEWNET` — denied (no network namespace tricks)

### 2.5 Resource limits

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Memory | 2 GiB | pnpm test suite + Node process |
| CPUs | 1.0 | Prevent starving CI on the same host |
| PIDs | 256 | Prevent fork bombs |
| nofile | 1024 | Prevent fd exhaustion |

### 2.6 SIGTERM delivery mechanics

`fs.watch` on `.cleo/sentient-state.json` (host-side, daemon process) fires
on any write. When `killSwitch` transitions to `true`:

1. Daemon calls `docker stop cleo-sandbox-sentient-agent` (sends SIGTERM to
   PID 1 inside the container, which is the Node entry point).
2. `stop_grace_period: 10s` — if the container has not exited after 10s,
   Docker sends SIGKILL.
3. Daemon records `kind:'abort'` event in llmtxt/events with
   `abortReason:'kill_switch'`.
4. Daemon calls `git worktree remove --force` on the experiment path.

Target: SIGTERM delivered within 2s of the `killSwitch` flag write.
This satisfies T1011 acceptance criterion 3 (2-tick window).

---

## 3. Event Chain

### 3.1 llmtxt/events schema

All events append to the project's llmtxt/events log at
`.cleo/audit/events.jsonl`. Each event has the structure:

```typescript
interface SentientEvent {
  kind: SentientEventKind;
  experimentId: string;       // UUIDv4; links all events for one experiment
  taskId: string;             // The Tier-2 accepted task driving the experiment
  receiptId: string;          // Unique receipt for THIS event
  parentHash: string;         // SHA-256 of previous event bytes (Merkle link)
  timestamp: string;          // ISO-8601 UTC
  sig: string;                // Ed25519 signature over canonical JSON bytes (exc. sig field)
  pub: string;                // Owner public key (hex)
  payload: SentientEventPayload; // Kind-specific data (see below)
}
```

### 3.2 Event kinds

| Kind | Written by | Payload fields | Kill-switch check |
|------|-----------|----------------|-------------------|
| `baseline` | Daemon (host) | `commitSha`, `baselineHash`, `metricsJson`, `worktreeNotCreatedYet: true` | Before experiment start |
| `sandbox.spawn` | Daemon (host) | `experimentId`, `dockerImage`, `worktreePath`, `experimentType` | Step 1 (pre-spawn) |
| `patch.proposed` | Agent (inside container via cleo CLI) | `taskId`, `patchFiles[]`, `patchSummary` | N/A — agent writes; daemon verifies |
| `verify` | Daemon (host) | `gate`, `evidenceAtoms[]`, `passed: boolean` | Steps 3-6 (per gate) |
| `sign` | Daemon (host) | `gates[]`, `allPassed: boolean` | Step 7 (pre-sign) |
| `merge` | Daemon (host) | `commitSha`, `mergeStrategy: 'ff-only'`, `prevHeadSha` | Step 9 (pre-merge), Step 10 (post-merge) |
| `abort` | Daemon (host) | `abortReason`, `abortAtStep: number`, `worktreeCleaned: boolean` | After kill at any step |
| `revert` | Daemon (host, owner-triggered) | `fromReceiptId`, `revertCommitSha`, `revertedRange`, `globalPauseSet: true` | N/A — revert IS the kill action |

### 3.3 Merkle chain linkage

```
event[0]  parentHash = "0000...0000" (genesis sentinel)
   │
   ↓ SHA-256(canonical_json_bytes(event[0]))
event[1]  parentHash = hash(event[0])
   │
   ↓ SHA-256(canonical_json_bytes(event[1]))
event[2]  parentHash = hash(event[1])
   ...
event[N]  parentHash = hash(event[N-1])
```

`verifyHashChain()` from `llmtxt/events` recomputes each link and confirms
every signature. Any insertion, deletion, or mutation of an event breaks the
chain from that point forward.

### 3.4 RFC 3161 daily anchor

Once per UTC day the daemon calls `llmtxt/events.anchorChain()` which POSTs
the current chain HEAD hash to a trusted TSA (e.g., `timestamp.digicert.com`).
The returned `TimeStampToken` is appended as a `kind:'tsa_anchor'` event.

This prevents an attacker with full FS access from backdating events, because
the TSA token proves the chain existed before the anchor timestamp. Any
events claiming to be from before the anchor but not reflected in the anchor's
hash are detectable.

Anchor frequency: daily at 00:00 UTC. Not per-experiment (per-experiment would
be too chatty for a TSA endpoint).

---

## 4. Signing and KMS

### 4.1 Ed25519 via llmtxt/identity

All Tier 3 events are signed using `signRequest()` from `llmtxt/identity`.
The signing context is:

```typescript
const signed = await signRequest(identity, {
  method: 'POST',
  url: 'cleo://sentient/event',
  body: canonicalJsonBytes(eventWithoutSig),
  nonce: cryptoRandomNonce(),
  timestamp: new Date().toISOString(),
});
event.sig = signed.signature;
event.pub = signed.publicKey;
```

No hand-rolled crypto. Zero duplication with llmtxt (owner Constraint #4).

### 4.2 KMS adapter abstraction

The `CLEO_KMS_ADAPTER` environment variable selects the key storage backend:

| Adapter | Value | Key location | When to use |
|---------|-------|-------------|-------------|
| `env` | `env` | `CLEO_SIGNING_SEED` env var (64-char hex) | Development, CI |
| `file` | `file` | `.cleo/keys/sentient.ed25519` (mode 0600) | Single-machine owner use |
| `vault` | `vault` | HashiCorp Vault `transit/` engine | Team/server deployment |
| `aws` | `aws` | AWS KMS (Ed25519 key) | Cloud deployment |

Default: `file` for backward compat with ADR-054. Recommended upgrade path:
`env` → `vault` or `aws` as deployment matures.

The adapter is selected in `packages/core/src/sentient/kms.ts` (new file,
T1010-S1). It wraps `llmtxt/identity`'s `generateIdentity()` and
`signRequest()` with a thin CLEO-specific loader.

### 4.3 Owner pubkey allowlist

`.cleo/config.json` gains an `ownerPubkeys` array (already established for
`cleo bug` severity attestation in ADR-054, T947). Tier 3 reuses this:

```json
{
  "ownerPubkeys": ["hex-encoded-ed25519-pub-1", "hex-encoded-ed25519-pub-2"]
}
```

Events signed by keys NOT in the allowlist are rejected at verification time
with `E_OWNER_ONLY`. This prevents a compromised experiment agent from
publishing events under a generated key.

### 4.4 Signed-baseline-predates-experiment enforcement

The `baseline` event is written by the daemon BEFORE `git worktree add` is
called. The daemon enforces this with a reflog check:

```typescript
// In T1010 implementation
const baselineEvent = await getLatestBaselineEvent(experimentId);
const worktreeCreationTime = await getWorktreeCreationReflogTime(worktreePath);
if (baselineEvent.timestamp >= worktreeCreationTime) {
  throw new Error('E_BASELINE_MUST_PREDATE_EXPERIMENT');
}
```

This closes Round 2 attack #5 (agent writes an artificially slow baseline by
delaying the baseline capture until after the experiment is underway).

---

## 5. Merge Ritual

### 5.1 10-step kill-switch checkpoints

Each step reads `.cleo/sentient-state.json` (cheap, ~1ms file read) and aborts
if `killSwitch === true`. The abort flow is identical at every step: write
`kind:'abort'` event, clean worktree, update experiment state to `aborted`.

```
Step  1: pre-pick        — check kill before selecting task
Step  2: post-pick       — check kill after task selection, before worktree creation
Step  3: pre-spawn       — check kill before container start
Step  4: post-spawn      — check kill after container returns (before evidence collection)
Step  5: pre-verify      — check kill before first cleo verify call
Step  6: post-verify     — check kill after all gates verified green
Step  7: pre-sign        — check kill before signing the event chain
Step  8: post-sign       — check kill after sign, before merge
Step  9: pre-merge       — check kill immediately before git merge --ff-only
Step 10: post-merge      — check kill after successful merge (catch and revert if fires here)
```

### 5.2 FF-only failure handling

```bash
# In T1011 implementation — host-side merge step
git -C /mnt/projects/cleocode fetch experiments/${EXPERIMENT_ID}
git -C /mnt/projects/cleocode merge --ff-only FETCH_HEAD
```

If `git merge --ff-only` exits non-zero:
1. The merge did NOT happen. Nothing to clean on main.
2. Write `kind:'abort'` event with `abortReason:'ff_failed'`.
3. Call `git worktree remove --force /mnt/projects/cleo-sandbox/experiments/<expId>`.
4. Mark experiment `status:'aborted'` in llmtxt/events.
5. The Tier-2 task that prompted the experiment is moved back to `status:'pending'`
   so the owner can decide whether to retry after rebasing.
6. Do NOT auto-rebase. Do NOT retry automatically. This is by design.

Rationale: a FF failure means main advanced since the experiment baseline was
taken. The experiment's tests verified against a now-stale main. Auto-rebasing
would re-run verification on a new baseline that the experiment was never
designed against — that is verify-then-tamper (Round 2 attack #2).

### 5.3 Abort-to-clean-state protocol

After any abort (kill-switch or FF failure):

```
1. Write kind:'abort' event to llmtxt/events (signed)
2. Stop sentient-agent container: docker stop cleo-sandbox-sentient-agent
3. Wait up to 10s for graceful exit, then docker kill
4. Remove worktree: git -C /mnt/projects/cleocode worktree remove --force \
       /mnt/projects/cleo-sandbox/experiments/<expId>
5. Verify worktree is gone (ls check); if not, rm -rf as fallback
6. Update experiment record: patchSentientState with activeExperiment=null
7. If abort was kill-switch triggered: leave killSwitch=true (owner must resume)
8. If abort was FF failure: leave killSwitch=false (daemon may pick next task)
```

### 5.4 Full merge sequence (success path)

```
1.  check kill (step 1 — pre-pick)
2.  pick task via cleo orchestrate ready / cleo next
3.  check kill (step 2 — post-pick)
4.  git worktree add /mnt/projects/cleo-sandbox/experiments/<expId> main
5.  write kind:'baseline' event (daemon, signed, before worktree exists logically)
6.  check kill (step 3 — pre-spawn)
7.  docker compose -f docker-compose.tier3.yml run sentient-agent
8.  check kill (step 4 — post-spawn)
9.  collect artifacts from /mnt/projects/cleo-sandbox/artifacts/<expId>/
10. check kill (step 5 — pre-verify)
11. cleo verify T### --gate implemented --evidence "commit:<sha>;files:..."
12. cleo verify T### --gate testsPassed --evidence "test-run:<artifacts>/vitest.json"
13. cleo verify T### --gate qaPassed --evidence "tool:biome;tool:tsc"
14. cleo verify T### --gate metricsImproved --evidence "metrics-delta:<artifacts>/after.json"
15. (run sandbox tests on ubuntu node — separate from container, reuses existing harness)
16. check kill (step 6 — post-verify)
17. check kill (step 7 — pre-sign)
18. cleo sentient sign <experimentId> —writes kind:'sign' event, signed
19. check kill (step 8 — post-sign)
20. check kill (step 9 — pre-merge)
21. git -C /mnt/projects/cleocode merge --ff-only FETCH_HEAD
    [if non-zero → abort flow §5.2]
22. write kind:'merge' event (signed)
23. check kill (step 10 — post-merge)
    [if kill fires here → cleo revert --from <mergeReceiptId> immediately]
24. cleo complete T###
25. git worktree remove experiments/<expId>
26. cleo memory observe "Tier3 experiment <expId> merged for T###: <summary>"
```

---

## 6. Revert Ritual

### 6.1 cleo revert --from \<receiptId\>

```bash
cleo revert --from <receiptId>
```

This is the owner kill-switch. It is the only safe way to undo a series of
Tier-3 merges.

### 6.2 Chain walker implementation

```typescript
// In T1012 implementation
// 1. Load the receipt event identified by <receiptId> from llmtxt/events
const fromEvent = await getEvent(receiptId);

// 2. Walk forward through the event chain to HEAD, collecting all
//    kind:'merge' events that postdate <receiptId>
const mergeEvents = await queryEvents({
  kinds: ['merge'],
  after: fromEvent.timestamp,
  order: 'asc',
});

// 3. Extract the commit SHAs from each merge event
const commits = mergeEvents.map(e => e.payload.commitSha);
// commits = [sha_A, sha_B, sha_C, ...sha_N]

// 4. Produce the squashed revert
// git revert --no-edit <sha_A>..<sha_N>
// This creates ONE revert commit covering all sentient changes since receiptId
```

### 6.3 Full revert sequence

```
1.  Owner runs: cleo revert --from <receiptId>
2.  Require owner-signed attestation (ownerPubkeys allowlist, same as cleo bug severity)
3.  Walk llmtxt/events chain forward from <receiptId> to HEAD
4.  Collect all kind:'merge' commit SHAs in chronological order
5.  git revert --no-edit <sha_first_after_receipt>..<sha_HEAD>
    (squashed into one commit on main)
6.  git commit -m "Revert(sentient): <receiptId>..HEAD — owner kill switch [$(date)]"
7.  Write kind:'revert' event to llmtxt/events:
    { fromReceiptId: <receiptId>, revertCommitSha: <new-sha>,
      revertedRange: [sha_A..sha_N], globalPauseSet: true }
8.  Set killSwitch=true in sentient-state.json
9.  All tiers (1, 2, 3) pause immediately (kill-switch is checked at every tick)
10. Owner must explicitly run: cleo sentient resume (with owner-signed attestation)
    to restart any tier
```

### 6.4 Why squash is safe here

FF-only merge ensures every sentient commit is a straight-line suffix of main.
There are no merge commits to navigate, no octopus merges to untangle. The
commit range `<sha_A>..<sha_N>` is a clean linear sequence, making
`git revert <range>` trivially conflict-free in the common case.

If a human committed to main between two sentient merges, the range would
include that human commit. In that case, `cleo revert` warns the owner and
outputs the range for manual review before proceeding. It does NOT
automatically revert human commits.

### 6.5 Global-pause flag and resume

After `cleo revert`, `killSwitch=true` is set on all projects sharing the
same sentient daemon (scoped to the project root). `cleo sentient resume`
requires:
- Owner public key signature over a resume attestation payload
- Payload includes `reason` and `afterRevertReceiptId` field linking to the
  revert event

This prevents a compromised agent from calling `cleo sentient resume`
autonomously (Round 2 attack #11).

---

## 7. Wave Plan

### 7.1 Dependency graph

```
T1009-S1: docker-compose.tier3.yml + Dockerfile ──────────────┐
T1009-S2: seccomp profile + resource limits                    │
T1009-S3: llm-gateway sidecar                                  │
T1009-S4: kill-switch → SIGTERM integration test               │
T1009-S5: host-side worktree creation helper                   │
                                                               ↓
T1010-S1: kms.ts (CLEO_KMS_ADAPTER abstraction) ──────────────┐
T1010-S2: baseline capture (daemon-side, pre-worktree) ←──────┤ needs T1009-S5
T1010-S3: llmtxt/events event schema + appendSentientEvent()   │
T1010-S4: metricsImproved gate + metrics-delta evidence atom   │
T1010-S5: verifyHashChain integration + chain-walker util      │
T1010-S6: RFC 3161 daily anchor                                │
                                                               ↓
T1011-S1: 10-step kill-switch checker utility ←────────────────┤ needs T1010-S3
T1011-S2: FF-only merge with abort-on-fail ←───────────────────┤ needs T1010-S3, T1010-S4
T1011-S3: abort-to-clean-state protocol (worktree remove)      │
T1011-S4: full merge ritual orchestrator (10 steps) ←──────────┤ needs T1011-S1, T1011-S2, T1011-S3
T1011-S5: merge ritual integration test (kill at step 6)       │
                                                               ↓
T1012-S1: revert chain walker ←────────────────────────────────┤ needs T1010-S3, T1010-S5
T1012-S2: squashed revert executor                             │
T1012-S3: global-pause + owner-signed resume                   │
T1012-S4: cleo revert CLI command                              │
T1012-S5: revert integration test (back to v2026.4.97)         │
```

### 7.2 Parallel vs serial

**Serial dependencies** (must execute in order):
- T1009 must be complete before T1010-S2 (baseline needs the worktree helper)
- T1010-S1, S2, S3 must be complete before T1011 (merge ritual needs events)
- T1011 must be complete before T1012-S1 (revert walker needs the events T1011 writes)

**Can run in parallel**:
- T1009-S1, S2, S3 can run in parallel (Dockerfile, seccomp, gateway are independent)
- T1009-S4, S5 can run in parallel after S1, S2, S3
- T1010-S1, S3, S4 can run in parallel (KMS adapter, event schema, metrics gate)
- T1010-S2 depends on T1010-S3 and T1009-S5
- T1010-S5, S6 can run in parallel after S3
- T1012-S1, S2, S3 can run in parallel (chain walker, revert executor, pause logic)

**Wave grouping**:
```
Wave 1: T1009-S1, T1009-S2, T1009-S3 (infrastructure — parallel)
Wave 2: T1009-S4, T1009-S5, T1010-S1, T1010-S3, T1010-S4 (parallel after Wave 1)
Wave 3: T1010-S2, T1010-S5, T1010-S6 (chain foundation — needs Wave 2)
Wave 4: T1011-S1, T1011-S2, T1011-S3 (merge ritual pieces — parallel after Wave 3)
Wave 5: T1011-S4, T1011-S5 (merge orchestrator + test — needs Wave 4)
Wave 6: T1012-S1, T1012-S2, T1012-S3 (revert pieces — parallel after Wave 5)
Wave 7: T1012-S4, T1012-S5 (CLI + integration test — needs Wave 6)
```

---

## 8. Subtask Catalog

### T1009 — Agent-in-Container Sandbox Harness

---

**T1009-S1: docker-compose.tier3.yml + sentient-agent Dockerfile**
Parent: T1009 | Size: small | Parallel: yes (Wave 1)
Depends on: none

Write `/mnt/projects/cleo-sandbox/docker-compose.tier3.yml` with
`sentient-agent` service definition (network=none, volume mounts, resource
limits). Write `dockerfiles/sentient-agent.Dockerfile` based on Ubuntu
with Node.js, git, pnpm, and the cleo CLI pre-installed from `/sandbox-src`.

Acceptance criteria:
1. `docker compose -f docker-compose.tier3.yml build sentient-agent` exits 0
2. Service definition includes `networks: []` (network=none)
3. `/sandbox-src` mounted RO; `/workspace` mounted RW; `/sandbox-out` mounted RW
4. `mem_limit: 2g`, `cpus: "1.0"`, `pids_limit: 256` present
5. `stop_signal: SIGTERM`, `stop_grace_period: 10s` present
6. `restart: no` — single-shot experiment container

Files touched:
- `/mnt/projects/cleo-sandbox/docker-compose.tier3.yml` (new)
- `/mnt/projects/cleo-sandbox/dockerfiles/sentient-agent.Dockerfile` (new)

---

**T1009-S2: seccomp profile for sentient-agent**
Parent: T1009 | Size: small | Parallel: yes (Wave 1)
Depends on: none

Write `/mnt/projects/cleo-sandbox/seccomp/sentient-agent-profile.json`
restricting syscalls to the Node.js/git/pnpm minimum. Block `ptrace`,
`mount`, `setuid`, `AF_INET socket`, `CLONE_NEWNET`.

Acceptance criteria:
1. File exists at `cleo-sandbox/seccomp/sentient-agent-profile.json`
2. `ptrace` syscall explicitly denied
3. `socket` with `AF_INET`/`AF_INET6` explicitly denied
4. `mount` and `umount2` explicitly denied
5. Docker can start the container with `security_opt: seccomp=<profile>` — no OCI error
6. `node -e "console.log('hello')"` inside the container exits 0 (basic functionality intact)

Files touched:
- `/mnt/projects/cleo-sandbox/seccomp/sentient-agent-profile.json` (new)

---

**T1009-S3: llm-gateway sidecar**
Parent: T1009 | Size: small | Parallel: yes (Wave 1)
Depends on: none

Write `packages/core/src/sentient/llm-gateway.ts` — a Node HTTP proxy that
runs on the host, listens on port 8765, and forwards requests only to URLs
matching a configurable allowlist (default: `api.anthropic.com`). Requests
not matching the allowlist receive 403.

Acceptance criteria:
1. Module exports `startLlmGateway(port, allowlist)` returning an `http.Server`
2. Requests to allowed hosts are proxied with original headers
3. Requests to non-allowed hosts return HTTP 403 with JSON error body
4. Integration test: start gateway, send request to `api.anthropic.com` → proxied;
   send to `example.com` → 403
5. TSDoc on exported functions
6. `pnpm biome check` and `pnpm tsc --noEmit` pass

Files touched:
- `packages/core/src/sentient/llm-gateway.ts` (new)
- `packages/core/src/sentient/__tests__/llm-gateway.test.ts` (new)

---

**T1009-S4: kill-switch SIGTERM integration test**
Parent: T1009 | Size: small | Parallel: yes (Wave 2)
Depends on: T1009-S1, T1009-S2

Write integration test that: spawns the `sentient-agent` container running a
long-running sleep, writes `killSwitch=true` to `sentient-state.json`, asserts
the container exits within 2s via `docker events` filter.

Acceptance criteria:
1. Test spawns `sentient-agent` container with a sleep-loop entry point
2. Test writes `killSwitch=true` to a temp `sentient-state.json`
3. Container exits within 2000ms of the write (measured wall-clock)
4. Exit code is 143 (SIGTERM) or 137 (SIGKILL fallback), not 0
5. Test passes in CI (no flakiness — use deterministic `docker wait` timeout)
6. Test is in `packages/core/src/sentient/__tests__/sigterm-delivery.test.ts`

Files touched:
- `packages/core/src/sentient/__tests__/sigterm-delivery.test.ts` (new)

---

**T1009-S5: host-side worktree creation helper**
Parent: T1009 | Size: small | Parallel: yes (Wave 2)
Depends on: T1009-S1

Write `packages/core/src/sentient/worktree.ts` exporting:
- `createExperimentWorktree(cleoRoot, experimentsDir, experimentId)` — runs
  `git worktree add <path> main` from `cleoRoot`
- `removeExperimentWorktree(cleoRoot, worktreePath)` — runs
  `git worktree remove --force <path>` with fallback `rm -rf`
- `listExperimentWorktrees(cleoRoot)` — returns active experiment worktrees

Acceptance criteria:
1. `createExperimentWorktree` creates worktree at expected path, exits 0
2. `removeExperimentWorktree` removes worktree cleanly; second call is no-op
3. `listExperimentWorktrees` returns all worktrees whose path starts with
   `<experimentsDir>/`
4. Unit tests for all three exports
5. TSDoc on all exports
6. No shell injection: all git calls use `execFile` with arg arrays, not `exec`

Files touched:
- `packages/core/src/sentient/worktree.ts` (new)
- `packages/core/src/sentient/__tests__/worktree.test.ts` (new)

---

### T1010 — Externally-Anchored Baseline + Signed llmtxt/events Audit

---

**T1010-S1: KMS adapter (CLEO_KMS_ADAPTER)**
Parent: T1010 | Size: small | Parallel: yes (Wave 2)
Depends on: none (uses llmtxt/identity, already installed)

Write `packages/core/src/sentient/kms.ts` implementing the
`CLEO_KMS_ADAPTER` selector. Exports `loadSigningIdentity(projectRoot)` which
returns an `AgentIdentity` from llmtxt/identity using the selected backend.

Acceptance criteria:
1. `env` adapter reads `CLEO_SIGNING_SEED` (64-char hex) and derives identity via `identityFromSeed`
2. `file` adapter reads `.cleo/keys/sentient.ed25519` (mode 0600); refuses if mode ≠ 0600
3. `vault` adapter stub: reads `VAULT_ADDR` + `VAULT_TOKEN`, fetches key material from `transit/` path
4. `aws` adapter stub: reads `AWS_KMS_KEY_ID`, calls AWS KMS `sign` API
5. Missing `CLEO_KMS_ADAPTER` defaults to `file`
6. Unit tests for `env` and `file` adapters; vault/aws stubs have interface-compliance tests

Files touched:
- `packages/core/src/sentient/kms.ts` (new)
- `packages/core/src/sentient/__tests__/kms.test.ts` (new)

---

**T1010-S2: baseline capture (daemon-side, pre-worktree)**
Parent: T1010 | Size: small | Parallel: no (Wave 3)
Depends on: T1010-S3, T1009-S5

Write `packages/core/src/sentient/baseline.ts` exporting
`captureBaseline(projectRoot, commitSha, experimentId)`. This function:
1. Runs `cleo bench --suite all --json` to capture metrics
2. Writes a signed `kind:'baseline'` event to llmtxt/events
3. Asserts that no worktree for this `experimentId` exists yet (enforces predate)

Acceptance criteria:
1. `captureBaseline` writes a `kind:'baseline'` event with `sig` and `pub` fields
2. If a worktree for `experimentId` already exists, throws `E_BASELINE_MUST_PREDATE_EXPERIMENT`
3. The event's `timestamp` field is before the worktree creation time (verified by unit test)
4. `metricsJson` in the baseline event matches the output of `cleo bench --json`
5. Integration test: capture baseline, then create worktree, verify timestamp order
6. TSDoc on exports

Files touched:
- `packages/core/src/sentient/baseline.ts` (new)
- `packages/core/src/sentient/__tests__/baseline.test.ts` (new)

---

**T1010-S3: llmtxt/events schema + appendSentientEvent()**
Parent: T1010 | Size: small | Parallel: yes (Wave 2)
Depends on: none (uses llmtxt/events, already installed)

Write `packages/core/src/sentient/events.ts` defining:
- The `SentientEvent` TypeScript type (all 8 kinds)
- `appendSentientEvent(projectRoot, identity, event)` — signs and appends via `llmtxt/events`
- `querySentientEvents(projectRoot, filter)` — queries the event log

Acceptance criteria:
1. All 8 event kinds are typed: baseline, sandbox.spawn, patch.proposed, verify, sign, merge, abort, revert
2. `appendSentientEvent` signs with KMS identity before calling `llmtxt/events.appendEvent`
3. `querySentientEvents` returns events filtered by `kind`, `experimentId`, `after` timestamp
4. Unit tests verify event shape for each kind
5. TSDoc on all exports
6. `pnpm biome check` and `pnpm tsc --noEmit` pass

Files touched:
- `packages/core/src/sentient/events.ts` (new)
- `packages/core/src/sentient/__tests__/events.test.ts` (new)

---

**T1010-S4: metricsImproved gate + metrics-delta evidence atom**
Parent: T1010 | Size: small | Parallel: yes (Wave 2)
Depends on: none (extends ADR-051 gate system)

Extend `packages/core/src/` to add:
- `metricsImproved` as a new `VerificationGate` enum value
- `metrics-delta:<path>` as a new `EvidenceAtom` kind
- Validator: loads `baseline.json` and `after.json`, asserts
  `after.primary < baseline.primary * 0.99` and all secondaries within 1%

Acceptance criteria:
1. `metricsImproved` appears in the `VerificationGate` union type
2. `metrics-delta:<path>` is parsed as a valid `EvidenceAtom`
3. Validator rejects if `after.primary >= baseline.primary` (no improvement)
4. Validator rejects if any secondary metric worsens by >1%
5. Integration test: gaming attempt (deliberately slow baseline file) → validator rejects
6. `cleo verify T### --gate metricsImproved --evidence "metrics-delta:after.json"` exits 0 on valid input

Files touched:
- `packages/core/src/` — gate types and validator (2-3 files, extend existing)
- `packages/core/src/__tests__/metrics-improved.test.ts` (new)

---

**T1010-S5: verifyHashChain integration + chain-walker utility**
Parent: T1010 | Size: small | Parallel: yes (Wave 3)
Depends on: T1010-S3

Write `packages/core/src/sentient/chain-walker.ts` exporting:
- `verifyEventChain(projectRoot)` — calls `llmtxt/events.verifyHashChain()`,
  returns `{ total, verified, broken, firstBrokenAt }`
- `walkChainFrom(projectRoot, receiptId)` — returns all events from `receiptId`
  forward to HEAD (used by T1012)

Acceptance criteria:
1. `verifyEventChain` returns `{ broken: 0 }` on an intact chain
2. `verifyEventChain` returns `{ broken: N, firstBrokenAt: <eventId> }` when
   an event is mutated (test by directly modifying a temp event file)
3. `walkChainFrom` returns events in chronological order
4. `walkChainFrom` with a non-existent `receiptId` throws `E_RECEIPT_NOT_FOUND`
5. Unit tests for both exports
6. TSDoc on all exports

Files touched:
- `packages/core/src/sentient/chain-walker.ts` (new)
- `packages/core/src/sentient/__tests__/chain-walker.test.ts` (new)

---

**T1010-S6: RFC 3161 daily anchor**
Parent: T1010 | Size: small | Parallel: yes (Wave 3)
Depends on: T1010-S3

Write `packages/core/src/sentient/tsa-anchor.ts` exporting
`anchorChainDaily(projectRoot)`. Runs once per UTC day from the daemon tick.
Posts chain HEAD hash to configurable TSA endpoint (default:
`http://timestamp.digicert.com`). Appends `kind:'tsa_anchor'` event with the
`TimeStampToken` bytes (base64).

Acceptance criteria:
1. `anchorChainDaily` is a no-op if last anchor was < 24h ago
2. TSA request uses correct RFC 3161 `TimeStampReq` structure
3. Returns token written to events log on success
4. On TSA failure (network error), logs warning and continues — does NOT block the daemon
5. Configurable TSA URL via `.cleo/sentient.json.tsaEndpoint`
6. Unit test with mocked TSA endpoint validates request format

Files touched:
- `packages/core/src/sentient/tsa-anchor.ts` (new)
- `packages/core/src/sentient/__tests__/tsa-anchor.test.ts` (new)

---

### T1011 — FF-Only Merge with Abort-on-Fail + Per-Step Kill-Switch Re-Check

---

**T1011-S1: 10-step kill-switch checker utility**
Parent: T1011 | Size: small | Parallel: yes (Wave 4)
Depends on: T1010-S3 (needs events to write abort record)

Write `packages/core/src/sentient/kill-check.ts` exporting
`checkKillSwitch(statePath, step, abortCtx)`. Reads `sentient-state.json`;
if `killSwitch=true`, writes `kind:'abort'` event and throws `KillSwitchError`.
`KillSwitchError` includes `step` and `abortCtx.experimentId`.

Acceptance criteria:
1. Returns normally (no error) when `killSwitch=false`
2. Throws `KillSwitchError` with correct `step` field when `killSwitch=true`
3. Before throwing, writes signed `kind:'abort'` event to llmtxt/events
4. Abort event has `abortAtStep: <step>` in payload
5. Unit tests for kill=false (no-op) and kill=true (throws + event written)
6. TSDoc on export

Files touched:
- `packages/core/src/sentient/kill-check.ts` (new)
- `packages/core/src/sentient/__tests__/kill-check.test.ts` (new)

---

**T1011-S2: FF-only merge with abort-on-fail**
Parent: T1011 | Size: small | Parallel: yes (Wave 4)
Depends on: T1010-S3 (events), T1009-S5 (worktree)

Write `packages/core/src/sentient/merge.ts` exporting
`mergeExperimentFfOnly(cleoRoot, experimentId, worktreePath)`. Runs
`git merge --ff-only`; on failure writes `kind:'abort'` event,
removes worktree, returns `{ success: false, reason: 'ff_failed' }`.

Acceptance criteria:
1. On FF success: returns `{ success: true, commitSha: <sha> }`
2. On FF failure: writes `kind:'abort'` event with `abortReason:'ff_failed'`
3. On FF failure: calls `removeExperimentWorktree()` (T1009-S5)
4. NEVER calls `git rebase` or any other conflict-resolution strategy
5. Unit test with a git repo where FF is impossible (diverged branch)
6. Commit message on merge includes `Sentient(T###): <summary> [exp:<expId>]`

Files touched:
- `packages/core/src/sentient/merge.ts` (new)
- `packages/core/src/sentient/__tests__/merge.test.ts` (new)

---

**T1011-S3: abort-to-clean-state protocol**
Parent: T1011 | Size: small | Parallel: yes (Wave 4)
Depends on: T1009-S1 (docker), T1009-S5 (worktree)

Write `packages/core/src/sentient/abort.ts` exporting
`abortExperiment(abortCtx)`. Orchestrates the full clean-state sequence:
stop container → write abort event → remove worktree → patch state file.

Acceptance criteria:
1. `docker stop cleo-sandbox-sentient-agent` is called (or skipped if container not running)
2. Abort event is written to llmtxt/events with `worktreeCleaned: boolean`
3. Worktree is removed via `removeExperimentWorktree` (T1009-S5)
4. `sentient-state.json` updated: `activeExperiment=null`
5. If `abortReason` is `kill_switch`, `killSwitch` is left `true` in state
6. If `abortReason` is `ff_failed`, `killSwitch` is left `false` in state

Files touched:
- `packages/core/src/sentient/abort.ts` (new)
- `packages/core/src/sentient/__tests__/abort.test.ts` (new)

---

**T1011-S4: full merge ritual orchestrator**
Parent: T1011 | Size: medium | Parallel: no (Wave 5)
Depends on: T1011-S1, T1011-S2, T1011-S3

Write `packages/core/src/sentient/experiment-runner.ts` exporting
`runExperiment(projectRoot, taskId, experimentType)`. Orchestrates all 10
steps in sequence, calling `checkKillSwitch` at each checkpoint.

Acceptance criteria:
1. Implements all 10 kill-switch checkpoint steps in order
2. On kill at any step: calls `abortExperiment` and exits cleanly
3. On FF failure at step 21: calls abort flow, returns `{ success: false }`
4. On success: returns `{ success: true, mergeReceiptId: <id> }`
5. TSDoc enumerates all 10 checkpoints with step number comments in code
6. `pnpm biome check` and `pnpm tsc --noEmit` pass

Files touched:
- `packages/core/src/sentient/experiment-runner.ts` (new)

---

**T1011-S5: merge ritual integration test (kill at step 6)**
Parent: T1011 | Size: small | Parallel: no (Wave 5)
Depends on: T1011-S4

Write integration test that runs a full mock experiment and injects a
kill-switch at step 6 (post-verify, pre-sign). Assert merge did NOT happen
and worktree was cleaned.

Acceptance criteria:
1. Mock experiment runner uses a real temp git repo (not mocked git)
2. Kill-switch is injected by writing `killSwitch=true` to state file in
   a separate thread while the experiment is running
3. Test asserts merge commit does NOT appear in git log
4. Test asserts worktree path does NOT exist after abort
5. Test asserts `kind:'abort'` event with `abortAtStep:6` in llmtxt/events
6. Test runs in < 30s (use minimal git operations, no Docker)

Files touched:
- `packages/core/src/sentient/__tests__/experiment-runner.test.ts` (new)

---

### T1012 — cleo revert --from \<receiptId\>

---

**T1012-S1: revert chain walker**
Parent: T1012 | Size: small | Parallel: yes (Wave 6)
Depends on: T1010-S3 (events), T1010-S5 (chain walker)

Write `packages/core/src/sentient/revert-walker.ts` exporting
`collectMergeCommits(projectRoot, fromReceiptId)`. Uses `walkChainFrom`
(T1010-S5) to find all `kind:'merge'` events after the given receipt.
Returns `{ commits: string[], events: SentientEvent[] }`.

Acceptance criteria:
1. Returns commits in chronological order (oldest first)
2. Skips non-merge events (baseline, verify, abort, etc.)
3. Throws `E_RECEIPT_NOT_FOUND` if `fromReceiptId` not in chain
4. Warns (does not abort) if a human commit appears in the range
5. Unit tests with synthetic event chains: 3 merges, 2 non-merges
6. TSDoc on export

Files touched:
- `packages/core/src/sentient/revert-walker.ts` (new)
- `packages/core/src/sentient/__tests__/revert-walker.test.ts` (new)

---

**T1012-S2: squashed revert executor**
Parent: T1012 | Size: small | Parallel: yes (Wave 6)
Depends on: T1012-S1 (needs commit list)

Write `packages/core/src/sentient/revert-executor.ts` exporting
`executeSquashedRevert(cleoRoot, commits, fromReceiptId)`. Runs
`git revert --no-edit <sha_first>..<sha_last>` and returns the new
revert commit SHA. Writes `kind:'revert'` event.

Acceptance criteria:
1. Produces a single squash revert commit on main
2. Commit message format: `Revert(sentient): <receiptId>..HEAD — owner kill switch`
3. Writes `kind:'revert'` event with `revertCommitSha`, `revertedRange`, `globalPauseSet:true`
4. If range includes a human commit: outputs warning to stderr and requires `--include-human` flag
5. Unit test with real temp git repo containing 3 sentient commits
6. Test verifies post-revert HEAD is before the first reverted commit's parent

Files touched:
- `packages/core/src/sentient/revert-executor.ts` (new)
- `packages/core/src/sentient/__tests__/revert-executor.test.ts` (new)

---

**T1012-S3: global-pause + owner-signed resume**
Parent: T1012 | Size: small | Parallel: yes (Wave 6)
Depends on: T1010-S1 (KMS for owner sig verification)

Extend `packages/core/src/sentient/state.ts` to add:
- `pausedByRevert: boolean` field to `SentientState`
- `pauseAllTiers(statePath, revertReceiptId)` — sets `killSwitch=true` + `pausedByRevert=true`
- `resumeAfterRevert(statePath, ownerSignedAttestation)` — verifies attestation
  against `ownerPubkeys`, clears both flags if valid

Acceptance criteria:
1. `pauseAllTiers` sets `killSwitch=true` and `pausedByRevert=true` atomically
2. `resumeAfterRevert` rejects if attestation signature not in `ownerPubkeys`
3. `resumeAfterRevert` rejects if attestation `afterRevertReceiptId` field is missing
4. `resumeAfterRevert` clears both flags on valid attestation
5. Bare `cleo sentient resume` (without attestation) fails with `E_OWNER_ATTESTATION_REQUIRED`
   when `pausedByRevert=true`
6. Unit tests for pause and resume flows

Files touched:
- `packages/core/src/sentient/state.ts` (extend — add 2 fields + 2 functions)
- `packages/core/src/sentient/__tests__/state-pause.test.ts` (new)

---

**T1012-S4: cleo revert CLI command**
Parent: T1012 | Size: small | Parallel: no (Wave 7)
Depends on: T1012-S1, T1012-S2, T1012-S3

Add `cleo revert --from <receiptId>` subcommand to
`packages/cleo/src/cli/commands/sentient.ts`. The command:
1. Requires `--from <receiptId>` argument
2. Prompts for owner attestation (or reads from `--attestation-file`)
3. Calls `collectMergeCommits`, `executeSquashedRevert`, `pauseAllTiers`
4. Prints summary of reverted commits

Acceptance criteria:
1. `cleo revert --from <receiptId>` is a valid CLI invocation
2. Without `--from` flag, exits with usage error
3. Owner attestation validated before revert executes
4. `--dry-run` flag prints commits that would be reverted without executing
5. JSON output (`--json`) includes `revertCommitSha`, `revertedRange`, `eventsReverted`
6. `cleo help revert` shows correct description

Files touched:
- `packages/cleo/src/cli/commands/sentient.ts` (extend — add revert subcommand)
- `packages/cleo/src/dispatch/domains/sentient.ts` (extend — add revert operation)

---

**T1012-S5: revert integration test (back to v2026.4.97)**
Parent: T1012 | Size: small | Parallel: no (Wave 7)
Depends on: T1012-S4

Write integration test that:
1. Creates a temp git repo with 3 synthetic sentient merge commits
2. Writes corresponding `kind:'merge'` events to llmtxt/events
3. Runs `cleo revert --from <first-merge-receiptId>` (with owner attestation)
4. Verifies all 3 commits reverted in a single squash commit
5. Verifies `killSwitch=true` and `pausedByRevert=true` in state

Acceptance criteria:
1. All 3 sentient commits are reverted (HEAD regresses to pre-first-merge SHA)
2. Exactly one new revert commit is created (squash, not individual reverts)
3. `killSwitch=true` in sentient-state.json after revert
4. `kind:'revert'` event exists in llmtxt/events with correct fields
5. `cleo sentient resume` (bare) fails with `E_OWNER_ATTESTATION_REQUIRED`
6. Test runs in < 30s

Files touched:
- `packages/core/src/sentient/__tests__/revert-integration.test.ts` (new)

---

## 9. Test Plan

### 9.1 Attack vector coverage

| Attack | Test location | Assertion |
|--------|--------------|-----------|
| Prompt-injected write to main repo | T1009-S4 (SIGTERM test) | Container with network=none + RO mount cannot write to `/mnt/projects/cleocode` |
| Baseline gaming | T1010-S2 (baseline test) | `E_BASELINE_MUST_PREDATE_EXPERIMENT` when baseline written after worktree creation |
| Kill-switch bypass | T1011-S5 (kill at step 6) | Merge does NOT happen; worktree cleaned |
| Receipt chain fork | T1010-S5 (chain walker test) | Mutated event breaks `verifyHashChain()` |
| Fake container PASS receipt | T1011-S2 (merge test) | Merge ritual runs tests from HOST worktree, not container artifacts |
| Compromised agent calls resume | T1012-S3 (pause/resume test) | Bare resume fails when `pausedByRevert=true` |
| Auto-rebase on FF failure | T1011-S2 (FF failure test) | `git rebase` is NEVER called; abort event written |
| Agent holds signing key | T1010-S1 (KMS test) | `signRequest` called in daemon process context only; container process never loads KMS |

### 9.2 Integration test matrix

| Test | What it validates |
|------|------------------|
| `sigterm-delivery.test.ts` | T1009: container exits within 2s of kill-switch write |
| `baseline.test.ts` | T1010: predate enforcement + event signing |
| `chain-walker.test.ts` | T1010: Merkle chain integrity detection |
| `kill-check.test.ts` | T1011: checkpoint throws + writes abort event |
| `experiment-runner.test.ts` | T1011: full 10-step flow with kill injection at step 6 |
| `revert-walker.test.ts` | T1012: commit collection from chain |
| `revert-executor.test.ts` | T1012: squash revert on temp git repo |
| `revert-integration.test.ts` | T1012: end-to-end revert from v2026.4.97-equivalent |

---

## 10. Rollback Plan

If Tier 3 misbehaves in production:

**Immediate**: `cleo sentient stop` — flips `killSwitch=true`, sends SIGTERM to
daemon, stops all tiers within seconds.

**Undo last merge**: `cleo revert --from <last-known-good-receiptId>` — squashes
all sentient merges since the good point into a single revert commit.

**Disable Tier 3 entirely** (without removing code): set `tier3Enabled: false`
in `.cleo/sentient.json` (planned config field for T1011-S4). Tier 1 and Tier 2
continue operating. Tier 3 experiments are never started.

**Full fallback to Tier 1 only**: `cleo sentient propose disable` disables Tier 2
as well. Daemon continues executing existing tasks (Tier 1) only. This is the
minimum safe mode.

**Remove all sentient automation**: `cleo sentient stop` + edit crontab to remove
daemon invocation. Database is unaffected. All history is preserved in
llmtxt/events for forensics.

**Data safety**: llmtxt/events log is append-only. Even if Tier 3 is fully
removed, the event history remains readable for audit. No data is lost by
disabling Tier 3.

---

## 11. Open Questions for Owner Decision

| # | Question | Options | Impact |
|---|----------|---------|--------|
| 1 | Default `CLEO_KMS_ADAPTER` for fresh installs? | `file` (simpler) vs `env` (more secure) | T1010-S1 default |
| 2 | Metrics baseline command: implement `cleo bench` now or use alternative? | Implement `cleo bench --suite all --json` | T1010-S2, T1010-S4 |
| 3 | TSA endpoint: paid/premium vs free tier? | Digicert (paid, reliable) vs FreeTSA.org (free, rate-limited) | T1010-S6 daily anchor |
| 4 | Human-commit warning in revert range: hard block or soft warning? | `--include-human` flag requirement (safe) vs auto-include with warning | T1012-S2 |
| 5 | `tier3Enabled` config field: add to `sentient.json` now or gate on T1011-S4? | Add as part of T1011-S4 | Feature flag consistency |
| 6 | Sandbox test nodes required for merge ritual: ubuntu only or ubuntu+alpine? | T1009 acceptance says ubuntu mandatory, alpine SHOULD | T1011-S4 step 15 |

---

## Appendix A: File Map

All new files are in:
- `packages/core/src/sentient/` — all new modules
- `packages/core/src/sentient/__tests__/` — all new tests
- `packages/cleo/src/cli/commands/sentient.ts` — CLI extensions (revert)
- `packages/cleo/src/dispatch/domains/sentient.ts` — dispatch extensions
- `/mnt/projects/cleo-sandbox/` — Docker and infrastructure files

No files outside these directories are modified by Tier 3 implementation.
ADR-051 is extended (not replaced) via additive gate and evidence types.
`sentient-state.ts` is extended with 2 new fields (backward-compatible).
