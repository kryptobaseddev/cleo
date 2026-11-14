---
id: push-hook-admission
tasks: [T14555]
kind: fix
summary: "Charge pre-push hooks separately and expose pending run waits"
---

Pushes reserve heavy memory only while their pre-push hook runs, using the hook's measured peak to size that admission. Pending `cleo run --wait` calls appear in `doctor tool-locks` before sampling or acquiring a governor slot, report why they wait, and print a notice within one second.
