---
id: t9852-lint-hotfix
tasks: [T9852, T9839]
kind: chore
summary: biome lint hotfixes — unblock CI after T9797 saga-T9787 file landed
prs: [427]
---

Three pre-existing lint failures surfacing on main: noUselessLoneBlockStatements in saga-T9787-e2e-validation.mjs:321; useOptionalChain in hermes-import-classifier.ts:143/150; noTemplateCurlyInString in lint-json-stream-hygiene.mjs:394. Also formatted command-manifest.ts to satisfy biome ci (generator drift, T9246 follow-up).
