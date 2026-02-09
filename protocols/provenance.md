# Provenance Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Supply Chain | "provenance", "supply chain", "chain of custody" | Artifact traceability |
| Attestation | "attest", "attestation", "in-toto", "SLSA" | Cryptographic evidence |
| SBOM | "sbom", "bill of materials", "cyclonedx", "spdx" | Dependency inventory |
| Signing | "sign", "cosign", "sigstore", "verify signature" | Artifact integrity |
| Checksums | "checksum", "digest", "sha256", "integrity" | Content verification |

**Explicit Override**: `--protocol provenance` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| PROV-001 | MUST record provenance chain from source commit to published artifact |
| PROV-002 | MUST compute SHA-256 digest for every produced artifact |
| PROV-003 | MUST generate attestation in in-toto Statement v1 format |
| PROV-004 | MUST record SLSA Build Level achieved (L1 minimum) |
| PROV-005 | MUST store provenance record in `.cleo/releases.json` via `record_release()` |
| PROV-006 | MUST verify provenance chain integrity before publishing attestation |
| PROV-007 | MUST set `agent_type: "provenance"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| PROV-010 | SHOULD generate SBOM (CycloneDX or SPDX) for artifacts with dependencies |
| PROV-011 | SHOULD sign attestations using keyless signing (sigstore/cosign) |
| PROV-012 | SHOULD publish provenance attestation alongside artifact |
| PROV-013 | SHOULD verify all input materials (dependencies, base images) have provenance |

### MAY

| Requirement | Description |
|-------------|-------------|
| PROV-020 | MAY achieve SLSA Build Level 3 or 4 |
| PROV-021 | MAY use key-based signing (GPG) as alternative to keyless |
| PROV-022 | MAY generate multiple SBOM formats (both CycloneDX and SPDX) |

---

## Provenance Chain Model

```
commit --> build --> artifact --> attestation --> registry
  |           |          |            |               |
  sha         log        digest       signature       published
  |           |          |            |               |
  source      env        checksum     certificate     location
  identity    capture    file         bundle          URL
```

### Chain Links

| Stage | Input | Output | Required Field |
|-------|-------|--------|----------------|
| Source | Repository URL | Commit SHA | `invocation.configSource.digest.sha1` |
| Build | Commit + Config | Build log | `metadata.buildInvocationId` |
| Artifact | Build output | File + SHA-256 | `artifacts[].sha256` |
| Attestation | Artifact digest | in-toto Statement | `attestation.predicateType` |
| Registry | Attestation + Artifact | Published URL | `artifacts[].registry` |

### Chain Integrity Rules

| Rule | Enforcement |
|------|-------------|
| Each link MUST reference previous link's output | `verify_provenance_chain()` validates |
| No link MAY be modified after creation | Append-only in `releases.json` |
| Missing links MUST be recorded as `incomplete` | `metadata.completeness` flags |
| Chain MUST be verifiable offline | Digests stored locally |

---

## SLSA Compliance Levels

### Requirements Matrix

| Requirement | L1 | L2 | L3 | L4 |
|-------------|:--:|:--:|:--:|:--:|
| Provenance exists | MUST | MUST | MUST | MUST |
| Provenance is signed | -- | MUST | MUST | MUST |
| Build on hosted platform | -- | MUST | MUST | MUST |
| Non-falsifiable provenance | -- | -- | MUST | MUST |
| All dependencies have provenance | -- | -- | -- | MUST |
| Two-party review | -- | -- | -- | MUST |
| Hermetic, reproducible build | -- | -- | -- | MUST |

### Level Detection Decision Tree

```
HAS provenance record?
+-- NO  -> Level 0 (non-compliant)
+-- YES
    +-- IS provenance signed?
    |   +-- NO  -> Level 1
    |   +-- YES
    |       +-- IS build on hosted/isolated platform?
    |       |   +-- NO  -> Level 1
    |       |   +-- YES
    |       |       +-- IS build non-falsifiable?
    |       |       |   +-- NO  -> Level 2
    |       |       |   +-- YES
    |       |       |       +-- ALL deps pinned + hermetic + reproducible?
    |       |       |       |   +-- NO  -> Level 3
    |       |       |       |   +-- YES -> Level 4
```

### Configuration

```json
{
  "release": {
    "security": {
      "provenance": {
        "enabled": true,
        "framework": "slsa",
        "level": "SLSA_BUILD_LEVEL_3"
      }
    }
  }
}
```

---

## Attestation Schema

### in-toto Statement (v1)

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "<artifact-name>",
      "digest": {
        "sha256": "<64-hex-chars>"
      }
    }
  ],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "<build-system-uri>",
      "externalParameters": {
        "source": {
          "uri": "git+<repo-url>",
          "digest": { "sha1": "<commit-sha>" }
        }
      },
      "internalParameters": {},
      "resolvedDependencies": [
        {
          "uri": "<dependency-uri>",
          "digest": { "sha256": "<dep-digest>" }
        }
      ]
    },
    "runDetails": {
      "builder": {
        "id": "<builder-id-uri>"
      },
      "metadata": {
        "invocationId": "<unique-build-id>",
        "startedOn": "<ISO-8601>",
        "finishedOn": "<ISO-8601>"
      }
    }
  }
}
```

### Required Fields

| Field | Required | Validation |
|-------|----------|------------|
| `subject[].digest.sha256` | MUST | 64-char hex, matches artifact |
| `predicateType` | MUST | Valid SLSA provenance URI |
| `buildDefinition.buildType` | MUST | Non-empty URI |
| `runDetails.builder.id` | MUST | Non-empty URI |
| `runDetails.metadata.invocationId` | SHOULD | Unique per build |
| `buildDefinition.resolvedDependencies` | SHOULD (L3+) | Array of URI+digest pairs |

### Storage Locations

| Location | Format | Purpose |
|----------|--------|---------|
| `.cleo/attestations/<version>.intoto.jsonl` | in-toto Statement (DSSE envelope) | Local attestation store |
| `<artifact>.att` | DSSE envelope (JSON) | Bundled with artifact |
| OCI registry (tag: `sha256-<digest>.att`) | Cosign attachment | Registry-hosted attestation |

---

## SBOM Requirements

### When to Generate

| Condition | SBOM Required |
|-----------|:-------------:|
| Artifact has runtime dependencies | MUST |
| Docker/OCI image | MUST |
| Library/package published to registry | MUST |
| Standalone binary with no deps | SHOULD |
| Documentation-only artifact | MAY skip |

### Supported Formats

| Format | Spec Version | Use Case |
|--------|-------------|----------|
| CycloneDX | 1.5+ | Default (machine-readable, JSON) |
| SPDX | 2.3+ | Compliance-focused (regulatory) |

### Minimum Schema (CycloneDX)

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "timestamp": "<ISO-8601>",
    "tools": [{ "name": "<generator>", "version": "<version>" }],
    "component": {
      "type": "application",
      "name": "<artifact-name>",
      "version": "<artifact-version>",
      "purl": "<package-url>"
    }
  },
  "components": [
    {
      "type": "library",
      "name": "<dep-name>",
      "version": "<dep-version>",
      "purl": "<dep-purl>",
      "hashes": [{ "alg": "SHA-256", "content": "<hex-digest>" }]
    }
  ]
}
```

### Storage

| Location | Purpose |
|----------|---------|
| `.cleo/sbom/<artifact-name>-<version>.cdx.json` | CycloneDX local store |
| `.cleo/sbom/<artifact-name>-<version>.spdx.json` | SPDX local store |
| `<artifact>.sbom.json` | Bundled with artifact |

---

## Signing Protocol

### Method Decision Tree

```
SIGNING_METHOD configured?
+-- "sigstore" (default)
|   +-- IS keyless enabled? (default: true)
|       +-- YES -> cosign sign-blob --yes <artifact>
|       +-- NO  -> cosign sign-blob --key <key-ref> <artifact>
+-- "gpg"
|   +-- GPG_KEY_ID set?
|       +-- YES -> gpg --detach-sign --armor -u <key-id> <artifact>
|       +-- NO  -> Exit 91 (E_SIGNING_KEY_MISSING)
+-- "none"
    +-- Skip signing (SLSA L1 only)
```

### Command Templates

| Method | Command | Output |
|--------|---------|--------|
| Sigstore (keyless) | `cosign sign-blob --yes --output-signature <sig> --output-certificate <cert> <artifact>` | `.sig` + `.pem` |
| Sigstore (key) | `cosign sign-blob --key <ref> --output-signature <sig> <artifact>` | `.sig` |
| GPG | `gpg --detach-sign --armor -u <key-id> <artifact>` | `.asc` |
| None | (skip) | (none) |

### Signing Metadata Record

```json
{
  "method": "sigstore",
  "keyless": true,
  "signed": true,
  "signedAt": "<ISO-8601>",
  "signature": "<path-to-sig>",
  "certificate": "<path-to-cert>",
  "transparencyLog": {
    "index": "<rekor-log-index>",
    "url": "https://rekor.sigstore.dev"
  }
}
```

### Validation

| Check | Condition | Exit Code |
|-------|-----------|-----------|
| Method configured | `signing.method` in `["sigstore", "gpg", "none"]` | 90 |
| Key available (if key-based) | Key reference resolves | 91 |
| Signature produced | `.sig` or `.asc` file exists | 92 |
| Signature verifies | `cosign verify-blob` or `gpg --verify` passes | 92 |

---

## Verification Protocol

### Verification Decision Tree

```
VERIFY artifact provenance:
+-- 1. Digest check
|   +-- Compute SHA-256, compare to recorded digest
|       +-- MISMATCH -> Exit 93 (E_DIGEST_MISMATCH)
|       +-- MATCH -> continue
+-- 2. Signature check (if signed)
|   +-- Verify signature against artifact
|       +-- FAIL -> Exit 92 (E_SIGNATURE_INVALID)
|       +-- PASS -> continue
+-- 3. Attestation check (if exists)
|   +-- Verify attestation subject matches artifact digest
|       +-- MISMATCH -> Exit 94 (E_ATTESTATION_INVALID)
|       +-- MATCH -> continue
+-- 4. Chain completeness
    +-- Walk chain: commit -> build -> artifact -> attestation
        +-- BROKEN -> report incomplete (warning, not blocking)
        +-- COMPLETE -> VERIFIED
```

### Verification Result Schema

```json
{
  "artifact": "<name>",
  "version": "<version>",
  "verified": true,
  "checks": {
    "digest": { "status": "pass", "algorithm": "sha256", "value": "<hex>" },
    "signature": { "status": "pass", "method": "sigstore" },
    "attestation": { "status": "pass", "predicateType": "https://slsa.dev/provenance/v1" },
    "chain": { "status": "pass", "completeness": { "source": true, "build": true, "artifact": true } }
  },
  "slsaLevel": "SLSA_BUILD_LEVEL_3",
  "verifiedAt": "<ISO-8601>"
}
```

---

## Checksum & Digest Management

### Supported Algorithms

| Algorithm | Required | Use Case |
|-----------|:--------:|----------|
| SHA-256 | MUST | All artifacts, attestation subjects |
| SHA-512 | MAY | High-security contexts |

### Computation Per Type

| Artifact Type | Input | Command |
|--------------|-------|---------|
| File | File path | `sha256sum <file> \| awk '{print $1}'` |
| Docker image | Image ref | `docker inspect --format='{{.Id}}' <image>` |
| OCI manifest | Manifest JSON | `sha256sum <manifest.json>` |

### Storage Locations

| Location | Format | Purpose |
|----------|--------|---------|
| `releases.json` -> `artifacts[].sha256` | Hex string (64 chars) | Provenance record |
| `checksums.txt` (release artifact) | `<sha256>  <filename>` | Distribution verification |
| Attestation `subject[].digest.sha256` | Hex string (64 chars) | Attestation binding |

### Publishing Channels

| Channel | Format |
|---------|--------|
| Git tag annotation | `SHA-256: <hex>` per artifact |
| GitHub Release body | `## Checksums\n<sha256>  <filename>` |
| Registry metadata | Registry-native digest field |
| `checksums.txt` file | `<sha256>  <filename>` per line |

---

## Error Codes (90-94)

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 90 | `E_PROVENANCE_CONFIG_INVALID` | Invalid provenance/signing config | Check `.cleo/config.json` security section |
| 91 | `E_SIGNING_KEY_MISSING` | Signing key not found | Set `GPG_KEY_ID` or configure sigstore keyless |
| 92 | `E_SIGNATURE_INVALID` | Signature verification failed | Re-sign artifact, check key validity |
| 93 | `E_DIGEST_MISMATCH` | Computed digest does not match record | Investigate tampering or rebuild artifact |
| 94 | `E_ATTESTATION_INVALID` | Attestation subject/format error | Regenerate attestation from correct artifact |

### Recoverability

| Code | Recoverable | Agent Action |
|------|:-----------:|--------------|
| 90 | Yes | Fix config, retry |
| 91 | Yes | Set key, retry |
| 92 | Yes | Re-sign, retry |
| 93 | No | Investigate tampering, rebuild |
| 94 | Yes | Regenerate attestation, retry |

### Error Recovery Decision Tree

```
EXIT CODE?
+-- 90 (CONFIG_INVALID)    -> Fix .cleo/config.json security section -> Retry
+-- 91 (SIGNING_KEY)       -> Set GPG_KEY_ID or enable sigstore keyless -> Retry
+-- 92 (SIGNATURE_INVALID) -> Re-sign artifact with valid key -> Retry
+-- 93 (DIGEST_MISMATCH)   -> Investigate tampering, clean rebuild -> Retry
+-- 94 (ATTESTATION)       -> Regenerate attestation from artifact -> Retry
```

---

## Output Format

### File Output

```markdown
# Provenance Report: <artifact-name> v<version>

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: provenance

---

## Summary

{2-3 sentence summary of provenance activities}

## Provenance Chain

| Stage | Value | Verified |
|-------|-------|:--------:|
| Source commit | `<sha>` | PASS |
| Build invocation | `<id>` | PASS |
| Artifact digest | `sha256:<hex>` | PASS |
| Attestation | `<predicate-type>` | PASS |
| Signature | `<method>` | PASS |

## SLSA Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Level achieved | L3 | |
| Provenance exists | PASS | |
| Provenance signed | PASS | sigstore/keyless |
| Hardened build | PASS | CI/CD platform |

## SBOM

| Format | Location | Components |
|--------|----------|:----------:|
| CycloneDX 1.5 | `.cleo/sbom/<name>.cdx.json` | 42 |

## Verification Results

| Artifact | Digest | Signature | Attestation | Chain |
|----------|:------:|:---------:|:-----------:|:-----:|
| `<name>` | PASS | PASS | PASS | PASS |
```

### Manifest Entry

```bash
cleo research add \
  --title "Provenance: <artifact-name> v<version>" \
  --file "YYYY-MM-DD_provenance-<artifact>.md" \
  --topics "provenance,supply-chain,slsa,attestation" \
  --findings "SLSA L3 achieved,SHA-256 verified,Attestation signed,SBOM generated" \
  --status complete \
  --task T#### \
  --not-actionable \
  --agent-type provenance
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| release | Release triggers provenance record via `record_release()` |
| artifact-publish | Artifact-publish delegates signing/attestation to provenance |
| implementation | Implementation produces artifacts requiring provenance |
| contribution | Contribution commits form source stage of chain |

### Existing Infrastructure

| Function | File | Purpose |
|----------|------|---------|
| `record_release()` | `lib/release-provenance.sh` | Store provenance record |
| `link_task_to_release()` | `lib/release-provenance.sh` | Associate tasks |
| `get_release_provenance()` | `lib/release-provenance.sh` | Retrieve chain |
| `verify_provenance_chain()` | `lib/release-provenance.sh` | Validate integrity |
| `generate_provenance_report()` | `lib/release-provenance.sh` | Human-readable output |
| `get_security_config()` | `lib/release-config.sh` | Read signing/provenance config |

### Handoff Patterns

| Scenario | Handoff Target |
|----------|----------------|
| Provenance complete, ready to publish | artifact-publish protocol |
| SBOM reveals vulnerable dependency | research protocol |
| Signing fails (key issue) | HITL escalation |
| Verification fails on consumed artifact | implementation protocol (rebuild) |

---

## Workflow Sequence

```
 1. Read task requirements (cleo show T####)
 2. Set focus (cleo focus set T####)
 3. Compute artifact digests (SHA-256)
 4. Generate attestation (in-toto Statement v1)
 5. Sign attestation (sigstore/cosign or gpg)
 6. Generate SBOM (if applicable per PROV-010)
 7. Record provenance via record_release()
 8. Verify chain via verify_provenance_chain()
 9. Write output file
10. Append manifest entry
11. Complete task (cleo complete T####)
12. Return: "Provenance complete. See MANIFEST.jsonl for summary."
```

---

## Example

**Task**: Generate provenance for CLEO v0.85.0 release

**Manifest Entry Command**:
```bash
cleo research add \
  --title "Provenance: CLEO v0.85.0" \
  --file "2026-02-09_provenance-v0850.md" \
  --topics "provenance,slsa,v0.85.0,supply-chain" \
  --findings "SLSA L3 achieved,3 artifacts signed,CycloneDX SBOM generated,Chain verified" \
  --status complete \
  --task T3200 \
  --epic T3195 \
  --not-actionable \
  --agent-type provenance
```

**Return Message**:
```
Provenance complete. See MANIFEST.jsonl for summary.
```

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Skipping digest computation | Breaks chain integrity, unverifiable artifacts |
| Hardcoding signing keys in config | Security risk, key exposure |
| Generating attestation without matching digest | Attestation binds to wrong artifact |
| Publishing artifact before signing | Cannot retrofit signatures |
| Modifying provenance records after creation | Violates immutability, breaks audit trail |
| Skipping SBOM for artifacts with dependencies | Hidden supply chain risk |
| Using SHA-1 or MD5 for digests | Cryptographically broken, non-compliant |
| Storing private keys in `.cleo/` directory | Key compromise risk |

---

*Protocol Version 1.0.0 - Supply Chain Provenance Protocol*
