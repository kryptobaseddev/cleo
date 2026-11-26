---
id: tree-sitter-0-25-arm64
tasks: [T14637]
kind: fix
summary: "cleo code and the nexus AST passes work again on linux/arm64 under Node 24: tree-sitter upgraded to 0.25.1"
---

`tree-sitter` moves from 0.21.1 to 0.25.1, which ships a linux-arm64 prebuild and
builds with C++20 where it must compile, so the optional native dependency is no
longer skipped on Graviton, Raspberry Pi or Docker on Apple Silicon. The grammars
move to their newest releases: `tree-sitter-c` 0.24.1, `tree-sitter-go` 0.25.0,
`tree-sitter-javascript` 0.25.0, `tree-sitter-python` 0.25.0 and `tree-sitter-rust`
0.24.0; cpp 0.23.4, java 0.23.5, ruby 0.23.1 and typescript 0.23.2 are already the
newest releases and ship linux-arm64 prebuilds. Their `tree-sitter` peer ranges are
optional, so npm and pnpm report a peer warning and install normally.

The `Packed CLI Install (linux/arm64)` smoke now fails when any optional native
dependency is skipped and runs a `cleo code outline` parse on the installed CLI.
