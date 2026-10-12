---
id: t12944-playbook-approval-patch-guard
tasks: [T12944]
kind: fix
summary: "The playbook approval patch helper refuses to change a decided gate"
---

`updatePlaybookApproval`, the exported playbook-state patch helper, could set
any approval status, including moving an approved gate back to pending. It
now refuses to change a gate that is already approved or rejected
(`E_APPROVAL_ALREADY_DECIDED`), the same guard `approveGate`/`rejectGate`
apply, so a future caller cannot make one device disagree with the synced
others.
