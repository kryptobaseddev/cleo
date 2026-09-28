---
id: t12474-nexus-portable-roots
tasks: [T12474]
kind: fix
summary: cleo nexus status no longer fails with scandir ENOENT after the project moves to a new path
---

The code-graph file manifest and graph assessment stored the absolute project
and source roots of the machine that last ran `cleo nexus analyze`. After the
project moved (another mount or machine), `cleo nexus status` walked the old
path and failed with `scandir ENOENT`, knowledge coverage reported "Recorded
source ownership differs", and the next analysis rebuilt from scratch.

Roots are now stored relative to the project and resolved against the live
project root when read. A record written by an older version is rebased onto
the live root when every path in it lies inside the project root it recorded,
and the next analysis rewrites it in the portable form. The ownership
fingerprint compares project-relative paths, so a move keeps the graph
incrementally reusable. A source root that still cannot be walked reports
freshness `unknown` with a reason instead of failing the command.
