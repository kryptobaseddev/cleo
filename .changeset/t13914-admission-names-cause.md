---
id: t13914-admission-names-cause
tasks: [T13914]
kind: fix
summary: An admission wait closed by memory pressure names the host's largest memory users, and an install is charged one process
---

When a non-CLEO process (a leaking 17 GB agent) drove memory pressure up, the
memory gate closed the admission budget to zero and every `cleo run --wait`
across projects waited with "Holders: none".

When the gate refuses, admission now probes the host's three largest memory
users (macOS `top` footprint, which counts compressed and swapped pages that
`ps` RSS misses; Linux RSS) at most once per 30 s, and stores them with the
pressure reading. The refusal reason, the "waiting: memory pressure" line, the
deferral fix, the one-minute holder report (which also says when the wait
gives up) and `cleo doctor tool-locks` (`budget.cause`) name them and how to
free memory.

`pnpm install`, `add`, `update` and `npm ci` are charged a single-process
plan (6 GiB on a 64 GiB Mac) instead of half a heavy run (12 GiB).
