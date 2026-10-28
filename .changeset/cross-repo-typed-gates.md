---
id: cross-repo-typed-gates
tasks: [T14078]
kind: feat
summary: "Typed gates can run in a declared evidence repository (an SDK in its own git repo); undeclared repositories are refused"
---

A project declares further evidence repositories in
`.cleo/project-context.json`:

```json
{ "evidence": { "repositories": [{ "name": "sdk", "path": "../sdk", "purpose": "the client SDK" }] } }
```

A typed gate names one with `"repo": "sdk"`. It then runs in that checkout,
its inputs are captured there, and `cleo complete` revalidates it there, so a
changed input in that repository is drift. A gate that names a repository the
project does not declare, or a path that is not the root of a checkout, is
that gate's error. It never runs in another tree.
