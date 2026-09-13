---
id: strict-envelope-test-helper
tasks: [T12167]
kind: test
summary: Spawned-CLI tests parse stdout as exactly one envelope instead of searching it for a brace-line
---

**gh#1223.** Eleven test files independently grew the same helper:

```ts
const envelopeLine = lines.find((l) => l.trim().startsWith('{'));
return JSON.parse(envelopeLine);
```

It **searches** stdout for something envelope-shaped. On polluted output it finds
one and passes. Measured against the exact stdout of a real `cleo` write:

```
lenient helper finds an envelope in polluted output:  true
JSON.parse on the whole stream:                       THREW
  "Unexpected non-whitespace character after JSON at position 3"
```

ADR-086 says stdout is one envelope per call. A helper that tolerates extra
lines does not merely miss a defect — **it makes stdout impurity untestable by
construction**, across every spawned-CLI test in the repo. That is how `ai@6`'s
`console.info` banner reached stdout and survived review: it appended a sentence
after the envelope, and every test looked past it.

`parseSoleEnvelope` parses the whole stream and names what came after the
envelope when it fails, because "unexpected token" alone sends the reader to the
envelope builder when the cause is a stray `console.log`.

`assertSpawnReachedCommand` is the second half, and it exists because I wrote a
spawned test that **passed against a dist whose dependencies were not built** —
the CLI died with `E_CLI_UNCAUGHT` before any command ran, and every assertion
about its output was vacuous. A test that cannot tell whether it exercised the
path reports success for work it did not do, which is the defect these tests
exist to catch, one level up. An unreached path now fails rather than passing
quietly.

**Scope, measured before choosing it:** 9 of the 11 files carrying the lenient
helper are in the T12067 quarantine and do not currently run. The two that do —
`goal.test.ts` and `docs-canonical-surface.test.ts` — are migrated here, plus
`docs-error-envelopes.test.ts` so the quarantined set does not re-enter carrying
the defect as it shrinks. 31 passing tests before, 31 after; the helper's own
suite adds 7, including one that pins the polluted output the lenient version
accepted, kept verbatim as a counter-example.
