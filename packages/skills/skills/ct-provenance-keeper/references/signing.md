# Signing Methods Reference

This file documents the three supported signing methods and when to pick each. The default is `sigstore` keyless via OIDC, which is what every npm and docker release in this monorepo uses.

## Method Decision Matrix

| Method | Trust root | Requires | Use when |
|--------|------------|----------|----------|
| `sigstore` keyless | Rekor transparency log | OIDC identity (CI) | Default for every CI release; produces SLSA L3. |
| `sigstore` keyed | Local or cloud key | Cosign key reference | Self-hosted CI without OIDC; produces SLSA L2. |
| `gpg` | GPG key in the local keystore | `GPG_KEY_ID` env var | Legacy workflows, air-gapped environments. |
| `none` | (no signing) | — | SLSA L1 only; explicit opt-out, never default. |

## Sigstore Keyless (default)

Cosign issues a short-lived certificate bound to an OIDC identity (GitHub Actions token, Google OAuth, etc.) and publishes the signature to Rekor for transparency.

### Command

```bash
cosign sign-blob \
  --yes \
  --output-signature "${ARTIFACT}.sig" \
  --output-certificate "${ARTIFACT}.pem" \
  "${ARTIFACT}"
```

### Outputs

- `<artifact>.sig` — detached signature.
- `<artifact>.pem` — short-lived certificate from Fulcio.
- Transparency log entry in Rekor (the command prints the index).

### OIDC Trusted Publishing

For npm, configure the trusted publisher in the npm registry settings:

1. Go to the package page → Settings → Trusted Publishers.
2. Add the GitHub repo and workflow file (`.github/workflows/release.yml`).
3. Scope the trust to the `release` job.

The workflow then runs `npm publish --provenance` without any token; npm exchanges the OIDC token for short-lived publish permission and produces the SLSA L3 attestation automatically.

For GHCR (docker), the `GITHUB_TOKEN` in CI is already OIDC-bound; no extra setup is needed.

### Verification

```bash
cosign verify-blob \
  --certificate "${ARTIFACT}.pem" \
  --signature "${ARTIFACT}.sig" \
  --certificate-identity-regexp "^https://github.com/kryptobaseddev/cleocode/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${ARTIFACT}"
```

## Sigstore Keyed

Use when OIDC is unavailable but cosign is still preferred.

### Command

```bash
cosign sign-blob \
  --key "cosign.key" \
  --output-signature "${ARTIFACT}.sig" \
  "${ARTIFACT}"
```

### Key storage

- **Local**: `cosign.key` file (reference only the path, never the contents).
- **Cloud KMS**: `cosign.key` reference like `awskms:///alias/cosign`.
- **HashiCorp Vault**: `hashivault://<path>`.

### Verification

```bash
cosign verify-blob \
  --key cosign.pub \
  --signature "${ARTIFACT}.sig" \
  "${ARTIFACT}"
```

## GPG

Use for air-gapped environments, regulated workflows, or legacy release lines that predate sigstore.

### Command

```bash
gpg --detach-sign --armor -u "${GPG_KEY_ID}" "${ARTIFACT}"
```

### Requirements

- `GPG_KEY_ID` environment variable set to the signing key identifier.
- The private key loaded in the GPG keyring (`gpg --list-secret-keys`).
- A corresponding public key published somewhere consumers can fetch.

### Output

- `<artifact>.asc` — ASCII-armored detached signature.

### Verification

```bash
gpg --verify "${ARTIFACT}.asc" "${ARTIFACT}"
```

## None

Explicit opt-out. Use only for internal pre-release builds that will never leave the build environment. Producing a `none` signing method downgrades the release to SLSA L1 automatically.

```json
{
  "release": {
    "security": {
      "provenance": {
        "enabled": true,
        "framework": "slsa",
        "level": "SLSA_BUILD_LEVEL_1",
        "signing": { "method": "none" }
      }
    }
  }
}
```

The skill rejects any config that declares `signing.method: none` with a target level higher than L1.

## Validation Decision Tree

```
signing.method configured?
+-- "sigstore" (default)
|   +-- IS keyless enabled (default: true)?
|       +-- YES -> cosign sign-blob --yes <artifact>
|                  require OIDC identity in env
|       +-- NO  -> cosign sign-blob --key <key-ref> <artifact>
|                  require key reference resolvable
+-- "gpg"
|   +-- GPG_KEY_ID set?
|       +-- YES -> gpg --detach-sign --armor -u <key-id> <artifact>
|       +-- NO  -> Exit 91 (E_SIGNING_KEY_MISSING)
+-- "none"
    +-- Target level > L1?
        +-- YES -> Exit 90 (E_PROVENANCE_CONFIG_INVALID)
        +-- NO  -> Skip signing; record as unsigned
```

## Signing Metadata Record

Every signed artifact appends a `signature` block to its entry in `releases.json`:

```json
{
  "signature": {
    "method": "sigstore",
    "keyless": true,
    "signed": true,
    "signedAt": "2026-04-06T19:50:32Z",
    "signature": ".cleo/attestations/cleocode-core-2026.4.5.sig",
    "certificate": ".cleo/attestations/cleocode-core-2026.4.5.pem",
    "transparencyLog": {
      "index": "123456789",
      "url": "https://rekor.sigstore.dev"
    }
  }
}
```

For gpg:

```json
{
  "signature": {
    "method": "gpg",
    "keyless": false,
    "signed": true,
    "signedAt": "2026-04-06T19:50:32Z",
    "signature": ".cleo/attestations/cleocode-core-2026.4.5.asc",
    "keyId": "0xDEADBEEFCAFEBABE"
  }
}
```

The skill MUST populate the method and signedAt fields on every signed record. Optional fields (transparency log, certificate) are filled when the signing method provides them.
