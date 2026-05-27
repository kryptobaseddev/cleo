---
id: t10170-lint-docs-similarity-gate
tasks: [T10170]
kind: feat
summary: "CI gate: docs similarity lint blocks PRs adding near-duplicate docs"
---

Adds scripts/lint-docs-similarity.mjs that scans newly-added .md files in the PR diff (git diff --diff-filter=A) against the canonical doc roots (publishMirror + rawMdPaths from .cleo/canon.yml). Computes cosine similarity over title+body keyword frequency vectors (stop-words filtered, title weighted x3); flags any pair >= 0.85 as a near-duplicate. Wires the new `Docs Similarity Lint (T10170)` job into .github/workflows/ci.yml. Includes 11 vitest cases covering strict/baseline/check modes, exempt marker, threshold override, and git-diff filter. Sister to T10369 (DocKind writer uniqueness) and T10361 (write-time slug similarity in `cleo docs add`). Saga T9855 / Epic E12.C13.
