# ct-master-tac Bundle Contents

> @task T430 @epic T382 @umbrella T377
> Source: `packages/skills/skills/ct-master-tac/bundled/`

This directory holds the canonical bundle assets shipped with the `ct-master-tac` plugin.

## protocols/

Copies of the 12 CANT protocol files from
`packages/core/src/validation/protocols/cant/`.

Each file defines a protocol primitive in the RCASD-IVTR+C lifecycle:

| File | ID | RCASD Stage |
|------|----|-------------|
| `research.cant` | RSCH | R — Research |
| `consensus.cant` | CONS | C — Consensus |
| `architecture-decision.cant` | ADR | A — Architecture Decision |
| `specification.cant` | SPEC | S — Specification |
| `decomposition.cant` | DCMP | D — Decomposition |
| `implementation.cant` | IMPL | I — Implementation |
| `validation.cant` | VALID | V — Validation |
| `testing.cant` | TEST | T — Testing |
| `contribution.cant` | CONT | cross-cutting |
| `release.cant` | REL | R — Release |
| `artifact-publish.cant` | ART | release sub-protocol |
| `provenance.cant` | PROV | release sub-protocol |

## teams/

| File | Description |
|------|-------------|
| `platform.cant` | Canonical 3-tier CleoOS platform team seed |

## Maintenance

When protocol files change in `packages/core/src/validation/protocols/cant/`,
re-copy them here and bump the version in `ct-master-tac/manifest.json` and
`ct-master-tac/SKILL.md`.
