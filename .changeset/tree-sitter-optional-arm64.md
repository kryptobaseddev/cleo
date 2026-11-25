---
id: tree-sitter-optional-arm64
tasks: [T14629]
kind: fix
summary: "npm i -g @cleocode/cleo no longer fails on linux/arm64: tree-sitter and its grammars are optional dependencies"
---

`tree-sitter@0.21.1` ships no linux-arm64 prebuild, and its source build fails
against the Node 24 headers ("C++20 or later required"). Because `@cleocode/cleo`,
`@cleocode/core` and `@cleocode/nexus` listed it as a regular dependency, a global
install failed outright on Graviton, Raspberry Pi and Docker on Apple Silicon.

tree-sitter and the ten grammars are now `optionalDependencies` in all three
packages. Where they cannot build, npm skips them and the install succeeds; the
code already loads them through `tryRequire`, so `cleo code` outline/search and
the nexus AST passes stay off and `cleo doctor` reports tree-sitter as a missing
optional dependency. x64 and macOS installs are unchanged.

CI gains `Packed CLI Install (linux/arm64)`: on dependency changes and nightly it
packs every published package on an `ubuntu-24.04-arm` runner, installs the CLI
from the tarballs and runs `cleo --version` (`packed-install-smoke.mjs --install-only`).
