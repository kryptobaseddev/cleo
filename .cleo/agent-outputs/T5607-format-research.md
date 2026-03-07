# T5607 Format Research Output

## Changelog Header Format

**From `src/core/release/changelog-writer.ts`, line 52:**
```typescript
lines.push(`## [${version}] (${date})`);
```

Produces: `## [2026.3.18] (2026-03-07)` — WITH square brackets, date in parentheses.

## CI Grep Patterns

**Release notes extraction (line 137):**
```bash
grep -q "## \[${VERSION}\]" CHANGELOG.md
sed -n "/## \[${VERSION}\]/,/## \[/p" CHANGELOG.md | head -n -1 | tail -n +2
```

**CHANGELOG gate (line 178):**
```bash
grep -qF "## [${VERSION}]" CHANGELOG.md
```

## Verdict: MATCH ✓

Both patterns match the `## [VERSION]` prefix in `## [2026.3.18] (2026-03-07)`.
- The release notes grep is a regex prefix match — finds it.
- The CHANGELOG gate uses `-F` (fixed string substring match) — finds it.
- Version stripping: `VERSION="${REF_NAME#v}"` correctly strips `v` from tag.

## v2026.3.18 Release Notes Failure Root Cause

The release commit `35a8bc0f` shows only 1 insertion, 5 deletions in CHANGELOG.md —
modifications to the existing `## [2026.3.17]` section with NO new `## [2026.3.18]` header.

The CHANGELOG section was missing because the release was done via direct git push
bypassing the release.ship pipeline. The `grep -q "## \[2026.3.18\]"` check returned
non-zero → CI fell back to git log → release notes showed only commit messages.

**Root cause confirmed: version bump disconnected from pipeline, not a format mismatch.**
