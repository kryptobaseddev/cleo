---
id: t12944-playbook-approval-once
tasks: [T12944]
kind: feat
summary: "Sync merges keep a decided playbook approval decided"
---

When two devices sync playbook approvals, an approval that one device approved
or rejected is never taken back to pending by a later write on another device.
If the two devices decided differently, every device ends with the same
decision and the other one is recorded as a conflict. A decision and its
approver, time and reason always travel together.
