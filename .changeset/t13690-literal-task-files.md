---
id: t13690-literal-task-files
tasks: [T13690]
kind: fix
summary: typed gates treat a declared task file such as app/[id]/page.tsx as a literal path, so its pass is cached and reused
---

A typed gate hashes the task's declared files as its inputs. Any path holding
`[`, `]`, `{`, `}`, `?` or `*` was refused as a glob ("Typed input requires an
explicit file path"), so a Next.js route file like `app/[id]/page.tsx` in
`task.files` broke input capture. `cleo verify --run` then ran the gate
uncached (its cache report said the inputs could not be captured), and every
later evidence write that read the cache failed with `E_GATE_NOT_CACHED`, even
in the same environment with unchanged inputs.

Declared task files are now literal paths: their bytes are hashed (or recorded
as absent), and the glob refusal applies only to paths from other sources. The
digest `--run` caches under is the one the evidence write reads.
