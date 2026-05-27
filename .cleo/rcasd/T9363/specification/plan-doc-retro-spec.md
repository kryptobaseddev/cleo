# Plan-Doc Retro: Phase 4 Planned vs As-Shipped Filename Mapping

> **Spec ID**: T9363-retro
> **Task**: T9363
> **Status**: Specification
> **Date**: 2026-05-16
> **Epic**: T9354 (T9261 closure)
> **ADR**: ADR-072 (see annotation addendum below)

---

## Purpose

This document records the divergence between filenames specified in
`docs/plans/T-LLM-CRED-CENTRALIZATION.md` Phase 4 (Waves W0b, W0c, W2) and the
filenames that were actually shipped during the Phase 4 implementation session
(v2026.5.67–v2026.5.68). All future audit tooling MUST consult this retro
before flagging "missing" files from the plan.

---

## Mapping: Planned → As-Shipped

### contracts/src/llm/ — W0b Contract Types (T9281)

| Planned Filename | As-Shipped Filename | Disposition |
|-----------------|---------------------|-------------|
| `credential.ts` | `resolved-credential.ts` | **Renamed** (see §Reasons) |
| `transport.ts` | `normalized-response.ts` | **Renamed** (LlmTransport lives here + NormalizedResponse) |
| `session.ts` | `interfaces.ts` | **Collapsed** into combined interfaces file |
| `executor.ts` | `interfaces.ts` | **Collapsed** into combined interfaces file |
| `normalized-message.ts` (W0c) | `interfaces.ts` (inline types) | **Absorbed** — NormalizedMessage-equivalent lives as `TransportMessage` in `normalized-response.ts`; delta types in `interfaces.ts` |
| *(new)* | `provider-id.ts` | **Added** — ProviderId / ApiMode / BuiltinProviderId union type |
| *(new)* | `provider-profile.ts` | **Added** — ProviderProfile hooks interface |
| *(new)* | `failover-reason.ts` | **Added** — ClassifiedError / FailoverReason |
| *(new)* | `oauth.ts` | **Added** — OAuth PKCE flow types |
| *(new)* | `plugin-llm.ts` | **Added** — Plugin facade types |

**Summary**: The plan called for 5 separate files (`credential.ts`, `transport.ts`,
`session.ts`, `executor.ts`, `normalized-message.ts`). The implementation produced
3 core files (`resolved-credential.ts`, `normalized-response.ts`, `interfaces.ts`)
plus 5 additional files that were not in the plan.

### core/src/llm/ — W2 Session + Executor (T9284 plan → T9287/T9288/T9290/T9291 actual)

| Planned Filename | As-Shipped Filename | Task | Disposition |
|-----------------|---------------------|------|-------------|
| `default-session.ts` | `concrete-session.ts` | T9287 | **Renamed** (see §Reasons) |
| `default-executor.ts` | `concrete-executor.ts` | T9290 | **Renamed** (see §Reasons) |
| *(implicit singleton)* | `executor-factory.ts` | T9291 | **Split out** — singleton + factory extracted to own file |
| *(implicit)* | `session-factory.ts` | T9288 | **Split out** — `LlmSessionFactory` implementation extracted |

### core/src/llm/ — W0c NormalizedMessage helper (T9282 plan)

| Planned Filename | As-Shipped Disposition |
|-----------------|------------------------|
| `normalized-message-utils.ts` (new) | **Never created** — conversion helpers were inlined into the individual transport files (`anthropic.ts`, `gemini.ts`, `chat-completions.ts`) rather than centralized. A `message-utils.ts` was later created for token-count estimation only (T9289/DRY cleanup) and does NOT perform message format conversion. |

### Phase 1 — contracts/src/llm/ (pre-W0b)

| Planned Filename | As-Shipped Filename | Context |
|-----------------|---------------------|---------|
| `packages/contracts/src/llm/credential.ts` (Phase 1 plan) | `packages/contracts/src/llm/resolved-credential.ts` | The Phase 1 plan specified `credential.ts` to hold `ResolvedCredential`. This file was **never created with that name**. When W0b (T9281) created the type, the implementer chose `resolved-credential.ts` to be unambiguous (the file holds the *resolved* credential, not a credential input). |

---

## Reasons for Divergence

All divergences occurred during the same Phase 4 implementation session
(2026-05-14 to 2026-05-15). No explicit decision record was filed at the time.
The rationale is reconstructed from commit messages:

### 1. `credential.ts` → `resolved-credential.ts`

The plan file `T-LLM-CRED-CENTRALIZATION.md` §Phase 1 described the file as
holding the `ResolvedCredential` type. The implementer named the file
`resolved-credential.ts` (matching the type name) to avoid ambiguity with any
potential future `credential.ts` that might hold credential *input* shapes
(e.g., `CredentialInput`, `StoredCredential`). The distinction is intentional:
`resolved-credential.ts` clearly signals "output of the resolution chain."

Commit: `428414a85` (T9281)

### 2. `transport.ts` → `normalized-response.ts` (and pre-dates W0b)

`LlmTransport` was defined in `normalized-response.ts` before W0b, as part
of T9263 (Phase 3 port of Hermes `agent/transports/types.py`). The T9263
implementer placed `LlmTransport` alongside `NormalizedResponse` in a single
file because the two types are tightly coupled at the wire level. By the time
W0b ran, moving `LlmTransport` to a separate `transport.ts` would have required
breaking all T9263 consumers. The implementer kept the established filename.

Commit: `9faf9f36d` (T9263, pre-ADR-072)

### 3. `session.ts` + `executor.ts` → `interfaces.ts`

The W0b implementer (T9281) chose a single `interfaces.ts` because:
- `LlmSession` and `LlmExecutor` are co-dependent (the executor holds a session
  factory; the session requires the transport from the executor context). Splitting
  into two files would create cross-imports immediately.
- The single file makes it trivial to import the full three-interface stack with
  one path: `import { LlmSession, LlmExecutor } from '@cleocode/contracts/llm/interfaces.js'`.
- Following the Hermes `agent/transports/types.py` precedent of keeping related
  interfaces in one module.

Commit: `428414a85` (T9281)

### 4. `normalized-message.ts` + `normalized-message-utils.ts` — never created

The W0c plan called for a standalone `normalized-message.ts` in contracts and
a `normalized-message-utils.ts` in core. Neither was created because:

- The `NormalizedMessage` concept from the plan was implemented as two distinct
  types during implementation: `TransportMessage` (the wire-level message in
  `normalized-response.ts`) and `NormalizedDelta` (the streaming delta in
  `interfaces.ts`). These reflect a deliberate design split between the
  non-streaming request message format and the streaming response delta format.
- The conversion utilities (Anthropic → normalized, OpenAI → normalized, etc.)
  were inlined into each transport file's `complete()` and `stream()` methods
  because they require provider-specific knowledge that makes centralization
  awkward. A central `normalized-message-utils.ts` would have needed to import
  from provider-specific SDK types, violating the transport isolation principle.
- W0c (commit `8cdf10f79`) focused on extending `LlmTransport` with `stream()` +
  `apiMode` rather than adding conversion utilities. The utilities were considered
  an implementation detail of each transport, not a shared contract.

**This planned file is officially superseded.** The conversion logic lives inline
in each transport implementation (anthropic.ts, gemini.ts, openai.ts, chat-completions.ts).

### 5. `default-session.ts` → `concrete-session.ts` and `default-executor.ts` → `concrete-executor.ts`

The plan used `DefaultLlmSession` / `DefaultLlmExecutor` following the Java/Gang-of-Four
"Default*" convention for concrete implementations of interfaces. The implementer
chose `Concrete*` names for two reasons visible in the commit messages:
- "Default" implies "one of many, used when no other is specified" — but the intent
  is that these ARE the only concrete implementations (not a fallback among options).
- "Concrete" is the DDD / hexagonal-architecture naming convention that more clearly
  signals "this is the non-abstract thing that implements the interface."
- The class names in the files are `ConcreteSession` and `ConcreteExecutor`
  (not `DefaultLlmSession` / `DefaultLlmExecutor`), so the filenames match the class names.

Commits: `89313ea0c` (T9287 ConcreteSession), `df370d2b7` (T9290 ConcreteExecutor)

### 6. `executor-factory.ts` and `session-factory.ts` — split from planned monolith

The plan described `DefaultLlmExecutor` as a "singleton factory" in a single file.
The implementer split this into:
- `session-factory.ts` — `DefaultLlmSessionFactory` implementing `LlmSessionFactory`
  (T9288, W2b) — bridges `resolveLLMForRole` to `ConcreteSession` via transport routing.
- `executor-factory.ts` — `getLlmExecutor` singleton + `ExecutorFactory` (T9291, W3b) —
  per-process singleton with optional `ContextEngine` wiring.

This split follows SRP: the session factory handles per-role transport routing; the
executor factory handles the singleton lifecycle and context-engine wiring. The plan
lumped these into one file for simplicity; the implementation recognized they have
different change reasons.

---

## Impact on ADR-072

ADR-072 §Implementation notes for W0b lists:

```
packages/contracts/src/llm/
  transport.ts
  session.ts
  executor.ts
  normalized-message.ts
  index.ts
```

**None of these filenames exist as written.** The ADR-072 section contains the PLANNED
names. The as-shipped names are:

```
packages/contracts/src/llm/
  normalized-response.ts    (contains LlmTransport + NormalizedResponse + TransportMessage etc.)
  interfaces.ts             (contains LlmSession + LlmExecutor + NormalizedDelta etc.)
  resolved-credential.ts    (contains ResolvedCredential)
  provider-id.ts            (contains ProviderId / ApiMode / BuiltinProviderId)
  provider-profile.ts       (contains ProviderProfile)
  failover-reason.ts        (contains ClassifiedError)
  oauth.ts                  (OAuth PKCE types)
  plugin-llm.ts             (plugin facade types)
```

ADR-072 §Migration strategy references "W0b/W0c" in terms of CONCEPTS (add contract types,
add W0c extensions). The CONCEPTUAL description remains accurate; only the filenames
listed in §Implementation notes are stale.

An annotation addendum is appended to ADR-072 as part of this task (see plan-doc edits).

---

## Acceptance Criteria Verification

| AC | Criterion | Status |
|----|-----------|--------|
| AC1 | Plan doc Phase 4 W0b/W0c/W2 sections annotated with 'as-shipped' filenames | DONE — see plan-doc edits |
| AC2 | credential.ts -> resolved-credential.ts mapping documented | DONE — §Mapping above + plan doc annotation |
| AC3 | transport.ts/session.ts/executor.ts -> interfaces.ts + normalized-response.ts mapping documented | DONE — §Mapping above |
| AC4 | default-session.ts/default-executor.ts -> concrete-session.ts/concrete-executor.ts/executor-factory.ts mapping documented | DONE — §Mapping above |
| AC5 | normalized-message-utils.ts marked as superseded by inline conversion in transports | DONE — §Reasons #4 above |
| AC6 | Reason for divergence captured (decision drift during Phase 4 implementation) | DONE — §Reasons above |

---

## File Checklist: All Referenced Filenames

| Filename | Exists? | Note |
|----------|---------|------|
| `packages/contracts/src/llm/credential.ts` | NO | Superseded by `resolved-credential.ts` |
| `packages/contracts/src/llm/transport.ts` | NO | Superseded by `normalized-response.ts` |
| `packages/contracts/src/llm/session.ts` | NO | Superseded by `interfaces.ts` |
| `packages/contracts/src/llm/executor.ts` | NO | Superseded by `interfaces.ts` |
| `packages/contracts/src/llm/normalized-message.ts` | NO | Superseded by `TransportMessage` in `normalized-response.ts` + inline types |
| `packages/core/src/llm/normalized-message-utils.ts` | NO | Never created; conversion inlined per transport |
| `packages/core/src/llm/default-session.ts` | NO | Superseded by `concrete-session.ts` |
| `packages/core/src/llm/default-executor.ts` | NO | Superseded by `concrete-executor.ts` |
| `packages/contracts/src/llm/resolved-credential.ts` | YES | As-shipped credential contract |
| `packages/contracts/src/llm/normalized-response.ts` | YES | As-shipped transport contract |
| `packages/contracts/src/llm/interfaces.ts` | YES | As-shipped session/executor contract |
| `packages/core/src/llm/concrete-session.ts` | YES | As-shipped session implementation |
| `packages/core/src/llm/concrete-executor.ts` | YES | As-shipped executor implementation |
| `packages/core/src/llm/session-factory.ts` | YES | As-shipped session factory |
| `packages/core/src/llm/executor-factory.ts` | YES | As-shipped executor factory/singleton |
