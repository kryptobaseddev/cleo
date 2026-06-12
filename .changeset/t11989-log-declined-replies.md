---
id: t11989-log-declined-replies
tasks: [T11989]
kind: feat
summary: "fix-gen logs redacted, truncated model reply on model-declined and fixgen-not-a-diff outcomes; reply excerpt persisted on DHQ evidence row"
---

Closes DHQ-091: when the self-improvement fix-gen stage declines to produce a patch
(`model-declined` or `fixgen-not-a-diff`), the model's actual reply was silently
discarded, making diagnosis impossible without a code walk. This change captures and
safely surfaces that reply.

**Changes:**

- **`packages/core/src/selfimprove/fix-gen.ts`** (modified):
  - New `truncateReply(reply)` export — credential-redacts via `@cleocode/utils redact`
    then byte-caps at 3072 bytes (`REPLY_EXCERPT_MAX_BYTES`) with a
    `…[truncated N bytes]` overflow marker. Pre-sanitized output is safe to log or persist.
  - `FixGenOutput` `'none'` variant gains an optional `rawReply?: string` field.
    `createLlmFixGenerator.propose()` populates it with `truncateReply(text)` on
    `model-declined` (non-empty reply only; empty reply = no excerpt).
  - `FixGenResult` `'skipped'` variant gains an optional `replyExcerpt?: string` field.
    `generateFixPatch` propagates `rawReply` from `FixGenOutput` into `replyExcerpt` for
    the `model-declined` path (debug log) and calls `truncateReply(output.diff)` for the
    `fixgen-not-a-diff` path (warn log). The `replyExcerpt` flows into the JSON the
    run-loop serializes onto the `selfimprove_dhq` evidence row, enabling the operator to
    diagnose the model's actual output without re-running.

**Tests added (`fix-gen.test.ts`):**

- `(a)` declined reply lands in `FixGenResult.replyExcerpt` truncated at 3 KiB.
- `(b)` seeded `sk-ant-...` / `Bearer ...` credential strings in the reply are redacted.
- `(c)` valid-diff path logs nothing extra (`replyExcerpt` absent on `written` result).
- `fixgen-not-a-diff` path attaches `replyExcerpt` from the non-diff output.
- New capstone test: `model-declined` reply excerpt is persisted on the leased DHQ
  evidence row (asserts `evidence.fixGen.replyExcerpt` via real adapter + in-memory DB).
