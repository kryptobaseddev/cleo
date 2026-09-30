---
id: t12848-multi-pr-evidence
tasks: [T12848]
kind: fix
summary: "cleo verify validates each pr: atom in one evidence write against its own merge commit, so pr:A;pr:B;files:… no longer fails E_EVIDENCE_INSUFFICIENT"
---

`files:` bytes were read at `atoms.find(pr).mergeCommitSha` — the first PR's merge — so a file only a later PR changed was "not inspectable at PR merge <first sha>", and a write that got past that was refused by a blanket "one PR per verification attempt" rule. Each `files:` path is now anchored at the merge of the PR that changed it (the latest merge when several did; the latest merge overall for a path no PR changed) through `prMergeCommitForPath`, used by both verify-time validation and complete-time re-validation so the hashed bytes stay the same. Every PR must still be covered by an inspected artifact it changed, so a mismatched file list still rejects. New optional `EvidenceValidationContext.artifactPrs` carries the anchors.

Each non-deletion-only PR must be proven by a listed file it changed that is read at its **own** merge commit: when two PRs changed the same file, that file is read at the later merge only, so it cannot prove the earlier PR (which is refused, naming the PR). PR coverage, merge anchoring and criterion basis share one path normaliser, so `files:./src/b.ts` matches a PR's `src/b.ts`. `EvidenceValidationContext.artifactCommitSha` is deprecated in favour of `artifactPrs`.
