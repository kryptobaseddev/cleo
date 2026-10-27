---
id: bounded-stdout-test
tasks: [T14076]
kind: fix
summary: "the tool-cache bounded-stdout test checks the retained buffer directly instead of a heap delta, so it no longer fails at random"
---

`does not retain unbounded stdout` measured a `heapUsed` delta with no forced
GC. It failed a release preflight at 14.6 MB against its 4 MB limit while
passing on main. It now checks what the runner keeps:
`spawnToolProcess` returns at most 64 KiB of the 5 MB streamed. With the buffer
cap removed, the test fails (it returned 5242884 bytes).
