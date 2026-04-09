---
# MIGRATION NOTICE — ct-grade-v2-1

This directory is a **decommissioned staging copy** of `ct-grade` v2.1.

## Status

**Superseded.** All content has been merged into `packages/skills/skills/ct-grade/`.

## What Changed (T429 skill dedupe)

- `ct-grade-v2-1/SKILL.md` description, `argument-hint`, `allowed-tools`, and version
  (2.1.0) were promoted into `ct-grade/SKILL.md`.
- `ct-grade-v2-1/manifest-entry.json` remains here as an archived snapshot; the
  canonical manifest entry lives in `packages/skills/skills/manifest.json` under name
  `ct-grade`.
- The `grade-viewer/` tooling in this directory was already reachable from `ct-grade/`
  via its `agents/` and `evals/` directories. No content was lost.

## Migration Date

2026-04-08 — T429 hygiene wave, epic T382.

## Action Required

None. Do NOT load this skill. Use `ct-grade` instead.
If you need the A/B or blind-compare modes documented here, they are now part of
`ct-grade`'s SKILL.md description and invocation modes.
