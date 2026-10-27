---
id: ci-node26-matrix
tasks: [T14055]
kind: chore
summary: "CI runs Type Check and the Linux unit shards on Node 26 beside the 24.16.0 floor"
---

Owner decision D11196: Node-26-only breakage surfaced on developer machines
(Homebrew Node 26.12.1), never in CI, which pinned 24.16.0 everywhere. Type
Check and every Linux unit shard now also run on Node 26; both versions are
required through the CI aggregate. The engines floor stays `>=24.16.0`, and
the node-engine SSoT gate now requires CI to test the floor and no version
below it, instead of every pin equalling the floor. The versions live in
`NODE_VERSIONS` in `scripts/ci-platform-matrix.mjs`.
