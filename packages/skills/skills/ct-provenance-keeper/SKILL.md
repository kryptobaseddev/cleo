---
name: ct-provenance-keeper
description: "Generates in-toto v1 attestations, SLSA-level provenance records, SBOMs (CycloneDX or SPDX), and sigstore/cosign signatures for published artifacts. Invoked by ct-artifact-publisher as a delegation for signing and attestation. Records the full commit, then build, then artifact, then attestation, then registry chain in .cleo/releases.json and rejects publishes whose digest does not match the attestation. Triggers when artifact-publish reaches the provenance step or when a release needs SLSA L2+ attestation."
---

# Provenance Keeper

## Overview

Sub-protocol of ct-artifact-publisher. Generates cryptographic evidence for every published artifact: SHA-256 digests, in-toto Statement v1 attestations, SBOMs (CycloneDX 1.5+ or SPDX 2.3+), and signatures via sigstore/cosign keyless or gpg. Records the full commit-to-registry chain in `.cleo/releases.json`, verifies chain integrity before publishing attestations, and refuses to bind an attestation to an artifact whose digest does not match.

## Core Principle

> Provenance is non-falsifiable or it is not provenance.

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| PROV-001 | Chain MUST be recorded from source commit to published artifact. | `record_release()` writes the full chain; missing links set `metadata.completeness: incomplete`. |
| PROV-002 | SHA-256 digest MUST be computed for every produced artifact. | Digest binds to the in-toto subject; mismatch exits 93. |
| PROV-003 | Attestation MUST be in in-toto Statement v1 format. | Validator rejects other schemas; exit 94. |
| PROV-004 | SLSA Build Level MUST be recorded (L1 minimum). | Level stored in `releases.json`; L1 is the floor. |
| PROV-005 | Provenance record MUST be stored in `.cleo/releases.json` via `record_release()`. | Missing record fails validation. |
| PROV-006 | Chain integrity MUST be verified before publishing the attestation. | `verify_provenance_chain()` runs before emit. |
| PROV-007 | Manifest entry MUST set `agent_type: "provenance"`. | Validator rejects any other value. |

## SLSA Compliance Levels

The skill records the achieved SLSA level in every provenance record. A minimum of L1 is mandatory; L3 is the target for npm + docker releases via OIDC keyless signing.

| Level | Requirements | Typical achievement |
|-------|--------------|---------------------|
| L1 | Provenance exists, basic metadata recorded. | Any run of the skill produces at least L1. |
| L2 | Signed provenance, build on a hosted platform. | Requires sigstore keyless OR gpg signing + CI build. |
| L3 | Non-falsifiable provenance, hermetic build environment. | CI runs with isolated runners and OIDC-bound identity (this is the default for npm + docker releases). |
| L4 | Reproducible builds, two-party review, all deps signed. | Rare; requires pinned dependencies and second-reviewer sign-off. |

Full requirements and per-level checklists are in [references/slsa.md](references/slsa.md).

## Signing Methods

Three methods are supported; the skill selects based on `release.security.provenance.signing.method`:

| Method | Command | Output | When to use |
|--------|---------|--------|-------------|
| `sigstore` (default, keyless) | `cosign sign-blob --yes --output-signature <sig> --output-certificate <cert> <artifact>` | `.sig` + `.pem` + Rekor transparency log entry | Default. Requires OIDC identity (CI). |
| `sigstore` (key) | `cosign sign-blob --key <ref> <artifact>` | `.sig` | Offline or self-hosted without OIDC. |
| `gpg` | `gpg --detach-sign --armor -u <key-id> <artifact>` | `.asc` | Legacy workflows, regulated environments. |
| `none` | (skip) | (none) | SLSA L1 only; explicit opt-out. |

The decision matrix, including `GPG_KEY_ID` and OIDC trusted-publisher setup, lives in [references/signing.md](references/signing.md).

## Provenance Chain

The skill walks and records the full chain for every release:

```
commit  -->  build  -->  artifact  -->  attestation  -->  registry
  |           |            |               |                |
  sha        log         digest        signature        published
  |           |            |               |                |
source    env capture   sha256 file    cert bundle        URL
```

Each link MUST reference the previous link's output. The chain is append-only in `releases.json`: no link is ever modified after creation. Missing links are recorded as `incomplete`, never elided. Offline verification MUST be possible — every digest is stored locally, not fetched per verification.

## SBOM Generation

SBOMs are mandatory for artifacts with runtime dependencies (docker images, npm packages) and recommended for standalone binaries.

| Format | Spec | Use case |
|--------|------|----------|
| CycloneDX | 1.5+ | Default. Machine-readable JSON. |
| SPDX | 2.3+ | Compliance-focused (FedRAMP, regulated environments). |

Storage locations:

- `.cleo/sbom/<artifact-name>-<version>.cdx.json` (CycloneDX)
- `.cleo/sbom/<artifact-name>-<version>.spdx.json` (SPDX)
- `<artifact>.sbom.json` (bundled alongside the artifact)

Generate with `syft packages dir:. -o cyclonedx-json` or equivalent.

## `.cleo/releases.json` Record Structure

Each release appends a record in the following shape. The skill MUST populate every field that can be known; the remainder stay as explicit nulls (never absent).

```json
{
  "version": "v2026.4.5",
  "commitSha": "3a2f1e9c4b8d7e6a5f2c1d0e9f8a7b6c5d4e3f2a",
  "gitTag": "v2026.4.5",
  "buildInvocationId": "gh-actions-12345",
  "builder": { "id": "https://github.com/actions/runner" },
  "artifacts": [
    {
      "type": "npm-package",
      "name": "@cleocode/core",
      "sha256": "a1b2c3...",
      "registry": "https://registry.npmjs.org",
      "publishedAt": "2026-04-06T19:50:00Z",
      "attestation": ".cleo/attestations/v2026.4.5-core.intoto.jsonl",
      "signature": {
        "method": "sigstore",
        "keyless": true,
        "transparencyLog": {
          "index": "123456789",
          "url": "https://rekor.sigstore.dev"
        }
      }
    }
  ],
  "sbom": {
    "format": "CycloneDX",
    "specVersion": "1.5",
    "path": ".cleo/sbom/cleocode-core-2026.4.5.cdx.json"
  },
  "slsaLevel": "SLSA_BUILD_LEVEL_3",
  "chainVerified": true,
  "recordedAt": "2026-04-06T19:51:00Z"
}
```

## Integration

Validate the provenance entry through `cleo check protocol`:

```bash
cleo check protocol \
  --protocolType provenance \
  --taskId T4902 \
  --hasAttestation true \
  --hasSbom true
```

Exit code 0 = provenance record is complete and verified. Exit code 90 = invalid config. Exit code 91 = signing key missing. Exit code 92 = signature invalid. Exit code 93 = digest mismatch (refuse to bind attestation). Exit code 94 = attestation format or subject is invalid.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Skipping digest computation | Chain integrity cannot be verified (violates PROV-002) | Always compute SHA-256 for every artifact before attesting |
| Hardcoding signing keys in config | Key exposure, credentials in VCS | Reference env vars by name; actual keys stay in the environment |
| Generating attestation without matching digest | Attestation binds to the wrong artifact (violates PROV-006) | Compute the digest first, then attest; refuse to attest a mismatched pair |
| Publishing artifact before signing | Cannot retrofit signatures after publish | Sign before push; the sub-protocol order is build → sign → publish |
| Modifying provenance records after creation | Breaks immutability, corrupts the audit trail | `.cleo/releases.json` is append-only; never rewrite old entries |
| Skipping SBOM for artifacts with dependencies | Hidden supply-chain risk | Generate CycloneDX for every artifact with runtime deps |
| Using SHA-1 or MD5 for digests | Cryptographically broken; non-compliant with SLSA | SHA-256 is mandatory; SHA-512 is optional for high-security contexts |
| Storing private keys inside `.cleo/` | Key compromise if the repo is leaked | Keys live in the keystore / OIDC / HSM — never in the worktree |

## Critical Rules Summary

1. Compute SHA-256 for every artifact; bind the attestation to the exact digest.
2. Produce attestations in in-toto Statement v1 format only.
3. Record the full chain in `.cleo/releases.json` via `record_release()`.
4. Verify chain integrity before publishing the attestation.
5. Default to sigstore keyless signing via OIDC in CI; fall back to gpg only when configured.
6. Generate CycloneDX SBOMs for every artifact with runtime dependencies.
7. `.cleo/releases.json` is append-only; never mutate past entries.
8. Validate every run via `cleo check protocol --protocolType provenance`.
