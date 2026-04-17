# T727 — Release Workflow Publish Loop Idempotency Fix

**Status**: complete
**Date**: 2026-04-15
**Commit**: ca5102a9e46ec35c9763314ba26f3ee0b34e81a8
**Workflow run**: https://github.com/kryptobaseddev/cleo/actions/runs/24480594624 (GREEN, 1m9s)

## Root Cause

`already_published()` used `npm view "@cleocode/$pkg" version` which returns the
**latest dist-tag** version pointer, not the specific `$VERSION` being published.

Under npm registry cache lag (immediately after a successful publish), the "latest"
pointer may not yet reflect the just-published version. This caused:

1. Pre-publish check: `already_published()` returned false (cache miss) — proceed to publish
2. Publish attempt: npm returns `403 You cannot publish over the previously published versions: X`
3. Post-failure re-check: `already_published()` also returned false (same cache miss)
4. Package recorded as FAIL with misleading error: "npm Trusted Publisher not configured"

The misleading error message caused the owner to doubt OIDC configuration, but OIDC was
never the problem — all packages DID publish successfully on the first run.

## Fix Applied

### 1. `already_published()` — explicit `@VERSION` qualifier

**Before:**
```bash
current=$(npm view "@cleocode/$pkg" version 2>/dev/null || echo "")
[[ "$current" == "$VERSION" ]]
```

**After:**
```bash
published_version=$(npm view "@cleocode/$pkg@$VERSION" version 2>/dev/null || true)
[[ "$published_version" == "$VERSION" ]]
```

The `@$VERSION` qualifier bypasses the latest-tag pointer and directly checks
whether that specific version exists on the registry. This is unambiguous regardless
of dist-tag (latest/beta/dev) and regardless of registry cache state.

### 2. Post-failure path — captures output for classification

publish output captured to `PUBLISH_OUTPUT` variable so both exit code and error
text are available without a second npm invocation. Three-branch classification:

- `already_published "$pkg"` → SKIP-RACE (concurrent publish or pre-exists)
- grep "cannot publish over the previously published" → SKIP-CONFLICT (version exists, registry cache missed pre-check)
- grep "OIDC|trusted publish|403|401|Unauthorized|Forbidden" → FAIL with specific error detail
- else → FAIL (generic)

### 3. Error message — accurate diagnosis guide

Replaced the single misleading "OIDC not configured" message with a tiered diagnosis
guide distinguishing:
- OIDC/401 failure (actual OIDC problem)
- 403 permission denied (private package or missing publishConfig.access=public)
- 403 version conflict (this version already exists — NOT an OIDC failure)

Explicit note: "403 'cannot publish over' is NOT an OIDC failure. OIDC trusted
publisher IS working if any packages published successfully."

## Verification

### Local logic tests
```
PASS: core@2026.4.62 detected as already published (would SKIP)
PASS: core@2026.4.99 correctly NOT detected as published (would attempt publish)
PASS: 403 version-conflict correctly detected
PASS: OIDC/auth failure correctly detected
```

### CI verification
- Re-ran Release workflow on v2026.4.62 (all packages already published)
- Result: GREEN in 1m9s, all 12 packages logged as SKIP
- OIDC config preserved untouched (id-token: write permission + --provenance flags unchanged)

## Files Changed

- `.github/workflows/release.yml` — publish loop fix (42 insertions, 18 deletions)
