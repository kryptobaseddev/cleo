# T1442 Playbook Dispatch OpsFromCore Plan

Task: T1442 (T1435-W1-playbook)
Domain: playbook
Date: 2026-04-27

## Summary

Migrates `packages/cleo/src/dispatch/domains/playbook.ts` from a manual class-based
switch/case handler to the typed-handler pattern using `OpsFromCore<typeof playbookCoreOps>`
inference. All behavior is preserved verbatim.

## Files changed

- `packages/core/src/playbooks/ops.ts` — NEW: declaration-only Core signature registry
- `packages/core/src/playbooks/index.ts` — add `export type { playbookCoreOps }`
- `packages/contracts/src/operations/index.ts` — add `export * from './playbook.js'`
- `packages/cleo/src/dispatch/domains/playbook.ts` — refactor to `defineTypedHandler` + `typedDispatch`
