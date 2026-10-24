---
id: t13921-run-urgent-measured-hook
tasks: [T13921]
kind: feat
summary: cleo run --urgent queues ahead of routine work, and a hooked git push is charged its measured peak
---

A one-file fix for a red main waited 35+ minutes behind four routine branch
pushes, each charged 12 GiB because pre-push runs a typecheck.

- `cleo run --urgent` puts the job at the head of the machine-wide queue,
  ahead of every routine waiter. It is still admitted only within the budget;
  nothing running is paused or displaced.
- A hooked `git push`/`git commit` that exits 0 records its measured peak
  resident memory (sampled every 5 s), keyed by the hook's name and the sha256
  of its content. The next run of that hook is charged that peak plus 25%
  (at least 1 GiB, never more than its class plan). An edited hook is
  measured again.
- The one-minute holder report shows the job's queue position.
