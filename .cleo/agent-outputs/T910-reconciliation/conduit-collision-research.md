# CONDUIT Domain Collision Research

**Task**: T910 Orchestration Coherence v4 — CONDUIT registration audit
**Date**: 2026-04-17
**Author**: cleo-prime research subagent
**Status**: EVIDENCE-COMPLETE

---

## Executive Summary

- **Current state**: CONDUIT is not a dispatch domain. Its 5 ops live under `orchestrate` as `orchestrate.conduit.{status,peek,start,stop,send}`. `CANONICAL_DOMAINS` in `packages/cleo/src/dispatch/types.ts:46-61` lists **14 domains** (none named `conduit`).
- **ADR-042 verdict**: The 2026-04-10 ADR deliberately folded `conduit` into `orchestrate` to preserve a then-existing "exactly 10 canonical domains" invariant (ADR-042 Decision 1, `/mnt/projects/cleocode/.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md:107-113`). That invariant no longer holds — the current count is **14**, already 40% past the original ceiling.
- **Spec concurs with ADR-042, not operator**: `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:25,29-34,89` explicitly says "Conduit is a runtime form, not a new domain" and "Conduit does not create an eleventh domain."
- **Operator's model is architecturally defensible**: CONDUIT is the agent-to-agent message bus; ORCHESTRATE is wave planning + spawn-prompt generation. They are semantically disjoint. ADR-042's rejection rationale (rule-of-10, "overlay" classification) has lapsed — the 10-count is already dead and `intelligence`, `docs`, `playbook`, `diagnostics` are all "overlay-ish" but still got promoted.
- **Recommendation: Option A — promote CONDUIT to its own domain** (domain #15). Low-risk, ~7 files to change, handler already exists (`ConduitHandler` at `packages/cleo/src/dispatch/domains/conduit.ts`). Risk: breaks direct `cleo dispatch orchestrate conduit.send` callers (zero found outside `cleo conduit *` CLI which re-dispatches internally).

---

## 1. ADR-042 Quote + Interpretation

### 1.1 The Load-Bearing Quote

From `/mnt/projects/cleocode/.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md:105-113`:

> **Decision 1: Conduit Domain Disposition**
>
> **Decision: Fold conduit's 5 operations into the `orchestrate` domain as `orchestrate.conduit.*`.**
>
> The `conduit` entry in `CANONICAL_DOMAINS` MUST be removed. The `orchestrate` domain MUST absorb the 5 conduit operations under the `conduit.*` sub-namespace. The comment on `CANONICAL_DOMAINS` MUST be corrected to accurately state 10 domains.

### 1.2 Rationale ADR-042 Used (line-numbered)

1. **Constitutional invariant** — the constitution at that date stated "exactly 10 canonical domains" (ADR-042:35-38, 115-119).
2. **Conceptual misclassification** — System Flow Atlas and CANT doc call Conduit a "relay path", not a dispatch domain (ADR-042:62-78).
3. **No unique data store ownership** — ADR-036/ADR-037 gave `conduit.db` to `admin` for backup/migration (ADR-042:128).
4. **Semantic fit** — "agent messaging falls naturally within orchestration" (ADR-042:134).
5. **Precedent concern** — "the same logic would apply to adding Hearth, BRAIN, LOOM… defeating the fixed-count invariant" (ADR-042:147-151).

### 1.3 Superseding Facts ADR-042 Now Contradicts

The ADR itself carries this preamble at line 3-5:

> **Status**: PARTIALLY SUPERSEDED
> **Superseded-By**: T565 (v2026.4.42) — `intelligence` added as the 11th canonical domain. … the canonical count is now **11**.

Further, `types.ts:46-61` (verified today) shows the count is now **14**, not 11:
```ts
export const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus', 'sticky',
  'intelligence', 'diagnostics', 'docs', 'playbook',
] as const;
```

The TSDoc above the array still says "The 14 canonical domain names" (`types.ts:43-45`) — count now matches code, but the ADR-042 Decision 1 rationale (preserve the 10-domain invariant) is fully dead. Four new domains (`intelligence`, `diagnostics`, `docs`, `playbook`) have been promoted since ADR-042, each with similar "overlay/runtime-form" concerns that ADR-042 used to reject `conduit`. The precedent the ADR feared materialized anyway — but not for `conduit`.

### 1.4 Was It Temporary Scaffolding or Architectural Intent?

**Temporary scaffolding.** Evidence:

- `packages/contracts/src/operations/conduit.ts:17-21` (commit `12a8819914ea`, 2026-04-18, one day ago):
  > "Registry note (ADR-042): the dispatcher currently registers these operations under `domain: 'orchestrate'`… The public/HTTP identifier is still `conduit.*` — that is the stable wire-format surface and what these contracts describe."
- Contract file explicitly separates the **wire-format public identity** (`conduit.*`) from the **registry's current internal placement** (`orchestrate.conduit.*`) — acknowledging the internal placement is accidental.
- `packages/cleo/src/dispatch/domains/conduit.ts:1-16` is a full-fledged `ConduitHandler` class (445 lines) that was written BEFORE ADR-042 and NEVER refactored to be an orchestrate sub-module. Its TSDoc still says "Conduit Domain Handler" — not "Orchestrate sub-handler."
- `packages/cleo/src/dispatch/domains/index.ts:14,31,67-68` imports and exports `ConduitHandler` at top level, then an ADR-042 comment explains it's instantiated inside OrchestrateHandler "no standalone domain entry needed." The top-level export serves no current consumer — it exists as a vestige of the pre-042 era.
- `packages/cleo/src/dispatch/domains/orchestrate.ts:49,57-58,294-298,581-587` shows `OrchestrateHandler` owns a `conduitHandler = new ConduitHandler()` singleton and routes 5 case-labels to it. This is a forwarding wrapper, not a semantic merger.

Conclusion: ADR-042 was a **rule-enforcement patch** (preserve the 10-domain count), never a semantic judgement that CONDUIT is-an orchestrate operation. The merger was registry-surface-only; the implementation remained a first-class handler.

---

## 2. Current Topology Map (file:line evidence)

### 2.1 Dispatch Layer

| File | Line(s) | What it shows |
|---|---|---|
| `packages/cleo/src/dispatch/types.ts` | 46-61 | `CANONICAL_DOMAINS` — 14 entries, `'conduit'` absent |
| `packages/cleo/src/dispatch/types.ts` | 43-45 | TSDoc "The 14 canonical domain names" |
| `packages/cleo/src/dispatch/registry.ts` | 4409 | Comment "conduit — agent messaging operations (ADR-042: moved under orchestrate domain)" |
| `packages/cleo/src/dispatch/registry.ts` | 4413, 4431, 4455, 4485, 4496 | 5 entries `domain: 'orchestrate', operation: 'conduit.*'` |
| `packages/cleo/src/dispatch/domains/conduit.ts` | 1-444 | Full `ConduitHandler` class — status, peek, start, stop, send |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 49, 57-58 | `import { ConduitHandler }` + singleton `const conduitHandler = new ConduitHandler()` |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 294-298 | `case 'conduit.status'`, `case 'conduit.peek'` → `conduitHandler.query()` |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 581-587 | `case 'conduit.start'`, `case 'conduit.stop'`, `case 'conduit.send'` → `conduitHandler.mutate()` |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 640-642, 658-661 | `getSupportedOperations()` lists 5 `conduit.*` ops under orchestrate |
| `packages/cleo/src/dispatch/domains/index.ts` | 14, 31, 67-68 | Imports & exports `ConduitHandler`; ADR-042 comment explains no standalone entry |

### 2.2 Core Implementation (`packages/core/src/conduit/`)

| File | LOC | Purpose |
|---|---|---|
| `packages/core/src/conduit/conduit-client.ts` | 128 | High-level client wrapping a `Transport` |
| `packages/core/src/conduit/factory.ts` | 69 | Transport picker (Local > HTTP > SSE) |
| `packages/core/src/conduit/local-transport.ts` | 319 | Reads/writes `conduit.db` (node:sqlite). "No network calls. Works fully offline" (`:5-8`) |
| `packages/core/src/conduit/http-transport.ts` | 202 | REST transport to cloud SignalDock |
| `packages/core/src/conduit/sse-transport.ts` | 382 | Server-Sent-Events transport |
| `packages/core/src/conduit/index.ts` | 15 | Barrel |

### 2.3 Contracts

| File | Lines | Purpose |
|---|---|---|
| `packages/contracts/src/conduit.ts` | 1-80+ | `ConduitMessage`, `ConduitSendOptions`, `ConduitState`, `Transport` — interface contracts |
| `packages/contracts/src/operations/conduit.ts` | 1-187 | Wire-format Params/Results for 5 ops (status, peek, start, stop, send) — authored yesterday as part of T910 |

Commit `12a8819914ea` (2026-04-18): "feat(contracts): add brain/conduit/nexus operation contracts … Completes the domain contract surface per docs/specs/CLEO-API-AUTHORITY.md. BRAIN/CONDUIT/NEXUS had live CLI dispatch operations but no typed contract files."

### 2.4 CLI Commands

| File | Lines | Purpose |
|---|---|---|
| `packages/cleo/src/cli/commands/conduit.ts` | 1-80+ | `cleo conduit {status,peek,start,stop,send}` — 5 citty subcommands |
| (same) | 22-42 | Each command calls `dispatchFromCli('query'\|'mutate', 'orchestrate', 'conduit.*', …)` |
| `packages/cleo/src/cli/commands/__tests__/conduit.test.ts` | — | Tests exist |

### 2.5 Tests & Parity

| File | Lines | Purpose |
|---|---|---|
| `packages/cleo/src/dispatch/__tests__/parity.test.ts` | 36, 817-825 | Asserts "every active registry domain is in `CANONICAL_DOMAINS`" — test is subset, not set-equality, so it won't fail on adding `conduit` |
| `packages/cleo/src/dispatch/__tests__/parity.test.ts` | 817 | Comment "The 10 canonical domains from CANONICAL_DOMAINS" — STALE (count is 14) |

### 2.6 Nexus Pattern (how an "independent" domain is wired) — for comparison

`packages/cleo/src/dispatch/registry.ts` has **22** entries with `domain: 'nexus'`. `packages/cleo/src/dispatch/domains/nexus.ts` is a standalone `NexusHandler`. `createDomainHandlers()` in `domains/index.ts:61` registers `handlers.set('nexus', new NexusHandler())`. This is the pattern CONDUIT should follow.

---

## 3. Semantic Analysis — CONDUIT vs ORCHESTRATE

### 3.1 What CONDUIT actually carries (evidence)

From `packages/core/src/conduit/local-transport.ts:2-12`:
> "LocalTransport — In-process SQLite transport for fully offline agent messaging. Reads and writes messages directly to `conduit.db` via node:sqlite. No network calls. Works fully offline. Messages are stored in the project-local `conduit.db` (ADR-037), keeping agent messaging isolated from the global-identity `signaldock.db`."

From `packages/contracts/src/conduit.ts:20-38` (ConduitMessage):
- `id`, `from` (sender agent id), `content` (text), `tags[]`, `threadId`, `groupId`, `timestamp`, `metadata`

From `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:12-25`:
> "Conduit is CLEO's live agent-to-agent relay path. It is the concrete runtime contract for: message envelope shape, addressing, delivery state, acknowledgement and retry behavior, lease ownership, TypeScript and Rust IPC boundaries."

**Verdict**: CONDUIT is an **agent-to-agent message bus**. It carries messages (text + metadata + threading) between agents, persisted in `conduit.db` or relayed via HTTP/SSE to SignalDock.

### 3.2 What ORCHESTRATE does (evidence)

From `packages/cleo/src/dispatch/registry.ts` operations in `domain: 'orchestrate'` (excluding `conduit.*`):
- `orchestrate.classify` — routes a request to a CANT team/lead/protocol
- `orchestrate.fanout` / `fanout.status` — parallel spawn via `Promise.allSettled`
- `orchestrate.analyze` — wave planning, critical path
- `orchestrate.parallel` — begin/end parallel execution wave
- `orchestrate.handoff` — composite (context.inject → session.end → spawn)
- `orchestrate.tessera.*` — template instantiation for chains
- `orchestrate.ivtr.*` — IVTR harness (T811)
- `orchestrate.approve/reject/pending` — HITL playbook approvals (T935)

**Verdict**: ORCHESTRATE is **wave planning + spawn-prompt generation + HITL gating**. It decides *who* runs *what* in *which order*. It does not transport messages between running agents.

### 3.3 The Semantic Gap

| Concern | ORCHESTRATE | CONDUIT |
|---|---|---|
| Temporality | Pre-execution (plans waves) + post-execution (gate checks) | During execution (live messaging) |
| State | Ephemeral (plans, classifications) | Durable (`conduit.db` messages + ack state) |
| Data store | No primary store | `conduit.db` (ADR-037 SSoT) |
| Audience | Orchestrator decides wave → spawns | Any two agents mid-work |
| Analog | Dispatcher / Traffic cop | Radio channel / Intercom |
| Dependencies | Depends on tasks, sessions | Depends on agent registry + transports |

They share no data, no runtime, and no behavior. Folding one under the other is a classification error driven by a since-dead count rule.

### 3.4 The Spec Wrinkle

`docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:29-39` says explicitly:
> 1. Conduit does not create an eleventh domain.
> …
> 7. Public inspection of Conduit state MUST surface through existing canonical domains, primarily `orchestrate`…

**This spec is dated 2026-03-06** (spec `:5`), written under the pre-ADR-042 10-domain regime. The spec is **drifted** — it assumes an invariant already broken four times over (intelligence, diagnostics, docs, playbook). The operator's directive supersedes both ADR-042 and this spec clause.

---

## 4. Concrete Reconciliation Plan (Option A — Recommended)

**Goal**: Promote `conduit` to domain #15. Restore CONDUIT as an independent dispatch root.

### 4.1 Files to Change (Exhaustive)

#### 4.1.1 Type system (1 file)

- `packages/cleo/src/dispatch/types.ts`
  - Line 44: update TSDoc to "The 15 canonical domain names"
  - Line 46-61: add `'conduit'` to the `CANONICAL_DOMAINS` array (suggest position: after `'nexus'` since both are cross-agent/project coordination)

#### 4.1.2 Registry (1 file)

- `packages/cleo/src/dispatch/registry.ts` (lines 4409-4510 region, 5 operation entries)
  - Line 4409 comment: change from "conduit — agent messaging operations (ADR-042: moved under orchestrate domain)" → "conduit — agent messaging operations (ADR-XXX: promoted to canonical domain per T910)"
  - Lines 4412, 4430, 4454, 4484, 4495 (the 5 `domain:` fields): change `domain: 'orchestrate'` → `domain: 'conduit'`
  - Lines 4413, 4431, 4455, 4485, 4496 (the 5 `operation:` fields): change `operation: 'conduit.XXX'` → `operation: 'XXX'` (drop the `conduit.` prefix; namespace is now implicit in domain)
  - Lines 4414, 4432, 4456, 4486, 4497 (description strings): keep the `conduit.XXX` prefix for human-readability or drop — either is fine

#### 4.1.3 Handler registration (1 file)

- `packages/cleo/src/dispatch/domains/index.ts`
  - Lines 67-68: delete the ADR-042 comment
  - Line 64 region: insert `handlers.set('conduit', new ConduitHandler());`

#### 4.1.4 Orchestrate handler (1 file) — remove forwarders

- `packages/cleo/src/dispatch/domains/orchestrate.ts`
  - Line 49: delete `import { ConduitHandler } from './conduit.js';` (already imported by `index.ts`)
  - Lines 57-58: delete `const conduitHandler = new ConduitHandler();`
  - Lines 294-298: delete `case 'conduit.status':` and `case 'conduit.peek':` query forwarders
  - Lines 581-587: delete `case 'conduit.start'`, `case 'conduit.stop'`, `case 'conduit.send'` mutate forwarders
  - Lines 640-642, 658-661: remove `conduit.status`, `conduit.peek`, `conduit.start`, `conduit.stop`, `conduit.send` from `getSupportedOperations()`

#### 4.1.5 ConduitHandler itself (1 file) — minor

- `packages/cleo/src/dispatch/domains/conduit.ts`
  - No structural change needed — the handler's `query()`/`mutate()` already use operation names `status|peek|start|stop|send` (WITHOUT the `conduit.` prefix) — see lines 29-43 and 59-81. Once registry drops the prefix (step 4.1.2), the handler works as-is.
  - `getSupportedOperations()` at `:96-101` already returns `{ query: ['status','peek'], mutate: ['start','stop','send'] }` — correct shape for a first-class domain.

#### 4.1.6 CLI command (1 file) — update dispatch target

- `packages/cleo/src/cli/commands/conduit.ts` (5 subcommands)
  - All 5 `dispatchFromCli(...)` calls at lines 33-41 (status), 63-74 (peek), etc.: change domain/operation:
    - `'orchestrate', 'conduit.status'` → `'conduit', 'status'`
    - `'orchestrate', 'conduit.peek'` → `'conduit', 'peek'`
    - `'orchestrate', 'conduit.start'` → `'conduit', 'start'`
    - `'orchestrate', 'conduit.stop'` → `'conduit', 'stop'`
    - `'orchestrate', 'conduit.send'` → `'conduit', 'send'`

#### 4.1.7 Contracts — wire-format pointer (1 file) — optional

- `packages/contracts/src/operations/conduit.ts`
  - Lines 17-21: update the "Registry note" paragraph to reflect that `conduit.*` is both the public wire-format AND the internal registry identity (no more split)

### 4.2 Constitution/Spec Updates (2 files)

- `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
  - Line 99-region: add `'conduit'` to the CANONICAL_DOMAINS code block
  - Section 4 domain list: add conduit
  - Section 6.6 (orchestrate): remove the 5 `conduit.*` rows at lines 427-431 and the explanatory paragraph at line 439
  - Add new Section 6.X for conduit domain (5 ops) — note: with operator promoting to canonical, strip the "[experimental]" tag
  - Update total count: currently "214" → "219" (+5 conduit ops count toward canonical total)

- `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md`
  - Line 25: change "Conduit is a runtime form, not a new domain" → "Conduit is CLEO's 15th canonical domain as of T910"
  - Lines 29-34 (Section 2): rewrite constraints. Keep LAFS/A2A constraints; delete "does not create an eleventh domain" and "public inspection MUST surface through orchestrate".
  - Add pointer to the superseding ADR.

### 4.3 New ADR Required

- `.cleo/adrs/ADR-054-conduit-as-canonical-domain.md` (or next available number)
  - Supersedes ADR-042 Decision 1
  - Quote operator directive: "conduit is communication around agents work, must be its own domain"
  - Rationale: (a) the 10-domain invariant ADR-042 protected is already dead (14→15), (b) semantic analysis above, (c) zero-cost migration since handler + core already structured for first-class domain status
  - Implementation sequence (references section 4.1 above)

### 4.4 Tests to Update

- `packages/cleo/src/dispatch/__tests__/parity.test.ts:817` — update comment "10 canonical domains" → "15 canonical domains" (the assertion at :819-824 is a `subset` check and remains valid — no test logic change)
- `packages/cleo/src/dispatch/__tests__/parity.integration.test.ts` — if it references op count, update the +5 delta (NEEDS VERIFICATION: grep showed no `conduit` matches here, but check for total op count assertions)
- `packages/cleo/src/cli/commands/__tests__/conduit.test.ts` — already tests via CLI so it should Just Work after the CLI target change in 4.1.6. Run to confirm.

### 4.5 Skills/Docs That Reference the Current Path

Grep for the forms that need updating:

```
Grep "orchestrate.conduit" — 3 files with matches:
  - packages/cleo/src/cli/commands/conduit.ts (updated in 4.1.6)
  - packages/cleo-os/starter-bundle/CLEOOS-IDENTITY.md
  - packages/adapters/src/providers/shared/conduit-trace-writer.ts

Grep "'orchestrate', 'conduit" — additionally:
  - packages/cleo/src/cli/commands/orchestrate.ts
  - packages/cleo/src/cli/help-renderer.ts
```

Each needs a find-and-replace of `orchestrate.conduit.X` → `conduit.X`.

### 4.6 Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Direct `cleo dispatch orchestrate conduit.send` callers break | Low | No such callers found outside the `cleo conduit *` CLI, which is updated in lockstep |
| HTTP adapter in flight (ADR mentions packages/cleo/src/dispatch/adapters/http.ts) | Medium | Verify with T910 HTTP adapter task owner; since wire format is already `conduit.*`, path `POST /conduit/send` is the natural mapping — this change simplifies that adapter |
| Parity test false positive | None | Current test is subset-check; adding to `CANONICAL_DOMAINS` is strictly additive |
| Drift from CLEO-CONDUIT-PROTOCOL-SPEC.md | Medium | Spec is already drifted (pre-dates ADR-042 supersession); update required anyway |
| Agent skill files referencing `orchestrate.conduit.*` | Low | Grep found 6 files; 1-liner changes each |
| Constitution total op count | Low | Count changes by 0 (same ops, different namespace); only the per-domain tables shift |

### 4.7 Migration Path (suggested sequence)

1. Create ADR-054 with operator-approved rationale
2. Update `types.ts` (add to CANONICAL_DOMAINS), `registry.ts` (rewrite 5 entries), `domains/index.ts` (add handler registration). Tests: parity, registry-derivation should still pass since handler is unchanged.
3. Update `orchestrate.ts` (remove 5 case labels + singleton). Run tests.
4. Update `conduit.ts` CLI command (change dispatch target). Run CLI tests.
5. Grep-replace `orchestrate.conduit` across adapters, skills, CLEOOS-IDENTITY.
6. Update constitution + spec docs.
7. Update `packages/contracts/src/operations/conduit.ts` registry note.
8. Run full `pnpm run build` + `pnpm run test` + `pnpm biome check --write .`.
9. Commit with reference to ADR-054 and T910.

Total LOC changed: ~40 lines across ~10 files. No data migration — same DB, same handler, same wire format. Operator-directed.

---

## 5. Rejected Alternatives

### 5.1 Option B — Keep under orchestrate, rename for clarity

Rejected. This is what ADR-042 did, and it's the state that caused operator to raise this question. Any rename inside `orchestrate.*` just repaints the collision.

### 5.2 Option C — Create a "communication" root domain that umbrellas conduit + sticky + (future) hearth

Rejected. `sticky` is already its own domain (types.ts:56). Adding a meta-domain just shifts the namespace problem up one level. Operator asked for conduit specifically — the minimal change is to restore conduit as a root.

### 5.3 Option D — Do nothing, update skills/docs to explain orchestrate.conduit

Rejected by operator's directive: "CONDUIT is agent-to-agent communication — it should NOT be nested under orchestrate."

---

## 6. Open Questions for HITL

1. **Domain ordering in CANONICAL_DOMAINS array** — operator preference on placement? Suggested: after `nexus` (both cross-agent coordination). Alternative: after `intelligence` (both run-time information flow).
2. **Operation naming** — drop the `conduit.` prefix (pattern: `conduit.status` → `status`, matching nexus/tasks/memory style) OR keep it (`conduit.conduit.status` would be odd; pattern 1 is clearly correct). Recommend: DROP.
3. **Experimental flag lifecycle** — ADR-042 classified all 5 as experimental. With promotion to canonical domain, should they be promoted to canonical tier operations, or stay experimental until Shell 2 of the 4-shell stack ships? Operator call.
4. **CLEO-CONDUIT-PROTOCOL-SPEC.md depth of rewrite** — minimum is Section 2 constraint #1 deletion. Full rewrite is out of scope for T910 but flagged.
5. **Rename of 4-shell Conduit Protocol** — if Conduit becomes domain #15, does the "relay path / runtime form" language in Manifesto/CANT/Flow Atlas still make sense? Minor doc hygiene, not a blocker.
6. **Does `admin` still own `conduit.db` backup/migration** (per ADR-036)? Recommend: YES — data-store ownership is orthogonal to dispatch domain ownership. `nexus` doesn't own its DB either (admin handles `nexus.db` backups).

---

## 7. Summary Verdict

**ADR-042 Decision 1 should be formally superseded.** It was a rule-of-10 patch, not a semantic decision, and the rule it protected is dead (count is now 14). The CONDUIT handler has remained first-class in the code the whole time — only the registry surface masks it. Promoting `conduit` to domain #15 is a ~40-LOC refactor that aligns internal registry with wire-format, CLI structure, Core module structure, and operator mental model. Risk is low; behavior change is zero.

---

## 8. References

- `/mnt/projects/cleocode/.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` (full ADR)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/types.ts:46-61` (CANONICAL_DOMAINS)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/registry.ts:4409-4510` (5 conduit ops)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/conduit.ts` (ConduitHandler)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/orchestrate.ts:49,57-58,294-298,581-587,640-642,658-661` (forwarders)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/index.ts:14,31,67-68` (registration)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/conduit.ts` (CLI surface)
- `/mnt/projects/cleocode/packages/contracts/src/operations/conduit.ts:17-21` (wire-format note)
- `/mnt/projects/cleocode/packages/contracts/src/conduit.ts` (interface contracts)
- `/mnt/projects/cleocode/packages/core/src/conduit/*` (transports: local, http, sse)
- `/mnt/projects/cleocode/docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:12-89` (protocol spec)
- `/mnt/projects/cleocode/docs/specs/CLEO-OPERATION-CONSTITUTION.md:99,404,427-439` (constitution references)
- Commit `86d53a780` "fix(dispatch): fold conduit domain into orchestrate per ADR-042"
- Commit `75e112a9c` "feat(conduit+constitution): wire CONDUIT delivery loop, reconcile 11 domains"
- Commit `12a8819914ea` "feat(contracts): add brain/conduit/nexus operation contracts"
