# ADR-054 (DRAFT) — Signed Audit Trail via `llmtxt/identity`

**Status:** Draft (owner to review, finalise, and promote to numbered ADR).
**Date:** 2026-04-17
**Task:** T947 Step 5
**Supersedes:** None. Extends ADR-051 (Gate Integrity) with a cryptographic layer.

## Context

ADR-051 established `.cleo/audit/*.jsonl` as the append-only source of truth for gate writes, emergency overrides, and decision records. Entries are currently unsigned: a file-system-level attacker (or a bug in a writer) could insert, rewrite, or remove lines with no way to detect the tampering after the fact. The owner's T947 constraint #4 further mandates that CLEO must not ship a second, home-grown signing primitive when `llmtxt/identity` (v2026.4.9+) already provides a peer-reviewed Ed25519 implementation backed by `@noble/ed25519` v3 and a Rust SSoT (`crates/llmtxt-core/src/identity.rs`). Duplicate primitives are a maintenance tax *and* an attack surface.

## Decision

CLEO adopts `llmtxt/identity` as the sole signing primitive for audit-trail attestations. A thin adapter (`packages/core/src/identity/cleo-identity.ts`) owns CLEO-specific concerns:

1. **Storage.** The identity seed persists to `<projectRoot>/.cleo/keys/cleo-identity.json` with mode `0o600` — **not** `llmtxt`'s default `~/.llmtxt/identity.key` — so each CLEO project carries its own signing key. A compromised key never bleeds across projects.
2. **Deterministic dev/test mode.** Setting `CLEO_IDENTITY_SEED` to a 64-char hex seed bypasses persistence and derives the identity via `identityFromSeed`. Test harnesses MUST use this rather than polluting the real key file.
3. **Signed JSONL.** New writers (`appendSignedGateAuditLine`) sign the canonical, alphabetically-sorted JSON bytes of the record and attach a `_sig: { sig, pub }` envelope. Existing `appendGateAuditLine` is unchanged — unsigned entries remain valid for zero-risk migration.
4. **Severity attestations.** `cleo bug --severity` writes a signed attestation to `.cleo/audit/bug-severity.jsonl`. When `.cleo/config.json` declares an `ownerPubkeys` allowlist, only identities in that list may sign — others receive `E_OWNER_ONLY` (exit 72) to defuse prompt-injection attacks that try to escalate bug severity.

## Migration & Key Rotation

Pre-v2026.4.9 audit entries (all currently on disk — 129 `gates.jsonl` lines, plus `force-bypass`, `assumptions`, `decisions`) remain readable and remain trusted under the project's existing trust model. They are counted in `verifyAuditHistory()` under the `unsigned` bucket. There is **no automatic re-signing** of historical entries: re-signing would grant present-day authority to past writes, defeating the point of the signature. Projects that need cryptographic coverage of legacy entries should snapshot the file, hash it, and commit the hash to a signed `ADR-054-baseline` entry at the cutover moment.

On key rotation (lost laptop, key exfiltration, periodic hygiene), operators replace `.cleo/keys/cleo-identity.json`, add the new pubkey to `config.json.ownerPubkeys`, and — crucially — **leave the old pubkey in the allowlist** as a non-signing *historical* marker so `verifyAuditHistory` can still validate entries produced under the old key. A future ADR may formalise key-rotation envelopes (`{"fromPub": "...", "toPub": "...", "sig": "..."}`) to chain trust across rotations; for v1 the allowlist pattern is sufficient.

## Consequences

- **Zero primitive duplication.** CLEO depends on `llmtxt@^2026.4.9` (already installed); no `@noble/ed25519` dependency enters the `@cleocode/core` tree directly.
- **Backwards compatibility.** All existing writers keep working. Opt-in adoption is per-callsite.
- **Verifiable tampering.** `cleo verify` can call `verifyAuditHistory()` to produce a `{ total, signed, verified, unsigned }` report suitable for CI gates.
- **Prompt-injection defence.** Severity setting via `cleo bug` is now cryptographically gated by the owner allowlist, closing the "malicious LLM files a P0 bug" vector.
