---
id: push-hook-admission
tasks: [T14555]
kind: fix
summary: "Charge pre-push hooks separately and expose pending run waits"
---

Pushes reserve heavy memory only while their pre-push hook runs, using the hook's measured peak to size that admission; unsupported Git or unavailable temporary storage keeps the original guarded push. Hooks always queue for admission. Pending `cleo run --wait` calls appear in `doctor tool-locks` before sampling or acquiring a governor slot, report why they wait, and print a notice within one second. Budget-wait lines repeat only when the wait state changes.
