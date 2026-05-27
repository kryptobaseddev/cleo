---
id: t10114-tree-legend-footer
tasks: [T10114]
kind: feat
summary: "cleo tree --human: default footer legend (icons + counts) — JSON unchanged"
---

Appends a footer legend + summary line under `cleo tree <id> --human`.
Legend lists only icons present in the rendered tree (KindIcon +
RelationIcon.GROUPS + StatusIcon). Summary reports total nodes, max
depth, and saga-member count. JSON output is unchanged — the footer
only emits in the human render path.

Uses `renderLegend` + `renderSummary` primitives from
`@cleocode/animations/render` (B3 / T10146).
