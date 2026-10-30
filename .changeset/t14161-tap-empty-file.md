---
id: t14161-tap-empty-file
tasks: [T14161]
kind: fix
summary: "An empty node:test file no longer counts as one passing test in TAP output (T14161)"
---

`node --test --test-reporter=tap` reports a file that declares no tests as
one passing top-level test named after the file (`ok 1 - smoke/empty.test.mjs`,
`# tests 1`), so a typed gate with `minCount: 1` passed on an empty file.
Node 22, 24 and 26 print that entry exactly like a real top-level test, so the
TAP alone cannot tell them apart. The TAP reader now takes the run's cwd: a
passing top-level `type: 'test'` entry with no nested tests whose name is an
existing file under that cwd counts as zero. A run left with zero tests is
refused and names the empty files. Typed gates pass the gate's cwd;
`test-run:` reports resolve against the execution root.
