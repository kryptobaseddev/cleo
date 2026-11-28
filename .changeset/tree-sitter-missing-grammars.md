---
id: tree-sitter-missing-grammars
tasks: [T14665]
kind: fix
summary: "cleo code, cleo nexus analyze and cleo doctor name each tree-sitter grammar that did not load and the command that restores it"
---

cpp, java, ruby and typescript ship no linux-arm64 prebuild, so an install with no
C++ toolchain (slim Docker images, minimal Pi installs) drops those grammars. `cleo
code outline` on such a file now names the grammar package, the platform and the fix
(install g++, make and python3, then `npm install -g @cleocode/cleo`), and the
`tree-sitter` check of `cleo doctor` lists every grammar that did not load with the
same fix, instead of reporting tree-sitter as fully installed. `cleo code search`
no longer returns an empty result that reads as "no match": it warns once per missing
grammar (`W_GRAMMAR_MISSING` in the JSON envelope's `meta.warnings`, a stderr line for a
person), and in JSON mode it now prints its envelope. `cleo nexus analyze` names each
missing grammar, its package and the fix once, with the count of files it kept out of
the index, instead of failing every file with "Parser or grammar unavailable".

`.tsx` files now outline: the tsx and typescript grammars shared one compiled query,
so whichever ran second captured nothing. C++ files now outline: the namespace pattern
named a node type tree-sitter-cpp does not have, so the whole cpp query failed to
compile.

The `Packed CLI Install (linux/arm64)` job also installs the packed CLI in a
toolchain-free `node:24.16.0-trixie-slim` container and requires each grammar to parse
or be reported with its fix, and at least one source-built grammar to have been dropped
and reported. It then reinstalls in `node:24.16.0-trixie`, which has the toolchain, and
requires every dropped grammar to come back and parse. With a toolchain it outlines a
sample of every grammar.
