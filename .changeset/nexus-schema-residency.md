---
id: nexus-schema-residency
tasks: [T12158]
kind: feat
summary: "`cleo doctor nexus-residency` — assert the schema-residency invariant nexus silently depends on"
---

**gh#1298.** `ensureGlobalRegistryAttached()` ATTACHes the global `cleo.db` onto
the project handle as `nexus_global` so nexus registry tables resolve by their
bare names through SQLite's fall-through. Its own comment states the split:
*graph tables resolve to the project `main`; registry tables fall through to the
attach.*

That split holds **only while each bare name exists in exactly one of the two
schemas.** SQLite resolves an unqualified name by searching `temp`, then `main`,
then attached schemas — so a table present in both is answered by `main`, with
no error and no cue. Nexus is correct today **by resolution order, not by the
invariant it documents**, and nothing fails if that stops being true.

**It is already half-false.** ADR-090/T11538 moved the four code-graph tables to
the project scope and T11539 removed them from the global schema source — but no
migration drops them from a database that already has them. Removing a table
from a schema module does not remove it from disk. Measured: project
`nexus_nodes` = 26,964 and `nexus_relations` = 75,500, with all four global
copies present and empty. Today the right side wins because `main` is the
project. Read from a handle whose `main` is the global store, they return **0
rows — an empty graph, indistinguishable from "nothing has been indexed yet"**,
which is a symptom this project has already lost a session to.

`cleo doctor nexus-residency` audits both stores and reports two finding kinds:
`orphaned-in-global` (a graph table still in the global store) and
`ambiguous-fallthrough` (a registry table present in both, so bare-name reads
have been silently answering from the project).

**It reports and drops nothing, deliberately.** This install's global copies are
empty, but an install that used nexus *before* the residency move wrote its graph
rows to the global store and no migration relocated them — there, those rows may
be the only copy. `safeToDrop` is therefore only ever true for an empty table,
and a populated orphan is a data-migration question for the owner rather than a
cleanup. Dropping on the strength of one machine's measurement would be the same
error as inferring a rule from the rows it is then used to exempt.

Tests build real SQLite stores rather than mocks, because the defect is a
property of what is on disk versus what the schema source declares — a mock
would encode the very assumption the audit exists to check.
