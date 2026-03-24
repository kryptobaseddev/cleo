# LAFS Boundary Model

## Ownership matrix

| Artifact | Owner | Notes |
|---|---|---|
| Normative protocol rules (`MUST`/`SHOULD`) | LAFS | Single source of truth |
| Envelope and error schemas | LAFS | Versioned under `schemas/` |
| Error taxonomy and transport mapping | LAFS | `error-registry.json` |
| Conformance definitions and fixtures | LAFS | Canonical checks |
| Product implementation mapping | Consumer project | Clause-to-component evidence |
| Product operational runbooks | Consumer project | Deployment and support guidance |
| Product-specific deltas | Consumer project | Must be explicit and labeled |

## Anti-patterns

- Copying LAFS normative sections into product docs
- Declaring product docs as canonical protocol source
- Shipping unlabeled product protocol extensions

## Clean separation acceptance criteria

1. Product docs reference LAFS canonical clauses instead of restating protocol law.
2. Product docs include a profile/mapping file with evidence only.
3. Product docs do not vendor protocol schemas unless pinned and synchronized.
4. Protocol changes are proposed upstream in LAFS before product normalization.
