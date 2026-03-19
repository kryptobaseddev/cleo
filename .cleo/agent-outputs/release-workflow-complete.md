# Release Workflow — Completion Report

**Date**: 2026-03-18
**Status**: complete

---

## Summary

Created a pnpm-native GitHub Actions release workflow for the cleocode monorepo,
adapting the 206-line pipeline from `claude-todo` for multi-package publishing in
dependency order. Also created `CHANGELOG.md` and a workflow template copy.

---

## Files Created

| File | Purpose |
|------|---------|
| `/mnt/projects/cleocode/CHANGELOG.md` | Initial changelog with [Unreleased] section |
| `/mnt/projects/cleocode/.github/workflows/release.yml` | Production release pipeline |
| `/mnt/projects/cleocode/templates/github/workflows/release.yml` | Template copy |

---

## Publish Targets Determined

| Package | Private? | publishConfig? | Decision |
|---------|----------|----------------|----------|
| `@cleocode/contracts` | no | yes (public) | Publish |
| `@cleocode/core` | no | yes (public) | Publish |
| `@cleocode/adapters` | no | no (but has files) | Publish if dist exists |
| `@cleocode/cleo` | no | yes (public) | Publish |
| `@cleocode/agents` | no | no (no files, no dist) | Skip |
| `@cleocode/skills` | no | no (no dist) | Skip |
| root (`@cleocode/monorepo`) | yes | — | Skip |

---

## What Was Kept from the Old Workflow

- CalVer validation logic (unchanged — YYYY.M.PATCH stable, pre-release allows +1 month)
- GitHub Release creation with tarball + SHA256SUMS
- CHANGELOG extraction for release notes, with git log fallback
- Idempotent release creation (delete-then-recreate pattern)
- Dist-tag logic: `latest` / `beta` / `dev` from version suffix
- OIDC trusted publishing (`id-token: write` permission)
- Manual break-glass `workflow_dispatch` trigger
- `env:` pattern for all untrusted GitHub context values (security-safe)

---

## What Changed for the New Repo

| Old | New |
|-----|-----|
| `npm ci` | `pnpm install --frozen-lockfile` |
| `cache: 'npm'` | `cache: 'pnpm'` + `pnpm/action-setup@v4` |
| Single `npm publish` | 4-step sequential publish in dependency order |
| Single `package.json` version sync | Loop over 4 publishable packages |
| Tarball from `dist/` | Tarball from `packages/*/dist/` |
| `npm run build` | `pnpm run build` |
| MCP registry publish (`server.json`) | Removed — no `server.json` exists in new repo |
| `install.sh` in tarball | Removed — not present in new repo |

---

## Publish Order (Dependency Chain)

```
1. @cleocode/contracts  (no workspace deps)
2. @cleocode/core       (depends on contracts)
3. @cleocode/adapters   (depends on contracts; conditional on dist existing)
4. @cleocode/cleo       (depends on core + contracts; published last)
```

---

## YAML Validation

Syntax verified: `python3 -c "import yaml; yaml.safe_load(...)"` returned clean.

---

## Notes for First Release

1. Add a `## [YYYY.M.PATCH]` section to `CHANGELOG.md` before pushing the tag
2. Push tag: `git tag v2026.3.X && git push origin v2026.3.X`
3. The workflow syncs all package versions from the tag automatically
4. `NPM_TOKEN` secret must be set in the repository settings
5. OIDC trusted publishing requires configuring the npm package's trusted publisher settings
