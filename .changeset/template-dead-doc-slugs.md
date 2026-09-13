---
id: template-dead-doc-slugs
tasks: [T12176]
kind: fix
summary: Remove the two `cleo docs fetch` directives in CLEO-INJECTION.md whose slugs both return E_NOT_FOUND — a template injected into every agent must not instruct a failing command
---

**gh#1342.** `CLEO-INJECTION.md` is injected verbatim into every spawned agent's
prompt and is phrased as instruction. It contained exactly two
`cleo docs fetch <slug>` directives, and both slugs returned `E_NOT_FOUND`:

    cleo docs fetch adr-092-failure-geometries       rc=0   <- positive control
    cleo docs fetch adr-086-cli-output-contract-e9   rc=4   E_NOT_FOUND
    cleo docs fetch adr-077-human-render-contract    rc=4   E_NOT_FOUND

Gate 14 asserts every `cleo <verb>` named in the template resolves against the
command manifest, and it passes here — `docs fetch` is a real command. The
*argument* is what does not exist, which nothing checks.

Both pointers removed. Each sat at the end of a section that already states its
contract inline, so nothing retrievable was lost: the instruction was the only
broken part. The generic `cleo docs fetch <slug>` row in the routing table stays,
because it is guidance rather than a directive with a dead target.
