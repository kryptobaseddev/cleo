---
id: check-canon-exit-nonzero
tasks: [T14591]
kind: fix
summary: "cleo check canon now exits 1 when its result is passed: false, so the CI canon drift step fails on drift"
---

`cleo check canon` returned a success envelope even when a forbidden phrase
appeared or a required phrase (such as the "Six Great Systems" heading) was
removed, so it exited 0 and the CI step never failed. A failed check now
returns an `E_CANON_VIOLATION` error envelope that names each violation and
failed assertion, carries the full result in `error.details.result`, and
exits 1.
