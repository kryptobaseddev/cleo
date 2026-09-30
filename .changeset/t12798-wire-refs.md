---
id: t12798-wire-refs
tasks: [T12798]
kind: fix
summary: A row received by sync never carries another row's local key; every reference travels as a uid and fingerprint, and a row whose target is missing waits (row uids, opt-in)
---

The receive contract behind row uids (T12341) translated only plain
reference columns. Other references were sent as raw local keys:
- an evidence binding's `ac_id`, and the criterion uid it records (`ac_uid`);
- an AC history row's `ac_id`;
- a session's `tasks_created_json` and `tasks_completed_json` arrays.

A raw local key means a different row on the receiving device. So a binding
could attach evidence to the wrong criterion, and a session could list the
wrong tasks.

- Those columns are now left out of the row's values. They travel as
  references: uid plus birth fingerprint, element by element for the arrays.
- The receiver resolves each reference to its own local row.
- A row whose target is not there yet waits in the identity quarantine and
  is placed once the target arrives. That includes a target the sender
  itself could not find.

Nothing changes while row uids are off (the default).
