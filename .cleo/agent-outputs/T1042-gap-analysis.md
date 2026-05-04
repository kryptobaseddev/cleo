# T1042 Gap Analysis — Redirect Stub

This file is a redirect. The full GitNexus-vs-Cleo-Nexus gap analysis was completed
in 2026-04-24 and lives across the existing artifacts in `T1042-nexus-gap/`:

| Artifact | Bytes | Contents |
|----------|-------|----------|
| `T1042-nexus-gap/gitnexus-surface.md` | 18,646 | GitNexus CLI capability surface |
| `T1042-nexus-gap/cleo-nexus-surface.md` | 29,357 | Cleo Nexus CLI capability surface |
| `T1042-nexus-gap/RECOMMENDATION-v2.md` | 61,830 | Owner-approved direction (773 lines, §8 = full decomposition) |
| `T1042-nexus-gap/gitnexus-runs/` | dir | Functional runs against `/mnt/projects/openclaw` |
| `T1042-nexus-gap/cleo-nexus-runs/` | dir | Functional runs against `/mnt/projects/openclaw` |
| `T1042-nexus-gap/NEXT-SESSION-BRIEF.md` | 27,533 | Closed-vs-pending roster + Council decisions 2026-05-04 |

## Disposition of T1647, T1648, T1649

- **T1647** (research: map gap surface) — closed against `gitnexus-surface.md` +
  `cleo-nexus-surface.md` + `RECOMMENDATION-v2.md` (these contain a strict superset
  of the originally-scoped analysis matrix).
- **T1648** (decompose into actionable tasks) — closed against the existing
  decomposition: T1042 → T1054 (EP1 done), T1055 (EP2 4/5 done), T1056 (EP3 11/17
  done). T1042 has 11 children covering every identified gap.
- **T1649** (implement top-3 priority gaps) — closed against shipped T1054
  ("Nexus P0: Core Query Power", done 2026-05-03T21:34, 8/8 children). EP1 delivered:
  graph query DSL, semantic code search, source content retrieval, wiki generator,
  hook augmenter — all 5 P0 capabilities from RECOMMENDATION-v2.md §8.

## Provenance

- Council session: `20260504T051843Z-a36ef96d` (5-advisor, 4/4 gates passed)
- Owner ratified: 2026-05-04
- D4 reversal: Leiden is shipped (`packages/nexus/src/pipeline/leiden.ts`) — Louvain
  has a known correctness bug (Traag, Waltman, van Eck 2019); Leiden's refinement
  phase fixes it. Brief's earlier "Louvain resolution tuning" framing was sloppy
  inheritance; T1063 description corrected source-of-truth.
- D3 owner decision (2026-05-04): full re-run validation campaign — see new
  validation task filed under T1042.
