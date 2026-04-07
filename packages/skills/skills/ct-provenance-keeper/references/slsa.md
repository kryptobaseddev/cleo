# SLSA Compliance Reference

SLSA (Supply-chain Levels for Software Artifacts) defines four levels of build provenance rigor. This file lists the exact requirements per level and the concrete checklist this skill uses to determine which level a release achieved.

## Level Matrix

| Requirement | L1 | L2 | L3 | L4 |
|-------------|:--:|:--:|:--:|:--:|
| Provenance exists | MUST | MUST | MUST | MUST |
| Provenance is signed | — | MUST | MUST | MUST |
| Build on hosted platform | — | MUST | MUST | MUST |
| Non-falsifiable provenance (isolated builder) | — | — | MUST | MUST |
| All dependencies have provenance | — | — | — | MUST |
| Two-party review | — | — | — | MUST |
| Hermetic, reproducible build | — | — | — | MUST |

## Level 1 Checklist

- [ ] Provenance record exists in `.cleo/releases.json` for this release.
- [ ] `commitSha` is populated.
- [ ] `artifacts[].sha256` is populated for every artifact.
- [ ] `builder.id` is a non-empty URI (local builder is fine).
- [ ] `buildInvocationId` is recorded (can be a local uuid).

If any of the above is missing, the release is L0 (non-compliant). The skill refuses to mark a release L0 — it raises the missing-field errors and asks for them to be populated.

## Level 2 Checklist

All L1 items plus:

- [ ] Attestation is signed (sigstore keyless or gpg).
- [ ] Signature verifies against the attestation subject digest.
- [ ] Build ran on a hosted CI platform (GitHub Actions, GitLab CI, CircleCI, etc.).
- [ ] `builder.id` points at the hosted runner's identity URI.

The skill determines L2 compliance automatically by inspecting the `signature.method` field and the `builder.id` URL shape.

## Level 3 Checklist

All L2 items plus:

- [ ] Provenance is non-falsifiable: the builder cannot forge attestations for builds it did not run.
- [ ] Build runs on an isolated runner (no long-lived state from prior builds).
- [ ] Signing identity is bound to the CI run via OIDC.
- [ ] The attestation is published to a transparency log (Rekor for sigstore).

In practice, L3 means: GitHub Actions with OIDC trusted publishing, sigstore keyless signing, and a Rekor transparency log entry. This is the default for npm + docker releases in this monorepo.

## Level 4 Checklist

All L3 items plus:

- [ ] Every runtime dependency has its own provenance attestation.
- [ ] The build is reproducible (same inputs produce identical output digests).
- [ ] A second reviewer signed off on the build config change that produced this release.
- [ ] The builder image is pinned to a digest, not a tag.

L4 is rare outside regulated environments. The skill does not attempt to claim L4 automatically; a human reviewer MUST assert the two-party review and reproducibility checks before the skill records L4.

## Configuration

The desired level is declared in `.cleo/config.json`:

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

The skill attempts to achieve the declared level. If the environment cannot satisfy it (e.g., declared L3 but no OIDC identity available), the skill records the actual level achieved and flags the shortfall in the manifest entry. It does NOT silently downgrade.

## Level Detection Decision Tree

```
HAS provenance record in releases.json?
+-- NO  -> Level 0 (non-compliant; error)
+-- YES
    +-- IS signature.method in ["sigstore", "gpg"]?
    |   +-- NO  -> Level 1
    |   +-- YES
    |       +-- IS builder.id a hosted CI runner URI?
    |       |   +-- NO  -> Level 1 (key-based but local build)
    |       |   +-- YES
    |       |       +-- IS signature.transparencyLog populated (Rekor for sigstore) OR equivalent?
    |       |       |   +-- NO  -> Level 2
    |       |       |   +-- YES
    |       |       |       +-- ALL deps have provenance AND build is reproducible AND two-party reviewed?
    |       |       |       |   +-- NO  -> Level 3
    |       |       |       |   +-- YES -> Level 4 (requires human assertion)
```

## Recording Level

The detected level is written to `releases.json` as a string:

```json
{
  "slsaLevel": "SLSA_BUILD_LEVEL_3"
}
```

Valid values: `SLSA_BUILD_LEVEL_1`, `SLSA_BUILD_LEVEL_2`, `SLSA_BUILD_LEVEL_3`, `SLSA_BUILD_LEVEL_4`. Never write `L0` — that's a validation error that the skill surfaces before writing anything.

## Verification

A consumer can verify SLSA level claims by:

1. Fetching the attestation from the registry or local store.
2. Verifying the signature via `cosign verify-blob` or `gpg --verify`.
3. Inspecting the `builder.id` in the predicate.
4. Checking the Rekor transparency log for the entry.

The skill provides `verify_provenance_chain()` for internal checks; consumers use the standard SLSA tooling.
