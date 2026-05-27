---
id: t9949-evidence-hint
tasks: [T9949]
kind: feat
summary: Rich CLI fix-hint for E_EVIDENCE_INSUFFICIENT pointing note-only callers at the correct alternative atom per gate
---

Added `formatGateRequirementHint(gate)` and `checkGateEvidenceMinimumDetailed(gate, atoms)` so `cleo verify` failures now surface a multi-line, copy-pasteable remediation hint via `engineError({fix})`. Each hint lists every satisfying combination as a complete `cleo verify ... --evidence '<atoms>'` invocation, then clarifies whether `note:` alone is accepted for that gate (and if not, which partner atoms to use). Legacy single-line message format preserved byte-for-byte for backward compatibility. Sub-issues 2 (.gitignore allowlist) and 3 (macOS shard 1 flake) deferred to T10489 and T10490.
