#!/usr/bin/env node
// Verifier stub for T-LLM-CRED-CENTRALIZATION epic.
// This epic is a roll-up — concrete acceptance lives in the child tasks:
//   - T9246 Phase 1 (OAuth Bearer auth, shipped PR #120)
//   - T9255 Phase 2 T-llm-1 (role-resolver + 7 call-sites)
//   - T9256 Phase 2 T-llm-2 (LlmConfig.default + roles + RoleName)
//   - T9257 Phase 2 T-llm-3 (credentials-store)
//   - T9258 Phase 2 T-llm-4 (cleo llm CLI)
//   - T9259 Phase 2 T-llm-5 (Phase 2 tests)
//   - T9260 Phase 3 RCASD (Hermes-port plugin registry, deferred)
// Child verifications carry the real evidence. Backfill with concrete
// rollup checks via `cleo verify backfill <epic-id>` once Phase 3 ships.
console.error(
  'T-LLM-CRED-CENTRALIZATION epic verifier stub — child tasks carry concrete evidence. ' +
    'Replace via `cleo verify backfill <epic-id>` to enforce rollup gates.',
);
process.exit(1);
